/**
 * Exports your "Tutorial 1", "Tutorial 2", "Tutorial 3" drafts (matched by
 * name prefix) as a single JSON file, so their track geometry can be used to
 * rebuild the in-app tutorial system (src/client/tracks/tutorialTracks.ts).
 *
 * HOW TO USE:
 *   1. Open the game in your browser (logged in) and open Chrome DevTools →
 *      Console.
 *   2. At the top-left of the Console panel, click the dropdown that says
 *      "top". Select the iframe whose URL is the game's own origin (the
 *      Devvit web view iframe, not reddit.com/top).
 *   3. Paste this entire script into the console and press Enter.
 *   4. It downloads "tutorial-drafts-export-<timestamp>.json". Share that
 *      file back so the tutorial tracks can be rebuilt from it.
 */

(async () => {
  function log(...args) { console.log('[export-tutorial]', ...args); }

  const res = await fetch('/api/mine-tracks');
  if (!res.ok) throw new Error(`GET /api/mine-tracks failed: HTTP ${res.status}`);
  const { tracks } = await res.json();

  const wanted = ['Tutorial 1', 'Tutorial 2', 'Tutorial 3'];
  const matches = wanted.map(prefix => tracks.find(t => t.name.startsWith(prefix)));
  matches.forEach((m, i) => {
    if (!m) log(`WARNING: no draft found whose name starts with "${wanted[i]}"`);
  });

  const found = matches.filter(Boolean);
  if (found.length === 0) throw new Error('No matching drafts found.');
  log(`Found ${found.length}/3: ${found.map(m => m.name).join(', ')}`);

  const results = [];
  for (const meta of found) {
    const r = await fetch(`/api/mine-track/${encodeURIComponent(meta.id)}`);
    if (!r.ok) { log(`WARNING: failed to fetch data for "${meta.name}" — HTTP ${r.status}`); continue; }
    const json = await r.json();
    const payload = JSON.parse(json.data);
    results.push({ id: meta.id, name: meta.name, ...payload });
  }

  const output = JSON.stringify(results, null, 2);
  const filename = `tutorial-drafts-export-${Date.now()}.json`;
  try {
    const blob = new Blob([output], { type: 'application/json' });
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
    log('Download failed — printing JSON to console instead.', err);
    console.log(output);
  }

  try {
    localStorage.setItem('dv-tutorial-drafts-export', output);
    log('Also stashed a copy in localStorage under "dv-tutorial-drafts-export".');
  } catch { /* quota exceeded — download/console log is the primary path anyway */ }
})();
