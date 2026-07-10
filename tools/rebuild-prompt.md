# Delta-V Racing — Rebuild Prompt for Advanced Model

You are building **Delta-V Racing** — a complete, production-ready, turn-based vector racing game running as a Reddit Devvit app. Build everything from scratch with clean, optimized architecture. Do not reference any existing implementation.

---

## Platform Constraints

- Runs inside a Reddit post as a Devvit WebView (embedded iframe)
- **Client**: TypeScript + Vite, rendered with Phaser 4 (WebGL canvas). Mobile-first — the primary device is a phone held portrait. Touch is the primary input; mouse/desktop must also work.
- **Server**: Hono on Devvit's Node.js runtime. Storage is Redis (Devvit KV store). No filesystem. No external databases.
- **Auth**: Devvit provides `username` and `isLoggedIn` via its context API. No separate auth flow.
- No persistent background processes — all work is request/response.
- Bundle must be small and fast. Lazy-load anything that isn't needed at startup.

---

## Core Game: Vector Racing

### The Physics

This is a **turn-based** game. Each turn the player picks a move from a 3×3 grid of dots centered on their current velocity vector. The chosen dot becomes the new velocity, and the car moves to: `position += velocity`. This is the classic "Racetrack" / vector racing mechanic.

- Velocity carries over every turn (inertia). You cannot stop instantly.
- The 3×3 grid means you can accelerate by ±1 in X or Y each turn, or hold velocity, or combine.
- **Crashes**: if the move path crosses a track barrier, the car bounces back to its previous position. A crash costs +1 to the score. Velocity resets to (0,0) on crash — the car must rebuild speed from zero.
- **Scoring**: `turns_taken + crash_count + finesse_fraction`. Lower is better. `finesse` is `(turns − par) / par` clamped [0,1), rewarding efficiency.
- **Win**: pass through the finish gate. Checkpoints (if any) must be touched in order first.
- Grid cell size is 24×24 world pixels.

### Turn Flow

1. Player is shown the 3×3 dot grid. Each dot is a candidate destination.
2. Dots that would result in a barrier hit are shown differently (dim/red) but are still selectable — the player may choose to crash intentionally.
3. Player taps/clicks a dot.
4. Car animates to new position (smooth tween, ~180ms).
5. If crash: show crash animation, car returns, velocity zeroed.
6. Check checkpoint/finish conditions.
7. Advance to next turn.

### Ghost Racing

- Up to 3 opponent ghosts race alongside the player simultaneously, one turn behind real-time.
- Ghosts are loaded from the server (`/api/race-ghosts/:trackId`) — a mix of top human runs and AI-generated ghosts.
- Ghost data: `{ v:1, trackId, score, startGX, startGY, moves:[{gx,gy,crash}], author? }` serialized as JSON.
- Each ghost has a distinct color slot (cyan-blue, amber, violet).
- Ghost trails: colored line segments + dots at waypoints. Trail fades and culls after 100+ segments (fade over 20 more, then remove oldest — bounded window of 120 segments max).
- Ghost cars animate independently each turn.

### Track Format

Tracks consist of **placed pieces** (straights and corners) plus **markers** (start position, finish gate, checkpoint gates/circles).

**Piece types:**
- `straight` — sizes: small (half), medium (full), large (double). Car travels through a rectangular corridor.
- `corner` — 90° arc, tight radius (~2 grid cells). Can flip (left/right turn). Walls on inside and/or outside.
- `big_corner` — 90° arc, large radius (~4 grid cells). Same flip/wall options.
- Each piece has a `walls` variant controlling which sides have barriers.

**Connectors**: each piece has an `entry` and `exit` connector (`{x, y, heading}`). Heading is degrees clockwise from north. Pieces chain by aligning their connectors.

**Markers:**
- `start`: position + heading, no collision geometry — just sets spawn point
- `finish`: gate shape, player must pass through
- `checkpoint`: gate or circle shape, must be touched in sequence

### Collision

The track barrier is a set of polylines in world space. A move from A to B is invalid if the line segment AB intersects any barrier polyline. Use line-segment intersection, not pixel collision. A small corridor of safe space runs through each piece — the player's path must stay in the corridor.

