import * as Phaser from 'phaser';
import { TIGHT, BIG, HALF_TRACK, STRAIGHT_LEN } from './TrackGeometry';
import { PlacedPiece, StraightDef, CornerDef, trackBounds } from './TrackLayout';
import type { TrackSkin } from './TrackSkin';

// Extra canvas margin so the glow doesn't clip at the texture edge.
const PAD = 28;

// ── Path accumulation ─────────────────────────────────────────────────────────

// Appends one piece's wall paths to the CURRENT canvas path (no beginPath / stroke).
// ctx must have the world→canvas offset already applied via ctx.translate().
function addPiecePaths(ctx: CanvasRenderingContext2D, p: PlacedPiece): void {
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(p.rotation * (Math.PI / 180));

  if (p.type === 'straight') {
    const half = STRAIGHT_LEN[(p as StraightDef).size] / 2;
    if (p.walls === 'both' || p.walls === 'outer') {
      ctx.moveTo(-HALF_TRACK, -half);
      ctx.lineTo(-HALF_TRACK,  half);
    }
    if (p.walls === 'both' || p.walls === 'inner') {
      ctx.moveTo(HALF_TRACK, -half);
      ctx.lineTo(HALF_TRACK,  half);
    }
  } else {
    const { outerR, innerR } = p.type === 'corner' ? TIGHT : BIG;
    const theta = (p as CornerDef).angle * (Math.PI / 180);
    if ((p as CornerDef).flip) ctx.scale(-1, 1);
    if (p.walls === 'both' || p.walls === 'outer') {
      ctx.moveTo(-outerR, 0);
      ctx.arc(0, 0, outerR, Math.PI, Math.PI + theta, false);
    }
    if (p.walls === 'both' || p.walls === 'inner') {
      ctx.moveTo(-innerR, 0);
      ctx.arc(0, 0, innerR, Math.PI, Math.PI + theta, false);
    }
  }

  ctx.restore();
}

// One stroke pass over ALL pieces simultaneously — a single beginPath/stroke
// so junctions are interior path points with no double-glow artifact.
function strokePass(
  ctx: CanvasRenderingContext2D,
  pieces: PlacedPiece[],
  lineWidth: number,
  color: string,
  blur: number,
): void {
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur  = blur;
  ctx.strokeStyle = color;
  ctx.lineWidth   = lineWidth;
  ctx.lineCap     = 'round';
  ctx.beginPath();
  for (const p of pieces) addPiecePaths(ctx, p);
  ctx.stroke();
  ctx.restore();
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Draw all barrier walls onto an existing 2D canvas context at an arbitrary scale.
 * scaleX/scaleY map world pixels to canvas pixels; offX/offY shift the origin.
 * lineWidthPx is the desired stroke width in canvas pixels.
 */
export function drawBarriersOnCanvas(
  ctx: CanvasRenderingContext2D,
  pieces: PlacedPiece[],
  worldL: number,
  worldT: number,
  scaleX: number,
  scaleY: number,
  offX = 0,
  offY = 0,
  color = '#33bb55',
  lineWidthPx = 1.5,
): void {
  ctx.save();
  ctx.translate(offX - worldL * scaleX, offY - worldT * scaleY);
  ctx.scale(scaleX, scaleY);
  ctx.strokeStyle = color;
  ctx.lineWidth   = lineWidthPx / Math.min(scaleX, scaleY);
  ctx.lineCap     = 'round';
  ctx.beginPath();
  for (const p of pieces) addPiecePaths(ctx, p);
  ctx.stroke();
  ctx.restore();
}

/**
 * Render the entire track onto a single canvas texture and add it to the scene.
 *
 * Drawing all walls in one pass per neon layer means every piece junction is
 * an interior point on a continuous path — no overlapping textures, no double
 * glow, no seams.
 */
export function buildTrackTexture(
  scene: Phaser.Scene,
  pieces: PlacedPiece[],
  skin: TrackSkin,
  key = 'track_combined',
): Phaser.GameObjects.Image {
  const b = trackBounds(pieces);
  const w = Math.ceil(b.width  + PAD * 2);
  const h = Math.ceil(b.height + PAD * 2);

  if (scene.textures.exists(key)) scene.textures.remove(key);
  const ct = scene.textures.createCanvas(key, w, h)!;
  const ctx = ct.getContext();

  // Shift all drawing so world (b.x, b.y) maps to canvas (PAD, PAD).
  ctx.translate(PAD - b.x, PAD - b.y);

  // Three neon passes — same as strokeNeon, but across ALL pieces at once.
  strokePass(ctx, pieces, skin.wallWidth * 4, skin.glowColor, skin.glowBlur);
  strokePass(ctx, pieces, skin.wallWidth,     skin.wallColor, skin.glowBlur * 0.5);
  strokePass(ctx, pieces, Math.max(1, skin.wallWidth - 1), 'rgba(255,255,255,0.70)', 0);

  ct.refresh();

  // Place the canvas top-left at its world position; origin (0, 0).
  return scene.add.image(b.x - PAD, b.y - PAD, key).setOrigin(0, 0);
}
