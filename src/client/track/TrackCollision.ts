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
 * Returns true if (wx, wy) penetrates a wall on any piece.
 * Uses exact piece bounds (no junction-overlap tolerance) so points in open
 * space just past a piece end are never falsely flagged.
 */
export function pointInsideBarrier(wx: number, wy: number, pieces: PlacedPiece[]): boolean {
  for (const piece of pieces) {
    const dx = wx - piece.x, dy = wy - piece.y;
    const maxR = piece.type === 'straight'
      ? Math.max(STRAIGHT_LEN[(piece as StraightDef).size] / 2, HALF_TRACK) + HALF_TRACK
      : (piece.type === 'corner' ? TIGHT : BIG).outerR + 20;
    if (dx * dx + dy * dy > maxR * maxR) continue;

    const [lx, ly] = toLocal(wx, wy, piece);

    if (piece.type === 'straight') {
      // Exact longitudinal extent — no extra HALF_TRACK tolerance used by physics.
      const half = STRAIGHT_LEN[(piece as StraightDef).size] / 2;
      if (Math.abs(ly) > half) continue;
      if (lx < -HALF_TRACK || lx > HALF_TRACK) return true;
    } else {
      const { outerR, innerR } = piece.type === 'corner' ? TIGHT : BIG;
      const theta = (piece as CornerDef).angle * (Math.PI / 180);
      const cx = (piece as CornerDef).flip ? -lx : lx;
      const cy = ly;
      // Exact angular range — no ±0.05 radian tolerance used by physics.
      const angle = Math.atan2(-cy, -cx);
      if (angle < 0 || angle > theta) continue;
      const dist = Math.sqrt(cx * cx + cy * cy);
      if (dist < 0.001) continue;
      if (dist < innerR || dist > outerR) return true;
    }
  }
  return false;
}

/**
 * Returns true if the straight line from (fromWX,fromWY) to (toWX,toWY)
 * passes through any barrier wall.  Samples every ~6 px along the segment.
 * A move that stays in open space never triggers this.
 */
export function intersectsBarrier(
  fromWX: number, fromWY: number,
  toWX:   number, toWY:   number,
  pieces: PlacedPiece[],
): boolean {
  const dx = toWX - fromWX, dy = toWY - fromWY;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0) return pointInsideBarrier(fromWX, fromWY, pieces);
  const steps = Math.max(1, Math.ceil(len / 6));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    if (pointInsideBarrier(fromWX + dx * t, fromWY + dy * t, pieces)) return true;
  }
  return false;
}

/**
 * Returns true if (wx, wy) in world pixels is on any track piece's driveable surface.
 * Used for rendering (minimap, thumbnails, dot grid) — not for move validation.
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
