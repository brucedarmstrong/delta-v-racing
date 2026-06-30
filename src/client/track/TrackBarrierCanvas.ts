import { TIGHT, BIG, HALF_TRACK, STRAIGHT_LEN } from './TrackGeometry';
import type { PlacedPiece, StraightDef, CornerDef } from './TrackLayout';

export function addPiecePaths(ctx: CanvasRenderingContext2D, p: PlacedPiece): void {
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
