# CLAUDE.md

Project-wide gotchas for `delta-v-racing`, a Devvit Web + Phaser 4.1.0 + Hono +
Redis game. This file is for hard-won, easy-to-re-break knowledge — not
general instructions (see `AGENTS.md`), not deploy steps (see `DEPLOYMENT.md`),
not future work (see `BACKLOG.md`). Add to this file whenever a bug takes more
than a few minutes to track down and the root cause could plausibly bite
someone again.

## Testing / verification

- This app only runs for real inside a Reddit webview via `devvit playtest`
  (`npm run dev`), which requires a live login and a real subreddit install.
  It **cannot be launched or driven headlessly** — an AI assistant working on
  this repo can typecheck/lint/read code but cannot click through the actual
  running game. Say so explicitly rather than claiming a UI change was
  verified. Ask the user to check in their own `devvit playtest` session.
- `reddit.com` and `old.reddit.com` are not fetchable from this dev
  environment (tooling restriction) — can't check live subreddit state
  (posts, comments) directly; rely on local repo state and ask the user.
- `npm run type-check` and `npm run lint` are the two checks that *can* run
  standalone and should be run after any change.

## Windows dev environment

- **`package.json` script globs must use double quotes, not single.** npm
  always runs its scripts through `cmd.exe` on Windows regardless of which
  shell invoked `npm`, and `cmd.exe` doesn't treat single quotes as quoting
  syntax — `eslint 'src/**/*.{ts,tsx}'` becomes a literal argument including
  the quote characters and matches zero files, silently. Double quotes work
  in both `cmd.exe` and POSIX shells. (Bit `npm run lint` and therefore
  `npm run deploy` for a while — fixed 2026-07-13.)
