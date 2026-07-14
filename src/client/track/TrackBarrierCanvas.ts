import { CORNER_RADII, HALF_TRACK, STRAIGHT_LEN } from './TrackGeometry';
import type { PlacedPiece, StraightDef, CornerDef } from './TrackLayout';
import type { TrackMarker } from './convertGmsTrack';

// Thumbnails render on plain Canvas 2D (splash screen, track lists) — outside
// Phaser — so marker sprites are loaded as plain <img> elements, eagerly, and
// used once they finish loading. Until then (or if a network error keeps one
// from ever loading), drawMarkersOnCanvas falls back to a plain dot.
const MARKER_SPRITE_COUNT = 3;
let markerSpritesSettled = 0;
const markerSpritesReadyCbs: Array<() => void> = [];

function loadMarkerSprite(key: string): HTMLImageElement {
  const img = new Image();
  const onSettle = () => {
    markerSpritesSettled++;
    if (markerSpritesSettled >= MARKER_SPRITE_COUNT) {
      const cbs = markerSpritesReadyCbs.splice(0);
      for (const cb of cbs) cb();
    }
  };
  img.onload = onSettle;
  img.onerror = onSettle;
  img.src = `assets/markers/${key}.png`;
  return img;
}
const FINISH_IMG          = loadMarkerSprite('tile_finish_0');
const CHECKPOINT_GATE_IMG = loadMarkerSprite('tile_checkpoint_0');
const CHECKPOINT_CIRC_IMG = loadMarkerSprite('tile_checkpoint_circle_0');

// Registers a one-shot callback for once every marker sprite has finished
// loading (or failed) — lets a one-time thumbnail draw upgrade from its
// dot fallback to the real sprites shortly after, without needing its own
// redraw loop.
export function onMarkerSpritesReady(cb: () => void): void {
  if (markerSpritesSettled >= MARKER_SPRITE_COUNT) cb();
  else markerSpritesReadyCbs.push(cb);
}

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
    const { outerR, innerR } = CORNER_RADII[p.type];
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
  _startHeading: number,
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

  // Scaled, rotated copy of the real in-game marker sprite. Returns false
  // (drawing nothing) if the image hasn't finished loading yet, so the
  // caller can fall back to a dot for that frame.
  const sprite = (img: HTMLImageElement, wx: number, wy: number, rotation: number, sizePx: number): boolean => {
    if (!img.complete || img.naturalWidth === 0) return false;
    const [cx, cy] = toC(wx, wy);
    const w = sizePx, h = sizePx * (img.naturalHeight / img.naturalWidth);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rotation * Math.PI / 180);
    ctx.drawImage(img, -w / 2, -h / 2, w, h);
    ctx.restore();
    return true;
  };

  for (const m of markers) {
    if (m.kind === 'checkpoint') {
      const img = m.shape === 'circle' ? CHECKPOINT_CIRC_IMG : CHECKPOINT_GATE_IMG;
      if (!sprite(img, m.x, m.y, m.rotation, 10)) dot(m.x, m.y, 2.5, '#ffdd00');
    }
  }
  const finish = markers.find(m => m.kind === 'finish');
  if (finish && !sprite(FINISH_IMG, finish.x, finish.y, finish.rotation, 14)) {
    dot(finish.x, finish.y, 3.5, '#ff3333', '#ffffff');
  }
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
