import { CORNER_RADII, HALF_TRACK, STRAIGHT_LEN } from './TrackGeometry';
import type { PlacedPiece, StraightDef, CornerDef } from './TrackLayout';

// How much velocity is kept after hitting a wall.
// normal component × RESTITUTION bounces back; tangential × FRICTION slides.
const RESTITUTION = 0.15;
const FRICTION    = 0.88;

// Two independently-placed pieces can end up a couple of px apart at a
// junction even when they render as one continuous wall (found via a real
// community track: a diagonal piece's wall ended 2.5px short of the vertical
// piece's wall it visually butts up against). intersectsBarrier tests each
// piece's wall as its own finite segment, so a move threading exactly through
// that sliver crossed neither one. WALL_JOIN_TOLERANCE extends each wall
// segment/arc very slightly past its authored endpoint to close that gap,
// regardless of how the two pieces happen to be walled (inner/outer/both) —
// it's a junction-precision fix, not a wall-configuration one.
const WALL_JOIN_TOLERANCE = 4; // px

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
  const { outerR, innerR } = CORNER_RADII[piece.type];
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
// Kept for external callers that check whether a world point is already in barrier material.
export function pointInsideBarrier(wx: number, wy: number, pieces: PlacedPiece[]): boolean {
  for (const piece of pieces) {
    const dx = wx - piece.x, dy = wy - piece.y;
    const maxR = piece.type === 'straight'
      ? Math.max(STRAIGHT_LEN[(piece as StraightDef).size] / 2, HALF_TRACK) + HALF_TRACK
      : CORNER_RADII[piece.type].outerR + 20;
    if (dx * dx + dy * dy > maxR * maxR) continue;

    const [lx, ly] = toLocal(wx, wy, piece);

    if (piece.type === 'straight') {
      const half = STRAIGHT_LEN[(piece as StraightDef).size] / 2;
      if (Math.abs(ly) > half) continue;
      if (lx < -HALF_TRACK || lx > HALF_TRACK) return true;
    } else {
      const { outerR, innerR } = CORNER_RADII[piece.type];
      const theta = (piece as CornerDef).angle * (Math.PI / 180);
      const cx = (piece as CornerDef).flip ? -lx : lx;
      const cy = ly;
      const angle = Math.atan2(-cy, -cx);
      if (angle < 0 || angle > theta) continue;
      const dist = Math.sqrt(cx * cx + cy * cy);
      if (dist < 0.001) continue;
      if (dist < innerR || dist > outerR) return true;
    }
  }
  return false;
}

// Returns true if the line segment from (lx1,ly1)→(lx2,ly2) in local straight-piece
// space crosses the lateral wall at lx=wallLx, within |ly| ≤ halfLen.
function crossesStraightWall(
  lx1: number, ly1: number, lx2: number, ly2: number,
  wallLx: number, halfLen: number,
): boolean {
  const dLx = lx2 - lx1;
  if (Math.abs(dLx) < 1e-8) return false; // segment parallel to wall
  const t = (wallLx - lx1) / dLx;
  if (t <= 0 || t >= 1) return false;      // crossing outside segment interior
  return Math.abs(ly1 + (ly2 - ly1) * t) <= halfLen + WALL_JOIN_TOLERANCE;
}

