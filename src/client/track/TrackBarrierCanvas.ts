import { TIGHT, BIG, HALF_TRACK, STRAIGHT_LEN } from './TrackGeometry';
import type { PlacedPiece, StraightDef, CornerDef } from './TrackLayout';
import type { TrackMarker } from './convertGmsTrack';

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

export function drawMarkersOnCanvas(
  ctx: CanvasRenderingContext2D,
  startX: number,
  startY: number,
  startHeading: number,
  markers: TrackMarker[],
  worldL: number,
  worldT: number,
  scaleX: number,
  scaleY: number,
  offX = 0,
  offY = 0,
): void {
  const toC = (wx: number, wy: number): [number, number] => [
    offX + (wx - worldL) * scaleX,
    offY + (wy - worldT) * scaleY,
  ];

  const dot = (wx: number, wy: number, r: number, fill: string, stroke?: string) => {
    const [cx, cy] = toC(wx, wy);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 0.75;
      ctx.stroke();
    }
  };

  for (const m of markers) {
    if (m.kind === 'checkpoint') dot(m.x, m.y, 2.5, '#ffdd00');
  }
  const finish = markers.find(m => m.kind === 'finish');
  if (finish) dot(finish.x, finish.y, 3.5, '#ff3333', '#ffffff');
  dot(startX, startY, 3, '#00eeff', '#ffffff');
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
