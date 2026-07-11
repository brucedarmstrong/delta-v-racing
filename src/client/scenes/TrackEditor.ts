import { Scene, GameObjects } from 'phaser';
import { buildTrackTexture } from '../track/TrackCanvasRenderer';
import { addPiecePaths } from '../track/TrackBarrierCanvas';
import { NEON_GREEN } from '../track/TrackSkin';
import {
  trackBounds, connectors,
  type PieceDef, type PlacedPiece, type CornerDef, type StraightDef,
} from '../track/TrackLayout';
import {
  HALF_TRACK, TIGHT, CORNER_RADII, CORNER_FAMILIES, STRAIGHT_LEN,
  CORNER_ANGLES, STRAIGHT_SIZES,
  type CornerAngle, type CornerFamily, type WallVariant, type StraightSize,
} from '../track/TrackGeometry';
import type { TrackMarker } from '../track/convertGmsTrack';
import type { TrackEntry } from '../tracks/trackRegistry';
import { saveDraft, fetchMineTrack } from '../track/TrackUpload';
import { getEditorSettings, setEditorSettings, type EditorSettings } from '../track/EditorSettings';
import { PhaserStarField } from '../starfield';
import type { TrackPayload } from '../track/TrackUpload';

// ── Types ─────────────────────────────────────────────────────────────────────

type PalTab = 'straight' | 'corner' | 'finish' | 'checkpoint';

// A multi-selection: pieces (by index), the finish line (at most one), and
// checkpoints (by index). Car start is never part of a multi-selection.
type MultiSel = { pieces: number[]; finish: boolean; checkpoints: number[] };

type Selection =
  | { kind: 'piece'; idx: number }
  | ({ kind: 'multi' } & MultiSel)
  | { kind: 'car' }
  | { kind: 'finish' }
  | { kind: 'checkpoint'; idx: number }
  | null;

type SelItem =
  | { type: 'piece'; idx: number }
  | { type: 'finish' }
  | { type: 'checkpoint'; idx: number };

type DragOp =
  | { kind: 'pan'; sx: number; sy: number; scrollX: number; scrollY: number; tapDeselect?: boolean }
  | { kind: 'move'; idx: number; offX: number; offY: number }
  | {
      kind: 'move-multi';
      pieces: number[]; finish: boolean; checkpoints: number[];
      startWX: number; startWY: number;
      pieceOrigins: { x: number; y: number }[];
      finishOrigin: { x: number; y: number } | null;
      checkpointOrigins: { x: number; y: number }[];
    }
  | { kind: 'marquee';          startWX: number; startWY: number; startSX: number; startSY: number }
  | { kind: 'rotate';           idx: number; handleLocalAngle: number }
  | { kind: 'move-car' }
  | { kind: 'move-finish' }
  | { kind: 'move-checkpoint'; idx: number }
  | { kind: 'rotate-car' }
  | { kind: 'rotate-finish' }
  | { kind: 'rotate-checkpoint'; idx: number }
  | null;

interface EditorSnapshot {
  pieces:       PlacedPiece[];
  finishMarker: TrackMarker | null;
  checkpoints:  TrackMarker[];
  startX:       number;
  startY:       number;
  startHeading: number;
  selection:    Selection;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const HEADER_H  = 52;
const PALETTE_H = 210;
const SNAP_R    = 55;
const MAX_UNDO  = 40;
const MAX_PIECES = 120;
const HIT_R_MARKER = 46;
const HANDLE_HIT_R = 22;   // hit radius for the rotate handle
// Caps how wide a palette/tab button can grow on wide desktop viewports —
// flex:1 alone stretches these to fill the row, which is fine at phone
// widths (where they're naturally this small) but comically huge on a wide
// or fullscreen desktop window.
const PAL_BTN_MAX = 84;

const DEFAULT_START_X = 0, DEFAULT_START_Y = 0, DEFAULT_START_H = 180;
const BG = 0x0a0a16;
// Same drift as the race screen's starfield (Game.ts).
const STARFIELD_DRIFT_X = 3;
const STARFIELD_DRIFT_Y = 8;

// ── Module helpers ─────────────────────────────────────────────────────────────

function rotateCW(x: number, y: number, deg: number): [number, number] {
  const r = deg * (Math.PI / 180);
  const c = Math.cos(r), s = Math.sin(r);
  return [x * c - y * s, x * s + y * c];
}

type WorldConn = { x: number; y: number; heading: number };

function worldConnectors(p: PlacedPiece): { entry: WorldConn; exit: WorldConn } {
  const c = connectors(p);
  const [ex, ey] = rotateCW(c.entryX, c.entryY, p.rotation);
  const [xx, xy] = rotateCW(c.exitX,  c.exitY,  p.rotation);
  return {
    entry: { x: p.x + ex, y: p.y + ey, heading: ((c.entryH + p.rotation) % 360 + 360) % 360 },
    exit:  { x: p.x + xx, y: p.y + xy, heading: ((c.exitH  + p.rotation) % 360 + 360) % 360 },
  };
}

// Draw one corner-wall arc on a Phaser Graphics object using lineBetween segments.
// Matches the same geometry as addPiecePaths / TrackBarrierCanvas.
// localStart: π for right turn (flip=false), 0 for left turn (flip=true).
function drawCornerArcOnGfx(
  g: GameObjects.Graphics,
  p: PlacedPiece,
  radius: number,
  lineW: number,
  color: number,
  alpha: number,
): void {
  const flip    = (p as CornerDef).flip ?? false;
  const θr      = (p as CornerDef).angle * Math.PI / 180;
  const pRad    = p.rotation * Math.PI / 180;
  const wStart  = (flip ? 0 : Math.PI) + pRad;
  const dir     = flip ? -1 : 1;
  const N       = Math.max(3, Math.ceil((p as CornerDef).angle / 5));
  g.lineStyle(lineW, color, alpha);
  for (let i = 0; i < N; i++) {
    const a1 = wStart + dir * (θr * i       / N);
    const a2 = wStart + dir * (θr * (i + 1) / N);
    g.lineBetween(
      p.x + Math.cos(a1) * radius, p.y + Math.sin(a1) * radius,
      p.x + Math.cos(a2) * radius, p.y + Math.sin(a2) * radius,
    );
  }
}

// Tight bounding box of a piece's actually-drawn geometry — used for marquee
// "fully contained" hit-testing. Unlike trackBounds() (used elsewhere, e.g.
// for texture sizing, which conservatively bounds a corner by its whole
// circle), this only covers the swept arc that's actually visible, so a
// marquee has to surround the piece you can see, not the invisible remainder
// of the circle its arc belongs to.
function pieceVisibleBounds(p: PlacedPiece): { x: number; y: number; width: number; height: number } {
  if (p.type === 'straight') {
    const half = STRAIGHT_LEN[(p as StraightDef).size] / 2;
    const rad  = p.rotation * Math.PI / 180;
    const c = Math.cos(rad), s = Math.sin(rad);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [lx, ly] of [[-HALF_TRACK, -half], [HALF_TRACK, -half], [HALF_TRACK, half], [-HALF_TRACK, half]] as [number, number][]) {
      const wx = p.x + lx * c - ly * s;
      const wy = p.y + lx * s + ly * c;
      minX = Math.min(minX, wx); maxX = Math.max(maxX, wx);
      minY = Math.min(minY, wy); maxY = Math.max(maxY, wy);
    }
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  // Corner: tight AABB of the swept annular wedge — the two arc endpoints at
  // both radii, plus the outer radius at any cardinal direction (0/90/180/270°)
  // the sweep crosses (the point furthest from center in that direction).
  const flip   = (p as CornerDef).flip ?? false;
  const θr     = (p as CornerDef).angle * Math.PI / 180;
  const pRad   = p.rotation * Math.PI / 180;
  const wStart = (flip ? 0 : Math.PI) + pRad;
  const dir    = flip ? -1 : 1;
  const a0 = wStart, a1 = wStart + dir * θr;
  const lo = Math.min(a0, a1), hi = Math.max(a0, a1);
  const { outerR, innerR } = CORNER_RADII[p.type];

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const consider = (angle: number, r: number) => {
    const x = p.x + Math.cos(angle) * r, y = p.y + Math.sin(angle) * r;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  };
  consider(lo, outerR); consider(lo, innerR);
  consider(hi, outerR); consider(hi, innerR);
  for (const cardinal of [0, Math.PI / 2, Math.PI, 3 * Math.PI / 2]) {
    for (let n = Math.ceil((lo - cardinal) / (2 * Math.PI)); ; n++) {
      const a = cardinal + n * 2 * Math.PI;
      if (a > hi) break;
      if (a >= lo) consider(a, outerR);
    }
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

// Handle sits 32px beyond the exit connector, in the same direction.
// This always ends up at the visible end of the piece (bottom of a straight,
// tip of a corner arc) so it is never hidden behind another piece.
const HANDLE_EXTEND = 32;

function getHandlePos(p: PlacedPiece): { x: number; y: number } {
  const c  = connectors(p);
  const ea = Math.atan2(c.exitY, c.exitX);
  const lx = c.exitX + Math.cos(ea) * HANDLE_EXTEND;
  const ly = c.exitY + Math.sin(ea) * HANDLE_EXTEND;
  const [wx, wy] = rotateCW(lx, ly, p.rotation);
  return { x: p.x + wx, y: p.y + wy };
}

function getHandleLocalAngle(p: PlacedPiece): number {
  const c = connectors(p);
  return Math.atan2(c.exitY, c.exitX);
}

// Returns the world position of a marker's rotation handle.
// The handle sits HANDLE_EXTEND px beyond HIT_R_MARKER in the marker's facing direction.
// Rotation convention: 0 = north (−y), 90 = east (+x), CW.
function getMarkerHandlePos(mx: number, my: number, rotDeg: number): { x: number; y: number } {
  const r    = rotDeg * Math.PI / 180;
  const dist = HIT_R_MARKER + HANDLE_EXTEND;
  return { x: mx + Math.sin(r) * dist, y: my - Math.cos(r) * dist };
}

// Draws a small filled arrow at (x, y) pointing in `headingDeg` (same
// convention as connectors()/getMarkerHandlePos: 0 = north/-y, 90 = east/+x,
// CW) — used in place of a plain dot to mark a connector, so the direction a
// piece will extend from (where the next piece would be placed) is visible
// at a glance, not just which end is which.
function drawHeadingArrow(
  g: GameObjects.Graphics,
  x: number, y: number,
  headingDeg: number,
  color: number,
  alpha: number,
  size: number,
): void {
  const r  = headingDeg * Math.PI / 180;
  const fx = Math.sin(r), fy = -Math.cos(r); // forward unit vector
  const px = fy, py = -fx;                   // left-perpendicular unit vector
  const tipX  = x + fx * size,        tipY  = y + fy * size;
  const backX = x - fx * size * 0.5,  backY = y - fy * size * 0.5;
  g.fillStyle(color, alpha);
  g.beginPath();
  g.moveTo(tipX, tipY);
  g.lineTo(backX + px * size * 0.6, backY + py * size * 0.6);
  g.lineTo(backX - px * size * 0.6, backY - py * size * 0.6);
  g.closePath();
  g.fillPath();
}

// Snap a raw pointer angle (screen atan2, east=0) to the nearest 15° in
// north-CW convention, returned as a value in [0, 360).
function snapMarkerRotation(wx: number, wy: number, cx: number, cy: number): number {
  const screenAngle = Math.atan2(wy - cy, wx - cx); // east=0, CW
  const northCW     = screenAngle * 180 / Math.PI + 90;
  return ((Math.round(northCW / 15) * 15) % 360 + 360) % 360;
}

function trySnapPiece(dragged: PlacedPiece, idx: number, all: PlacedPiece[]): PlacedPiece | null {
  const dc = connectors(dragged);
  const [dex, dey] = rotateCW(dc.entryX, dc.entryY, dragged.rotation);
  const [dxx, dxy] = rotateCW(dc.exitX,  dc.exitY,  dragged.rotation);
  const entryW = { x: dragged.x + dex, y: dragged.y + dey };
  const exitW  = { x: dragged.x + dxx, y: dragged.y + dxy };

  for (let i = 0; i < all.length; i++) {
    if (i === idx) continue;
    const oc = worldConnectors(all[i]);

    // dragged comes AFTER other: dragged.entry → other.exit
    if (Math.hypot(entryW.x - oc.exit.x, entryW.y - oc.exit.y) < SNAP_R) {
      const newRot = ((oc.exit.heading - dc.entryH) % 360 + 360) % 360;
      if (newRot !== dragged.rotation) continue; // would require rotating — don't snap
      const [nex, ney] = rotateCW(dc.entryX, dc.entryY, newRot);
      return { ...dragged, rotation: newRot, x: oc.exit.x - nex, y: oc.exit.y - ney };
    }

    // dragged comes BEFORE other: dragged.exit → other.entry
    if (Math.hypot(exitW.x - oc.entry.x, exitW.y - oc.entry.y) < SNAP_R) {
      const newRot = ((oc.entry.heading - dc.exitH) % 360 + 360) % 360;
      if (newRot !== dragged.rotation) continue; // would require rotating — don't snap
      const [nxx, nxy] = rotateCW(dc.exitX, dc.exitY, newRot);
      return { ...dragged, rotation: newRot, x: oc.entry.x - nxx, y: oc.entry.y - nxy };
    }

    // Nose-to-nose: dragged.entry butts against other.entry — the two pieces
    // face opposite directions at the shared point, so headings are 180°
    // apart rather than equal.
    if (Math.hypot(entryW.x - oc.entry.x, entryW.y - oc.entry.y) < SNAP_R) {
      const newRot = ((oc.entry.heading + 180 - dc.entryH) % 360 + 360) % 360;
      if (newRot !== dragged.rotation) continue;
      const [nex, ney] = rotateCW(dc.entryX, dc.entryY, newRot);
      return { ...dragged, rotation: newRot, x: oc.entry.x - nex, y: oc.entry.y - ney };
    }

    // Tail-to-tail: dragged.exit butts against other.exit — same idea, 180°
    // apart at the shared point.
    if (Math.hypot(exitW.x - oc.exit.x, exitW.y - oc.exit.y) < SNAP_R) {
      const newRot = ((oc.exit.heading + 180 - dc.exitH) % 360 + 360) % 360;
      if (newRot !== dragged.rotation) continue;
      const [nxx, nxy] = rotateCW(dc.exitX, dc.exitY, newRot);
      return { ...dragged, rotation: newRot, x: oc.exit.x - nxx, y: oc.exit.y - nxy };
    }
  }
  return null;
}

// Draws a dashed (marching-ants) outline along a polyline using plain vector
// line segments — works with Phaser's Graphics object, which has no native
// canvas-style setLineDash. `offset` animates the dashes.
//
// `phase` (position within the current dash/gap cycle) is advanced by adding
// the exact step just consumed, rather than re-derived via `(dist + t) % period`
// each iteration — re-deriving it that way lets floating-point rounding put
// `phase` a hair below a dash/gap boundary, which yields a near-zero remaining
// step that never meaningfully advances `t`, hanging the loop. Incremental
// `phase` can't drift the same way, so a boundary is crossed in at most one
// extra negligible sub-step instead of getting stuck on it forever.
function drawDashedPolyline(
  g: GameObjects.Graphics,
  pts: { x: number; y: number }[],
  closed: boolean,
  dash: number,
  gap: number,
  offset: number,
  color: number,
  alpha: number,
  lineWidth: number,
): void {
  const period = dash + gap;
  let phase = ((-offset % period) + period) % period;
  const n = pts.length;
  const segCount = closed ? n : n - 1;
  g.lineStyle(lineWidth, color, alpha);
  for (let i = 0; i < segCount; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const segLen = Math.hypot(b.x - a.x, b.y - a.y);
    if (segLen === 0) continue;
    let t = 0;
    while (t < segLen) {
      const remain = phase < dash ? dash - phase : period - phase;
      const step  = Math.min(remain, segLen - t);
      if (phase < dash) {
        const t0 = t, t1 = t + step;
        g.lineBetween(
          a.x + (b.x - a.x) * (t0 / segLen), a.y + (b.y - a.y) * (t0 / segLen),
          a.x + (b.x - a.x) * (t1 / segLen), a.y + (b.y - a.y) * (t1 / segLen),
        );
      }
      t += step;
      phase += step;
      if (phase >= period) phase -= period;
    }
  }
}

// ── Palette icon drawing (DOM canvas) ────────────────────────────────────────

const PAL_COLOR = '#22ee55';

// Three-pass neon: wide bloom → core line → white highlight (used for selected/active state)
function palNeon(ctx: CanvasRenderingContext2D, path: () => void, lw: number): void {
  ctx.save();
  ctx.shadowColor = PAL_COLOR; ctx.shadowBlur = lw * 4;
  ctx.strokeStyle = PAL_COLOR; ctx.lineWidth = lw * 2.5;
  ctx.lineCap = 'round'; ctx.globalAlpha = 0.45;
  path(); ctx.stroke();
  ctx.restore();
  ctx.save();
  ctx.strokeStyle = PAL_COLOR; ctx.lineWidth = lw; ctx.lineCap = 'round';
  path(); ctx.stroke();
  ctx.restore();
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.75)';
  ctx.lineWidth = Math.max(0.5, lw * 0.35); ctx.lineCap = 'round';
  path(); ctx.stroke();
  ctx.restore();
}

// Two-pass flat: core line + white highlight, no shadowBlur (used for inactive/unselected state)
function palFlat(ctx: CanvasRenderingContext2D, path: () => void, lw: number): void {
  ctx.save();
  ctx.strokeStyle = PAL_COLOR; ctx.lineWidth = lw; ctx.lineCap = 'round';
  path(); ctx.stroke();
  ctx.restore();
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.75)';
  ctx.lineWidth = Math.max(0.5, lw * 0.35); ctx.lineCap = 'round';
  path(); ctx.stroke();
  ctx.restore();
}

// Two parallel walls at 45°, using exact piece proportions (HALF_TRACK width, real length).
// The canvas is rotated 45° so local-space coordinates draw correctly.
function drawStraightIcon(canvas: HTMLCanvasElement, size: StraightSize, walls: WallVariant = 'both', glow = true): void {
  const ctx = canvas.getContext('2d')!;
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const half    = STRAIGHT_LEN[size] / 2;
  // Scale fixed to the largest piece so smaller pieces appear proportionally shorter.
  const maxHalf   = STRAIGHT_LEN[100] / 2;
  const maxExtent = (Math.SQRT2 / 2) * (HALF_TRACK + maxHalf);
  const margin    = 2;
  const scale     = (Math.min(W, H) / 2 - margin) / maxExtent;
  const hw = HALF_TRACK * scale;
  const hl = half * scale;
  const lw = 1.8;
  const stroke = glow ? palNeon : palFlat;
  ctx.save();
  ctx.translate(W / 2, H / 2);
  ctx.rotate(Math.PI / 4);
  if (walls !== 'inner') stroke(ctx, () => { ctx.beginPath(); ctx.moveTo(-hw, -hl); ctx.lineTo(-hw, +hl); }, lw);
  if (walls !== 'outer') stroke(ctx, () => { ctx.beginPath(); ctx.moveTo(+hw, -hl); ctx.lineTo(+hw, +hl); }, lw);
  ctx.restore();
}

// Arc center at bottom-right (flip=false) or bottom-left (flip=true).
// Scales to fill the canvas regardless of family or angle.
function drawCornerIcon(
  canvas: HTMLCanvasElement,
  family: CornerFamily,
  angleDeg: CornerAngle,
  flip: boolean,
  walls: WallVariant = 'both',
  glow = true,
): void {
  const ctx = canvas.getContext('2d')!;
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const { outerR: rO, innerR: rI } = CORNER_RADII[family];
  const θ = angleDeg * Math.PI / 180;
  const margin = Math.max(3, W * 0.06);
  const avW = W - margin, avH = H - margin;
  const contentH = rO * Math.sin(θ);
  const scale = Math.min(avW / rO, contentH > 2 ? avH / contentH : avW / (rO * 0.2));
  const outerR = rO * scale, innerR = rI * scale;
  const lw = Math.max(1, W / 32);
  const stroke = glow ? palNeon : palFlat;
  ctx.save();
  if (flip) { ctx.translate(W, 0); ctx.scale(-1, 1); }
  const ax = W - margin, ay = H - margin;
  const s = Math.PI, e = Math.PI + θ;
  if (walls !== 'inner') stroke(ctx, () => { ctx.beginPath(); ctx.arc(ax, ay, outerR, s, e, false); }, lw);
  if (walls !== 'outer' && innerR > 0.5) {
    stroke(ctx, () => { ctx.beginPath(); ctx.arc(ax, ay, innerR, s, e, false); }, lw);
  }
  ctx.restore();
}

// Icon for the wall-toggle button: XS straight drawn vertically (straight tab)
// or 30° tight corner (corner tabs).  Shows only the active wall(s).
function drawWallToggleIcon(
  canvas: HTMLCanvasElement,
  walls: WallVariant,
  kind: 'straight' | 'corner',
): void {
  const ctx = canvas.getContext('2d')!;
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const lw = Math.max(1, W / 20);

  if (kind === 'straight') {
    // Two short vertical lines (gap ≈ 52% of canvas width, height ≈ 68% of canvas height).
    const gap   = W * 0.52;
    const lineH = H * 0.68;
    const cx = W / 2, cy = H / 2;
    if (walls !== 'inner') {
      palNeon(ctx, () => { ctx.beginPath(); ctx.moveTo(cx - gap / 2, cy - lineH / 2); ctx.lineTo(cx - gap / 2, cy + lineH / 2); }, lw);
    }
    if (walls !== 'outer') {
      palNeon(ctx, () => { ctx.beginPath(); ctx.moveTo(cx + gap / 2, cy - lineH / 2); ctx.lineTo(cx + gap / 2, cy + lineH / 2); }, lw);
    }
  } else {
    // 30° tight corner — same geometry as drawCornerIcon but fixed angle/family.
    const θ = 30 * Math.PI / 180;
    const { outerR: rO, innerR: rI } = TIGHT;
    const margin = Math.max(3, W * 0.06);
    const contentH = rO * Math.sin(θ);
    const scale = Math.min((W - margin) / rO, contentH > 2 ? (H - margin) / contentH : (W - margin) / (rO * 0.2));
    const outerR = rO * scale, innerR = rI * scale;
    const ax = W - margin, ay = H - margin;
    const s = Math.PI, e = Math.PI + θ;
    if (walls !== 'inner') {
      palNeon(ctx, () => { ctx.beginPath(); ctx.arc(ax, ay, outerR, s, e, false); }, lw);
    }
    if (walls !== 'outer' && innerR > 0.5) {
      palNeon(ctx, () => { ctx.beginPath(); ctx.arc(ax, ay, innerR, s, e, false); }, lw);
    }
  }
}

// Returns an HTML string for a Material Design Icon, with an optional text label.
function ic(name: string, label = ''): string {
  const i = `<i class="mdi mdi-${name}" style="font-size:16px;line-height:1;vertical-align:middle;pointer-events:none;"></i>`;
  return label ? `${i}<span style="pointer-events:none;"> ${label}</span>` : i;
}

// ── Scene ──────────────────────────────────────────────────────────────────────

export class TrackEditor extends Scene {

