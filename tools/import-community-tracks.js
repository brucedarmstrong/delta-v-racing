/**
 * Bulk-uploads a community-tracks export (produced by export-community-tracks.js)
 * into whichever Devvit environment this script is run against — e.g. paste
 * this into the PRODUCTION post's console to migrate tracks exported from dev.
 *
 * Uses the app's existing /api/seed-tracks endpoint (the same one behind the
 * "⊕ Seed Library" button in the community tab). Requires you to be a
 * MODERATOR of the subreddit hosting this post. Safe to re-run: it overwrites
 * by track id rather than duplicating.
 *
 * HOW TO USE:
 *   1. Open the PRODUCTION post in your browser and open Chrome DevTools → Console.
 *   2. At the top-left of the Console panel, click the dropdown that says "top".
 *      Select the iframe whose URL is the game's own origin (the Devvit web
 *      view iframe, not reddit.com/top).
 *   3. Paste this entire script into the console and press Enter.
 *   4. A file picker appears — choose the "community-tracks-export-*.json"
 *      file you got from export-community-tracks.js. Uploads happen in small
 *      batches with progress logged to the console.
 *
 * NOTE: Imported tracks won't have an individual Reddit post (same as the
 * built-in "Seed Library" tracks) — the app already handles that gracefully,
 * they're fully playable from the community list, just not individually
 * upvotable as their own post.
 */

(async () => {
  const BATCH_SIZE = 20;

  function log(...args) { console.log('[import]', ...args); }

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
    log('Pick the community-tracks-export-*.json file in the picker that just appeared…');
  });

  const text = await file.text();
  const parsed = JSON.parse(text);
  const tracks = Array.isArray(parsed) ? parsed : parsed.tracks;
  if (!Array.isArray(tracks) || tracks.length === 0) {
    throw new Error('File did not contain a non-empty "tracks" array.');
  }
  log(`Loaded ${tracks.length} track(s) from "${file.name}".`);

  // ── 2. Upload in batches ───────────────────────────────────────────────────
  let uploaded = 0;
  for (let i = 0; i < tracks.length; i += BATCH_SIZE) {
    const batch = tracks.slice(i, i + BATCH_SIZE);
    const res = await fetch('/api/seed-tracks', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ tracks: batch }),
    });
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      if (res.status === 403) {
        throw new Error(`Forbidden — you must be a moderator of this subreddit to run this. HTTP 403 ${bodyText}`);
      }
      throw new Error(`Batch ${i / BATCH_SIZE + 1} failed: HTTP ${res.status} ${bodyText}`);
    }
    uploaded += batch.length;
    log(`Uploaded ${uploaded}/${tracks.length}…`);
  }

  log(`Done. ${uploaded} track(s) are now in this environment's community list.`);
})();
