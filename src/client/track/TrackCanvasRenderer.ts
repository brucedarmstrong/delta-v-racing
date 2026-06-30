import * as Phaser from 'phaser';
import { PlacedPiece, trackBounds } from './TrackLayout';
import type { TrackSkin } from './TrackSkin';
import { addPiecePaths } from './TrackBarrierCanvas';
export { drawBarriersOnCanvas } from './TrackBarrierCanvas';

// Extra canvas margin so the glow doesn't clip at the texture edge.
const PAD = 28;

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