  // Track state
  private pieces:       PlacedPiece[]      = [];
  private finishMarker: TrackMarker | null  = null;
  private checkpoints:  TrackMarker[]       = [];
  private curStartX    = DEFAULT_START_X;
  private curStartY    = DEFAULT_START_Y;
  private curStartH    = DEFAULT_START_H;

  // Editor state
  private selection:   Selection  = null;
  private snapEnabled              = true;
  private selectModeOn             = false;
  private isDirty                  = false;
  private clipboard: { pieces: PlacedPiece[]; checkpoints: TrackMarker[] } | null = null;
  // Double-tap-to-reverse (touch only — desktop uses the 'R' key instead).
  private lastTapPieceIdx: number | null = null;
  private lastTapTime = 0;

  // Undo / redo
  private undoStack: EditorSnapshot[] = [];
  private redoStack: EditorSnapshot[] = [];

  // Drag / pinch
  private dragOp:    DragOp = null;
  private touches    = new Map<number, { x: number; y: number }>();
  private pinchDist  = 0;
  private pinchZoom  = 1;

  // Marquee (rubber-band multi-select) — live end point, updated on every
  // pointermove so update() can keep animating the dashes while the pointer
  // holds still mid-drag.
  private marqueeCurWX = 0;
  private marqueeCurWY = 0;

  // Toast
  private toastEl:        HTMLDivElement | null = null;
  private toastHideTimer: ReturnType<typeof setTimeout> | null = null;
  private toastRemoveTimer: ReturnType<typeof setTimeout> | null = null;

  // Palette
  private palTab:   PalTab      = 'straight';
  private palWalls: WallVariant = 'both';
  private palFlip   = false;
  private palAngle: CornerAngle  = 90;
  // Which corner tightness new corner pieces get placed as — the Corner tab
  // covers all tightnesses now instead of a separate tab per size.
  private palCornerFamily: CornerFamily = 'corner';

  // Phaser objects
  private markerGfx!:     GameObjects.Graphics;
  private selectionGfx!:  GameObjects.Graphics;
  private connGfx!:       GameObjects.Graphics;
  private marqueeGfx!:    GameObjects.Graphics;
  private groupOutlineGfx!: GameObjects.Graphics;
  private starField: PhaserStarField | null = null;
  private barrierImg:       GameObjects.Image | null = null;
  private barrierExclude:   number[] | null          = null;
  // Pooled marching-ants highlight — one canvas-texture + Image pair per
  // selected piece, so single- and multi-select both get the same precise
  // piece-shaped dashed outline (not just a bounding box).
  private selHighlights: { tex: Phaser.Textures.CanvasTexture; img: GameObjects.Image }[] = [];
  private selDashOffset  = 0;
  private finishImg:      GameObjects.Image | null = null;
  private checkpointImgs: GameObjects.Image[]      = [];
  private startCarImg:    GameObjects.Image | null = null;

  // DOM
  private hdrEl:     HTMLElement | null       = null;
  private palEl:     HTMLElement | null       = null;
  private snapBtnEl: HTMLButtonElement | null = null;
  private selectBtnEl: HTMLButtonElement | null = null;
  // Context
  private mineTrackId: string | null = null;
  private existingName = '';
  // null = unknown/loading (or no saved draft yet to check).
  private verified: boolean | null = null;
  private settings: EditorSettings = getEditorSettings();
  private moreMenuEl: HTMLElement | null = null;
  private moreMenuBackdropEl: HTMLElement | null = null;

  constructor() { super('TrackEditor'); }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  preload(): void {
    for (const key of ['tile_finish_0', 'tile_checkpoint_0', 'tile_checkpoint_circle_0']) {
      if (!this.textures.exists(key)) this.load.image(key, `assets/markers/${key}.png`);
    }
  }

  init(data?: { mineTrackId?: string; track?: TrackEntry; startHeading?: number }): void {
    this.pieces        = [];
    this.finishMarker  = null;
    this.checkpoints   = [];
    this.isDirty       = false;
    this.mineTrackId   = data?.mineTrackId ?? null;
    this.existingName  = data?.track?.name ?? '';
    this.verified      = null;
    this.selection     = null;
    this.dragOp        = null;
    this.undoStack     = [];
    this.redoStack     = [];
    this.clipboard     = null;
    this.startCarImg   = null;
    this.barrierExclude = null;
    // Empty on scene restart — the pool's images will be in a destroyed state already
    this.selHighlights = [];

    this.curStartX = data?.track?.startX      ?? DEFAULT_START_X;
    this.curStartY = data?.track?.startY      ?? DEFAULT_START_Y;
    this.curStartH = data?.startHeading       ?? data?.track?.startHeading ?? DEFAULT_START_H;

    const track = data?.track;
    if (track) {
      // PlacedPiece[] already has x, y, rotation — use directly
      this.pieces       = track.pieces.map(p => ({ ...p }));
      const finish      = track.markers.find(m => m.kind === 'finish');
      this.finishMarker = finish ? { ...finish } : null;
      this.checkpoints  = track.markers.filter(m => m.kind === 'checkpoint').map(m => ({ ...m }));
    }
  }

