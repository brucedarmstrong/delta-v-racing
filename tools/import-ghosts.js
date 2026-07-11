/**
 * Bulk-uploads a ghosts export (produced by export-ghosts.js) into whichever
 * Devvit environment this script is run against — e.g. paste this into the
 * PRODUCTION post's console to migrate ghosts exported from dev.
 *
 * Requires you to be a MODERATOR of the subreddit hosting this post — the
 * server-side /api/seed-ghosts and /api/seed-ai-ghosts endpoints only accept
 * writes from mods. Safe to re-run: it overwrites by trackId+username (or
 * trackId+skill for AI ghosts) rather than duplicating.
 *
 * HOW TO USE:
 *   1. Open the PRODUCTION post in your browser and open Chrome DevTools → Console.
 *   2. At the top-left of the Console panel, click the dropdown that says "top".
 *      Select the iframe whose URL is the game's own origin (the Devvit web
 *      view iframe, not reddit.com/top).
 *   3. Paste this entire script into the console and press Enter.
 *   4. A file picker appears — choose the "ghosts-export-*.json" file you got
 *      from export-ghosts.js. Uploads happen in small batches with progress
 *      logged to the console.
 *
 * Run this AFTER import-community-tracks.js if you're migrating community
 * tracks too — ghosts reference trackId, and while a leaderboard entry can
 * exist before its track record does, players won't be able to race those
 * tracks/ghosts until the track itself is imported.
 */

(async () => {
  const BATCH_SIZE = 30;

  function log(...args) { console.log('[import-ghosts]', ...args); }

  // ── 1. Prompt for the exported JSON file ──────────────────────────────────
  const file = await new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json';
    input.style.position = 'fixed';
    input.style.zIndex = '999999';
    input.style.top = '10px';
    input.style.left = '10px';
    input.addEventListener('change', () => {
      input.remove();
      if (input.files && input.files[0]) resolve(input.files[0]);
      else reject(new Error('No file selected'));
    });
    document.body.appendChild(input);
    log('Pick the ghosts-export-*.json file in the picker that just appeared…');
  });

  const text = await file.text();
  const parsed = JSON.parse(text);
  const ghosts   = Array.isArray(parsed.ghosts)   ? parsed.ghosts   : [];
  const aiGhosts = Array.isArray(parsed.aiGhosts) ? parsed.aiGhosts : [];
  if (ghosts.length === 0 && aiGhosts.length === 0) {
    throw new Error('File contained no ghosts or aiGhosts.');
  }
  log(`Loaded ${ghosts.length} player ghost(s) and ${aiGhosts.length} AI ghost(s) from "${file.name}".`);

  async function uploadBatches(path, items, label) {
    let uploaded = 0;
    for (let i = 0; i < items.length; i += BATCH_SIZE) {
      const batch = items.slice(i, i + BATCH_SIZE);
      const res = await fetch(path, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ ghosts: batch }),
      });
      if (!res.ok) {
        const bodyText = await res.text().catch(() => '');
        if (res.status === 403) {
          throw new Error(`${label}: forbidden — you must be a moderator of this subreddit to run this. HTTP 403 ${bodyText}`);
        }
        throw new Error(`${label} batch ${i / BATCH_SIZE + 1} failed: HTTP ${res.status} ${bodyText}`);
      }
      uploaded += batch.length;
      log(`${label}: uploaded ${uploaded}/${items.length}…`);
    }
    return uploaded;
  }

  const ghostCount   = await uploadBatches('/api/seed-ghosts', ghosts, 'Player ghosts');
  const aiGhostCount = await uploadBatches('/api/seed-ai-ghosts', aiGhosts, 'AI ghosts');

  log(`Done. ${ghostCount} player ghost(s) + ${aiGhostCount} AI ghost(s) are now in this environment.`);
})();
