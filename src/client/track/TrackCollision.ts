import { TIGHT, BIG, HALF_TRACK, STRAIGHT_LEN } from './TrackGeometry';
import type { PlacedPiece, StraightDef, CornerDef } from './TrackLayout';

// How much velocity is kept after hitting a wall.
// normal component × RESTITUTION bounces back; tangential × FRICTION slides.
const RESTITUTION = 0.15;
const FRICTION    = 0.88;

type Hit = { nx: number; ny: number; depth: number };

// ── Coordinate helpers ────────────────────────────────────────────────────────

function toLocal(wx: number, wy: number, piece: PlacedPiece): [number, number] {
  const dx = wx - piece.x, dy = wy - piece.y;
  const r  = -piece.rotation * (Math.PI / 180);
  const c = Math.cos(r), s = Math.sin(r);
  return [dx * c - dy * s, dx * s + dy * c];
}

function toWorldVec(lx: number, ly: number, piece: PlacedPiece): [number, number] {
  const r = piece.rotation * (Math.PI / 180);
  const c = Math.cos(r), s = Math.sin(r);
  return [lx * c - ly * s, lx * s + ly * c];
}

// ── Per-piece wall checks ─────────────────────────────────────────────────────

function checkStraight(lx: number, ly: number, piece: StraightDef): Hit | null {
  const half = STRAIGHT_LEN[piece.size] / 2;
  // Only act while inside (or just past) the piece's longitudinal extent.
  if (Math.abs(ly) > half + HALF_TRACK) return null;

  if (lx < -HALF_TRACK) return { nx:  1, ny: 0, depth: -HALF_TRACK - lx };
  if (lx >  HALF_TRACK) return { nx: -1, ny: 0, depth:  lx - HALF_TRACK };
  return null;
}

function checkCorner(lx: number, ly: number, piece: CornerDef): Hit | null {
  const { outerR, innerR } = piece.type === 'corner' ? TIGHT : BIG;
  const theta = piece.angle * (Math.PI / 180);

  // Mirror x for left-turn (flip) corners so the maths are symmetric.
  const cx = piece.flip ? -lx : lx;
  const cy = ly;

  // Arc sweeps from angle 0 (left, −x axis) to theta (CW on screen).
  // atan2(−cy, −cx) maps that region to [0, theta].
  const angle = Math.atan2(-cy, -cx);
  if (angle < -0.05 || angle > theta + 0.05) return null;

  const dist = Math.sqrt(cx * cx + cy * cy);
  if (dist < 0.001) return null;

  // Radial unit vector in (possibly flipped) local space.
  const rx = cx / dist, ry = cy / dist;
  // Unflip x before returning the normal so it's in true local space.
  const fx = piece.flip ? -1 : 1;

  if (dist < innerR) return { nx:  fx * rx,   ny:  ry,  depth: innerR - dist };
  if (dist > outerR) return { nx: -fx * rx,   ny: -ry,  depth: dist - outerR };
  return null;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns true if (wx, wy) in world pixels is on any track piece's driveable surface.
 * Used for turn-based move validation.
 */
export function isOnSurface(wx: number, wy: number, pieces: PlacedPiece[]): boolean {
  for (const piece of pieces) {
    const dx = wx - piece.x, dy = wy - piece.y;
    const maxR = piece.type === 'straight'
      ? Math.max(STRAIGHT_LEN[(piece as StraightDef).size] / 2, HALF_TRACK) + HALF_TRACK
      : (piece.type === 'corner' ? TIGHT : BIG).outerR + 20;
    if (dx * dx + dy * dy > maxR * maxR) continue;

    const [lx, ly] = toLocal(wx, wy, piece);

    if (piece.type === 'straight') {
      const half = STRAIGHT_LEN[(piece as StraightDef).size] / 2;
      // Small epsilon on length so junction grid points aren't left unclaimed.
      if (Math.abs(lx) <= HALF_TRACK && Math.abs(ly) <= half + 2) return true;
    } else {
      const { outerR, innerR } = piece.type === 'corner' ? TIGHT : BIG;
      const theta = (piece as CornerDef).angle * (Math.PI / 180);
      const cx = (piece as CornerDef).flip ? -lx : lx;
      const cy = ly;
      const angle = Math.atan2(-cy, -cx);
      if (angle < -0.05 || angle > theta + 0.05) continue;
      const dist = Math.sqrt(cx * cx + cy * cy);
      if (dist >= innerR && dist <= outerR) return true;
    }
  }
  return false;
}

/**
 * For each track piece, check whether (cx, cy) penetrates a wall.
 * If so, push the position out and reflect/scrub velocity.
 * Returns corrected [x, y, vx, vy].
 */
export function applyWallCollisions(
  cx: number, cy: number,
  vx: number, vy: number,
  pieces: PlacedPiece[],
): [number, number, number, number] {
  let x = cx, y = cy, wx = vx, wy = vy;

  for (const piece of pieces) {
    // Broad-phase: skip pieces that are clearly too far away.
    const dx = x - piece.x, dy = y - piece.y;
    const maxR = piece.type === 'straight'
      ? Math.max(STRAIGHT_LEN[(piece as StraightDef).size] / 2, HALF_TRACK) + HALF_TRACK
      : (piece.type === 'corner' ? TIGHT : BIG).outerR + 20;
    if (dx * dx + dy * dy > maxR * maxR) continue;

    const [lx, ly] = toLocal(x, y, piece);
    const hit = piece.type === 'straight'
      ? checkStraight(lx, ly, piece as StraightDef)
      : checkCorner  (lx, ly, piece as CornerDef);
    if (!hit) continue;

    // Transform hit normal to world space.
    const [wnx, wny] = toWorldVec(hit.nx, hit.ny, piece);

    // Push position out of wall.
    x += wnx * hit.depth;
    y += wny * hit.depth;

    // Reflect velocity only when moving INTO the wall.
    const vDotN = wx * wnx + wy * wny;
    if (vDotN >= 0) continue;

    // Decompose into normal + tangential, apply restitution + friction.
    const tx = -wny, ty = wnx; // tangent (perp to normal)
    const vDotT = wx * tx + wy * ty;

    wx = (-RESTITUTION * vDotN) * wnx + (FRICTION * vDotT) * tx;
    wy = (-RESTITUTION * vDotN) * wny + (FRICTION * vDotT) * ty;
  }

  return [x, y, wx, wy];
}