---

## Track Editor

A full in-app track editor. Pieces are placed from a palette. The track auto-chains: each new piece snaps to the exit connector of the previous one.

**Features:**
- Palette tabs: Straights, Corners, Big Corners, Finish/Checkpoints
- Piece selection, move (drag), rotate (drag handle), delete, copy/paste
- Snap-to-connector toggle
- Undo/redo (40 levels)
- Piece limit: 60 pieces max
- Marching-ants selection highlight (animated dashed outline on selected piece, Canvas 2D)
- Finish line and checkpoint placement snaps near the last placed piece's exit connector
- Test-run button: launches the game with the current track in "validation mode" — on completion, uploads the ghost under the saved track ID so it becomes the track maker's ghost for others to race against
- Save as draft → upload to community. Draft is synced to server; on publish, the maker's validation ghost is transferred from the draft ID to the community post ID before the draft is deleted.

**Mobile editor UX:**
- Top toolbar: icon-only buttons (snap, drafts, test, save) + a "?" help popup explaining all controls
- Palette at bottom with tabs
- Piece selected: shows control row with rotate, flip, delete, copy/paste, wall toggle
- Pinch-to-zoom + pan

---

## Ghost Recording & Upload

When a player completes a race (wins), their run is recorded as a ghost and uploaded (`POST /api/ghost`) if it beats their personal best score for that track. The server stores it in Redis as `ghost:{trackId}:{username}` and maintains a sorted leaderboard `lb:{trackId}` (by score, ascending).

The `/api/race-ghosts/:trackId` endpoint returns up to 3 ghosts: random selection from the top-25 human ghosts, with remaining slots filled from AI ghosts (`ai-ghost:{trackId}:{skill}` in Redis). Skills: `rookie`, `average`, `expert`.

AI ghosts are generated server-side using a pathfinding solver and uploaded once per track.

---

## Screens / Navigation

1. **Splash / Attract** (`splash.html`): Title screen. Shows an animated track thumbnail (Oval Small track with ghost trails playing). Animated "PLAY" button with glowing pulse. Buttons: Play, Community Tracks, Leaderboard, Create Your Own. If opened from a community track post, shows that track's thumbnail + "RACE THIS TRACK" button instead.

2. **Track Select** (`game.html`, Phaser scenes):
   - "My Tracks" tab: listed drafts with thumbnail. Each has Edit, Test, Upload buttons. Upload flow: sync to server → POST `/api/track` → transfer maker ghost → generate AI ghosts → delete draft → navigate to new post.
   - "Community" tab: paginated grid of community tracks with thumbnails + animated ghost trails on hover. Search by name or filter by author.
   - "Leaderboard" tab: overall points leaderboard.
   - "Standard" tab: built-in tracks.
   - "Daily" tab: curated daily challenges (mod-only promotion).
   - "Tutorial" tab: guided tutorial tracks.

3. **Game**: The racing scene. HUD shows turn counter, crash count, score. Top bar with pause. Minimap (DOM canvas, fixed position, drag-to-any-corner, minimize). Ghost trails. Move picker (3×3 dot grid). Win/lose overlay with ghost recording.

4. **Track Editor**: described above.

---

## Minimap

- DOM `<canvas>` element (not Phaser, immune to camera transform)
- Fixed position, draggable to any of 4 corners (`top-left`, `top-right`, `bottom-left`, `bottom-right`), or minimized
- Corner preference persisted in localStorage
- Auto-hides control strip after 3s idle; reappears on touch
- ⚙ button opens corner-picker popover; ▭ button minimizes; restore button in top bar
- Renders: static track barriers (pre-baked ImageData for perf), car dot, checkpoint dots (dim=untouched, bright=touched), ghost dots
- Pixel-accurate bounds via probe canvas scan (avoids over-padded conservative bounding box)

---

## "Juiciness" — Visual Polish Requirements

This is the most important addition over a naive implementation. Every interaction should feel tactile and satisfying:

**Car & Movement**
- Car sprite rotates to face velocity direction, with a brief anticipation lean (slight opposite rotation) before snapping to the new heading
- Smooth tween for car movement with an ease that feels weighted (ease-in, hard ease-out)
- Speed lines / motion blur effect at high velocities (|vx|+|vy| > 3)
- Subtle car wobble/bounce on landing at destination

