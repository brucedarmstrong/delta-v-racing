import {
  TIGHT, BIG, STRAIGHT_LEN, HALF_TRACK,
  CornerAngle, StraightSize, WallVariant,
} from './TrackGeometry';

// ── Types ─────────────────────────────────────────────────────────────────────

export type StraightDef = {
  type: 'straight';
  size: StraightSize;
  walls: WallVariant;
  reversed?: boolean; // true = entry/exit connectors swapped (see connectors())
};

export type CornerDef = {
  type: 'corner' | 'big_corner';
  angle: CornerAngle;
  walls: WallVariant;
  flip?: boolean; // true = left (CCW) turn
  reversed?: boolean; // true = entry/exit connectors swapped (see connectors())
};

export type PieceDef    = StraightDef | CornerDef;
// groupId is editor-only metadata (see TrackEditor.ts grouping) — it travels
// with the piece through save/load but has no effect on gameplay/collision.
export type PlacedPiece = PieceDef & { x: number; y: number; rotation: number; groupId?: string };

export type TrackDef = {
  startX: number;
  startY: number;
  startHeading: number; // degrees: 0 = north, 90 = east, clockwise
  pieces: PieceDef[];
};

// ── Rotation helper ───────────────────────────────────────────────────────────

// Visual CW rotation in Y-down screen coords (= math CCW matrix).
function rotateCW(x: number, y: number, deg: number): [number, number] {
  const r = deg * (Math.PI / 180);
  const c = Math.cos(r), s = Math.sin(r);
  return [x * c - y * s, x * s + y * c];
}

// ── Connector geometry ────────────────────────────────────────────────────────

// Returns the entry and exit connectors in local (unrotated) piece space.
// Heading convention: 0 = north, 90 = east, clockwise (same as TrackDef).
//
// Straight (default: vertical, car travels south):
//   entry at top-centre heading south, exit at bottom-centre heading south.
//
// Corner right turn (flip=false, default: car enters at (-clR,0) heading north):
//   arc sweeps CW from angle π (left) by θ, exit heading turns right by θ.
//
// Corner left turn (flip=true): mirror about Y axis at arc centre.
//
// reversed=true swaps entry<->exit (heading +180 each) with no change to the
// piece's physical shape — walls/barriers don't depend on connectors(), so a
// reversed piece looks identical, it just offers its other end for chaining.
export function connectors(piece: PieceDef) {
  let c: { entryX: number; entryY: number; entryH: number; exitX: number; exitY: number; exitH: number };

  if (piece.type === 'straight') {
    const half = STRAIGHT_LEN[piece.size] / 2;
    c = { entryX: 0, entryY: -half, entryH: 180, exitX: 0, exitY: half, exitH: 180 };
  } else {
    const flip = (piece as CornerDef).flip ?? false;
    const θd   = (piece as CornerDef).angle;          // degrees
    const θr   = θd * (Math.PI / 180);
    const clR  = piece.type === 'corner' ? TIGHT.clR : BIG.clR;
    const sign = flip ? 1 : -1;                        // mirrors entry/exit about Y axis

    c = {
      entryX: sign * clR,
      entryY: 0,
      entryH: 0,                                        // car heading north at entry
      exitX:  sign * clR * Math.cos(θr),
      exitY:  -clR * Math.sin(θr),
      exitH:  flip ? (360 - θd) : θd,                  // left turn subtracts, right adds
    };
  }

  if (!(piece as StraightDef | CornerDef).reversed) return c;
  return {
    entryX: c.exitX,  entryY: c.exitY,  entryH: (c.exitH  + 180) % 360,
    exitX:  c.entryX, exitY:  c.entryY, exitH:  (c.entryH + 180) % 360,
  };
}

// ── Track builder ─────────────────────────────────────────────────────────────

// Compute world transforms for every piece in the track by chaining entry/exit
// connectors.  The cursor tracks the current position and heading; each piece
// rotates its entry connector to align with the cursor, then advances the cursor
// to the piece's exit connector.
// Bounding box of a placed track — conservative (uses outerR/len as radius in all
// directions) but accurate enough for camera fitting.
export function trackBounds(pieces: PlacedPiece[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pieces) {
    const r = p.type === 'straight'
      ? Math.max(STRAIGHT_LEN[(p as StraightDef).size] / 2, HALF_TRACK)
      : (p.type === 'corner' ? TIGHT : BIG).outerR;
    minX = Math.min(minX, p.x - r);
    minY = Math.min(minY, p.y - r);
    maxX = Math.max(maxX, p.x + r);
    maxY = Math.max(maxY, p.y + r);
  }
  return {
    x: minX, y: minY,
    width: maxX - minX, height: maxY - minY,
    cx: (minX + maxX) / 2, cy: (minY + maxY) / 2,
  };
}

export function buildTrackWithCursor(def: TrackDef): {
  placed: PlacedPiece[];
  cursor: { x: number; y: number; heading: number };
} {
  const placed: PlacedPiece[] = [];
  let cx = def.startX, cy = def.startY, ch = def.startHeading;

  for (const piece of def.pieces) {
    const { entryX, entryY, entryH, exitX, exitY, exitH } = connectors(piece);
    const rot = ((ch - entryH) % 360 + 360) % 360;
    const [rex, rey] = rotateCW(entryX, entryY, rot);
    const ox = cx - rex, oy = cy - rey;
    placed.push({ ...piece, x: ox, y: oy, rotation: rot });
    const [rxx, rxy] = rotateCW(exitX, exitY, rot);
    cx = ox + rxx;
    cy = oy + rxy;
    ch = ((exitH + rot) % 360 + 360) % 360;
  }

  return { placed, cursor: { x: cx, y: cy, heading: ch } };
}

export function buildTrack(def: TrackDef): PlacedPiece[] {
  const placed: PlacedPiece[] = [];
  let cx = def.startX, cy = def.startY, ch = def.startHeading;

  for (const piece of def.pieces) {
    const { entryX, entryY, entryH, exitX, exitY, exitH } = connectors(piece);

    // Rotation needed so this piece's entry heading aligns with the cursor heading.
    const rot = ((ch - entryH) % 360 + 360) % 360;

    // Piece origin (arc centre / piece centre) in world space.
    const [rex, rey] = rotateCW(entryX, entryY, rot);
    const ox = cx - rex, oy = cy - rey;

    placed.push({ ...piece, x: ox, y: oy, rotation: rot });

    // Advance cursor to exit connector.
    const [rxx, rxy] = rotateCW(exitX, exitY, rot);
    cx = ox + rxx;
    cy = oy + rxy;
    ch = ((exitH + rot) % 360 + 360) % 360;
  }

  return placed;
}