  create(): void {
    const cam = this.cameras.main;
    cam.setBackgroundColor(BG);
    cam.setZoom(0.65);
    cam.centerOn(DEFAULT_START_X, DEFAULT_START_Y);

    this.starField = new PhaserStarField(this, {
      depth: -10, parallax: 0.08, texKey: 'starfield_editor',
      driftX: STARFIELD_DRIFT_X, driftY: STARFIELD_DRIFT_Y,
    });

    // World grid
    const gridGfx = this.add.graphics();
    gridGfx.lineStyle(1, 0x1c1c4c, 1);
    const EXT = 4800, CELL = 24;
    for (let x = -EXT; x <= EXT; x += CELL) gridGfx.lineBetween(x, -EXT, x, EXT);
    for (let y = -EXT; y <= EXT; y += CELL) gridGfx.lineBetween(-EXT, y, EXT, y);

    this.markerGfx        = this.add.graphics().setDepth(5);
    this.groupOutlineGfx  = this.add.graphics().setDepth(6);
    this.selectionGfx     = this.add.graphics().setDepth(8);
    this.connGfx          = this.add.graphics().setDepth(7);
    this.marqueeGfx       = this.add.graphics().setDepth(9);

    this.makeEditorCarTexture();
    this.createHeader();
    this.createPalette();

    if (this.pieces.length > 0) {
      this.updateBarrierImg();
      const b = trackBounds(this.pieces);
      cam.centerOn(b.cx, b.cy);
    }
    this.updateStartCarImg();
    this.updateFinishImg();
    this.updateCheckpointImgs();

    if (this.mineTrackId) {
      fetchMineTrack(this.mineTrackId)
        .then(({ meta }) => { this.verified = meta.verified; })
        .catch(() => { this.verified = false; });
    } else {
      this.verified = false;
    }

    this.input.addPointer(1);
    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => this.onDown(p));
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => this.onMove(p));
    this.input.on('pointerup',   (p: Phaser.Input.Pointer) => this.onUp(p));
    this.input.on('wheel',       (p: Phaser.Input.Pointer) => {
      if (!p.deltaY) return;
      const z = cam.zoom;
      cam.setZoom(Math.min(Math.max(z * (p.deltaY > 0 ? 1 / 1.12 : 1.12), 0.12), 4));
    });

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (this.selection) { this.deselectAllWithUndo(); return; }
        this.goBack();
        return;
      }

      // Don't hijack standard edit shortcuts while the user is typing
      // somewhere (e.g. the Save Track name field).
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;

      const mod = e.ctrlKey || e.metaKey;

      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) this.redo(); else this.undo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        this.redo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'c') {
        e.preventDefault();
        this.copySelected();
        return;
      }
      if (mod && e.key.toLowerCase() === 'v') {
        e.preventDefault();
        this.paste();
        return;
      }
      if (mod && e.key.toLowerCase() === 'g') {
        e.preventDefault();
        this.toggleGroupSelected();
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        this.deleteSelection();
        return;
      }
      if ((e.key === '+' || e.key === '=') && this.selection?.kind === 'piece') {
        e.preventDefault();
        this.cyclePieceSize(1);
        return;
      }
      if (e.key === '-' && this.selection?.kind === 'piece') {
        e.preventDefault();
        this.cyclePieceSize(-1);
        return;
      }
      if (e.key.toLowerCase() === 'r' && !mod && this.selection?.kind === 'piece') {
        e.preventDefault();
        this.reverseSelectedPiece();
        return;
      }
      if (
        (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight')
        && this.selection
      ) {
        e.preventDefault();
        const dx = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
        const dy = e.key === 'ArrowUp'   ? -1 : e.key === 'ArrowDown'  ? 1 : 0;
        this.nudgeSelection(dx, dy, !e.repeat);
        return;
      }
    };
    window.addEventListener('keydown', onKeyDown);

    this.events.once('shutdown', () => {
      window.removeEventListener('keydown', onKeyDown);
      this.hdrEl?.remove();
      this.palEl?.remove();
      this.hdrEl = null;
      this.palEl = null;
    });
  }

  // ── Header ─────────────────────────────────────────────────────────────────

  private createHeader(): void {
    const hdr = document.createElement('div');
    hdr.style.cssText = [
      'position:fixed', 'top:0', 'left:0', 'right:0',
      `height:${HEADER_H}px`,
      'background:#12122a', 'border-bottom:1px solid #3a3a6a',
      'display:flex', 'align-items:center', 'gap:4px',
      'padding:0 8px', 'z-index:100',
      'user-select:none', '-webkit-user-select:none',
    ].join(';');

    const backBtn = document.createElement('button');
    backBtn.innerHTML = ic('arrow-left');
    backBtn.title = 'Back';
    backBtn.style.cssText = 'background:none;border:none;cursor:pointer;color:#8888ff;font-size:16px;padding:0 6px;height:100%;flex-shrink:0;display:inline-flex;align-items:center;';
    backBtn.addEventListener('click', () => this.goBack());

    const titleEl = document.createElement('div');
    titleEl.style.cssText = 'flex:1;';

    const mkBtn = (html: string, title: string, color: string, bg: string, border: string, fn: () => void) => {
      const b = document.createElement('button');
      b.innerHTML = html; b.title = title;
      b.style.cssText = [
        'border-radius:5px', 'cursor:pointer', 'font:bold 12px Arial,sans-serif',
        'display:inline-flex', 'align-items:center', 'gap:3px',
        'padding:4px 8px', `color:${color}`, `background:${bg}`, `border:1px solid ${border}`,
        `height:${HEADER_H - 16}px`, 'white-space:nowrap', 'flex-shrink:0',
      ].join(';');
      b.addEventListener('click', fn);
      return b;
    };

    const sep = () => {
      const s = document.createElement('div');
      s.style.cssText = 'width:1px;height:55%;background:#333366;margin:0 1px;flex-shrink:0;';
      return s;
    };

    const snapBtn = document.createElement('button');
    snapBtn.title = 'Toggle connection snapping';
    snapBtn.style.cssText = [
      'border-radius:5px', 'cursor:pointer', 'font:bold 12px Arial,sans-serif',
      'display:inline-flex', 'align-items:center', 'gap:3px',
      'padding:4px 8px', `height:${HEADER_H - 16}px`, 'flex-shrink:0',
    ].join(';');
    snapBtn.addEventListener('click', () => {
      this.snapEnabled = !this.snapEnabled;
      this.updateSnapBtn();
      this.showToast(this.snapEnabled ? 'Snap On' : 'Snap Off');
    });
    this.snapBtnEl = snapBtn;
    this.updateSnapBtn();

    // Select Mode — while on, tapping a piece/finish/checkpoint (mouse or
    // touch) toggles it in/out of the multi-selection instead of dragging it,
    // same as holding Shift. Primarily for touch, where there's no Shift key.
    const selectBtn = document.createElement('button');
    selectBtn.title = 'Toggle select mode';
    selectBtn.style.cssText = [
      'border-radius:5px', 'cursor:pointer', 'font:bold 12px Arial,sans-serif',
      'display:inline-flex', 'align-items:center', 'gap:3px',
      'padding:4px 8px', `height:${HEADER_H - 16}px`, 'flex-shrink:0',
    ].join(';');
    selectBtn.addEventListener('click', () => {
      this.selectModeOn = !this.selectModeOn;
      this.updateSelectBtn();
      this.showToast(this.selectModeOn ? 'Select Mode On' : 'Select Mode Off');
    });
    this.selectBtnEl = selectBtn;
    this.updateSelectBtn();

    const circleBtn = (label: string, title: string, onClick: () => void) => {
      const b = document.createElement('button');
      b.innerHTML = `<span style="font:bold 13px Arial,sans-serif;line-height:1;">${label}</span>`;
      b.title = title;
      b.style.cssText = [
        'border-radius:50%', 'cursor:pointer', 'width:28px', 'height:28px',
        'display:inline-flex', 'align-items:center', 'justify-content:center',
        'color:#8888cc', 'background:#111128', 'border:1px solid #3a3a60', 'flex-shrink:0',
      ].join(';');
      b.addEventListener('click', onClick);
      return b;
    };

    hdr.appendChild(backBtn);
    hdr.appendChild(titleEl);
    hdr.appendChild(sep());
    hdr.appendChild(snapBtn);
    hdr.appendChild(sep());
    hdr.appendChild(mkBtn(ic('undo'),          'Undo',       '#ffaa44', '#1a0e00', '#553300', () => this.undo()));
    hdr.appendChild(mkBtn(ic('redo'),          'Redo',       '#ffaa44', '#1a0e00', '#553300', () => this.redo()));
    hdr.appendChild(sep());
    hdr.appendChild(mkBtn(ic('play'),          'Test track', '#44ffcc', '#001a12', '#226644', () => this.testTrack()));
    hdr.appendChild(mkBtn(ic('content-save'),  'Save track', '#66ff99', '#001a08', '#226633', () => this.showSaveDialog()));
    hdr.appendChild(sep());
    hdr.appendChild(selectBtn);
    hdr.appendChild(sep());
    const moreBtn = circleBtn('⋮', 'More', () => this.toggleMoreMenu(moreBtn));
    hdr.appendChild(moreBtn);

    document.body.appendChild(hdr);
    this.hdrEl = hdr;
  }

  private updateSnapBtn(): void {
    if (!this.snapBtnEl) return;
    this.snapBtnEl.innerHTML = ic('link-variant');
    this.snapBtnEl.style.background = this.snapEnabled ? '#001a22' : '#111128';
    this.snapBtnEl.style.color      = this.snapEnabled ? '#44ddff' : '#445566';
    this.snapBtnEl.style.border     = `1px solid ${this.snapEnabled ? '#226644' : '#2a2a44'}`;
  }

  private updateSelectBtn(): void {
    if (!this.selectBtnEl) return;
    this.selectBtnEl.innerHTML = ic('vector-selection', 'Select');
    this.selectBtnEl.style.background = this.selectModeOn ? '#22004a' : '#111128';
    this.selectBtnEl.style.color      = this.selectModeOn ? '#dd88ff' : '#445566';
    this.selectBtnEl.style.border     = `1px solid ${this.selectModeOn ? '#663388' : '#2a2a44'}`;
  }

  private toggleMoreMenu(anchorBtn: HTMLElement): void {
    if (this.moreMenuEl) { this.closeMoreMenu(); return; }

    const backdrop = document.createElement('div');
    backdrop.style.cssText = 'position:fixed;inset:0;z-index:199;';
    backdrop.addEventListener('click', () => this.closeMoreMenu());

    const rect = anchorBtn.getBoundingClientRect();
    const menu = document.createElement('div');
    menu.style.cssText = [
      'position:fixed', `top:${rect.bottom + 4}px`, `right:${window.innerWidth - rect.right}px`,
      'background:#12122a', 'border:1px solid #3a3a6a', 'border-radius:8px',
      'padding:4px', 'z-index:200', 'display:flex', 'flex-direction:column', 'gap:2px',
      'min-width:170px', 'box-shadow:0 6px 20px rgba(0,0,0,0.5);',
    ].join(';');

    const item = (iconName: string, label: string, fn: () => void) => {
      const b = document.createElement('button');
      b.innerHTML = ic(iconName, label);
      b.style.cssText = 'display:flex;align-items:center;gap:8px;width:100%;padding:9px 10px;border-radius:5px;border:none;background:none;color:#ccccff;font:13px Arial,sans-serif;cursor:pointer;text-align:left;white-space:nowrap;box-sizing:border-box;';
      b.addEventListener('click', () => { this.closeMoreMenu(); fn(); });
      return b;
    };

    menu.appendChild(item('file-outline', 'New',        () => this.newTrack()));
    menu.appendChild(item('folder-open',  'My Drafts',  () => this.openDrafts()));
    menu.appendChild(item('information',  'Track Info', () => this.showInfo()));
    menu.appendChild(item('help-circle',  'Help',       () => this.showHelp()));
    menu.appendChild(item('cog',          'Options',    () => this.showOptions()));

    document.body.appendChild(backdrop);
    document.body.appendChild(menu);
    this.moreMenuBackdropEl = backdrop;
    this.moreMenuEl = menu;
  }

  private closeMoreMenu(): void {
    this.moreMenuEl?.remove();
    this.moreMenuBackdropEl?.remove();
    this.moreMenuEl = null;
    this.moreMenuBackdropEl = null;
  }

  private showOptions(): void {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.80);z-index:500;display:flex;align-items:flex-start;justify-content:center;overflow-y:auto;padding:16px;box-sizing:border-box;';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    const card = document.createElement('div');
    card.style.cssText = 'background:#12122a;border:1px solid #3a3a6a;border-radius:10px;width:100%;max-width:340px;padding:16px 16px 20px;position:relative;margin:auto;';

    const closeBtn = document.createElement('button');
    closeBtn.innerHTML = ic('close');
    closeBtn.title = 'Close';
    closeBtn.style.cssText = 'position:absolute;top:10px;right:10px;background:none;border:none;color:#8888aa;font-size:18px;cursor:pointer;padding:4px;line-height:1;';
    closeBtn.addEventListener('click', () => overlay.remove());

    const heading = document.createElement('div');
    heading.textContent = 'Options';
    heading.style.cssText = 'color:#aaaaff;font:bold 15px Arial,sans-serif;margin-bottom:14px;';

    card.appendChild(closeBtn);
    card.appendChild(heading);

    // ── Props bar layout ─────────────────────────────────────────────────────
    const sec = document.createElement('div');
    const secHead = document.createElement('div');
    secHead.textContent = 'Selection Toolbar';
    secHead.style.cssText = 'font:bold 10px Arial,sans-serif;color:#5566aa;letter-spacing:0.5px;text-transform:uppercase;border-bottom:1px solid #2a2a4a;padding-bottom:4px;margin-bottom:8px;';
    sec.appendChild(secHead);

    const desc = document.createElement('div');
    desc.textContent = 'How piece/selection buttons behave when there are more than fit on screen.';
    desc.style.cssText = 'font:11px Arial,sans-serif;color:#7777aa;margin-bottom:8px;line-height:1.4;';
    sec.appendChild(desc);

    const optRow = document.createElement('div');
    optRow.style.cssText = 'display:flex;gap:8px;';
    const renderOptRow = () => {
      optRow.innerHTML = '';
      optRow.appendChild(this.mkOptBtn('Scroll (1 row)', this.settings.propsBarLayout === 'scroll', () => {
        this.settings = setEditorSettings({ propsBarLayout: 'scroll' });
        this.rebuildCtrlRow();
        renderOptRow();
      }));
      optRow.appendChild(this.mkOptBtn('Wrap (2 rows)', this.settings.propsBarLayout === 'wrap', () => {
        this.settings = setEditorSettings({ propsBarLayout: 'wrap' });
        this.rebuildCtrlRow();
        renderOptRow();
      }));
    };
    renderOptRow();
    sec.appendChild(optRow);
    card.appendChild(sec);

    // ── Group outlines ────────────────────────────────────────────────────────
    const grpSec = document.createElement('div');
    grpSec.style.cssText = 'margin-top:14px;';
    const grpSecHead = document.createElement('div');
    grpSecHead.textContent = 'Group Outlines';
    grpSecHead.style.cssText = 'font:bold 10px Arial,sans-serif;color:#5566aa;letter-spacing:0.5px;text-transform:uppercase;border-bottom:1px solid #2a2a4a;padding-bottom:4px;margin-bottom:8px;';
    grpSec.appendChild(grpSecHead);

    const grpDesc = document.createElement('div');
    grpDesc.textContent = 'Show a dashed rectangle around every group at all times, not just while selected.';
    grpDesc.style.cssText = 'font:11px Arial,sans-serif;color:#7777aa;margin-bottom:8px;line-height:1.4;';
    grpSec.appendChild(grpDesc);

    const grpRow = document.createElement('div');
    grpRow.style.cssText = 'display:flex;gap:8px;';
    const renderGrpRow = () => {
      grpRow.innerHTML = '';
      grpRow.appendChild(this.mkOptBtn('Always show', this.settings.showGroupOutlines, () => {
        this.settings = setEditorSettings({ showGroupOutlines: true });
        this.redrawGroupOutlines();
        renderGrpRow();
      }));
      grpRow.appendChild(this.mkOptBtn('Only when selected', !this.settings.showGroupOutlines, () => {
        this.settings = setEditorSettings({ showGroupOutlines: false });
        this.redrawGroupOutlines();
        renderGrpRow();
      }));
    };
    renderGrpRow();
    grpSec.appendChild(grpRow);
    card.appendChild(grpSec);

    overlay.appendChild(card);
    document.body.appendChild(overlay);
  }

  private showInfo(): void {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.80);z-index:500;display:flex;align-items:flex-start;justify-content:center;overflow-y:auto;padding:16px;box-sizing:border-box;';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    const card = document.createElement('div');
    card.style.cssText = 'background:#12122a;border:1px solid #3a3a6a;border-radius:10px;width:100%;max-width:340px;padding:16px 16px 20px;position:relative;margin:auto;';

    const closeBtn = document.createElement('button');
    closeBtn.innerHTML = ic('close');
    closeBtn.title = 'Close';
    closeBtn.style.cssText = 'position:absolute;top:10px;right:10px;background:none;border:none;color:#8888aa;font-size:18px;cursor:pointer;padding:4px;line-height:1;';
    closeBtn.addEventListener('click', () => overlay.remove());

    const heading = document.createElement('div');
    heading.textContent = 'Track Status';
    heading.style.cssText = 'color:#aaaaff;font:bold 15px Arial,sans-serif;margin-bottom:14px;';

    card.appendChild(closeBtn);
    card.appendChild(heading);

    const sectionHead = (label: string) => {
      const h = document.createElement('div');
      h.textContent = label;
      h.style.cssText = 'font:bold 10px Arial,sans-serif;color:#5566aa;letter-spacing:0.5px;text-transform:uppercase;border-bottom:1px solid #2a2a4a;padding-bottom:4px;margin-bottom:8px;';
      return h;
    };

    const statRow = (label: string, value: string, accent = '#ccccff') => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:7px;';
      const l = document.createElement('div');
      l.style.cssText = 'font:12px Arial,sans-serif;color:#8888aa;';
      l.textContent = label;
      const v = document.createElement('div');
      v.style.cssText = `font:bold 12px Arial,sans-serif;color:${accent};`;
      v.textContent = value;
      row.appendChild(l);
      row.appendChild(v);
      return row;
    };

    // ── Name ──────────────────────────────────────────────────────────────────
    const nameEl = document.createElement('div');
    nameEl.style.cssText = 'margin-bottom:14px;padding-bottom:10px;border-bottom:1px solid #2a2a4a;';
    const nameLbl = document.createElement('div');
    nameLbl.style.cssText = 'font:10px Arial,sans-serif;color:#5566aa;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;';
    nameLbl.textContent = 'Track';
    const nameVal = document.createElement('div');
    nameVal.style.cssText = 'font:bold 13px Arial,sans-serif;color:#ccccff;';
    nameVal.textContent = this.existingName || 'Untitled';
    nameEl.appendChild(nameLbl);
    nameEl.appendChild(nameVal);
    card.appendChild(nameEl);

    // ── Pieces ────────────────────────────────────────────────────────────────
    const total    = this.pieces.length;
    const straights = this.pieces.filter(p => p.type === 'straight').length;
    const tight     = this.pieces.filter(p => p.type === 'corner').length;
    const big       = this.pieces.filter(p => p.type === 'big_corner').length;
    const huge      = this.pieces.filter(p => p.type === 'huge_corner').length;
    const pct       = total / MAX_PIECES;
    const barColor  = pct >= 1 ? '#ff5555' : pct >= 0.8 ? '#ffaa44' : '#44ff99';

    const pieceSec = document.createElement('div');
    pieceSec.style.marginBottom = '14px';
    pieceSec.appendChild(sectionHead('Pieces'));

    const barWrap = document.createElement('div');
    barWrap.style.cssText = 'height:5px;background:#1a1a3a;border-radius:3px;margin-bottom:10px;overflow:hidden;';
    const barFill = document.createElement('div');
    barFill.style.cssText = `height:100%;width:${Math.min(100, pct * 100).toFixed(1)}%;background:${barColor};border-radius:3px;`;
    barWrap.appendChild(barFill);
    pieceSec.appendChild(barWrap);

    pieceSec.appendChild(statRow('Total',         `${total} / ${MAX_PIECES}`, barColor));
    pieceSec.appendChild(statRow('Straights',     String(straights)));
    pieceSec.appendChild(statRow('Tight corners', String(tight)));
    pieceSec.appendChild(statRow('Big corners',   String(big)));
    pieceSec.appendChild(statRow('Huge corners',  String(huge)));
    card.appendChild(pieceSec);

    // ── Markers ───────────────────────────────────────────────────────────────
    const markerSec = document.createElement('div');
    markerSec.style.marginBottom = '14px';
    markerSec.appendChild(sectionHead('Markers'));
    markerSec.appendChild(statRow(
      'Finish line',
      this.finishMarker ? '✓ Placed' : '✗ Not placed',
      this.finishMarker ? '#66ff99' : '#ff6666',
    ));
    markerSec.appendChild(statRow(
      'Checkpoints',
      this.checkpoints.length === 0 ? 'None' : String(this.checkpoints.length),
    ));
    card.appendChild(markerSec);

    // ── Session ───────────────────────────────────────────────────────────────
    const sessionSec = document.createElement('div');
    sessionSec.appendChild(sectionHead('Session'));
    sessionSec.appendChild(statRow(
      'Unsaved changes',
      this.isDirty ? 'Yes' : 'None',
      this.isDirty ? '#ffaa44' : '#8888aa',
    ));

    let readyLabel: string, readyColor: string;
    if (!this.mineTrackId) {
      readyLabel = 'Not saved yet';
      readyColor = '#8888aa';
    } else if (this.isDirty) {
      readyLabel = 'Save & test again';
      readyColor = '#ffaa44';
    } else if (this.verified === null) {
      readyLabel = 'Checking…';
      readyColor = '#8888aa';
    } else if (this.verified) {
      readyLabel = '✓ Yes';
      readyColor = '#66ff99';
    } else {
      readyLabel = '✗ Not yet — test it first';
      readyColor = '#ff6666';
    }
    sessionSec.appendChild(statRow('Ready to upload', readyLabel, readyColor));

    card.appendChild(sessionSec);

    overlay.appendChild(card);
    document.body.appendChild(overlay);
  }

  private showHelp(): void {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.88);z-index:500;display:flex;align-items:flex-start;justify-content:center;overflow-y:auto;padding:16px;box-sizing:border-box;';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    const card = document.createElement('div');
    card.style.cssText = 'background:#12122a;border:1px solid #3a3a6a;border-radius:10px;width:100%;max-width:400px;padding:16px 16px 20px;position:relative;margin:auto;';

    const closeBtn = document.createElement('button');
    closeBtn.innerHTML = ic('close');
    closeBtn.title = 'Close';
    closeBtn.style.cssText = 'position:absolute;top:10px;right:10px;background:none;border:none;color:#8888aa;font-size:18px;cursor:pointer;padding:4px;line-height:1;';
    closeBtn.addEventListener('click', () => overlay.remove());

    const title = document.createElement('div');
    title.textContent = 'Editor Help';
    title.style.cssText = 'color:#aaaaff;font:bold 15px Arial,sans-serif;margin-bottom:14px;';

    type HelpRow = [string, string, string]; // [icon html, label, description]
    const section = (heading: string, rows: HelpRow[]) => {
      const sec = document.createElement('div');
      sec.style.cssText = 'margin-bottom:14px;';
      const h = document.createElement('div');
      h.textContent = heading;
      h.style.cssText = 'font:bold 10px Arial,sans-serif;color:#5566aa;letter-spacing:0.5px;text-transform:uppercase;border-bottom:1px solid #2a2a4a;padding-bottom:4px;margin-bottom:8px;';
      sec.appendChild(h);
      for (const [iconHtml, label, desc] of rows) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:baseline;gap:8px;margin-bottom:5px;';
        const left = document.createElement('div');
        left.innerHTML = `${iconHtml} <strong>${label}</strong>`;
        left.style.cssText = 'color:#ccccff;font:12px Arial,sans-serif;min-width:100px;flex-shrink:0;';
        const right = document.createElement('div');
        right.textContent = desc;
        right.style.cssText = 'color:#8888aa;font:12px Arial,sans-serif;line-height:1.4;';
        row.appendChild(left); row.appendChild(right);
        sec.appendChild(row);
      }
      return sec;
    };

    card.appendChild(closeBtn);
    card.appendChild(title);
    card.appendChild(section('Toolbar', [
      [ic('arrow-left'),         'Back',   'Exit the editor'],
      [ic('link-variant'),       'Snap',   'Toggle connector snapping — pieces snap together at endpoints when on'],
      [ic('undo'),               'Undo',   'Undo the last change'],
      [ic('redo'),               'Redo',   'Redo the last undone change'],
      [ic('play'),               'Test',   'Test drive the current track'],
      [ic('content-save'),       'Save',   'Save and publish the track'],
      [ic('vector-selection'),   'Select', 'Toggle Select Mode — drag from empty space to rubber-band select a group (normally that drag just pans the map)'],
      ['⋮',                      'More',   'New, Drafts, Track Info, Help, Options'],
    ]));
    card.appendChild(section('Palette — nothing selected', [
      ['', 'Walls',      'Default wall layout for new pieces: Both walls / Outer only / Inner only'],
      ['', 'Flip',       'Default turn direction for new corners: right turn / left turn'],
      ['', 'Tightness',  'Default tightness for new corners, on the Corner tab: Tight / Big / Huge'],
    ]));
    card.appendChild(section('Piece selected', [
      ['', 'Walls',                                         'Cycle wall layout on the selected piece'],
      [ic('flip-horizontal'),                'Flip',        'Mirror a corner piece to switch turn direction'],
      ['', 'Tightness',                                     'Cycle a selected corner\'s tightness: Tight / Big / Huge'],
      [ic('rotate-left') + ic('rotate-right'), '±15°',     'Rotate the selected piece in 15° steps'],
      ['', '+ / −', 'Cycle corner angle or straight length (wraps at min/max)'],
      ['', 'Arrow keys', 'Nudge the piece 1px in that direction'],
      [ic('content-copy'),                   'Copy',        'Copy the selected piece'],
      [ic('content-paste'),                  'Paste',       'Paste the last copied piece'],
      ['', 'R / double-tap', 'Reverse the piece\'s entry/exit ends — the palette then extends the track from its other end'],
      [ic('delete'),                         'Delete',      'Remove the selected piece from the track'],
    ]));
    card.appendChild(section('Multiple items selected', [
      ['', 'Drag-select',   'In Select Mode, drag from empty canvas space to rubber-band select everything fully inside the rectangle'],
      ['', 'Shift+click',   'Add/remove a piece, checkpoint, or the finish line from the selection (desktop)'],
      [ic('rotate-left') + ic('rotate-right'), '±15°', 'Rotate the whole selection as a rigid group'],
      ['', 'Arrow keys', 'Nudge the whole selection 1px in that direction'],
      [ic('content-copy') + ic('content-paste'), 'Copy/Paste', 'Copy/paste every selected piece and checkpoint together'],
      [ic('group'),   'Ctrl+G', 'Group the selection — clicking any one piece afterward selects, drags, and copies the whole group'],
      [ic('ungroup'), 'Ctrl+G', 'While a group is selected, ungroup it'],
      [ic('delete'),  'Delete', 'Remove everything selected'],
    ]));
    card.appendChild(section('Marker selected  (finish / checkpoint)', [
      [ic('rotate-left') + ic('rotate-right'), '±15°',  'Rotate the marker in 15° steps'],
      ['', 'Arrow keys', 'Nudge the marker 1px in that direction'],
      [ic('content-copy'),                     'Copy',   'Copy the selected checkpoint (the finish line can\'t be copied — only one is allowed)'],
      [ic('content-paste'),                    'Paste',  'Paste the last copied checkpoint'],
      [ic('delete'),                           'Delete', 'Remove the finish line or checkpoint'],
    ]));

    overlay.appendChild(card);
    document.body.appendChild(overlay);
  }

  // ── Barrier texture ─────────────────────────────────────────────────────────

  // Dashed bounding rectangle around each group. Controlled by the
  // showGroupOutlines option: when on, every group gets one at all times
  // (idle indicator); when off, only the currently-selected group does — the
  // per-piece marching-ants highlight on selection is unaffected either way.
  private redrawGroupOutlines(): void {
    const g = this.groupOutlineGfx;
    g.clear();

    const groups = new Map<string, number[]>();
    for (let i = 0; i < this.pieces.length; i++) {
      const gid = this.pieces[i].groupId;
      if (!gid) continue;
      const arr = groups.get(gid);
      if (arr) arr.push(i); else groups.set(gid, [i]);
    }
    if (groups.size === 0) return;

    const selectedGroup = this.selection?.kind === 'multi' && this.isExactGroup(this.selection.pieces)
      ? new Set(this.selection.pieces) : null;

    const PAD = 10;
    for (const idxs of groups.values()) {
      const isSelected = !!selectedGroup && idxs.length === selectedGroup.size && idxs.every(i => selectedGroup.has(i));
      if (!this.settings.showGroupOutlines && !isSelected) continue;

      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const i of idxs) {
        const b = pieceVisibleBounds(this.pieces[i]);
        minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
        maxX = Math.max(maxX, b.x + b.width); maxY = Math.max(maxY, b.y + b.height);
      }
      minX -= PAD; minY -= PAD; maxX += PAD; maxY += PAD;
      const pts = [
        { x: minX, y: minY }, { x: maxX, y: minY },
        { x: maxX, y: maxY }, { x: minX, y: maxY },
      ];
      // Idle color bumped up from the original muted grey-blue (0x6666aa @
      // 0.45 alpha) — that blended into the background grid badly enough to
      // read as "not there" at a glance on a real track.
      const color = isSelected ? 0xccccff : 0x8888ff;
      const alpha = isSelected ? 0.9 : 0.75;
      drawDashedPolyline(g, pts, true, 6, 5, 0, color, alpha, isSelected ? 2 : 1.5);
    }
  }

  private updateBarrierImg(excludeIdxs: number[] | null = null): void {
    this.redrawGroupOutlines();
    this.barrierExclude = excludeIdxs;
    if (this.barrierImg) { this.barrierImg.destroy(); this.barrierImg = null; }
    const drawPieces = excludeIdxs !== null
      ? this.pieces.filter((_, i) => !excludeIdxs.includes(i))
      : this.pieces;
    if (drawPieces.length === 0) return;
    this.barrierImg = buildTrackTexture(this, drawPieces, NEON_GREEN, '_ed_barriers').setDepth(3);
  }

  // Marching-ants selection outline(s) — one canvas texture + Image pair per
  // selected piece, pooled and reused across selection changes. Destroying
  // and re-creating an Image each time causes Phaser's WebGL backend to
  // silently lose the texture binding after the first remove/recreate cycle,
  // so pool slots are only resized (not recreated) when reused for a
  // similarly-sized piece.
  private updateSelectionHighlights(): void {
    const idxs =
      this.selection?.kind === 'piece' ? [this.selection.idx]
      : this.selection?.kind === 'multi' ? this.selection.pieces
      : [];

    while (this.selHighlights.length > idxs.length) {
      const h = this.selHighlights.pop()!;
      h.img.destroy();
      if (this.textures.exists(h.tex.key)) this.textures.remove(h.tex.key);
    }
    while (this.selHighlights.length < idxs.length) {
      const key = `_ed_sel_hl_${this.selHighlights.length}`;
      if (this.textures.exists(key)) this.textures.remove(key);
      const tex = this.textures.createCanvas(key, 4, 4)!;
      const img = this.add.image(0, 0, key).setOrigin(0, 0).setDepth(3.5);
      this.selHighlights.push({ tex, img });
    }

    for (let k = 0; k < idxs.length; k++) this.layoutHighlightSlot(k, idxs[k]);
  }

  // Resizes/repositions pool slot `slot` to fit piece `pieceIdx`'s current
  // bounds, then redraws its dashed outline.
  private layoutHighlightSlot(slot: number, pieceIdx: number): void {
    const entry = this.selHighlights[slot];
    const p     = this.pieces[pieceIdx];
    if (!entry || !p) return;

    const b   = trackBounds([p]);
    const pad = 14;
    const w   = Math.max(4, Math.ceil(b.width  + pad * 2));
    const h   = Math.max(4, Math.ceil(b.height + pad * 2));

    if (entry.tex.width !== w || entry.tex.height !== h) {
      const key = entry.tex.key;
      if (this.textures.exists(key)) this.textures.remove(key);
      entry.tex = this.textures.createCanvas(key, w, h)!;
      entry.img.setTexture(key);
    }
    entry.img.setPosition(b.x - pad, b.y - pad);
    entry.img.setVisible(true);
    this.redrawHighlightSlot(slot, pieceIdx);
  }

  // Redraws pool slot `slot`'s dashed outline at the current selDashOffset.
  // Called from layoutHighlightSlot and then every frame from update().
  private redrawHighlightSlot(slot: number, pieceIdx: number): void {
    const entry = this.selHighlights[slot];
    const p     = this.pieces[pieceIdx];
    if (!entry || !p) return;

    const b   = trackBounds([p]);
    const pad = 14;
    const ctx = entry.tex.getContext();
    const cw  = entry.tex.width;
    const ch  = entry.tex.height;

    // Hard-reset all state that could have drifted across frames or canvas reuse.
    // Using setTransform instead of save/restore avoids any stack imbalance issues.
    ctx.globalAlpha             = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cw, ch);

    // Apply the world-to-canvas offset
    ctx.setTransform(1, 0, 0, 1, pad - b.x, pad - b.y);
    ctx.lineWidth = 2.5;
    ctx.lineCap   = 'round';

    // Black base — fills the gaps so they read as black instead of transparent
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;
    ctx.strokeStyle = '#000000';
    ctx.beginPath(); addPiecePaths(ctx, p); ctx.stroke();

    // Cyan dashes on top
    ctx.setLineDash([10, 8]);
    ctx.lineDashOffset = -this.selDashOffset;
    ctx.strokeStyle = '#00ddff';
    ctx.beginPath(); addPiecePaths(ctx, p); ctx.stroke();

    // Leave the context in a clean identity state
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.setLineDash([]);

    entry.tex.refresh();
  }

  // ── Marker images ───────────────────────────────────────────────────────────

  private makeEditorCarTexture(): void {
    const KEY = 'editor_car';
    if (this.textures.exists(KEY)) return;
    const gPx = 36;
    const HW = Math.round(gPx * 0.50), HH = Math.round(gPx * 0.85);
    const PAD = Math.round(gPx * 0.45);
    const W = (HW + PAD) * 2, H = (HH + PAD) * 2;
    const cx = W / 2, cy = H / 2;
    const ct  = this.textures.createCanvas(KEY, W, H)!;
    const ctx = ct.getContext();
    ctx.shadowColor = 'hsl(300,100%,60%)'; ctx.shadowBlur = 10;
    ctx.fillStyle   = 'hsl(300,100%,60%)';
    ctx.beginPath();
    ctx.moveTo(cx, cy - HH); ctx.lineTo(cx + HW, cy + HH);
    ctx.lineTo(cx, cy + HH * 0.35); ctx.lineTo(cx - HW, cy + HH);
    ctx.closePath(); ctx.fill();
    ctx.shadowBlur = 0; ctx.fillStyle = 'rgba(255,255,255,0.80)';
    ctx.beginPath();
    ctx.moveTo(cx, cy - HH + 3); ctx.lineTo(cx + HW * 0.45, cy + HH * 0.2);
    ctx.lineTo(cx, cy + HH * 0.1); ctx.lineTo(cx - HW * 0.45, cy + HH * 0.2);
    ctx.closePath(); ctx.fill();
    ct.refresh();
  }

  private updateStartCarImg(): void {
    this.startCarImg?.destroy();
    this.startCarImg = this.add.image(this.curStartX, this.curStartY, 'editor_car')
      .setAngle(this.curStartH).setOrigin(0.5).setDepth(6);
  }

  private updateFinishImg(): void {
    this.finishImg?.destroy(); this.finishImg = null;
    if (!this.finishMarker) return;
    this.finishImg = this.add.image(this.finishMarker.x, this.finishMarker.y, 'tile_finish_0')
      .setAngle(this.finishMarker.rotation).setOrigin(0.5).setDepth(4);
  }

  private updateCheckpointImgs(): void {
    for (const img of this.checkpointImgs) img.destroy();
    this.checkpointImgs = [];
    for (const cp of this.checkpoints) {
      const key = cp.shape === 'circle' ? 'tile_checkpoint_circle_0' : 'tile_checkpoint_0';
      this.checkpointImgs.push(
        this.add.image(cp.x, cp.y, key).setAngle(cp.rotation).setOrigin(0.5).setDepth(4),
      );
    }
  }

  // ── Selection overlay ────────────────────────────────────────────────────────

  private drawSelectionOverlay(): void {
    this.redrawGroupOutlines();
    this.selectionGfx.clear();
    this.connGfx.clear();

    if (this.selection?.kind === 'car') {
      this.drawMarkerRing(this.curStartX, this.curStartY, this.curStartH, 0x00eeff); return;
    }
    if (this.selection?.kind === 'finish' && this.finishMarker) {
      this.drawMarkerRing(this.finishMarker.x, this.finishMarker.y, this.finishMarker.rotation, 0xffdd00); return;
    }
    if (this.selection?.kind === 'checkpoint') {
      const cp = this.checkpoints[this.selection.idx];
      if (cp) this.drawMarkerRing(cp.x, cp.y, cp.rotation, 0x00ccff);
      return;
    }
    if (this.selection?.kind === 'multi') {
      this.drawMultiSelectionMarkers();
      return;
    }
    if (this.selection?.kind !== 'piece') return;

    const p = this.pieces[this.selection.idx];
    if (!p) return;
    const g = this.selectionGfx;

    // Rotate handle — drawn from the exit connector outward
    const conns = worldConnectors(p);
    const h     = getHandlePos(p);
    // Stem line from exit connector to handle
    g.lineStyle(2, 0x00eeff, 0.6);
    g.lineBetween(conns.exit.x, conns.exit.y, h.x, h.y);
    // Outer ring
    g.lineStyle(3, 0x00eeff, 1);
    g.strokeCircle(h.x, h.y, HANDLE_HIT_R);
    // Inner fill
    g.fillStyle(0x00eeff, 0.85);
    g.fillCircle(h.x, h.y, HANDLE_HIT_R - 5);
    // White centre dot
    g.fillStyle(0xffffff, 1);
    g.fillCircle(h.x, h.y, 4);

    // Connector direction arrows (on connGfx so they can be cleared independently) —
    // arrows point where the *next* piece placed from the palette would extend,
    // which is clearer than a plain dot once entry/exit both matter.
    const cg = this.connGfx;
    drawHeadingArrow(cg, conns.entry.x, conns.entry.y, conns.entry.heading, 0xffee00, 0.9, 11);
    drawHeadingArrow(cg, conns.exit.x,  conns.exit.y,  conns.exit.heading,  0x44ff88, 0.9, 11);

    // Other pieces' connectors during move drag
    if (this.snapEnabled && this.dragOp?.kind === 'move') {
      for (let i = 0; i < this.pieces.length; i++) {
        if (i === this.selection.idx) continue;
        const oc = worldConnectors(this.pieces[i]);
        drawHeadingArrow(cg, oc.exit.x,  oc.exit.y,  oc.exit.heading,  0xff8844, 0.75, 9);
        drawHeadingArrow(cg, oc.entry.x, oc.entry.y, oc.entry.heading, 0x4488ff, 0.75, 9);
      }
    }
  }

  // Draws a ring (no rotate handle) around each selected finish/checkpoint
  // marker in a multi-selection. Selected pieces get their own precise
  // marching-ants outline via the selHighlights pool instead (see
  // updateSelectionHighlights), not drawn here.
  private drawMultiSelectionMarkers(): void {
    if (this.selection?.kind !== 'multi') return;
    if (this.selection.finish && this.finishMarker) {
      this.drawMarkerRing(this.finishMarker.x, this.finishMarker.y, this.finishMarker.rotation, 0xffdd00, false);
    }
    for (const idx of this.selection.checkpoints) {
      const cp = this.checkpoints[idx];
      if (cp) this.drawMarkerRing(cp.x, cp.y, cp.rotation, 0x00ccff, false);
    }
  }

  // Rubber-band marquee rectangle drawn while dragging from empty canvas space.
  private drawMarquee(wx0: number, wy0: number, wx1: number, wy1: number): void {
    this.marqueeGfx.clear();
    const x0 = Math.min(wx0, wx1), x1 = Math.max(wx0, wx1);
    const y0 = Math.min(wy0, wy1), y1 = Math.max(wy0, wy1);
    this.marqueeGfx.fillStyle(0x00ddff, 0.08);
    this.marqueeGfx.fillRect(x0, y0, x1 - x0, y1 - y0);
    const pts = [
      { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 },
    ];
    drawDashedPolyline(this.marqueeGfx, pts, true, 8, 6, this.selDashOffset, 0x00ddff, 1, 2);
  }

  private drawMarkerRing(x: number, y: number, rotDeg: number, color: number, withHandle = true): void {
    const r = 38, g = this.selectionGfx;
    g.lineStyle(2, color, 0.9); g.strokeCircle(x, y, r);
    g.fillStyle(color, 1);
    for (const [dx, dy] of [[0,-r],[r,0],[0,r],[-r,0]] as [number,number][]) {
      g.fillCircle(x + dx, y + dy, 3.5);
    }
    if (!withHandle) return;
    // Rotation handle — identical style to piece handles
    const h = getMarkerHandlePos(x, y, rotDeg);
    g.lineStyle(2, color, 0.6);
    g.lineBetween(x, y, h.x, h.y);
    g.lineStyle(3, color, 1);
    g.strokeCircle(h.x, h.y, HANDLE_HIT_R);
    g.fillStyle(color, 0.85);
    g.fillCircle(h.x, h.y, HANDLE_HIT_R - 5);
    g.fillStyle(0xffffff, 1);
    g.fillCircle(h.x, h.y, 4);
  }

  // ── Hit testing ─────────────────────────────────────────────────────────────

  private hitTestPiece(wx: number, wy: number): number | null {
    for (let i = this.pieces.length - 1; i >= 0; i--) {
      const p = this.pieces[i];
      const dx = wx - p.x, dy = wy - p.y;
      if (p.type === 'straight') {
        const half = STRAIGHT_LEN[(p as StraightDef).size] / 2;
        const rad  = p.rotation * Math.PI / 180;
        const c = Math.cos(rad), s = Math.sin(rad);
        const lx = dx * c + dy * s, ly = -dx * s + dy * c;
        if (Math.abs(lx) <= HALF_TRACK * 1.15 && Math.abs(ly) <= half * 1.1) return i;
      } else {
        const { outerR, innerR } = CORNER_RADII[p.type];
        const dist   = Math.hypot(dx, dy);
        // Annular radial check
        if (dist >= outerR || dist <= Math.max(innerR - 8, 4)) continue;
        // Angular sector check: transform touch to local piece space, then
        // verify it falls within the arc's angular sweep.
        const pRad = p.rotation * Math.PI / 180;
        const pc = Math.cos(pRad), ps = Math.sin(pRad);
        const lx = dx * pc + dy * ps;   // undo piece rotation
        const ly = -dx * ps + dy * pc;
        const flip   = (p as CornerDef).flip ?? false;
        const θr     = (p as CornerDef).angle * Math.PI / 180;
        const c      = connectors(p);
        const eAngle = Math.atan2(c.entryY, c.entryX);
        const tAngle = Math.atan2(ly, lx);
        // Relative angle sweeping CW on screen (= increasing atan2).
        // Right turn sweeps [0, θ], left turn sweeps [2π-θ, 2π].
        const rel = ((tAngle - eAngle) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
        const TOL = 8 * Math.PI / 180; // 8° tolerance at arc edges
        const inArc = flip ? rel >= (2 * Math.PI - θr - TOL) : rel <= (θr + TOL);
        if (inArc) return i;
      }
    }
    return null;
  }

  private hitTestHandle(wx: number, wy: number): boolean {
    const sel = this.selection;
    if (!sel) return false;
    if (sel.kind === 'piece') {
      const p = this.pieces[sel.idx];
      if (!p) return false;
      const h = getHandlePos(p);
      return Math.hypot(wx - h.x, wy - h.y) < HANDLE_HIT_R;
    }
    if (sel.kind === 'car') {
      const h = getMarkerHandlePos(this.curStartX, this.curStartY, this.curStartH);
      return Math.hypot(wx - h.x, wy - h.y) < HANDLE_HIT_R;
    }
    if (sel.kind === 'finish' && this.finishMarker) {
      const h = getMarkerHandlePos(this.finishMarker.x, this.finishMarker.y, this.finishMarker.rotation);
      return Math.hypot(wx - h.x, wy - h.y) < HANDLE_HIT_R;
    }
    if (sel.kind === 'checkpoint') {
      const cp = this.checkpoints[sel.idx];
      if (!cp) return false;
      const h = getMarkerHandlePos(cp.x, cp.y, cp.rotation);
      return Math.hypot(wx - h.x, wy - h.y) < HANDLE_HIT_R;
    }
    return false;
  }

  // ── Input ───────────────────────────────────────────────────────────────────

  private onDown(ptr: Phaser.Input.Pointer): void {
    if (ptr.y > this.scale.height - this.paletteH()) return;
    this.touches.set(ptr.id, { x: ptr.x, y: ptr.y });

    if (this.touches.size >= 2) {
      this.dragOp = null;
      const [a, b] = [...this.touches.values()];
      this.pinchDist = Math.hypot(b.x - a.x, b.y - a.y);
      this.pinchZoom = this.cameras.main.zoom;
      return;
    }

    const wx = ptr.worldX, wy = ptr.worldY;
    const cam = this.cameras.main;

    // Middle mouse button — always pans the camera, regardless of what's under
    // the pointer, without disturbing the current selection.
    if (ptr.button === 1) {
      this.dragOp = { kind: 'pan', sx: ptr.x, sy: ptr.y, scrollX: cam.scrollX, scrollY: cam.scrollY };
      return;
    }

    // Rotate handle — highest priority (covers pieces AND markers)
    if (this.hitTestHandle(wx, wy)) {
      this.saveUndo();
      const sel = this.selection!;
      if (sel.kind === 'piece') {
        const p = this.pieces[sel.idx];
        this.updateBarrierImg([sel.idx]);
        this.dragOp = { kind: 'rotate', idx: sel.idx, handleLocalAngle: getHandleLocalAngle(p) };
      } else if (sel.kind === 'car') {
        this.dragOp = { kind: 'rotate-car' };
      } else if (sel.kind === 'finish') {
        this.dragOp = { kind: 'rotate-finish' };
      } else if (sel.kind === 'checkpoint') {
        this.dragOp = { kind: 'rotate-checkpoint', idx: sel.idx };
      }
      return;
    }

    // Markers are tested before pieces because they visually sit on top of the
    // track and must win the hit test when both overlap.

    // Car
    if (Math.hypot(wx - this.curStartX, wy - this.curStartY) < HIT_R_MARKER) {
      this.selectMarker({ kind: 'car' });
      this.saveUndo();
      this.dragOp = { kind: 'move-car' };
      return;
    }

    // Finish
    if (this.finishMarker &&
        Math.hypot(wx - this.finishMarker.x, wy - this.finishMarker.y) < HIT_R_MARKER) {
      if (ptr.event.shiftKey) { this.toggleMultiSelectItem({ type: 'finish' }); return; }
      if (this.selection?.kind === 'multi' && this.selection.finish) {
        this.startMultiMoveDrag(wx, wy);
        return;
      }
      this.selectMarker({ kind: 'finish' });
      this.saveUndo();
      this.dragOp = { kind: 'move-finish' };
      return;
    }

    // Checkpoints
    for (let i = 0; i < this.checkpoints.length; i++) {
      const cp = this.checkpoints[i];
      if (Math.hypot(wx - cp.x, wy - cp.y) < HIT_R_MARKER) {
        if (ptr.event.shiftKey) { this.toggleMultiSelectItem({ type: 'checkpoint', idx: i }); return; }
        if (this.selection?.kind === 'multi' && this.selection.checkpoints.includes(i)) {
          this.startMultiMoveDrag(wx, wy);
          return;
        }
        this.selectMarker({ kind: 'checkpoint', idx: i });
        this.saveUndo();
        this.dragOp = { kind: 'move-checkpoint', idx: i };
        return;
      }
    }

    // Piece
    const pidx = this.hitTestPiece(wx, wy);
    if (pidx !== null) {
      // Shift+click toggles this piece in/out of a multi-selection instead of
      // starting a drag.
      if (ptr.event.shiftKey) {
        this.toggleMultiSelectItem({ type: 'piece', idx: pidx });
        return;
      }

      // Clicking an item that's already part of the current multi-selection
      // drags the whole group together; the selection itself is unchanged.
      if (this.selection?.kind === 'multi' && this.selection.pieces.includes(pidx)) {
        this.startMultiMoveDrag(wx, wy);
        return;
      }

      this.selectPiece(pidx);

      // selectPiece() expands to the whole group when pidx belongs to one —
      // drag that group together rather than falling through to a
      // single-piece move.
      if (this.selection?.kind === 'multi') {
        this.startMultiMoveDrag(wx, wy);
        return;
      }

      this.saveUndo();
      this.updateBarrierImg([pidx]);
      const p = this.pieces[pidx];
      this.dragOp = { kind: 'move', idx: pidx, offX: wx - p.x, offY: wy - p.y };
      this.drawSelectionOverlay();
      return;
    }

    // Empty space: Select Mode drags a rubber-band marquee (mouse or touch);
    // otherwise it always pans, on both mouse and touch — middle mouse still
    // pans regardless of mode too (handled above). A plain click/tap (no real
    // drag) on empty space still deselects either way.
    if (this.selectModeOn) {
      this.marqueeCurWX = wx; this.marqueeCurWY = wy;
      this.dragOp = { kind: 'marquee', startWX: wx, startWY: wy, startSX: ptr.x, startSY: ptr.y };
      return;
    }
    this.dragOp = { kind: 'pan', sx: ptr.x, sy: ptr.y, scrollX: cam.scrollX, scrollY: cam.scrollY, tapDeselect: true };
  }

  private onMove(ptr: Phaser.Input.Pointer): void {
    if (this.touches.has(ptr.id)) this.touches.set(ptr.id, { x: ptr.x, y: ptr.y });

    if (this.touches.size >= 2) {
      const [a, b] = [...this.touches.values()];
      const dist = Math.hypot(b.x - a.x, b.y - a.y);
      if (this.pinchDist > 0)
        this.cameras.main.setZoom(Math.min(Math.max(this.pinchZoom * dist / this.pinchDist, 0.12), 4));
      return;
    }

    if (!ptr.isDown || !this.dragOp) return;
    const op = this.dragOp;
    const wx = ptr.worldX, wy = ptr.worldY;

    if (op.kind === 'pan') {
      const z = this.cameras.main.zoom;
      this.cameras.main.setScroll(op.scrollX - (ptr.x - op.sx) / z, op.scrollY - (ptr.y - op.sy) / z);
      return;
    }

    if (op.kind === 'marquee') {
      this.marqueeCurWX = wx; this.marqueeCurWY = wy;
      this.drawMarquee(op.startWX, op.startWY, wx, wy);
      return;
    }

    if (op.kind === 'move-multi') {
      const dx = wx - op.startWX, dy = wy - op.startWY;
      for (let k = 0; k < op.pieces.length; k++) {
        const i = op.pieces[k];
        this.pieces[i] = { ...this.pieces[i], x: op.pieceOrigins[k].x + dx, y: op.pieceOrigins[k].y + dy };
      }
      if (op.finish && this.finishMarker && op.finishOrigin) {
        this.finishMarker.x = op.finishOrigin.x + dx;
        this.finishMarker.y = op.finishOrigin.y + dy;
        this.updateFinishImg();
      }
      for (let k = 0; k < op.checkpoints.length; k++) {
        const i  = op.checkpoints[k];
        const cp = this.checkpoints[i];
        const origin = op.checkpointOrigins[k];
        if (cp && origin) {
          cp.x = origin.x + dx; cp.y = origin.y + dy;
          this.checkpointImgs[i]?.setPosition(cp.x, cp.y);
        }
      }
      this.isDirty = true;
      // Keep every selected piece's marching-ants outline anchored as it moves
      for (let k = 0; k < op.pieces.length; k++) this.layoutHighlightSlot(k, op.pieces[k]);
      this.drawSelectionOverlay();
      return;
    }

    if (op.kind === 'move') {
      let updated = { ...this.pieces[op.idx], x: wx - op.offX, y: wy - op.offY };
      if (this.snapEnabled) {
        const snapped = trySnapPiece(updated, op.idx, this.pieces);
        if (snapped) updated = snapped;
      }
      this.pieces[op.idx] = updated;
      this.isDirty = true;
      // Keep the marching-ants outline anchored to the piece as it moves
      this.layoutHighlightSlot(0, op.idx);
      this.drawSelectionOverlay();
      return;
    }

    if (op.kind === 'rotate') {
      const p        = this.pieces[op.idx];
      const ptrAngle = Math.atan2(wy - p.y, wx - p.x);
      const rawDeg   = (ptrAngle - op.handleLocalAngle) * 180 / Math.PI;
      const newRot   = ((Math.round(rawDeg / 15) * 15) % 360 + 360) % 360;
      if (newRot === p.rotation) return; // no 15° snap change — skip redraw
      this.pieces[op.idx] = { ...p, rotation: newRot };
      this.isDirty = true;
      const angEl = document.getElementById('ed-ctrl-angle');
      if (angEl) angEl.textContent = `${newRot}°`;
      // Keep the marching-ants outline visible and current so the piece stays visible at the new angle.
      this.updateSelectionHighlights();
      this.drawSelectionOverlay();
      return;
    }

    if (op.kind === 'move-car') {
      const GRID = 24; // matches the drawn grid + the startX/Y-must-be-multiples-of-24 assumption elsewhere (ghost/AI solver)
      this.curStartX = Math.round(wx / GRID) * GRID;
      this.curStartY = Math.round(wy / GRID) * GRID;
      this.updateStartCarImg(); this.drawSelectionOverlay(); this.isDirty = true;
      return;
    }

    if (op.kind === 'move-finish' && this.finishMarker) {
      this.finishMarker.x = wx; this.finishMarker.y = wy;
      this.updateFinishImg(); this.drawSelectionOverlay(); this.isDirty = true;
      return;
    }

    if (op.kind === 'move-checkpoint') {
      const cp = this.checkpoints[op.idx];
      const img = this.checkpointImgs[op.idx];
      if (cp && img) {
        cp.x = wx; cp.y = wy;
        img.setPosition(wx, wy);
        this.drawSelectionOverlay(); this.isDirty = true;
      }
      return;
    }

    if (op.kind === 'rotate-car') {
      const r = snapMarkerRotation(wx, wy, this.curStartX, this.curStartY);
      if (r === this.curStartH) return;
      this.curStartH = r;
      const angEl = document.getElementById('ed-ctrl-angle');
      if (angEl) angEl.textContent = `${r}°`;
      this.updateStartCarImg(); this.drawSelectionOverlay(); this.isDirty = true;
      return;
    }

    if (op.kind === 'rotate-finish' && this.finishMarker) {
      const r = snapMarkerRotation(wx, wy, this.finishMarker.x, this.finishMarker.y);
      if (r === this.finishMarker.rotation) return;
      this.finishMarker.rotation = r;
      const angEl = document.getElementById('ed-ctrl-angle');
      if (angEl) angEl.textContent = `${r}°`;
      this.updateFinishImg(); this.drawSelectionOverlay(); this.isDirty = true;
      return;
    }

    if (op.kind === 'rotate-checkpoint') {
      const cp  = this.checkpoints[op.idx];
      const img = this.checkpointImgs[op.idx];
      if (!cp || !img) return;
      const r = snapMarkerRotation(wx, wy, cp.x, cp.y);
      if (r === cp.rotation) return;
      cp.rotation = r;
      img.setAngle(r);
      const angEl = document.getElementById('ed-ctrl-angle');
      if (angEl) angEl.textContent = `${r}°`;
      this.drawSelectionOverlay(); this.isDirty = true;
      return;
    }
  }

  private onUp(ptr: Phaser.Input.Pointer): void {
    const wasPinching = this.touches.size >= 2;
    this.touches.delete(ptr.id);
    if (wasPinching) {
      this.pinchDist = 0;
      const rem = [...this.touches.values()][0];
      if (rem) {
        const cam = this.cameras.main;
        this.dragOp = { kind: 'pan', sx: rem.x, sy: rem.y, scrollX: cam.scrollX, scrollY: cam.scrollY };
      }
      return;
    }

    // Touch-pan-on-empty-space: a real drag just pans (handled live in
    // onMove); a tap that barely moved deselects, matching the old
    // single-touch behavior and the mouse marquee's click fallback below.
    if (this.dragOp?.kind === 'pan' && this.dragOp.tapDeselect) {
      const op = this.dragOp;
      this.dragOp = null;
      if (Math.hypot(ptr.x - op.sx, ptr.y - op.sy) < 6) this.deselectAllWithUndo();
      return;
    }

    if (this.dragOp?.kind === 'marquee') {
      const op = this.dragOp;
      this.marqueeGfx.clear();
      this.dragOp = null;

      // A negligible drag distance is treated as a plain click on empty space.
      const movedPx = Math.hypot(ptr.x - op.startSX, ptr.y - op.startSY);
      const shiftHeld = ptr.event.shiftKey;
      if (movedPx < 6) {
        if (!shiftHeld) this.deselectAllWithUndo();
        return;
      }

      const wx = ptr.worldX, wy = ptr.worldY;
      const x0 = Math.min(op.startWX, wx), x1 = Math.max(op.startWX, wx);
      const y0 = Math.min(op.startWY, wy), y1 = Math.max(op.startWY, wy);
      // "Contains" semantics: an item is only selected if it's entirely inside
      // the marquee, not merely touched by it. A pure overlap test used each
      // piece's (conservative, circle-based for corners) bounding box, so a
      // corner piece whose bounds happened to graze the rectangle could get
      // selected even though its visible arc was nowhere near it.
      const rectContainsCircle = (mx: number, my: number, r: number) =>
        mx - r >= x0 && mx + r <= x1 && my - r >= y0 && my + r <= y1;

      const hitPieces: number[] = [];
      for (let i = 0; i < this.pieces.length; i++) {
        const b = pieceVisibleBounds(this.pieces[i]);
        if (b.x >= x0 && b.x + b.width <= x1 && b.y >= y0 && b.y + b.height <= y1) hitPieces.push(i);
      }
      const hitFinish = !!this.finishMarker && rectContainsCircle(this.finishMarker.x, this.finishMarker.y, HIT_R_MARKER);
      const hitCheckpoints: number[] = [];
      for (let i = 0; i < this.checkpoints.length; i++) {
        const cp = this.checkpoints[i];
        if (rectContainsCircle(cp.x, cp.y, HIT_R_MARKER)) hitCheckpoints.push(i);
      }

      let finalPieces: number[], finalFinish: boolean, finalCheckpoints: number[];
      if (shiftHeld) {
        const existing   = this.selectionAsMulti(this.selection);
        finalPieces      = [...new Set([...existing.pieces, ...hitPieces])];
        finalFinish      = existing.finish || hitFinish;
        finalCheckpoints = [...new Set([...existing.checkpoints, ...hitCheckpoints])];
      } else {
        finalPieces = hitPieces; finalFinish = hitFinish; finalCheckpoints = hitCheckpoints;
      }
      this.setMultiSelection({ pieces: finalPieces, finish: finalFinish, checkpoints: finalCheckpoints });
      return;
    }

    // Double-tap a piece (touch): reverse its entry/exit.
    const preTapOp = this.dragOp;
    if (
      preTapOp?.kind === 'move' && ptr.wasTouch
      && Math.hypot(ptr.x - ptr.downX, ptr.y - ptr.downY) < 6
    ) {
      const idx = preTapOp.idx;
      const now = Date.now();
      if (this.lastTapPieceIdx === idx && now - this.lastTapTime < 350) {
        this.dragOp = null;
        this.lastTapPieceIdx = null;
        this.selectPiece(idx);
        this.reverseSelectedPiece();
        return;
      }
      this.lastTapPieceIdx = idx;
      this.lastTapTime = now;
    }

    // Commit drag: rebuild barrier with all pieces, refresh highlight + props.
    // dragOp is nulled BEFORE drawSelectionOverlay so it doesn't draw drag-preview
    // lines (cyan straight/arc outlines) that should only appear while dragging.
    const endedDrag = this.dragOp?.kind === 'move' || this.dragOp?.kind === 'rotate' || this.dragOp?.kind === 'move-multi';
    this.dragOp = null;
    if (endedDrag) {
      this.updateBarrierImg();
      this.updateSelectionHighlights();
      this.drawSelectionOverlay();
      this.rebuildCtrlRow();
    }
  }

  // ── Selection management ──────────────────────────────────────────────────────

  private selectPiece(idx: number): void {
    // Selecting any piece of a group selects the whole group.
    const withGroup = this.expandGroupMembership([idx]);
    if (withGroup.length > 1) {
      this.setMultiSelection({ pieces: withGroup, finish: false, checkpoints: [] });
      return;
    }
    this.selection = { kind: 'piece', idx };
    this.updateSelectionHighlights();
    this.rebuildCtrlRow();
    this.drawSelectionOverlay();
  }

  // Given a set of piece indices, returns it expanded to include every other
  // piece sharing a groupId with any of them — grouped pieces are always
  // selected/moved/deleted/copied together as a unit.
  private expandGroupMembership(pieceIdxs: number[]): number[] {
    const groupIds = new Set(pieceIdxs.map(i => this.pieces[i]?.groupId).filter((g): g is string => !!g));
    if (groupIds.size === 0) return pieceIdxs;
    const result = new Set(pieceIdxs);
    for (let i = 0; i < this.pieces.length; i++) {
      const gid = this.pieces[i].groupId;
      if (gid && groupIds.has(gid)) result.add(i);
    }
    return [...result];
  }

  private newGroupId(): string {
    return `grp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  private selectMarker(sel: Exclude<Selection, null | { kind: 'piece' } | { kind: 'multi' }>): void {
    this.selection = sel;
    this.updateSelectionHighlights(); // clears any leftover piece pool entries
    this.rebuildCtrlRow();
    this.drawSelectionOverlay();
  }

  private deselectAll(): void {
    this.selection = null;
    this.selectionGfx.clear();
    this.connGfx.clear();
    this.updateSelectionHighlights(); // trims the highlight pool to empty
    this.redrawGroupOutlines();
    this.rebuildCtrlRow();
  }

  // Normalizes a multi-item selection into the right Selection shape: nothing
  // selected deselects, exactly one item collapses to the precise
  // single-selection highlight, two or more become a multi-selection.
  private setMultiSelection(m: MultiSel): void {
    // Selecting any piece of a group (by marquee, shift-click, paste, etc.)
    // brings in the rest of that group too.
    const pieces      = [...new Set(this.expandGroupMembership(m.pieces))].sort((a, b) => a - b);
    const checkpoints = [...new Set(m.checkpoints)].sort((a, b) => a - b);
    const finish      = m.finish && !!this.finishMarker;
    const total = pieces.length + (finish ? 1 : 0) + checkpoints.length;

    if (total === 0) { this.deselectAll(); return; }
    if (total === 1) {
      if (pieces.length === 1)      { this.selectPiece(pieces[0]); return; }
      if (finish)                   { this.selectMarker({ kind: 'finish' }); return; }
      this.selectMarker({ kind: 'checkpoint', idx: checkpoints[0] });
      return;
    }
    this.selection = { kind: 'multi', pieces, finish, checkpoints };
    this.updateSelectionHighlights();
    this.rebuildCtrlRow();
    this.drawSelectionOverlay();
  }

  // Converts any current selection into MultiSel shape (car has no multi-select
  // equivalent, so it maps to "nothing"). Shared by shift-click toggling and
  // touch's tap-to-add.
  private selectionAsMulti(sel: Selection): MultiSel {
    if (sel?.kind === 'multi')      return { pieces: [...sel.pieces], finish: sel.finish, checkpoints: [...sel.checkpoints] };
    if (sel?.kind === 'piece')      return { pieces: [sel.idx], finish: false, checkpoints: [] };
    if (sel?.kind === 'finish')     return { pieces: [], finish: true, checkpoints: [] };
    if (sel?.kind === 'checkpoint') return { pieces: [], finish: false, checkpoints: [sel.idx] };
    return { pieces: [], finish: false, checkpoints: [] };
  }

  // Shift+click on a piece, the finish line, or a checkpoint — add/remove it
  // from the current selection.
  private toggleMultiSelectItem(item: SelItem): void {
    const m = this.selectionAsMulti(this.selection);
    if (item.type === 'piece') {
      // Toggle the whole group together, not just the clicked piece.
      const group = this.expandGroupMembership([item.idx]);
      const allIn = group.every(i => m.pieces.includes(i));
      m.pieces = allIn ? m.pieces.filter(i => !group.includes(i)) : [...new Set([...m.pieces, ...group])];
    } else if (item.type === 'finish') {
      m.finish = !m.finish;
    } else {
      m.checkpoints = m.checkpoints.includes(item.idx) ? m.checkpoints.filter(i => i !== item.idx) : [...m.checkpoints, item.idx];
    }
    this.setMultiSelection(m);
  }

  // Starts dragging the entire current multi-selection (pieces + finish +
  // checkpoints) together, preserving each item's offset from the pointer.
  private startMultiMoveDrag(wx: number, wy: number): void {
    if (this.selection?.kind !== 'multi') return;
    this.saveUndo();
    const { pieces, finish, checkpoints } = this.selection;
    const pieceOrigins = pieces.map(i => ({ x: this.pieces[i].x, y: this.pieces[i].y }));
    const finishOrigin = finish && this.finishMarker ? { x: this.finishMarker.x, y: this.finishMarker.y } : null;
    const checkpointOrigins = checkpoints.map(i => ({ x: this.checkpoints[i].x, y: this.checkpoints[i].y }));
    this.updateBarrierImg(pieces);
    this.dragOp = {
      kind: 'move-multi', pieces, finish, checkpoints,
      startWX: wx, startWY: wy, pieceOrigins, finishOrigin, checkpointOrigins,
    };
    this.drawSelectionOverlay();
  }

  // True if `pieceIdxs` is exactly the full membership of one existing group
  // (not a subset, not a superset, not a mix of groups/ungrouped pieces).
  private isExactGroup(pieceIdxs: number[]): boolean {
    if (pieceIdxs.length < 2) return false;
    const groupIds = new Set(pieceIdxs.map(i => this.pieces[i]?.groupId).filter((g): g is string => !!g));
    if (groupIds.size !== 1) return false;
    const [gid] = groupIds;
    let count = 0;
    for (const p of this.pieces) if (p.groupId === gid) count++;
    return count === pieceIdxs.length;
  }

  // Ctrl+G — group the current multi-selection of pieces into a unit that
  // always selects/moves/copies together from now on; Ctrl+G again while
  // that exact group is selected ungroups it. Desktop-only in practice,
  // since it's a keyboard shortcut with no touch equivalent.
  private toggleGroupSelected(): void {
    if (this.selection?.kind !== 'multi' || this.selection.pieces.length < 2) return;
    const idxs = this.selection.pieces;

    if (this.isExactGroup(idxs)) {
      this.saveUndo();
      for (const i of idxs) this.pieces[i] = { ...this.pieces[i], groupId: undefined };
      this.isDirty = true;
      this.showToast(`Ungrouped ${idxs.length} pieces`);
      this.redrawGroupOutlines();
      this.rebuildCtrlRow();
      return;
    }

    // Otherwise: group the current selection (overwriting any prior group
    // membership of its pieces).
    this.saveUndo();
    const gid = this.newGroupId();
    for (const i of idxs) this.pieces[i] = { ...this.pieces[i], groupId: gid };
    this.isDirty = true;
    this.showToast(`Grouped ${idxs.length} pieces`);
    this.redrawGroupOutlines();
    this.rebuildCtrlRow();
  }

  // ── Piece & marker management ─────────────────────────────────────────────────

  private addPieceFromPalette(def: PieceDef): void {
    if (this.pieces.length >= MAX_PIECES) {
      this.showToast(`Track limit reached (${MAX_PIECES} pieces)`);
      return;
    }
    this.saveUndo();
    let newX = this.viewCenterX(), newY = this.viewCenterY(), newRot = 0;

    // Extend from the selected piece's exit if one is selected (its exit is
    // whichever end reverseSelectedPiece() has left open for chaining);
    // otherwise fall back to the array's last piece, same as before.
    const attachFrom = this.selection?.kind === 'piece' ? this.pieces[this.selection.idx]
      : this.pieces.length > 0 ? this.pieces[this.pieces.length - 1]
      : null;
    if (attachFrom) {
      const lconn = worldConnectors(attachFrom);
      const dc    = connectors(def);
      newRot = ((lconn.exit.heading - dc.entryH) % 360 + 360) % 360;
      const [nex, ney] = rotateCW(dc.entryX, dc.entryY, newRot);
      newX = lconn.exit.x - nex;
      newY = lconn.exit.y - ney;
    }

    const piece: PlacedPiece = { ...def, x: newX, y: newY, rotation: newRot };
    this.pieces.push(piece);
    const idx = this.pieces.length - 1;
    this.updateBarrierImg();
    this.selectPiece(idx);
    this.scrollToShowPieces([idx]);
    this.spawnPiecePop(piece);
    this.isDirty = true;
  }

  // Quick scale-from-zero "drop in" pop at a newly placed piece's location.
  private spawnPiecePop(piece: PlacedPiece): void {
    const b = pieceVisibleBounds(piece);
    const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
    const ring = this.add.graphics();
    ring.lineStyle(2.5, 0x55ff77, 0.9);
    ring.strokeCircle(0, 0, 10);
    ring.setPosition(cx, cy);
    ring.setDepth(8);
    ring.setScale(0.1);
    this.tweens.add({
      targets: ring,
      scaleX: 1, scaleY: 1, alpha: { from: 1, to: 0 },
      duration: 260,
      ease: 'Back.easeOut',
      onComplete: () => ring.destroy(),
    });
  }

  // Quick shrink-and-fade at a piece's former location right before it's removed.
  private spawnPieceDeleteFade(piece: PlacedPiece): void {
    const b = pieceVisibleBounds(piece);
    const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
    const ring = this.add.graphics();
    ring.lineStyle(2.5, 0xff8888, 0.9);
    ring.strokeCircle(0, 0, 14);
    ring.setPosition(cx, cy);
    ring.setDepth(8);
    this.tweens.add({
      targets: ring,
      scaleX: 0.1, scaleY: 0.1, alpha: 0,
      duration: 200,
      ease: 'Quad.easeIn',
      onComplete: () => ring.destroy(),
    });
  }

  private deletePiece(idx: number): void {
    this.spawnPieceDeleteFade(this.pieces[idx]);
    this.pieces.splice(idx, 1);
    if (this.selection?.kind === 'piece') {
      const si = this.selection.idx;
      if (si === idx) {
        this.deselectAll();
      } else if (si > idx) {
        this.selection = { kind: 'piece', idx: si - 1 };
        this.rebuildCtrlRow();
      }
    }
    this.updateBarrierImg();
    this.drawSelectionOverlay();
    this.isDirty = true;
  }

  // Removes an entire multi-selection at once — pieces, the finish line, and
  // checkpoints together. Pieces/checkpoints splice from the highest index
  // down so earlier indices in each list stay valid.
  private deleteMultiSelection(sel: MultiSel): void {
    for (const i of [...sel.pieces].sort((a, b) => b - a)) this.pieces.splice(i, 1);
    if (sel.finish) { this.finishMarker = null; this.updateFinishImg(); }
    for (const i of [...sel.checkpoints].sort((a, b) => b - a)) this.checkpoints.splice(i, 1);
    if (sel.checkpoints.length) this.updateCheckpointImgs();
    this.deselectAll();
    this.updateBarrierImg();
    this.drawSelectionOverlay();
    this.isDirty = true;
  }

  // Spawn position for a new marker: exit connector of the last placed piece,
  // oriented to match the track heading at that point.
  private markerSpawnPos(): { x: number; y: number; rotation: number } {
    const last = this.pieces[this.pieces.length - 1];
    const { exit } = worldConnectors(last);
    return { x: exit.x, y: exit.y, rotation: exit.heading };
  }

  private placeFinish(): void {
    if (this.pieces.length === 0) { this.showToast('Add track pieces first'); return; }
    this.saveUndo();
    const { x, y, rotation } = this.markerSpawnPos();
    this.finishMarker = { kind: 'finish', shape: 'gate', x, y, rotation };
    this.updateFinishImg();
    this.selectMarker({ kind: 'finish' });
    this.showToast('Finish placed — drag to position');
    this.isDirty = true;
  }

  private placeCheckpoint(shape: 'gate' | 'circle'): void {
    if (this.pieces.length === 0) { this.showToast('Add track pieces first'); return; }
    this.saveUndo();
    const { x, y, rotation } = this.markerSpawnPos();
    const idx = this.checkpoints.length;
    this.checkpoints.push({ kind: 'checkpoint', shape, x, y, rotation });
    this.updateCheckpointImgs();
    this.selectMarker({ kind: 'checkpoint', idx });
    this.showToast('Checkpoint placed — drag to position');
    this.isDirty = true;
  }

  // Nudges whatever is selected by (dx, dy) world px — bound to the arrow
  // keys for pixel-precise positioning (drag/snap is coarser). pushUndo is
  // false for OS key-repeat events so holding an arrow key coalesces into a
  // single undo step instead of one per repeated keydown.
  private nudgeSelection(dx: number, dy: number, pushUndo: boolean): void {
    const sel = this.selection;
    if (!sel) return;
    if (pushUndo) this.saveUndo();

    if (sel.kind === 'piece') {
      const p = this.pieces[sel.idx];
      this.pieces[sel.idx] = { ...p, x: p.x + dx, y: p.y + dy };
      this.updateBarrierImg();
      this.layoutHighlightSlot(0, sel.idx);
    } else if (sel.kind === 'car') {
      this.curStartX += dx; this.curStartY += dy;
      this.updateStartCarImg();
    } else if (sel.kind === 'finish' && this.finishMarker) {
      this.finishMarker.x += dx; this.finishMarker.y += dy;
      this.updateFinishImg();
    } else if (sel.kind === 'checkpoint') {
      const cp = this.checkpoints[sel.idx];
      if (!cp) return;
      cp.x += dx; cp.y += dy;
      this.updateCheckpointImgs();
    } else if (sel.kind === 'multi') {
      for (const i of sel.pieces) {
        const p = this.pieces[i];
        this.pieces[i] = { ...p, x: p.x + dx, y: p.y + dy };
      }
      if (sel.finish && this.finishMarker) {
        this.finishMarker.x += dx; this.finishMarker.y += dy;
        this.updateFinishImg();
      }
      for (const i of sel.checkpoints) {
        const cp = this.checkpoints[i];
        if (cp) { cp.x += dx; cp.y += dy; }
      }
      if (sel.checkpoints.length) this.updateCheckpointImgs();
      if (sel.pieces.length) { this.updateBarrierImg(); this.updateSelectionHighlights(); }
    }

    this.drawSelectionOverlay();
    this.isDirty = true;
  }

  private rotateSelected(delta: number): void {
    if (this.selection?.kind === 'piece') {
      const p = this.pieces[this.selection.idx];
      this.pieces[this.selection.idx] = { ...p, rotation: ((p.rotation + delta) % 360 + 360) % 360 };
      this.updateBarrierImg();
      this.updateSelectionHighlights();
      this.drawSelectionOverlay();
      this.rebuildCtrlRow();
      this.isDirty = true;
    } else if (this.selection?.kind === 'multi') {
      this.rotateMultiSelection(this.selection, delta);
    } else if (this.selection?.kind === 'car') {
      this.curStartH = ((this.curStartH + delta) % 360 + 360) % 360;
      this.updateStartCarImg(); this.rebuildCtrlRow(); this.isDirty = true;
    } else if (this.selection?.kind === 'finish' && this.finishMarker) {
      this.finishMarker.rotation = ((this.finishMarker.rotation + delta) % 360 + 360) % 360;
      this.updateFinishImg(); this.rebuildCtrlRow(); this.isDirty = true;
    } else if (this.selection?.kind === 'checkpoint') {
      const cp = this.checkpoints[this.selection.idx];
      if (cp) { cp.rotation = ((cp.rotation + delta) % 360 + 360) % 360; this.updateCheckpointImgs(); this.rebuildCtrlRow(); this.isDirty = true; }
    }
    this.showToast(delta > 0 ? 'Rotated +15°' : 'Rotated −15°');
  }

  // Bounding-box center of every item in a multi-selection — pieces, the
  // finish line, and checkpoints together — used as the pivot for group
  // rotation.
  private multiSelectionCenter(sel: MultiSel): { cx: number; cy: number } {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const extend = (x: number, y: number) => {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    };
    for (const i of sel.pieces) {
      const b = trackBounds([this.pieces[i]]);
      extend(b.x, b.y); extend(b.x + b.width, b.y + b.height);
    }
    if (sel.finish && this.finishMarker) extend(this.finishMarker.x, this.finishMarker.y);
    for (const i of sel.checkpoints) { const cp = this.checkpoints[i]; extend(cp.x, cp.y); }
    if (!isFinite(minX)) return { cx: 0, cy: 0 };
    return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
  }

  // Rotates a whole multi-selection as a rigid group — pieces, the finish
  // line, and checkpoints together — around its combined bounding-box
  // center, so connected sub-assemblies stay connected.
  private rotateMultiSelection(sel: MultiSel, delta: number): void {
    const { cx, cy } = this.multiSelectionCenter(sel);
    for (const i of sel.pieces) {
      const p = this.pieces[i];
      const [rx, ry] = rotateCW(p.x - cx, p.y - cy, delta);
      this.pieces[i] = { ...p, x: cx + rx, y: cy + ry, rotation: ((p.rotation + delta) % 360 + 360) % 360 };
    }
    if (sel.finish && this.finishMarker) {
      const fm = this.finishMarker;
      const [rx, ry] = rotateCW(fm.x - cx, fm.y - cy, delta);
      fm.x = cx + rx; fm.y = cy + ry;
      fm.rotation = ((fm.rotation + delta) % 360 + 360) % 360;
      this.updateFinishImg();
    }
    for (const i of sel.checkpoints) {
      const cp = this.checkpoints[i];
      const [rx, ry] = rotateCW(cp.x - cx, cp.y - cy, delta);
      cp.x = cx + rx; cp.y = cy + ry;
      cp.rotation = ((cp.rotation + delta) % 360 + 360) % 360;
    }
    if (sel.checkpoints.length) this.updateCheckpointImgs();
    this.updateBarrierImg();
    this.updateSelectionHighlights();
    this.drawSelectionOverlay();
    this.rebuildCtrlRow();
    this.isDirty = true;
  }

  private changePieceWalls(walls: WallVariant): void {
    if (this.selection?.kind !== 'piece') return;
    this.saveUndo();
    this.pieces[this.selection.idx] = { ...this.pieces[this.selection.idx], walls };
    this.updateBarrierImg(); this.updateSelectionHighlights(); this.drawSelectionOverlay(); this.rebuildCtrlRow(); this.isDirty = true;
  }

  // Given the old piece at `idx` and a candidate replacement (same shape as
  // oldPiece but with different flip/angle/size — position/rotation are just
  // placeholders), re-anchors the candidate so whichever of its connectors a
  // neighbor is snapped to keeps that connector's world position and heading
  // fixed; the other connector moves to fit the new shape. Falls back to the
  // candidate's placeholder position/rotation if no neighbor is snapped.
  private anchorReshapedPiece(idx: number, oldPiece: PlacedPiece, candidate: PlacedPiece): PlacedPiece {
    const newC = connectors(candidate);
    const { entry: oldEntry, exit: oldExit } = worldConnectors(oldPiece);
    for (let i = 0; i < this.pieces.length; i++) {
      if (i === idx) continue;
      const oc = worldConnectors(this.pieces[i]);

      // Our entry is snapped to their exit — anchor on entry
      if (Math.hypot(oldEntry.x - oc.exit.x, oldEntry.y - oc.exit.y) < SNAP_R) {
        const newRot = ((oldEntry.heading - newC.entryH) % 360 + 360) % 360;
        const [nex, ney] = rotateCW(newC.entryX, newC.entryY, newRot);
        return { ...candidate, rotation: newRot, x: oldEntry.x - nex, y: oldEntry.y - ney };
      }

      // Our exit is snapped to their entry — anchor on exit
      if (Math.hypot(oldExit.x - oc.entry.x, oldExit.y - oc.entry.y) < SNAP_R) {
        const newRot = ((oldExit.heading - newC.exitH) % 360 + 360) % 360;
        const [nxx, nxy] = rotateCW(newC.exitX, newC.exitY, newRot);
        return { ...candidate, rotation: newRot, x: oldExit.x - nxx, y: oldExit.y - nxy };
      }
    }
    return candidate;
  }

  private changePieceFlip(flip: boolean): void {
    if (this.selection?.kind !== 'piece') return;
    const idx = this.selection.idx;
    const p = this.pieces[idx];
    if (p.type === 'straight') return;
    this.saveUndo();

    const candidate: PlacedPiece = { ...(p as CornerDef & { x: number; y: number; rotation: number }), flip };
    this.pieces[idx] = this.anchorReshapedPiece(idx, p, candidate);
    this.updateBarrierImg(); this.updateSelectionHighlights(); this.drawSelectionOverlay(); this.rebuildCtrlRow(); this.isDirty = true;
  }

  private changePieceFamily(family: CornerFamily): void {
    if (this.selection?.kind !== 'piece') return;
    const idx = this.selection.idx;
    const p = this.pieces[idx];
    if (p.type === 'straight') return;
    this.saveUndo();

    const candidate: PlacedPiece = { ...(p as CornerDef & { x: number; y: number; rotation: number }), type: family };
    this.pieces[idx] = this.anchorReshapedPiece(idx, p, candidate);
    this.updateBarrierImg(); this.updateSelectionHighlights(); this.drawSelectionOverlay(); this.rebuildCtrlRow(); this.isDirty = true;
  }

  // Cycles the selected piece's shape variant: corner angle (15°–90°) or
  // straight length (XS–L), wrapping past the min/max. Bound to +/- keys.
  private cyclePieceSize(delta: 1 | -1): void {
    if (this.selection?.kind !== 'piece') return;
    const idx = this.selection.idx;
    const p = this.pieces[idx];
    this.saveUndo();

    if (p.type === 'straight') {
      const i    = STRAIGHT_SIZES.indexOf(p.size);
      const next = STRAIGHT_SIZES[(i + delta + STRAIGHT_SIZES.length) % STRAIGHT_SIZES.length];
      const candidate: PlacedPiece = { ...(p as StraightDef & { x: number; y: number; rotation: number }), size: next };
      this.pieces[idx] = this.anchorReshapedPiece(idx, p, candidate);
      const labels: Record<StraightSize, string> = { 25: 'XS', 50: 'S', 75: 'M', 100: 'L' };
      this.showToast(`Size: ${labels[next]}`);
    } else {
      const i    = CORNER_ANGLES.indexOf(p.angle);
      const next = CORNER_ANGLES[(i + delta + CORNER_ANGLES.length) % CORNER_ANGLES.length];
      const candidate: PlacedPiece = { ...(p as CornerDef & { x: number; y: number; rotation: number }), angle: next };
      this.pieces[idx] = this.anchorReshapedPiece(idx, p, candidate);
      this.showToast(`Angle: ${next}°`);
    }

    this.updateBarrierImg(); this.updateSelectionHighlights(); this.drawSelectionOverlay(); this.rebuildCtrlRow(); this.isDirty = true;
  }

  // Swaps which end of the selected piece is "entry" vs "exit" for chaining
  // purposes. The piece's physical shape/position/rotation never change —
  // walls and barriers don't depend on entry/exit — so this is purely a
  // relabel: it lets addPieceFromPalette() extend the track from what used
  // to be this piece's entry side instead, i.e. build in the other direction.
  private reverseSelectedPiece(): void {
    if (this.selection?.kind !== 'piece') return;
    const idx = this.selection.idx;
    const p = this.pieces[idx] as PlacedPiece & { reversed?: boolean };
    this.saveUndo();
    this.pieces[idx] = { ...p, reversed: !p.reversed };
    this.updateSelectionHighlights(); this.drawSelectionOverlay(); this.rebuildCtrlRow(); this.isDirty = true;
    this.showToast('Reversed');
  }

  private deleteSelectedPiece(): void {
    if (this.selection?.kind !== 'piece') return;
    this.saveUndo(); this.deletePiece(this.selection.idx);
    this.showToast('Deleted');
  }

  // Deletes whatever is currently selected — piece(s), finish, and/or
  // checkpoint(s) (car start can't be deleted). Shared by the ctrl-row
  // Delete button and the Delete/Backspace keyboard shortcut.
  private deleteSelection(): void {
    const sel = this.selection;
    if (!sel) return;
    if (sel.kind === 'piece') {
      this.deleteSelectedPiece();
    } else if (sel.kind === 'multi') {
      this.saveUndo();
      const n = sel.pieces.length + (sel.finish ? 1 : 0) + sel.checkpoints.length;
      this.deleteMultiSelection(sel);
      this.showToast(`Deleted ${n} items`);
    } else if (sel.kind === 'finish') {
      this.saveUndo(); this.finishMarker = null; this.updateFinishImg(); this.deselectAll(); this.isDirty = true;
      this.showToast('Deleted');
    } else if (sel.kind === 'checkpoint') {
      this.saveUndo(); this.checkpoints.splice(sel.idx, 1); this.updateCheckpointImgs(); this.deselectAll(); this.isDirty = true;
      this.showToast('Deleted');
    }
  }

  // Copying covers pieces and checkpoints. The finish line is excluded — the
  // track can only have one, so duplicating it isn't meaningful.
  private copySelected(): void {
    if (this.selection?.kind === 'piece') {
      this.clipboard = { pieces: [{ ...this.pieces[this.selection.idx] }], checkpoints: [] };
      this.showToast('Copied — use Paste in the controls bar');
      this.rebuildCtrlRow();
    } else if (this.selection?.kind === 'checkpoint') {
      const cp = this.checkpoints[this.selection.idx];
      if (!cp) return;
      this.clipboard = { pieces: [], checkpoints: [{ ...cp }] };
      this.showToast('Copied — use Paste in the controls bar');
      this.rebuildCtrlRow();
    } else if (this.selection?.kind === 'multi' && (this.selection.pieces.length > 0 || this.selection.checkpoints.length > 0)) {
      const pieces      = this.selection.pieces.map(i => ({ ...this.pieces[i] }));
      const checkpoints = this.selection.checkpoints.map(i => ({ ...this.checkpoints[i] }));
      this.clipboard = { pieces, checkpoints };
      const n = pieces.length + checkpoints.length;
      this.showToast(`Copied ${n} item${n === 1 ? '' : 's'} — use Paste in the controls bar`);
      this.rebuildCtrlRow();
    }
  }

  private paste(): void {
    if (!this.clipboard || (this.clipboard.pieces.length === 0 && this.clipboard.checkpoints.length === 0)) {
      this.showToast('Nothing to paste');
      return;
    }
    if (this.pieces.length + this.clipboard.pieces.length > MAX_PIECES) {
      this.showToast(`Track limit reached (${MAX_PIECES} pieces)`);
      return;
    }
    this.saveUndo();
    const OFFSET = 60;
    const startPieceIdx = this.pieces.length;
    const startCpIdx    = this.checkpoints.length;
    // Pasted pieces that were grouped in the source stay grouped with each
    // other, but as a fresh, independent group — not sharing membership with
    // the pieces they were copied from.
    const groupIdMap = new Map<string, string>();
    const pieceCopies = this.clipboard.pieces.map(p => {
      let groupId = p.groupId;
      if (groupId) {
        let mapped = groupIdMap.get(groupId);
        if (!mapped) { mapped = this.newGroupId(); groupIdMap.set(groupId, mapped); }
        groupId = mapped;
      }
      return { ...p, x: p.x + OFFSET, y: p.y + OFFSET, groupId };
    });
    const cpCopies    = this.clipboard.checkpoints.map(c => ({ ...c, x: c.x + OFFSET, y: c.y + OFFSET }));
    // Advance the clipboard so repeated paste keeps offsetting further.
    this.clipboard = { pieces: pieceCopies.map(p => ({ ...p })), checkpoints: cpCopies.map(c => ({ ...c })) };
    this.pieces.push(...pieceCopies);
    this.checkpoints.push(...cpCopies);
    this.updateBarrierImg();
    if (cpCopies.length) this.updateCheckpointImgs();
    const newPieceIdxs = pieceCopies.map((_, i) => startPieceIdx + i);
    const newCpIdxs    = cpCopies.map((_, i) => startCpIdx + i);
    this.setMultiSelection({ pieces: newPieceIdxs, finish: false, checkpoints: newCpIdxs });
    this.scrollToShowPieces(newPieceIdxs, cpCopies.map(c => ({ x: c.x, y: c.y })));
    this.isDirty = true;
    const n = pieceCopies.length + cpCopies.length;
    this.showToast(n > 1 ? `Pasted ${n} items` : 'Pasted');
  }

  // ── Undo / redo ───────────────────────────────────────────────────────────────

  private cloneSelection(sel: Selection): Selection {
    if (sel?.kind === 'multi') return { kind: 'multi', pieces: [...sel.pieces], finish: sel.finish, checkpoints: [...sel.checkpoints] };
    if (!sel) return null;
    return { ...sel };
  }

  private snapshot(): EditorSnapshot {
    return {
      pieces:       this.pieces.map(p => ({ ...p })),
      finishMarker: this.finishMarker ? { ...this.finishMarker } : null,
      checkpoints:  this.checkpoints.map(c => ({ ...c })),
      startX:       this.curStartX, startY: this.curStartY, startHeading: this.curStartH,
      selection:    this.cloneSelection(this.selection),
    };
  }

  private saveUndo(): void {
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
    this.redoStack = [];
  }

  // Deselects, but first — if a multi-selection (a group, potentially
  // effortful to rebuild via marquee/shift-click/tap) is about to be lost —
  // pushes an undo snapshot so Ctrl+Z restores it. Used at user-initiated
  // deselect gestures (empty click/tap, Escape); plain deselectAll() (e.g.
  // used internally while restoring a snapshot) never pushes its own undo.
  private deselectAllWithUndo(): void {
    if (this.selection?.kind === 'multi') this.saveUndo();
    this.deselectAll();
  }

  // Applies a selection restored from an undo/redo snapshot, driving the same
  // visual updates (highlight pool, ctrl row, overlay) the normal selection
  // helpers do.
  private applySelection(sel: Selection): void {
    if (!sel) { this.deselectAll(); return; }
    if (sel.kind === 'piece') { this.selectPiece(sel.idx); return; }
    if (sel.kind === 'multi') {
      this.selection = this.cloneSelection(sel);
      this.updateSelectionHighlights();
      this.rebuildCtrlRow();
      this.drawSelectionOverlay();
      return;
    }
    this.selectMarker(sel);
  }

  private restoreSnapshot(s: EditorSnapshot): void {
    this.pieces       = s.pieces.map(p => ({ ...p }));
    this.finishMarker = s.finishMarker ? { ...s.finishMarker } : null;
    this.checkpoints  = s.checkpoints.map(c => ({ ...c }));
    this.curStartX = s.startX; this.curStartY = s.startY; this.curStartH = s.startHeading;
    this.updateBarrierImg();
    this.updateStartCarImg();
    this.updateFinishImg();
    this.updateCheckpointImgs();
    this.applySelection(s.selection);
    this.isDirty = true;
  }

  private undo(): void {
    const s = this.undoStack.pop();
    if (!s) { this.showToast('Nothing to undo'); return; }
    this.redoStack.push(this.snapshot());
    this.restoreSnapshot(s);
    this.showToast('Undo');
  }

  private redo(): void {
    const s = this.redoStack.pop();
    if (!s) { this.showToast('Nothing to redo'); return; }
    this.showToast('Redo');
    this.undoStack.push(this.snapshot());
    this.restoreSnapshot(s);
  }

  // ── Palette DOM ───────────────────────────────────────────────────────────────

  private createPalette(): void {
    const el = document.createElement('div');
    el.style.cssText = [
      'position:fixed', 'bottom:0', 'left:0', 'right:0',
      'background:#0d0d20', 'border-top:1.5px solid #3a3a6a',
      'z-index:100', 'display:flex', 'flex-direction:column',
      'padding:4px 6px max(env(safe-area-inset-bottom,0px),8px)',
      'box-sizing:border-box',
      'user-select:none', '-webkit-user-select:none', 'gap:4px',
    ].join(';');

    // Wrapper — ctrl row + piece buttons.
    const wrapperEl = document.createElement('div');
    wrapperEl.style.cssText = 'display:flex;flex-direction:column;gap:4px;flex-shrink:0;';
    el.appendChild(wrapperEl);

    // Unified ctrl row: palette defaults when nothing selected, piece/marker controls when selected.
    const ctrlEl = document.createElement('div');
    ctrlEl.id = 'ed-ctrl';
    ctrlEl.style.cssText = 'display:none;'; // rebuildCtrlRow() owns the rest once shown
    wrapperEl.appendChild(ctrlEl);

    // Piece buttons content area.
    const contentEl = document.createElement('div');
    contentEl.id = 'ed-content';
    contentEl.style.cssText = 'display:flex;flex-direction:column;gap:4px;';
    wrapperEl.appendChild(contentEl);

    // Tab row — always at the very bottom
    const tabRow = document.createElement('div');
    tabRow.id = 'ed-tabs';
    tabRow.style.cssText = 'display:flex;gap:4px;flex-shrink:0;justify-content:center;';
    el.appendChild(tabRow);

    document.body.appendChild(el);
    this.palEl = el;
    this.rebuildTabs();
    this.rebuildCtrlRow();
    this.rebuildContent();
  }

  private rebuildTabs(): void {
    const row = document.getElementById('ed-tabs');
    if (!row) return;
    row.innerHTML = '';
    // Tab bar: no gap so tabs sit flush against each other like a real tab strip.
    row.style.gap = '0';

    type TabDef = {
      tab:      PalTab;
      label:    string;
      draw?:    (c: HTMLCanvasElement, glow: boolean) => void;
      imgBase?: string; // e.g. 'assets/markers/tile_finish_' — appended with '0.png'/'1.png'
    };
    const ICO = 36;
    const defs: TabDef[] = [
      { tab: 'straight',   label: 'Straight', draw: (c, g) => drawStraightIcon(c, 75, 'both', g) },
      { tab: 'corner',     label: 'Corner',   draw: (c, g) => drawCornerIcon(c, this.palCornerFamily, 90, false, 'both', g) },
      { tab: 'finish',     label: 'Finish',   imgBase: 'assets/markers/tile_finish_' },
      { tab: 'checkpoint', label: 'Chkpt',    imgBase: 'assets/markers/tile_checkpoint_' },
    ];

    for (const def of defs) {
      const active = this.palTab === def.tab;
      const btn = document.createElement('button');
      btn.style.cssText = [
        'flex:1', 'min-width:0', `max-width:${PAL_BTN_MAX}px`, 'display:flex', 'flex-direction:column',
        'align-items:center', 'justify-content:center',
        'gap:2px', 'padding:4px 2px 3px', 'cursor:pointer',
        // Rounded top corners only — flat bottom connects to palette edge.
        'border-radius:7px 7px 0 0',
        active
          ? 'background:#192819;border:1.5px solid #44aa55;border-bottom-color:#192819;box-shadow:inset 0 3px 0 #55ff77;'
          : 'background:#0d0d1e;border:1px solid #1e1e36;border-bottom-color:#0d0d20;',
      ].join(';');

      if (def.draw) {
        const c = document.createElement('canvas');
        c.width = ICO; c.height = ICO;
        c.style.cssText = `width:${ICO}px;height:${ICO}px;display:block;`;
        def.draw(c, active);
        btn.appendChild(c);
      } else if (def.imgBase) {
        const img = document.createElement('img');
        img.src = `${def.imgBase}${active ? 1 : 0}.png`;
        img.style.cssText = `width:${ICO}px;height:${ICO}px;object-fit:contain;transform:rotate(45deg);`;
        img.onerror = () => { img.style.display = 'none'; };
        btn.appendChild(img);
      }

      const sp = document.createElement('span');
      sp.textContent = def.label;
      sp.style.cssText = `font:bold 9px Arial,sans-serif;line-height:1;color:${active ? '#77ff99' : '#334455'};`;
      btn.appendChild(sp);

      btn.addEventListener('click', () => { this.palTab = def.tab; this.rebuildTabs(); this.rebuildContent(); });
      row.appendChild(btn);
    }
  }

  private rebuildContent(): void {
    const el = document.getElementById('ed-content');
    if (!el) return;
    el.innerHTML = '';

    const ICO = 56; // canvas buffer size — CSS display width adapts via flex

    // Helper: canvas piece button. Canvas fills button width via CSS so 6 buttons
    // fit without overflow even on narrow phones (min-width:0 allows flex shrinking).
    const mkCanvasBtn = (
      draw: (c: HTMLCanvasElement, glow: boolean) => void,
      label: string,
      active: boolean,
    ): HTMLButtonElement => {
      const btn = document.createElement('button');
      btn.style.cssText = [
        'flex:1', 'min-width:0', `max-width:${PAL_BTN_MAX}px`, 'display:flex', 'flex-direction:column',
        'align-items:center', 'justify-content:center',
        'gap:2px', 'padding:3px 2px', 'border-radius:6px', 'cursor:pointer',
        active ? 'background:#1a2a1a;border:1.5px solid #44aa55;'
               : 'background:#111120;border:1px solid #2a2a44;',
      ].join(';');
      const c = document.createElement('canvas');
      c.width = ICO; c.height = ICO;
      c.style.cssText = 'width:100%;aspect-ratio:1;display:block;';
      draw(c, active);
      btn.appendChild(c);
      let sp: HTMLSpanElement | null = null;
      if (label) {
        sp = document.createElement('span');
        sp.textContent = label;
        sp.style.cssText = `font:bold 9px Arial,sans-serif;line-height:1;color:${active ? '#88ff66' : '#5566aa'};`;
        btn.appendChild(sp);
      }
      // Press flash: light up on pointerdown, restore on release/cancel
      btn.addEventListener('pointerdown', () => {
        btn.style.background = '#1a2a1a';
        btn.style.border = '1.5px solid #44aa55';
        if (sp) sp.style.color = '#88ff66';
        draw(c, true);
      });
      const onRelease = () => {
        btn.style.background = active ? '#1a2a1a' : '#111120';
        btn.style.border = active ? '1.5px solid #44aa55' : '1px solid #2a2a44';
        if (sp) sp.style.color = active ? '#88ff66' : '#5566aa';
        draw(c, active);
      };
      btn.addEventListener('pointerup', onRelease);
      btn.addEventListener('pointercancel', onRelease);
      return btn;
    };

    // Helper: sprite image button (finish/checkpoint).
    // Sprites rotated 45° to sit on the top-left→bottom-right diagonal of the piece icons.
    // displayPx: CSS display size of the image; pass a smaller value for the circle
    // checkpoint so it appears at the same pixel density as the gate (120px sprite).
    const mkSpriteBtn = (src: string, label: string, color: string, displayPx = ICO): HTMLButtonElement => {
      const btn = document.createElement('button');
      btn.style.cssText = [
        'flex:1', 'min-width:0', `max-width:${PAL_BTN_MAX * 2}px`, 'display:flex', 'flex-direction:column',
        'align-items:center', 'justify-content:center',
        'gap:4px', 'padding:6px 4px', 'border-radius:6px', 'cursor:pointer',
        `background:#111120;border:1px solid ${color}55;`,
      ].join(';');
      const img = document.createElement('img');
      img.src = src;
      img.style.cssText = `width:${displayPx}px;height:${displayPx}px;object-fit:contain;transform:rotate(45deg);`;
      img.onerror = () => { img.style.display = 'none'; };
      btn.appendChild(img);
      const sp = document.createElement('span');
      sp.textContent = label;
      sp.style.cssText = `font:bold 11px Arial,sans-serif;color:${color};`;
      btn.appendChild(sp);
      return btn;
    };

    // ─ Straight ─
    if (this.palTab === 'straight') {
      const row = this.mkRow(); row.style.gap = '3px';
      const sizes: [StraightSize, string][] = [[25,'XS'],[50,'S'],[75,'M'],[100,'L']];
      for (const [sz, lbl] of sizes) {
        const b = mkCanvasBtn((c, g) => drawStraightIcon(c, sz, this.palWalls, g), lbl, false);
        b.addEventListener('click', () => this.addPieceFromPalette({ type:'straight', size:sz, walls:this.palWalls }));
        row.appendChild(b);
      }
      // Two ghost spacers so each straight button is the same width as a corner button (1/6 of row).
      for (let i = 0; i < 2; i++) {
        const sp = document.createElement('div');
        sp.style.cssText = `flex:1;min-width:0;max-width:${PAL_BTN_MAX}px;`;
        row.appendChild(sp);
      }
      el.appendChild(row);
    }

    // ─ Corner (all tightnesses) ─
    if (this.palTab === 'corner') {
      const row = this.mkRow(); row.style.gap = '3px';
      const family = this.palCornerFamily;
      for (const ang of CORNER_ANGLES) {
        const b = mkCanvasBtn((c, g) => drawCornerIcon(c, family, ang, this.palFlip, this.palWalls, g), `${ang}°`, false);
        b.addEventListener('click', () => {
          this.palAngle = ang;
          this.addPieceFromPalette({ type: family, angle: ang, walls: this.palWalls, flip: this.palFlip });
        });
        row.appendChild(b);
      }
      el.appendChild(row);
    }

    // ─ Finish ─
    if (this.palTab === 'finish') {
      const row = this.mkRow();
      const b = mkSpriteBtn('assets/markers/tile_finish_0.png', 'Place Finish Line', '#ff7070');
      b.addEventListener('click', () => this.placeFinish());
      row.appendChild(b);
      el.appendChild(row);
    }

    // ─ Checkpoint ─
    if (this.palTab === 'checkpoint') {
      // Circle sprite is 46×46 vs gate's 120×120; normalize to the same pixel density.
      const circlePx = Math.round(46 * ICO / 120);
      const row = this.mkRow();
      const bG = mkSpriteBtn('assets/markers/tile_checkpoint_0.png',        'Gate',   '#00ccff');
      const bC = mkSpriteBtn('assets/markers/tile_checkpoint_circle_0.png', 'Circle', '#00ccff', circlePx);
      bG.addEventListener('click', () => this.placeCheckpoint('gate'));
      bC.addEventListener('click', () => this.placeCheckpoint('circle'));
      row.appendChild(bG); row.appendChild(bC);
      el.appendChild(row);
    }

    this.rebuildCtrlRow();
  }

  // ── Unified ctrl row ─────────────────────────────────────────────────────────
  // Shown when: any selection (piece/marker), or a piece tab with wall/flip options.
  // Buttons adapt to context: palette defaults when nothing selected; piece/marker
  // controls when something is selected.

  private rebuildCtrlRow(): void {
    const el = document.getElementById('ed-ctrl');
    if (!el) return;
    el.innerHTML = '';

    const sel = this.selection;
    const tab = this.palTab;

    const selPiece    = sel?.kind === 'piece' ? this.pieces[(sel as { kind: 'piece'; idx: number }).idx] : null;
    const isCornerSel = !!selPiece && selPiece.type !== 'straight';
    const isCornerTab = tab === 'corner';
    const isPieceTab  = tab === 'straight' || tab === 'corner';

    const showFlip   = (!sel && isCornerTab) || isCornerSel;
    const showFamily = (!sel && isCornerTab) || isCornerSel;
    const showWall   = (!sel && isPieceTab)  || !!selPiece;
    const showRotate = !!sel;
    const showCopy   = !!selPiece || sel?.kind === 'checkpoint'
      || (sel?.kind === 'multi' && (sel.pieces.length > 0 || sel.checkpoints.length > 0));
    const showDelete = !!selPiece || sel?.kind === 'multi' || sel?.kind === 'finish' || sel?.kind === 'checkpoint';
    const showLabel  = !!sel && sel.kind !== 'piece' && sel.kind !== 'multi';
    const showMultiCount = sel?.kind === 'multi';

    if (!showFlip && !showWall && !showRotate) {
      el.style.display = 'none';
      return;
    }
    const wrapMode = this.settings.propsBarLayout === 'wrap';
    el.style.cssText = wrapMode
      ? 'display:flex;gap:5px;align-items:center;flex-wrap:wrap;overflow:visible;'
      : 'display:flex;gap:5px;align-items:center;flex-wrap:nowrap;overflow-x:auto;overflow-y:hidden;';

    const mkB = (html: string, title: string, color: string, bg: string, border: string, fn: () => void) => {
      const b = document.createElement('button');
      b.innerHTML = html; b.title = title;
      b.style.cssText = `display:inline-flex;align-items:center;gap:3px;padding:5px 8px;border-radius:5px;cursor:pointer;font:bold 12px Arial,sans-serif;white-space:nowrap;color:${color};background:${bg};border:1px solid ${border};flex-shrink:0;`;
      b.addEventListener('click', fn);
      return b;
    };

    // Wall toggle — always leftmost when visible; same size as other buttons;
    // 20×20 canvas icon inline with text label.
    if (showWall) {
      const curWalls: WallVariant = selPiece ? selPiece.walls : this.palWalls;
      const togKind: 'straight' | 'corner' =
        (selPiece ? selPiece.type !== 'straight' : isCornerTab) ? 'corner' : 'straight';
      const ICON = 20;
      const togBtn = document.createElement('button');
      togBtn.style.cssText = [
        'display:flex', 'align-items:center', 'gap:5px',
        'padding:5px 8px', 'border-radius:5px', 'cursor:pointer', 'flex-shrink:0',
        'background:#111128;border:1px solid #3a3a60;white-space:nowrap;',
      ].join(';');
      const togCanvas = document.createElement('canvas');
      togCanvas.width = ICON; togCanvas.height = ICON;
      togCanvas.style.cssText = `width:${ICON}px;height:${ICON}px;display:block;flex-shrink:0;`;
      drawWallToggleIcon(togCanvas, curWalls, togKind);
      const wallNames: Record<WallVariant, string> = { both: 'Both', outer: 'Outer', inner: 'Inner' };
      const togLabel = document.createElement('span');
      togLabel.style.cssText = 'font:bold 12px Arial,sans-serif;line-height:1;color:#8899bb;';
      togLabel.textContent = wallNames[curWalls];
      togBtn.appendChild(togCanvas);
      togBtn.appendChild(togLabel);
      togBtn.title = `Walls: ${wallNames[curWalls]} — click to cycle`;
      togBtn.addEventListener('click', () => {
        const cycle: WallVariant[] = ['both', 'outer', 'inner'];
        const next = cycle[(cycle.indexOf(curWalls) + 1) % cycle.length];
        if (selPiece) this.changePieceWalls(next);
        else { this.palWalls = next; this.rebuildContent(); }
        this.showToast(`Walls: ${wallNames[next]}`);
      });
      el.appendChild(togBtn);
    }

    // Tightness toggle — cycles the corner family (Tight/Big/Huge). Acts on
    // the selected corner piece if one is selected, otherwise sets the
    // tab-level default used for newly-placed corners (mirrors Flip).
    if (showFamily) {
      const curFamily = isCornerSel ? (selPiece as CornerDef).type : this.palCornerFamily;
      const famNames: Record<CornerFamily, string> = { corner: 'Tight', big_corner: 'Big', huge_corner: 'Huge' };
      const ICON = 20;
      const famBtn = document.createElement('button');
      famBtn.style.cssText = [
        'display:flex', 'align-items:center', 'gap:5px',
        'padding:5px 8px', 'border-radius:5px', 'cursor:pointer', 'flex-shrink:0',
        'background:#111128;border:1px solid #3a3a60;white-space:nowrap;',
      ].join(';');
      famBtn.title = `Tightness: ${famNames[curFamily]} — click to cycle Tight → Big → Huge`;
      const famCanvas = document.createElement('canvas');
      famCanvas.width = ICON; famCanvas.height = ICON;
      famCanvas.style.cssText = `width:${ICON}px;height:${ICON}px;display:block;flex-shrink:0;`;
      drawCornerIcon(famCanvas, curFamily, 90, false, 'both', false);
      const famLabel = document.createElement('span');
      famLabel.style.cssText = 'font:bold 12px Arial,sans-serif;line-height:1;color:#8899bb;';
      famLabel.textContent = `Tightness: ${famNames[curFamily]}`;
      famBtn.appendChild(famCanvas);
      famBtn.appendChild(famLabel);
      famBtn.addEventListener('click', () => {
        const next = CORNER_FAMILIES[(CORNER_FAMILIES.indexOf(curFamily) + 1) % CORNER_FAMILIES.length];
        if (isCornerSel) this.changePieceFamily(next);
        else { this.palCornerFamily = next; this.rebuildTabs(); this.rebuildContent(); }
        this.showToast(`Tightness: ${famNames[next]}`);
      });
      el.appendChild(famBtn);
    }

    // Marker label (car / finish / checkpoint) — leftmost when wall toggle absent
    if (showLabel) {
      const labelHtml =
        sel!.kind === 'car'          ? ic('car',             'Start')
        : sel!.kind === 'finish'     ? ic('flag-checkered',  'Finish')
        : ic('map-marker', `CP ${(sel as { kind: 'checkpoint'; idx: number }).idx + 1}`);
      const lEl = document.createElement('span');
      lEl.innerHTML = labelHtml;
      lEl.style.cssText = 'display:inline-flex;align-items:center;gap:3px;color:#aaaacc;font:bold 12px Arial,sans-serif;flex-shrink:0;padding-right:2px;';
      el.appendChild(lEl);
    }

    // Multi-select item count — leftmost when wall toggle absent
    if (showMultiCount) {
      const m = sel as { kind: 'multi' } & MultiSel;
      const count = m.pieces.length + (m.finish ? 1 : 0) + m.checkpoints.length;
      const grouped = this.isExactGroup(m.pieces);
      const lEl = document.createElement('span');
      lEl.innerHTML = ic(grouped ? 'group' : 'vector-selection', grouped ? `${count} grouped` : `${count} selected`);
      lEl.style.cssText = 'display:inline-flex;align-items:center;gap:3px;color:#aaaacc;font:bold 12px Arial,sans-serif;flex-shrink:0;padding-right:2px;';
      el.appendChild(lEl);
    }

    // Flip — sets palFlip (no selection) or piece flip (corner selected)
    if (showFlip) {
      const curFlip = isCornerSel ? ((selPiece as CornerDef).flip ?? false) : this.palFlip;
      el.appendChild(mkB(ic('flip-horizontal', 'Flip'), 'Flip',
        '#ccccff', '#22224a', '#6666cc',
        () => {
          if (isCornerSel) this.changePieceFlip(!curFlip);
          else { this.palFlip = !curFlip; this.rebuildContent(); }
          this.showToast('Flipped');
        }));
    }

    // Spacer — pushes rotate/copy/delete to the right in scroll mode; in wrap
    // mode a flex:1 spacer would claim the rest of line 1 and dump everything
    // after it onto line 2, so it's just a small fixed gap instead.
    {
      const sp = document.createElement('div');
      sp.style.cssText = wrapMode ? 'flex:0 0 6px;' : 'flex:1;min-width:4px;';
      el.appendChild(sp);
    }

    // Rotate - angle + — visible whenever anything is selected
    if (showRotate) {
      const rot =
        sel!.kind === 'car'          ? this.curStartH
        : sel!.kind === 'finish'     ? (this.finishMarker?.rotation ?? 0)
        : sel!.kind === 'checkpoint' ? (this.checkpoints[(sel as { kind: 'checkpoint'; idx: number }).idx]?.rotation ?? 0)
        : sel!.kind === 'multi'      ? null
        : selPiece!.rotation;
      el.appendChild(mkB(ic('rotate-left'),  'Rotate −15°', '#aaaacc', '#111128', '#2a2a44', () => this.rotateSelected(-15)));
      const angEl = document.createElement('span');
      angEl.id = 'ed-ctrl-angle';
      angEl.textContent = rot === null ? 'group' : `${rot}°`;
      angEl.style.cssText = 'color:#8888aa;font:12px Arial,sans-serif;min-width:34px;text-align:center;flex-shrink:0;';
      el.appendChild(angEl);
      el.appendChild(mkB(ic('rotate-right'), 'Rotate +15°', '#aaaacc', '#111128', '#2a2a44', () => this.rotateSelected(15)));
    }

    // Group / Ungroup — multi-selections of 2+ pieces only
    if (sel?.kind === 'multi' && sel.pieces.length >= 2) {
      const grouped = this.isExactGroup(sel.pieces);
      el.appendChild(mkB(
        ic(grouped ? 'ungroup' : 'group'), grouped ? 'Ungroup (Ctrl+G)' : 'Group (Ctrl+G)',
        '#ccccff', '#22224a', '#6666cc', () => this.toggleGroupSelected(),
      ));
    }

    // Copy / Paste — pieces and checkpoints (not the finish line — only one is allowed)
    if (showCopy) {
      el.appendChild(mkB(ic('content-copy'),  'Copy', '#aaaaff', '#0a0a22', '#333366', () => this.copySelected()));
      if (this.clipboard)
        el.appendChild(mkB(ic('content-paste'), 'Paste', '#aaaaff', '#0a0a22', '#333366', () => this.paste()));
    }

    // Delete — pieces + finish + checkpoint (not car start)
    if (showDelete) {
      el.appendChild(mkB(ic('delete'), 'Delete', '#ff8888', '#1a0808', '#663333', () => this.deleteSelection()));
    }
  }

  // ── DOM helpers ───────────────────────────────────────────────────────────────

  private mkRow(): HTMLDivElement {
    const r = document.createElement('div');
    // Centered so capped-size palette buttons (see mkCanvasBtn/mkSpriteBtn)
    // don't just clump against the left edge on wide/fullscreen viewports.
    r.style.cssText = 'display:flex;gap:5px;justify-content:center;';
    return r;
  }

  private mkOptBtn(label: string, active: boolean, fn: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = [
      'padding:5px 8px','border-radius:5px','font:13px Arial,sans-serif','cursor:pointer',
      active ? 'background:#22224a;color:#ccccff;border:1.5px solid #6666cc;'
             : 'background:#111128;color:#6666aa;border:1px solid #2a2a44;',
    ].join(';');
    b.addEventListener('click', fn);
    return b;
  }

  // ── Camera helpers ────────────────────────────────────────────────────────────

  private viewCenterX(): number {
    const cam = this.cameras.main;
    return cam.scrollX + cam.width / (2 * cam.zoom);
  }

  private paletteH(): number { return this.palEl?.offsetHeight ?? PALETTE_H; }

  private viewCenterY(): number {
    const cam = this.cameras.main;
    return cam.scrollY + (cam.height - this.paletteH() + HEADER_H) / (2 * cam.zoom);
  }

  // Pans just enough to bring every listed piece's walls (plus any extra
  // marker points, e.g. pasted checkpoints) into view, and does nothing at
  // all if they're already fully visible — so e.g. pasting a group that's
  // already on-screen doesn't yank the camera.
  private scrollToShowPieces(idxs: number[], markerPoints: { x: number; y: number }[] = []): void {
    let minWX = Infinity, minWY = Infinity, maxWX = -Infinity, maxWY = -Infinity;
    for (const idx of idxs) {
      const p = this.pieces[idx];
      if (!p) continue;
      // Bounding box of piece center + both connectors, padded by HALF_TRACK
      // so the track walls (not just the spine) clear the palette and header.
      const { entry, exit } = worldConnectors(p);
      for (const pt of [{ x: p.x, y: p.y }, entry, exit]) {
        minWX = Math.min(minWX, pt.x - HALF_TRACK); maxWX = Math.max(maxWX, pt.x + HALF_TRACK);
        minWY = Math.min(minWY, pt.y - HALF_TRACK); maxWY = Math.max(maxWY, pt.y + HALF_TRACK);
      }
    }
    for (const pt of markerPoints) {
      minWX = Math.min(minWX, pt.x - HIT_R_MARKER); maxWX = Math.max(maxWX, pt.x + HIT_R_MARKER);
      minWY = Math.min(minWY, pt.y - HIT_R_MARKER); maxWY = Math.max(maxWY, pt.y + HIT_R_MARKER);
    }
    if (!isFinite(minWX)) return;

    const cam = this.cameras.main;
    const W = this.scale.width, H = this.scale.height;
    const pH = this.paletteH();

    let { scrollX, scrollY } = cam;
    const z = cam.zoom;

    // Don't pan at all if the piece is already fully visible in the raw play
    // area (no comfort padding) — only reach for the camera when it's
    // actually clipped by the header/palette or off-screen.
    const rawSx0 = (minWX - scrollX) * z, rawSx1 = (maxWX - scrollX) * z;
    const rawSy0 = (minWY - scrollY) * z, rawSy1 = (maxWY - scrollY) * z;
    const fullyVisible = rawSx0 >= 0 && rawSx1 <= W && rawSy0 >= HEADER_H && rawSy1 <= H - pH;
    if (fullyVisible) return;

    // Once a pan is actually needed, land with some breathing room instead
    // of flush against the edge.
    const margin = Math.min(W, H - HEADER_H - pH) * 0.12;
    if (rawSx0 < margin)     scrollX -= (margin - rawSx0) / z;
    if (rawSx1 > W - margin) scrollX += (rawSx1 - (W - margin)) / z;

    const topBound = HEADER_H + margin;
    const botBound = H - pH - margin;
    if (rawSy0 < topBound)   scrollY -= (topBound - rawSy0) / z;
    if (rawSy1 > botBound)   scrollY += (rawSy1 - botBound) / z;

    cam.setScroll(scrollX, scrollY);
  }

  // ── Save / drafts ─────────────────────────────────────────────────────────────

  private openDrafts(): void {
    if (!this.isDirty) { this.scene.start('TrackSelect', { activeTab: 'drafts' }); return; }
    this.showConfirm('Discard unsaved changes?', 'Discard',
      () => this.scene.start('TrackSelect', { activeTab: 'drafts' }),
    );
  }

  private goBack(): void {
    if (!this.isDirty) { this.scene.start('ModeSelect'); return; }
    this.showConfirm('Discard unsaved changes?', 'Discard',
      () => this.scene.start('ModeSelect'),
    );
  }

  // Clears the track currently being edited and starts fresh — a full scene
  // restart (same entry point as opening the editor with nothing loaded) so
  // every piece of state (pieces, markers, undo stack, draft id, DOM) resets
  // cleanly rather than trying to hand-unwind it all in place.
  private newTrack(): void {
    if (!this.isDirty) { this.scene.start('TrackEditor'); return; }
    this.showConfirm('Discard unsaved changes?', 'Discard',
      () => this.scene.start('TrackEditor'),
    );
  }

  private testTrack(): void {
    if (this.pieces.length < 1) { this.showToast('Add track pieces first'); return; }
    if (!this.finishMarker)     { this.showToast('Place a finish line first (Finish tab)'); return; }
    const entry: TrackEntry = {
      id:           '__test__',
      name:         this.existingName || 'Test Track',
      author:       '',
      startX:       this.curStartX,
      startY:       this.curStartY,
      startHeading: this.curStartH,
      pieces:       this.pieces.map(p => ({ ...p })),
      markers:      [this.finishMarker, ...this.checkpoints],
    };
    this.scene.start('Game', {
      track:       entry,
      mineTrackId: this.mineTrackId ?? undefined,
      returnTab:   'editor',
    });
  }

  private showSaveDialog(): void {
    if (!this.finishMarker) { this.showToast('Place a finish line first  (Finish tab)'); return; }
    if (this.pieces.length < 2) { this.showToast('Add more track pieces first'); return; }

    const overlay = this.mkOverlay();
    const card    = this.mkCard(overlay);

    const title = document.createElement('div');
    title.textContent = 'Save Track';
    title.style.cssText = 'font:bold 20px "Arial Black",Arial,sans-serif;color:#e8e8ff;text-align:center;';

    const input = document.createElement('input');
    input.type = 'text'; input.placeholder = 'Track name…'; input.maxLength = 40;
    input.value = this.existingName;
    input.style.cssText = 'padding:10px;border-radius:6px;border:1px solid #444488;background:#1a1a36;color:#e8e8ff;font:16px Arial,sans-serif;outline:none;box-sizing:border-box;width:100%;';

    const status = document.createElement('div');
    status.style.cssText = 'font:13px Arial,sans-serif;color:#8899cc;text-align:center;min-height:1.2em;';

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:10px;';

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText = 'flex:1;padding:10px;border-radius:6px;border:1px solid #444466;background:#1a1a2a;color:#aaaacc;font:14px Arial,sans-serif;cursor:pointer;';
    cancelBtn.addEventListener('click', () => overlay.remove());

    const saveBtn = document.createElement('button');
    saveBtn.textContent = 'Save';
    saveBtn.style.cssText = 'flex:1;padding:10px;border-radius:6px;border:1px solid #336633;background:#0a2a0a;color:#66ff99;font:bold 14px Arial,sans-serif;cursor:pointer;';

    saveBtn.addEventListener('click', async () => {
      const name = input.value.trim();
      if (!name) { input.focus(); status.textContent = 'Enter a track name.'; return; }
      saveBtn.disabled = true; cancelBtn.disabled = true; status.textContent = 'Saving…';
      try {
        const payload: TrackPayload = {
          startX: this.curStartX, startY: this.curStartY, startHeading: this.curStartH,
          pieces: this.pieces,
          markers: [this.finishMarker!, ...this.checkpoints],
        };
        // Saving under the same name updates this draft in place. Saving
        // under a NEW name is a "Save As" — fork a separate draft rather
        // than renaming/overwriting the one already open, so the original
        // stays put in My Drafts.
        const sameTrack = !!this.mineTrackId && name === this.existingName;
        const result = await saveDraft(name, JSON.stringify(payload), sameTrack ? this.mineTrackId ?? undefined : undefined);
        // Remember the id/name so a later save in this same session updates
        // this draft instead of creating a duplicate — saving no longer
        // leaves the editor, so there's no round-trip through TrackSelect to
        // pick that up otherwise.
        this.mineTrackId = result.id;
        this.existingName = name;
        this.isDirty = false;
        if (!sameTrack) this.verified = false; // forked draft — not yet tested under its own id
        overlay.remove();
        this.showToast(sameTrack ? 'Track saved' : 'Saved as new track');
      } catch (err) {
        status.textContent = err instanceof Error ? err.message : 'Save failed — try again.';
        saveBtn.disabled = false; cancelBtn.disabled = false;
      }
    });

    btnRow.appendChild(cancelBtn); btnRow.appendChild(saveBtn);
    card.appendChild(title); card.appendChild(input); card.appendChild(status); card.appendChild(btnRow);
    setTimeout(() => input.focus(), 50);
  }

  private showConfirm(msg: string, actionLabel: string, onConfirm: () => void): void {
    const overlay = this.mkOverlay();
    const card    = this.mkCard(overlay);
    const msgEl   = document.createElement('div');
    msgEl.textContent = msg;
    msgEl.style.cssText = 'font:bold 17px "Arial Black",Arial,sans-serif;color:#e8e8ff;text-align:center;';
    const btnRow = document.createElement('div'); btnRow.style.cssText = 'display:flex;gap:10px;';
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Keep editing';
    cancelBtn.style.cssText = 'flex:1;padding:10px;border-radius:6px;border:1px solid #444466;background:#1a1a2a;color:#aaaacc;font:14px Arial,sans-serif;cursor:pointer;';
    cancelBtn.addEventListener('click', () => overlay.remove());
    const actionBtn = document.createElement('button');
    actionBtn.textContent = actionLabel;
    actionBtn.style.cssText = 'flex:1;padding:10px;border-radius:6px;border:1px solid #663333;background:#1a0808;color:#ff8888;font:bold 14px Arial,sans-serif;cursor:pointer;';
    actionBtn.addEventListener('click', () => { overlay.remove(); onConfirm(); });
    btnRow.appendChild(cancelBtn); btnRow.appendChild(actionBtn);
    card.appendChild(msgEl); card.appendChild(btnRow);
  }

  private mkOverlay(): HTMLDivElement {
    const o = document.createElement('div');
    o.style.cssText = 'position:fixed;inset:0;z-index:300;background:rgba(0,0,0,0.78);display:flex;align-items:center;justify-content:center;';
    document.body.appendChild(o);
    return o;
  }

  private mkCard(overlay: HTMLDivElement): HTMLDivElement {
    const c = document.createElement('div');
    c.style.cssText = 'background:#0d0d1e;border:1.5px solid #444488;border-radius:10px;padding:20px 18px;width:min(320px,calc(100%-32px));display:flex;flex-direction:column;gap:12px;';
    overlay.appendChild(c);
    return c;
  }

  private showToast(msg: string): void {
    // Replace any toast already in flight so rapid button presses (e.g. holding
    // rotate) refresh a single line instead of piling up overlapping toasts.
    if (this.toastHideTimer)   clearTimeout(this.toastHideTimer);
    if (this.toastRemoveTimer) clearTimeout(this.toastRemoveTimer);
    this.toastEl?.remove();

    const t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = [
      'position:fixed', `bottom:${this.paletteH() + 10}px`, 'left:50%',
      'transform:translateX(-50%) translateY(12px)', 'opacity:0',
      'transition:opacity 0.2s ease, transform 0.2s ease',
      'background:#2a2a50', 'border:1px solid #5555aa',
      'border-radius:6px', 'padding:8px 16px', 'color:#ccccff', 'font:13px Arial,sans-serif',
      'z-index:400', 'pointer-events:none', 'white-space:nowrap',
    ].join(';');
    document.body.appendChild(t);
    this.toastEl = t;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      t.style.opacity   = '1';
      t.style.transform = 'translateX(-50%) translateY(0)';
    }));
    this.toastHideTimer = setTimeout(() => {
      t.style.opacity   = '0';
      t.style.transform = 'translateX(-50%) translateY(-8px)';
    }, 2220);
    this.toastRemoveTimer = setTimeout(() => {
      t.remove();
      if (this.toastEl === t) this.toastEl = null;
    }, 2500);
  }

  override update(_time: number, delta: number): void {
    // Advance the shared marching-ants dash offset whenever something needs it:
    // one or more selected pieces (highlight pool), or an in-progress marquee drag.
    const idxs =
      this.selection?.kind === 'piece' ? [this.selection.idx]
      : this.selection?.kind === 'multi' ? this.selection.pieces
      : [];
    const marquee = this.dragOp?.kind === 'marquee';
    if (idxs.length === 0 && !marquee) return;

    this.selDashOffset = (this.selDashOffset + delta * 0.03) % 18;
    for (let k = 0; k < idxs.length; k++) this.redrawHighlightSlot(k, idxs[k]);
    if (this.dragOp?.kind === 'marquee') {
      this.drawMarquee(this.dragOp.startWX, this.dragOp.startWY, this.marqueeCurWX, this.marqueeCurWY);
    }
  }
}
