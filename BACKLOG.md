# Backlog

Ideas and future enhancements that aren't urgent. No particular priority order.

---

## Track Editor

### Scalable straight pieces
Add an optional `scale` multiplier to `StraightDef` so a straight can be 2×, 3×, etc. its base length without adding new size variants.

- Add `scale?: number` (default 1) to `StraightDef` in `TrackLayout.ts` — backward-compatible, old tracks load fine
- Add `straightLen(p: StraightDef)` helper to `TrackGeometry.ts` returning `STRAIGHT_LEN[p.size] * (p.scale ?? 1)`
- Replace every `STRAIGHT_LEN[piece.size]` reference with the helper across `TrackLayout.ts`, `TrackBarrierCanvas.ts`, `TrackCollision.ts`, `PieceTextureFactory.ts` (~10 call sites)
- UI: `−` / `+` buttons in the ctrl row when a straight piece is selected, step 0.5, min 0.5, max ~6

---

## Thumbnails

### Use actual game sprites in track thumbnails
Currently finish and checkpoint markers are rendered as plain colored dots. Replace with scaled versions of the real sprites.

- Finish: `tile_finish_0.png`
- Checkpoint gate: `tile_checkpoint_0.png`
- Checkpoint circle: `tile_checkpoint_circle_0.png`
- Start position: keep as a neutral `#00eeff` dot — do not use a car graphic, car customization is planned
- Files to update: `drawMarkersOnCanvas` in `TrackBarrierCanvas.ts` and the thumbnail drawing in `TrackSelect.ts`
- Sprites must be loaded as plain `Image` elements (not Phaser textures) since thumbnails draw on Canvas 2D outside Phaser

---

## Tutorial

### Purpose-built tutorial tracks
Tutorial lessons currently reuse `oval_small`, `short_track`, and `canada` from the standard track registry. These are too complex — each lesson should have a track shaped around the concept being taught.

Suggested layouts:
- **Tutorial 1 (Basics)** — Dead-simple straight to finish. No corners. 3–4 turns to demonstrate the 9-dot grid and velocity arrow.
- **Tutorial 2 (Cornering)** — One long straight followed by a single 90° corner and a short run to finish. Forces the player to brake before the corner.
- **Tutorial 3 (Checkpoints + Planning)** — Compact S-shape with 1–2 checkpoints at the apexes. Short enough to finish in ~10 turns.

Coach message turn numbers will need updating once new tracks are in place. File: `src/client/tracks/tutorialTracks.ts`
