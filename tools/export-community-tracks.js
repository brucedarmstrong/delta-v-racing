/**
 * Downloads every track currently in the COMMUNITY list (not drafts, not
 * "mine") as a single JSON file, in the exact shape /api/seed-tracks expects.
 * Pair this with import-community-tracks.js to migrate a community library
 * from one Devvit environment (e.g. dev/test subreddit) to another (e.g.
 * production), without needing to re-upload each track by hand.
 *
 * HOW TO USE:
 *   1. Open the dev/test post in your browser and open Chrome DevTools → Console.
 *   2. At the top-left of the Console panel, click the dropdown that says "top".
 *      A list of iframes appears. Select the one whose URL is the game's own
 *      origin (the Devvit web view iframe, not reddit.com/top).
 *   3. Paste this entire script into the console and press Enter.
 *   4. It fetches every community track's metadata + full data, then triggers
 *      a browser download of "community-tracks-export-<timestamp>.json".
 *      A copy is also stashed in localStorage under "dv-community-export" as
 *      a fallback in case the download is blocked.
 *
 * NOTE: Tracks migrated this way land in the target's community list without
 * an individual Reddit post (same as the built-in "Seed Library" feature) —
 * the app already handles that case (TrackSelect's "load in-place" path), so
 * they're fully playable, just not individually upvotable as their own post.
 */

(async () => {
  const PAGE_SIZE = 50;      // server clamps limit to 50 max
  const CONCURRENCY = 6;     // parallel /api/track/:id fetches

  function log(...args) { console.log('[export]', ...args); }

  // ── 1. Page through /api/tracks/community to collect every id ────────────
  log('Fetching community track list…');
  const metas = [];
  let offset = 0, total = Infinity;
  while (offset < total) {
    const res = await fetch(`/api/tracks/community?offset=${offset}&limit=${PAGE_SIZE}`);
    if (!res.ok) throw new Error(`GET /api/tracks/community failed: HTTP ${res.status}`);
    const json = await res.json();
    total = json.total;
    metas.push(...json.tracks);
    offset += PAGE_SIZE;
  }
  log(`Found ${metas.length} community track(s).`);

  if (metas.length === 0) {
    log('Nothing to export.');
    return;
  }

  // ── 2. Fetch full data for each track, with modest concurrency ───────────
  const results = new Array(metas.length);
  let cursor = 0, done = 0;
  async function worker() {
    while (cursor < metas.length) {
      const i = cursor++;
      const meta = metas[i];
      const res = await fetch(`/api/track/${encodeURIComponent(meta.id)}`);
      if (!res.ok) {
        log(`WARNING: failed to fetch data for "${meta.name}" (${meta.id}) — HTTP ${res.status}, skipping.`);
        continue;
      }
      const json = await res.json();
      results[i] = {
        id:         meta.id,
        name:       meta.name,
        author:     meta.author,
        uploadedAt: meta.uploadedAt,
        data:       json.data,
      };
      done++;
      if (done % 10 === 0 || done === metas.length) log(`Fetched ${done}/${metas.length}…`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const tracks = results.filter(Boolean);
  log(`Exported ${tracks.length}/${metas.length} track(s).`);

  // ── 3. Trigger a download, with a localStorage fallback ──────────────────
  const payload = JSON.stringify({ exportedAt: Date.now(), tracks }, null, 2);
  const filename = `community-tracks-export-${Date.now()}.json`;

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
    localStorage.setItem('dv-community-export', payload);
    log('Also stashed a copy in localStorage under "dv-community-export".');
  } catch { /* quota exceeded — download is the primary path anyway */ }

  log('Done. Copy the downloaded JSON file to the production side and run import-community-tracks.js there.');
})();