- No `ffmpeg`/ImageMagick/Python are installed in this environment by
  default. GameMaker Studio installs happen to bundle an `ffmpeg.exe` under
  `%APPDATA%\GameMaker-Studio\` if you need one for video/image processing
  tasks (e.g. extracting frames for marketing screenshots).

## Phaser 4 (v4.1.0) in the Devvit webview

Phaser 4 has several sharp edges versus Phaser 3 that cost real debugging
time. Full details/history in `.claude` memory (`feedback_phaser4_workarounds`,
`feedback_phaser4_update_and_hud`, `feedback_float_radius_animations`); the
load-bearing summary:

- **Scene `update()` may not fire reliably.** Anything that must run every
  frame (minimap dot, HUD, pulsing effects) should be driven by
  `requestAnimationFrame` instead, cancelled on scene `shutdown`.
- **`setScrollFactor(0)` blocks camera *scroll*, not camera *zoom*.** A
  Graphics object with `setScrollFactor(0)` at world position (x, y) still
  renders at screen pixel (x × zoom, y × zoom) — it will fly off-screen at
  any zoom level other than 1. For a truly fixed HUD, use a `position:fixed`
  DOM element instead of a Phaser object.
- **Never overlay a DOM `<canvas>` (Canvas 2D) on top of Phaser's WebGL
  canvas for interactive content.** This crashes Chrome's renderer process
  (white screen, no JS error — a native GPU/compositor crash) on
  touch/drag, including in Reddit's mobile in-app WebView. This was the root
  cause of a long-unsolved TrackEditor crash. Fixed HUD overlays as plain DOM
  `<div>`s are fine; interactive world content must stay in Phaser
  Graphics/textures.
- **`camera.width`/`camera.height` are unreliable under `Scale.RESIZE`** —
  use `cam.worldView.width/height` and `.centerX/Y` instead.
- **Wheel event signature changed**: Phaser 4 is
  `(pointer, deltaX, deltaY, deltaZ)`, no `gameObjects` param (Phaser 3 had
  one). Using the old positional order silently reads the wrong delta.
- **Pinch zoom needs `this.input.addPointer(1)` called explicitly** — two-touch
  gestures are otherwise silently ignored.
- **`Phaser.Math.Clamp` is not available as a global** in the bundled Vite
  build (throws "Phaser is not defined"). Use `Math.min(Math.max(v, lo), hi)`.
- **`emitter.explode(n)` stops continuous flow mode** (sets `frequency = -1`).
  For an initial burst *and* ongoing flow, use `emitter.emitParticle(n)`
  instead, which doesn't change the emitter's mode.
- **Any `this.scale.on('resize', ...)` listener must be removed on scene
  shutdown.** `this.scale` is the global ScaleManager and outlives the scene
  — an unremoved listener fires against destroyed Text/Graphics objects on
  the next resize (e.g. toggling DevTools' device toolbar) and crashes.
  Pattern used everywhere in this repo: name the handler, and
  `this.events.once('shutdown', () => this.scale.off('resize', onResize))`.
- **Never `Math.round()` a radius/size driven by a sine/time animation** —
  integer snapping produces visible step-jitter even though the underlying
  math is smooth. Use the raw float, and vary size + alpha together for a
  noticeably smoother pulse than either alone.

## Devvit-specific traps

- **`context.appVersion` is Devvit's own auto-incrementing build number**
  (e.g. `"v0.0.1.484"`), bumped on *every* `devvit upload` — it is not a
  semantic/release version you control. Do not gate any "show this again on
  a meaningful update" behavior on it; it'll fire on every single deploy.
  See `FTUE_TAG` in `src/client/scenes/ModeSelect.ts` for the pattern that
  replaced an `appVersion`-tied flag after this exact bug shipped and reset
  the "New here?" overlay for everyone on every deploy during active
  development.
- **A `?migrate=1`-style URL query param cannot reach the client script.**
  Devvit renders a post's content in a sandboxed webview with its own URL —
  query params on the outer `reddit.com` post page never make it in. Any
  "trigger via URL" idea for mod tooling needs a different mechanism (this
  repo uses a `window`-attached function invoked from the browser devtools
  console instead — see `showMigrationDialog` in `splash.ts`).
- **The dev→prod migration tool (`/api/migration/*` routes, `TrackUpload.ts`
  helpers, `showMigrationDialog` in `splash.ts`) is intentionally kept, not
  dead code.** It was built for the one-time hackathon launch migration
  (completed 2026-07-15) and deliberately *not* deleted afterward — kept as a
  standing capability for future re-migrations/backups. It has no UI trigger
  by design (a discoverable tap-gesture was removed as light hardening);
  invoke `showMigrationDialog()` from devtools console. Full usage steps in
  `DEPLOYMENT.md`.

## App architecture gotchas

- **Daily-schedule entries don't own their own copy of track data.**
  `daily:schedule` in Redis is just a `date -> trackId` pointer into the same
  `track:{id}` record used by Community tracks (see
  `src/client/track/DailyCalendar.ts` and the `/api/daily-schedule/*` /
  `/api/community-track/:id` routes in `src/server/routes/api.ts`).
  Promoting a Community track to Daily does not clone it. Consequently,
  **deleting a Community track must also clear any `daily:schedule` slots
  pointing at it**, or that day silently orphans (the day just stops
  appearing, with no obvious cause) — `DELETE /api/community-track/:id`
  handles this cleanup as of 2026-07-15; if you add another path that can
  delete a `track:{id}` record, it needs the same cleanup.
- **Mod status (`this.isMod` in `TrackSelect.ts`) is fetched lazily by
  whichever tab loads first, then cached** (`isModChecked`). Every tab that
  gates UI on `this.isMod` (Community, Drafts, Daily) must resolve it through
  the shared `this.modPromise()` / `this.commitModCheck()` helpers, not read
  `this.isMod` directly — otherwise a mod who opens straight to a tab other
  than Community sees mod-only buttons silently missing until they happen to
  visit Community first in that session. (This exact bug shipped once and
  hid the Drafts-tab AI-verify button for mods.)
- **Track-editor marquee/rubber-band hit-testing only considers a piece's
  actually-drawn geometry** (`pieceVisibleBounds()` in `TrackEditor.ts`), not
  the full circle a corner's swept arc belongs to. A naive
  circle-based conservative bounding box lets a corner piece that's nowhere
  near the marquee visually get selected anyway. The "fully inside" vs.
  "touching" hit-test mode is a persisted setting
  (`EditorSettings.marqueeTouchMode`, Options screen) — both modes must keep
  using `pieceVisibleBounds()`, not a looser box, if either is ever touched.
- **`TODO(pre-production)` is a grep-able convention** for anything
  deliberately left in a not-production-ready state during active
  development (e.g. a gating check temporarily relaxed for testing). Grep
  `src/` for it before any real launch/deploy. Currently zero hits — keep it
  that way, or add the marker when you introduce the next one.