// Returns true if the line segment from (lx1,ly1)→(lx2,ly2) in local corner-piece
// space crosses the arc of radius R within angular range [0, theta].
// flip mirrors the x-axis so left-turn corners use the same angle convention.
function crossesArc(
  lx1: number, ly1: number, lx2: number, ly2: number,
  flip: boolean, R: number, theta: number,
): boolean {
  const sx = flip ? -1 : 1;
  const ax = sx * lx1, ay = ly1;
  const bx = sx * lx2, by = ly2;
  const dx = bx - ax, dy = by - ay;
  const a = dx * dx + dy * dy;
  if (a < 1e-8) return false;
  const b = 2 * (ax * dx + ay * dy);
  const c = ax * ax + ay * ay - R * R;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return false;
  const sq = Math.sqrt(disc);
  // Convert the pixel join-tolerance to an angular one at this arc's radius
  // (arc length ≈ R × angle), so the tolerance behaves consistently in world
  // distance regardless of whether R is a tight, big, or huge corner.
  const angleTolerance = WALL_JOIN_TOLERANCE / R;
  for (const sign of [-1, 1] as const) {
    const t = (-b + sign * sq) / (2 * a);
    if (t <= 0 || t >= 1) continue;  // crossing outside segment interior
    const ix = ax + dx * t, iy = ay + dy * t;
    const angle = Math.atan2(-iy, -ix);
    if (angle >= -angleTolerance && angle <= theta + angleTolerance) return true;
  }
  return false;
}

/**
 * Returns true if the straight line from (fromWX,fromWY) to (toWX,toWY)
 * crosses any wall arc or line of any track piece.
 *
 * Wall-crossing only — no "corridor" or "barrier zone" concept.
 * A move from a valid position never crashes unless the path actually crosses
 * a wall, regardless of what any adjacent piece's geometry might claim.
 */
export function intersectsBarrier(
  fromWX: number, fromWY: number,
  toWX:   number, toWY:   number,
  pieces: PlacedPiece[],
): boolean {
  const sdx = toWX - fromWX, sdy = toWY - fromWY;
  if (sdx === 0 && sdy === 0) return false; // zero-length move never crosses a wall

  const midX = (fromWX + toWX) / 2, midY = (fromWY + toWY) / 2;
  const halfLen = Math.sqrt(sdx * sdx + sdy * sdy) / 2;

  for (const piece of pieces) {
    // Broad phase: skip pieces whose closest point is definitely too far.
    const pdx = midX - piece.x, pdy = midY - piece.y;
    const maxR = piece.type === 'straight'
      ? Math.max(STRAIGHT_LEN[(piece as StraightDef).size] / 2, HALF_TRACK) + HALF_TRACK
      : CORNER_RADII[piece.type].outerR;
    if (pdx * pdx + pdy * pdy > (maxR + halfLen) * (maxR + halfLen)) continue;

    const [lx1, ly1] = toLocal(fromWX, fromWY, piece);
    const [lx2, ly2] = toLocal(toWX,   toWY,   piece);

    if (piece.type === 'straight') {
      const half  = STRAIGHT_LEN[(piece as StraightDef).size] / 2;
      const walls = (piece as StraightDef).walls;
      if (walls !== 'inner' && crossesStraightWall(lx1, ly1, lx2, ly2, -HALF_TRACK, half)) return true;
      if (walls !== 'outer' && crossesStraightWall(lx1, ly1, lx2, ly2,  HALF_TRACK, half)) return true;
    } else {
      const { outerR, innerR } = CORNER_RADII[piece.type];
      const theta = (piece as CornerDef).angle * (Math.PI / 180);
      const flip  = (piece as CornerDef).flip ?? false;
      const walls = (piece as CornerDef).walls;
      if (walls !== 'inner' && crossesArc(lx1, ly1, lx2, ly2, flip, outerR, theta)) return true;
      if (walls !== 'outer' && crossesArc(lx1, ly1, lx2, ly2, flip, innerR, theta)) return true;
    }
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
      : CORNER_RADII[piece.type].outerR + 20;
    if (dx * dx + dy * dy > maxR * maxR) continue;

    const [lx, ly] = toLocal(wx, wy, piece);

    if (piece.type === 'straight') {
      const half = STRAIGHT_LEN[(piece as StraightDef).size] / 2;
      // Small epsilon on length so junction grid points aren't left unclaimed.
      if (Math.abs(lx) <= HALF_TRACK && Math.abs(ly) <= half + 2) return true;
    } else {
      const { outerR, innerR } = CORNER_RADII[piece.type];
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
      : CORNER_RADII[piece.type].outerR + 20;
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
