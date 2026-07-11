/**
 * Downloads every player leaderboard ghost AND every cached AI ghost, across
 * every track that has one, as a single JSON file. Pair this with
 * import-ghosts.js to migrate ghost data from one Devvit environment (e.g.
 * dev/test subreddit) to another (e.g. production).
 *
 * Requires you to be a MODERATOR of the subreddit hosting this post — the
 * server-side /api/seed-ghosts and /api/seed-ai-ghosts endpoints only accept
 * writes from mods, since (unlike normal ghost uploads) they write explicit
 * usernames rather than the current session's.
 *
 * HOW TO USE:
 *   1. Open the dev/test post in your browser and open Chrome DevTools → Console.
 *   2. At the top-left of the Console panel, click the dropdown that says "top".
 *      Select the iframe whose URL is the game's own origin (the Devvit web
 *      view iframe, not reddit.com/top).
 *   3. Paste this entire script into the console and press Enter.
 *   4. It fetches every track's leaderboard + ghosts, then triggers a browser
 *      download of "ghosts-export-<timestamp>.json". A copy is also stashed
 *      in localStorage under "dv-ghosts-export" as a fallback.
 *
 * Run alongside export-community-tracks.js / import-community-tracks.js if
 * you're migrating community tracks too — ghosts reference trackId, so make
 * sure the corresponding tracks exist on the target side first (or at least
 * before players start racing them there).
 */

(async () => {
  const CONCURRENCY = 6;
  const AI_SKILLS = ['perfect', 'skilled', 'average', 'rookie'];

  function log(...args) { console.log('[export-ghosts]', ...args); }

  // ── 0. Discover every trackId with leaderboard activity ───────────────────
  const dumpRes = await fetch('/api/debug/dump');
  if (!dumpRes.ok) throw new Error(`GET /api/debug/dump failed: HTTP ${dumpRes.status}`);
  const dump = await dumpRes.json();
  const trackIds = dump['lb:tracks'] ?? [];
  log(`Found ${trackIds.length} track(s) with leaderboard activity.`);

  // ── 1. Page through each track's leaderboard for username+score pairs ────
  const lbEntries = []; // { trackId, username, score }
  for (const trackId of trackIds) {
    let offset = 0, total = Infinity;
    while (offset < total) {
      const res = await fetch(`/api/leaderboard/${encodeURIComponent(trackId)}?offset=${offset}&limit=100`);
      if (!res.ok) { log(`WARNING: leaderboard fetch failed for ${trackId}, skipping rest.`); break; }
      const json = await res.json();
      total = json.total;
      for (const e of json.entries) lbEntries.push({ trackId, username: e.username, score: e.score });
      offset += 100;
    }
  }
  log(`Found ${lbEntries.length} player leaderboard entr(ies) across all tracks.`);

  // ── 2. Fetch each player ghost's raw data, with modest concurrency ───────
  const ghostResults = new Array(lbEntries.length);
  {
    let cursor = 0, done = 0;
    async function worker() {
      while (cursor < lbEntries.length) {
        const i = cursor++;
        const e = lbEntries[i];
        const res = await fetch(`/api/ghost/${encodeURIComponent(e.trackId)}/${encodeURIComponent(e.username)}`);
        if (!res.ok) { log(`WARNING: no ghost data for ${e.trackId}/${e.username}, skipping.`); continue; }
        const json = await res.json();
        ghostResults[i] = { trackId: e.trackId, username: e.username, score: e.score, ghost: json.ghost };
        done++;
        if (done % 20 === 0 || done === lbEntries.length) log(`Fetched ${done}/${lbEntries.length} player ghosts…`);
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  }
  const ghosts = ghostResults.filter(Boolean);

  // ── 3. Fetch AI ghosts (4 skills × N tracks) ──────────────────────────────
  const aiJobs = trackIds.flatMap(trackId => AI_SKILLS.map(skill => ({ trackId, skill })));
  const aiResults = new Array(aiJobs.length);
  {
    let cursor = 0, done = 0;
    async function worker() {
      while (cursor < aiJobs.length) {
        const i = cursor++;
        const { trackId, skill } = aiJobs[i];
        const res = await fetch(`/api/ai-ghost/${encodeURIComponent(trackId)}/${skill}`);
        if (!res.ok) continue; // no AI ghost cached for this track/skill — fine, skip
        const json = await res.json();
        aiResults[i] = { trackId, skill, ghost: json.ghost };
        done++;
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  }
  const aiGhosts = aiResults.filter(Boolean);
  log(`Fetched ${aiGhosts.length} AI ghost(s).`);

  // ── 4. Trigger a download, with a localStorage fallback ──────────────────
  const payload = JSON.stringify({ exportedAt: Date.now(), ghosts, aiGhosts }, null, 2);
  const filename = `ghosts-export-${Date.now()}.json`;

  try {
    const blob = new Blob([payload], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    log(`Download triggered: ${filename}`);
  } catch (err) {
    log('Download failed, falling back to localStorage only.', err);
  }

  try {
    localStorage.setItem('dv-ghosts-export', payload);
    log('Also stashed a copy in localStorage under "dv-ghosts-export".');
  } catch { /* quota exceeded — download is the primary path anyway */ }

  log(`Done. ${ghosts.length} player ghost(s) + ${aiGhosts.length} AI ghost(s) exported.`);
  log('Copy the downloaded JSON file to the production side and run import-ghosts.js there.');
})();