**Crashes**
- Screen shake (brief, 150ms, diminishing) on crash
- Sparks particle burst at crash point (6–10 particles, fan-shaped, orange/white, short-lived)
- Car briefly flashes red/white
- "CRASH!" text popup that bounces in and fades

**Move Picker**
- Dots pulse/breathe while waiting for input
- The dot under the pointer grows slightly before tap
- Dots that would crash are shown with a warning glow (red), not just dimmed — a subtle pulsing danger indicator
- Trajectory preview line from current position to hovered dot, showing the path the car will take
- Ripple/confirmation animation when a move is committed

**Ghost Trails**
- Ghost trails fade in as they appear (alpha ramp over 3–5 segments)
- Ghost car has a faint glow matching its trail color
- Ghost names (author) float briefly above ghost car on each turn advance

**UI**
- Button press: scale down 5% on press, spring back on release
- Scene transitions: not instant cuts — crossfade or slide (250ms)
- Turn counter increments with a small bounce/pop animation
- Score breakdown on win screen animates in line by line
- Win screen: confetti or particle celebration for personal best
- All toasts/notifications slide in from edge, fade out smoothly
- Checkpoint touched: brief flash + satisfying ring pulse at checkpoint position
- Finish crossed: big flash, camera briefly zooms out, then win overlay slides in

**Track Editor**
- Piece placement: new piece "drops in" with a quick scale-from-zero animation
- Marching ants selection dashes animate at a satisfying speed
- Delete: piece shrinks and fades out
- Toolbar buttons have micro-animations on press

**Minimap**
- Drag handle has a subtle grab cursor and a shadow lift effect while dragging
- Snap-to-corner has a spring/bounce settle

**Ambient**
- Subtle parallax on the background grid (moves slightly opposite to camera pan)
- The splash screen grid scrolls in a slow drift

---

## Server API Summary

```
POST   /api/track                         — publish track (body: {name, data})
GET    /api/track/:id                     — fetch community track
GET    /api/tracks/community              — paginated community list
POST   /api/ghost                         — upload ghost {trackId, score, ghost}
GET    /api/ghost/:trackId/:username      — fetch specific ghost
GET    /api/race-ghosts/:trackId          — fetch up to 3 race ghosts
POST   /api/ai-ghost                      — store AI ghost {trackId, skill, ghost}
GET    /api/ai-ghost/:trackId/:skill      — fetch AI ghost
GET    /api/mine-tracks                   — list current user's saved tracks
GET    /api/mine-track/:id                — fetch draft data
POST   /api/mine-track                    — save/update draft
DELETE /api/mine-track/:id                — delete draft
PATCH  /api/mine-track/:id/verify         — mark track as solvable
GET    /api/leaderboard/overall           — point-based overall rankings
GET    /api/leaderboard/:trackId          — per-track leaderboard
GET    /api/race-ghosts/:trackId          — ghosts for a race session
GET    /api/daily-tracks                  — today's curated tracks
```

---

## Architecture Guidance

- Separate Phaser scenes: `Boot`, `Splash`, `TrackSelect`, `Game`, `TrackEditor`
- Keep DOM HUD elements (minimap, top bar, toast layer) in plain DOM, not Phaser GameObjects — they must be immune to camera zoom/scroll
- Pre-render the minimap track to `ImageData` once; stamp it every frame rather than redrawing
- Ghost playback is turn-driven, not time-driven — step each ghost forward one move per player turn
- All Redis keys follow the pattern `{type}:{trackId}:{qualifier}` for easy prefix scanning
- Track geometry (connector math, collision) belongs in pure functions with no Phaser dependency — it needs to run in server-side AI ghost generation too

---

## Notes for the Implementer

- The Devvit SDK wiring (`postData`, `username`, `requestExpandedMode`, etc.) requires the actual Devvit web client API docs — prepend those before implementing the platform integration layer.
- Audio is not specified here. Test Devvit WebView audio constraints before committing to a sound design.
- The juiciness list is a **first-class design requirement**, not optional polish. Budget for it from the start rather than bolting it on at the end.
