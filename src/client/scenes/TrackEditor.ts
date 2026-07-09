import { Scene, GameObjects } from 'phaser';
import { buildTrackTexture } from '../track/TrackCanvasRenderer';
import { addPiecePaths } from '../track/TrackBarrierCanvas';
import { NEON_GREEN } from '../track/TrackSkin';
import {
  trackBounds, connectors,
  type PieceDef, type PlacedPiece, type CornerDef, type StraightDef,
} from '../track/TrackLayout';
import {
  HALF_TRACK, TIGHT, BIG, STRAIGHT_LEN,
  CORNER_ANGLES,
  type CornerAngle, type CornerFamily, type WallVariant, type StraightSize,
} from '../track/TrackGeometry';
import type { TrackMarker } from '../track/convertGmsTrack';
import type { TrackEntry } from '../tracks/trackRegistry';
import { saveDraft } from '../track/TrackUpload';
import type { TrackPayload } from '../track/TrackUpload';

// ── Types ─────────────────────────────────────────────────────────────────────

type PalTab = 'straight' | 'tight' | 'big' | 'finish' | 'checkpoint';

type Selection =
  | { kind: 'piece'; idx: number }
  | { kind: 'car' }
  | { kind: 'finish' }
  | { kind: 'checkpoint'; idx: number }
  | null;

type DragOp =
  | { kind: 'pan';              sx: number; sy: number; scrollX: number; scrollY: number }
  | { kind: 'move';             idx: number; offX: number; offY: number }
  | { kind: 'rotate';           idx: number; handleLocalAngle: number }
  | { kind: 'move-car' }
  | { kind: 'move-finish' }
  | { kind: 'move-checkpoint';  idx: number }
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
}

// ── Constants ─────────────────────────────────────────────────────────────────

const HEADER_H  = 52;
const PALETTE_H = 210;
const SNAP_R    = 55;
const MAX_UNDO  = 40;
const HIT_R_MARKER = 46;
const HANDLE_HIT_R = 22;   // hit radius for the rotate handle

const DEFAULT_START_X = 0, DEFAULT_START_Y = 0, DEFAULT_START_H = 180;
const BG = 0x0a0a16;

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
      const [nex, ney] = rotateCW(dc.entryX, dc.entryY, newRot);
      return { ...dragged, rotation: newRot, x: oc.exit.x - nex, y: oc.exit.y - ney };
    }

    // dragged comes BEFORE other: dragged.exit → other.entry
    if (Math.hypot(exitW.x - oc.entry.x, exitW.y - oc.entry.y) < SNAP_R) {
      const newRot = ((oc.entry.heading - dc.exitH) % 360 + 360) % 360;
      const [nxx, nxy] = rotateCW(dc.exitX, dc.exitY, newRot);
      return { ...dragged, rotation: newRot, x: oc.entry.x - nxx, y: oc.entry.y - nxy };
    }
  }
  return null;
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
  const { outerR: rO, innerR: rI } = family === 'corner' ? TIGHT : BIG;
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
  private isDirty                  = false;
  private clipboard:   PlacedPiece | null = null;

  // Undo / redo
  private undoStack: EditorSnapshot[] = [];
  private redoStack: EditorSnapshot[] = [];

  // Drag / pinch
  private dragOp:    DragOp = null;
  private touches    = new Map<number, { x: number; y: number }>();
  private pinchDist  = 0;
  private pinchZoom  = 1;

  // Palette
  private palTab:   PalTab      = 'straight';
  private palWalls: WallVariant = 'both';
  private palFlip   = false;
  private palAngle: CornerAngle  = 90;

  // Phaser objects
  private markerGfx!:     GameObjects.Graphics;
  private selectionGfx!:  GameObjects.Graphics;
  private connGfx!:       GameObjects.Graphics;
  private barrierImg:       GameObjects.Image | null = null;
  private barrierExclude:   number | null            = null;
  private selectedPieceImg: GameObjects.Image | null = null;
  private selCanvasTex:     Phaser.Textures.CanvasTexture | null = null;
  private selDashOffset     = 0;
  private finishImg:      GameObjects.Image | null = null;
  private checkpointImgs: GameObjects.Image[]      = [];
  private startCarImg:    GameObjects.Image | null = null;

  // DOM
  private hdrEl:     HTMLElement | null       = null;
  private palEl:     HTMLElement | null       = null;
  private snapBtnEl: HTMLButtonElement | null = null;
  // Context
  private mineTrackId: string | null = null;
  private existingName = '';

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
    this.selection     = null;
    this.dragOp        = null;
    this.undoStack     = [];
    this.redoStack     = [];
    this.clipboard     = null;
    this.startCarImg   = null;
    this.barrierExclude = null;
    // Null both on scene restart — they'll be in a destroyed state already
    this.selCanvasTex     = null;
    this.selectedPieceImg = null;

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

    // World grid
    const gridGfx = this.add.graphics();
    gridGfx.lineStyle(1, 0x1c1c4c, 1);
    const EXT = 4800, CELL = 24;
    for (let x = -EXT; x <= EXT; x += CELL) gridGfx.lineBetween(x, -EXT, x, EXT);
    for (let y = -EXT; y <= EXT; y += CELL) gridGfx.lineBetween(-EXT, y, EXT, y);

    this.markerGfx    = this.add.graphics().setDepth(5);
    this.selectionGfx = this.add.graphics().setDepth(8);
    this.connGfx      = this.add.graphics().setDepth(7);

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

    this.input.addPointer(1);
    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => this.onDown(p));
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => this.onMove(p));
    this.input.on('pointerup',   (p: Phaser.Input.Pointer) => this.onUp(p));
    this.input.on('wheel',       (p: Phaser.Input.Pointer) => {
      if (!p.deltaY) return;
      const z = cam.zoom;
      cam.setZoom(Math.min(Math.max(z * (p.deltaY > 0 ? 1 / 1.12 : 1.12), 0.12), 4));
    });

    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (this.selection) { this.deselectAll(); return; }
      this.scene.start('ModeSelect');
    };
    window.addEventListener('keydown', onEsc);

    this.events.once('shutdown', () => {
      window.removeEventListener('keydown', onEsc);
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
    backBtn.addEventListener('click', () => this.scene.start('ModeSelect'));

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
    snapBtn.addEventListener('click', () => { this.snapEnabled = !this.snapEnabled; this.updateSnapBtn(); });
    this.snapBtnEl = snapBtn;
    this.updateSnapBtn();

    hdr.appendChild(backBtn);
    hdr.appendChild(titleEl);
    hdr.appendChild(sep());
    hdr.appendChild(snapBtn);
    hdr.appendChild(sep());
    hdr.appendChild(mkBtn(ic('undo'),                    'Undo',              '#ffaa44', '#1a0e00', '#553300', () => this.undo()));
    hdr.appendChild(mkBtn(ic('redo'),                    'Redo',              '#ffaa44', '#1a0e00', '#553300', () => this.redo()));
    hdr.appendChild(sep());
    hdr.appendChild(mkBtn(ic('folder-open',  'Drafts'), 'My drafts',         '#aaaaff', '#0a0a22', '#333366', () => this.openDrafts()));
    hdr.appendChild(sep());
    hdr.appendChild(mkBtn(ic('play',         'Test'),   'Test track',        '#44ffcc', '#001a12', '#226644', () => this.testTrack()));
    hdr.appendChild(mkBtn(ic('content-save', 'Save'),   'Save track',        '#66ff99', '#001a08', '#226633', () => this.showSaveDialog()));

    document.body.appendChild(hdr);
    this.hdrEl = hdr;
  }

  private updateSnapBtn(): void {
    if (!this.snapBtnEl) return;
    this.snapBtnEl.innerHTML = ic('link-variant', 'Snap');
    this.snapBtnEl.style.background = this.snapEnabled ? '#001a22' : '#111128';
    this.snapBtnEl.style.color      = this.snapEnabled ? '#44ddff' : '#445566';
    this.snapBtnEl.style.border     = `1px solid ${this.snapEnabled ? '#226644' : '#2a2a44'}`;
  }

  // ── Barrier texture ─────────────────────────────────────────────────────────

  private updateBarrierImg(excludeIdx: number | null = null): void {
    this.barrierExclude = excludeIdx;
    if (this.barrierImg) { this.barrierImg.destroy(); this.barrierImg = null; }
    const drawPieces = excludeIdx !== null
      ? this.pieces.filter((_, i) => i !== excludeIdx)
      : this.pieces;
    if (drawPieces.length === 0) return;
    this.barrierImg = buildTrackTexture(this, drawPieces, NEON_GREEN, '_ed_barriers').setDepth(3);
  }

  // Marching-ants selection outline.  One canvas texture + one Image are kept alive
  // for the life of the scene.  Only the canvas content and Image position change.
  // Destroying and re-creating the Image each time causes Phaser's WebGL backend
  // to silently lose the texture binding after the first remove/recreate cycle.
  private updateSelectedHighlight(): void {
    if (this.selection?.kind !== 'piece') {
      this.selectedPieceImg?.setVisible(false);
      return;
    }
    const p = this.pieces[this.selection.idx];
    if (!p) { this.selectedPieceImg?.setVisible(false); return; }

    const b   = trackBounds([p]);
    const pad = 14;
    const w   = Math.max(4, Math.ceil(b.width  + pad * 2));
    const h   = Math.max(4, Math.ceil(b.height + pad * 2));
    const key = '_ed_sel_hl';

    // Only remove/recreate when the canvas size must change (different piece family).
    // When reusing, keep the same Image object — just reposition and show it.
    if (!this.selCanvasTex || this.selCanvasTex.width !== w || this.selCanvasTex.height !== h) {
      if (this.textures.exists(key)) this.textures.remove(key);
      this.selCanvasTex = this.textures.createCanvas(key, w, h)!;
      this.selectedPieceImg?.destroy();
      this.selectedPieceImg = this.add.image(0, 0, key).setOrigin(0, 0).setDepth(3.5);
    } else if (!this.selectedPieceImg) {
      this.selectedPieceImg = this.add.image(0, 0, key).setOrigin(0, 0).setDepth(3.5);
    }

    this.selectedPieceImg.setPosition(b.x - pad, b.y - pad);
    this.selectedPieceImg.setVisible(true);
    this.redrawSelectionDashes();
  }

  // Redraws the marching-ants outline at the current selDashOffset.
  // Called once from updateSelectedHighlight and then every frame from update().
  private redrawSelectionDashes(): void {
    if (!this.selCanvasTex || this.selection?.kind !== 'piece') return;
    const p = this.pieces[this.selection.idx];
    if (!p) return;
    const b   = trackBounds([p]);
    const pad = 14;
    const ctx = this.selCanvasTex.getContext();
    const cw  = this.selCanvasTex.width;
    const ch  = this.selCanvasTex.height;

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

    this.selCanvasTex.refresh();
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

    // Connection-point dots (on connGfx so they can be cleared independently)
    const cg = this.connGfx;
    cg.fillStyle(0xffee00, 0.9);
    cg.fillCircle(conns.entry.x, conns.entry.y, 6);
    cg.fillStyle(0x44ff88, 0.9);
    cg.fillCircle(conns.exit.x, conns.exit.y, 6);

    // Other pieces' connectors during move drag
    if (this.snapEnabled && this.dragOp?.kind === 'move') {
      for (let i = 0; i < this.pieces.length; i++) {
        if (i === this.selection.idx) continue;
        const oc = worldConnectors(this.pieces[i]);
        cg.fillStyle(0xff8844, 0.75); cg.fillCircle(oc.exit.x,  oc.exit.y,  5);
        cg.fillStyle(0x4488ff, 0.75); cg.fillCircle(oc.entry.x, oc.entry.y, 5);
      }
    }
  }

  private drawMarkerRing(x: number, y: number, rotDeg: number, color: number): void {
    const r = 38, g = this.selectionGfx;
    g.lineStyle(2, color, 0.9); g.strokeCircle(x, y, r);
    g.fillStyle(color, 1);
    for (const [dx, dy] of [[0,-r],[r,0],[0,r],[-r,0]] as [number,number][]) {
      g.fillCircle(x + dx, y + dy, 3.5);
    }
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
        const outerR = p.type === 'corner' ? TIGHT.outerR : BIG.outerR;
        const innerR = p.type === 'corner' ? TIGHT.innerR : BIG.innerR;
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


    // Rotate handle — highest priority (covers pieces AND markers)
    if (this.hitTestHandle(wx, wy)) {
      this.saveUndo();
      const sel = this.selection!;
      if (sel.kind === 'piece') {
        const p = this.pieces[sel.idx];
        this.updateBarrierImg(sel.idx);
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
      this.selectMarker({ kind: 'finish' });
      this.saveUndo();
      this.dragOp = { kind: 'move-finish' };
      return;
    }

    // Checkpoints
    for (let i = 0; i < this.checkpoints.length; i++) {
      const cp = this.checkpoints[i];
      if (Math.hypot(wx - cp.x, wy - cp.y) < HIT_R_MARKER) {
        this.selectMarker({ kind: 'checkpoint', idx: i });
        this.saveUndo();
        this.dragOp = { kind: 'move-checkpoint', idx: i };
        return;
      }
    }

    // Piece
    const pidx = this.hitTestPiece(wx, wy);
    if (pidx !== null) {
      this.selectPiece(pidx);
      this.saveUndo();
      this.updateBarrierImg(pidx);
      const p = this.pieces[pidx];
      this.dragOp = { kind: 'move', idx: pidx, offX: wx - p.x, offY: wy - p.y };
      this.drawSelectionOverlay();
      return;
    }

    // Empty — deselect + pan
    this.deselectAll();
    this.dragOp = { kind: 'pan', sx: ptr.x, sy: ptr.y, scrollX: cam.scrollX, scrollY: cam.scrollY };
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

    if (op.kind === 'move') {
      let updated = { ...this.pieces[op.idx], x: wx - op.offX, y: wy - op.offY };
      if (this.snapEnabled) {
        const snapped = trySnapPiece(updated, op.idx, this.pieces);
        if (snapped) updated = snapped;
      }
      this.pieces[op.idx] = updated;
      this.isDirty = true;
      // Keep the marching-ants image anchored to the piece as it moves
      if (this.selectedPieceImg) {
        const b = trackBounds([updated]);
        this.selectedPieceImg.setPosition(b.x - 14, b.y - 14);
      }
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
      // Keep selectedPieceImg visible and current so the piece stays visible at the new angle.
      this.updateSelectedHighlight();
      this.drawSelectionOverlay();
      return;
    }

    if (op.kind === 'move-car') {
      this.curStartX = wx; this.curStartY = wy;
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

    // Commit drag: rebuild barrier with all pieces, refresh highlight + props.
    // dragOp is nulled BEFORE drawSelectionOverlay so it doesn't draw drag-preview
    // lines (cyan straight/arc outlines) that should only appear while dragging.
    const endedDrag = this.dragOp?.kind === 'move' || this.dragOp?.kind === 'rotate';
    this.dragOp = null;
    if (endedDrag) {
      this.updateBarrierImg();
      this.updateSelectedHighlight();
      this.drawSelectionOverlay();
      this.rebuildCtrlRow();
    }
  }

  // ── Selection management ──────────────────────────────────────────────────────

  private selectPiece(idx: number): void {
    this.selection = { kind: 'piece', idx };
    this.updateSelectedHighlight();
    this.rebuildCtrlRow();
    this.drawSelectionOverlay();
  }

  private selectMarker(sel: Exclude<Selection, null | { kind: 'piece' }>): void {
    this.selection = sel;
    this.rebuildCtrlRow();
    this.drawSelectionOverlay();
  }

  private deselectAll(): void {
    this.selection = null;
    this.selectionGfx.clear();
    this.connGfx.clear();
    this.selectedPieceImg?.setVisible(false); // hide but keep alive for reuse
    this.rebuildCtrlRow();
  }

  // ── Piece & marker management ─────────────────────────────────────────────────

  private addPieceFromPalette(def: PieceDef): void {
    this.saveUndo();
    let newX = this.viewCenterX(), newY = this.viewCenterY(), newRot = 0;

    if (this.pieces.length > 0) {
      const last  = this.pieces[this.pieces.length - 1];
      const lconn = worldConnectors(last);
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
    this.scrollToShowPiece(idx);
    this.isDirty = true;
  }

  private deletePiece(idx: number): void {
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

  private placeFinish(): void {
    if (this.pieces.length === 0) { this.showToast('Add track pieces first'); return; }
    this.saveUndo();
    this.finishMarker = { kind: 'finish', shape: 'gate', x: this.viewCenterX(), y: this.viewCenterY(), rotation: 0 };
    this.updateFinishImg();
    this.selectMarker({ kind: 'finish' });
    this.showToast('Finish placed — drag to position');
    this.isDirty = true;
  }

  private placeCheckpoint(shape: 'gate' | 'circle'): void {
    if (this.pieces.length === 0) { this.showToast('Add track pieces first'); return; }
    this.saveUndo();
    const idx = this.checkpoints.length;
    this.checkpoints.push({ kind: 'checkpoint', shape, x: this.viewCenterX(), y: this.viewCenterY(), rotation: 0 });
    this.updateCheckpointImgs();
    this.selectMarker({ kind: 'checkpoint', idx });
    this.showToast('Checkpoint placed — drag to position');
    this.isDirty = true;
  }

  private rotateSelected(delta: number): void {
    if (this.selection?.kind === 'piece') {
      const p = this.pieces[this.selection.idx];
      this.pieces[this.selection.idx] = { ...p, rotation: ((p.rotation + delta) % 360 + 360) % 360 };
      this.updateBarrierImg();
      this.updateSelectedHighlight();
      this.drawSelectionOverlay();
      this.rebuildCtrlRow();
      this.isDirty = true;
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
  }

  private changePieceWalls(walls: WallVariant): void {
    if (this.selection?.kind !== 'piece') return;
    this.saveUndo();
    this.pieces[this.selection.idx] = { ...this.pieces[this.selection.idx], walls };
    this.updateBarrierImg(); this.updateSelectedHighlight(); this.drawSelectionOverlay(); this.rebuildCtrlRow(); this.isDirty = true;
  }

  private changePieceFlip(flip: boolean): void {
    if (this.selection?.kind !== 'piece') return;
    const idx = this.selection.idx;
    const p = this.pieces[idx];
    if (p.type === 'straight') return;
    this.saveUndo();

    // Build the flipped piece with the same position/rotation as a starting point.
    let flipped: PlacedPiece = { ...(p as CornerDef & { x: number; y: number; rotation: number }), flip };
    const newC = connectors(flipped);

    // If any neighbor is snapped to our entry or exit, keep that connector fixed
    // as the anchor point so the flip doesn't break the connection.
    const { entry: oldEntry, exit: oldExit } = worldConnectors(p);
    for (let i = 0; i < this.pieces.length; i++) {
      if (i === idx) continue;
      const oc = worldConnectors(this.pieces[i]);

      // Our entry is snapped to their exit — anchor on entry
      if (Math.hypot(oldEntry.x - oc.exit.x, oldEntry.y - oc.exit.y) < SNAP_R) {
        const newRot = ((oldEntry.heading - newC.entryH) % 360 + 360) % 360;
        const [nex, ney] = rotateCW(newC.entryX, newC.entryY, newRot);
        flipped = { ...flipped, rotation: newRot, x: oldEntry.x - nex, y: oldEntry.y - ney };
        break;
      }

      // Our exit is snapped to their entry — anchor on exit
      if (Math.hypot(oldExit.x - oc.entry.x, oldExit.y - oc.entry.y) < SNAP_R) {
        const newRot = ((oldExit.heading - newC.exitH) % 360 + 360) % 360;
        const [nxx, nxy] = rotateCW(newC.exitX, newC.exitY, newRot);
        flipped = { ...flipped, rotation: newRot, x: oldExit.x - nxx, y: oldExit.y - nxy };
        break;
      }
    }

    this.pieces[idx] = flipped;
    this.updateBarrierImg(); this.updateSelectedHighlight(); this.drawSelectionOverlay(); this.rebuildCtrlRow(); this.isDirty = true;
  }

  private deleteSelectedPiece(): void {
    if (this.selection?.kind !== 'piece') return;
    this.saveUndo(); this.deletePiece(this.selection.idx);
  }

  private copySelected(): void {
    if (this.selection?.kind !== 'piece') return;
    this.clipboard = { ...this.pieces[this.selection.idx] };
    this.showToast('Copied — use Paste in the controls bar');
    this.rebuildCtrlRow();
  }

  private paste(): void {
    if (!this.clipboard) { this.showToast('Nothing to paste'); return; }
    this.saveUndo();
    const copy: PlacedPiece = { ...this.clipboard, x: this.clipboard.x + 60, y: this.clipboard.y + 60 };
    this.clipboard = { ...copy }; // advance clipboard so each subsequent paste offsets further
    this.pieces.push(copy);
    this.updateBarrierImg();
    this.selectPiece(this.pieces.length - 1);
    this.scrollToShowPiece(this.pieces.length - 1);
    this.isDirty = true;
  }

  // ── Undo / redo ───────────────────────────────────────────────────────────────

  private snapshot(): EditorSnapshot {
    return {
      pieces:       this.pieces.map(p => ({ ...p })),
      finishMarker: this.finishMarker ? { ...this.finishMarker } : null,
      checkpoints:  this.checkpoints.map(c => ({ ...c })),
      startX:       this.curStartX, startY: this.curStartY, startHeading: this.curStartH,
    };
  }

  private saveUndo(): void {
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
    this.redoStack = [];
  }

  private restoreSnapshot(s: EditorSnapshot): void {
    this.pieces       = s.pieces.map(p => ({ ...p }));
    this.finishMarker = s.finishMarker ? { ...s.finishMarker } : null;
    this.checkpoints  = s.checkpoints.map(c => ({ ...c }));
    this.curStartX = s.startX; this.curStartY = s.startY; this.curStartH = s.startHeading;
    this.deselectAll();
    this.updateBarrierImg();
    this.updateStartCarImg();
    this.updateFinishImg();
    this.updateCheckpointImgs();
    this.isDirty = true;
  }

  private undo(): void {
    const s = this.undoStack.pop();
    if (!s) { this.showToast('Nothing to undo'); return; }
    this.redoStack.push(this.snapshot());
    this.restoreSnapshot(s);
  }

  private redo(): void {
    const s = this.redoStack.pop();
    if (!s) { this.showToast('Nothing to redo'); return; }
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
    ctrlEl.style.cssText = 'display:none;gap:5px;align-items:center;overflow-x:auto;';
    wrapperEl.appendChild(ctrlEl);

    // Piece buttons content area.
    const contentEl = document.createElement('div');
    contentEl.id = 'ed-content';
    contentEl.style.cssText = 'display:flex;flex-direction:column;gap:4px;';
    wrapperEl.appendChild(contentEl);

    // Tab row — always at the very bottom
    const tabRow = document.createElement('div');
    tabRow.id = 'ed-tabs';
    tabRow.style.cssText = 'display:flex;gap:4px;flex-shrink:0;';
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
      { tab: 'tight',      label: 'Tight',    draw: (c, g) => drawCornerIcon(c, 'corner',     90, false, 'both', g) },
      { tab: 'big',        label: 'Big',      draw: (c, g) => drawCornerIcon(c, 'big_corner', 90, false, 'both', g) },
      { tab: 'finish',     label: 'Finish',   imgBase: 'assets/markers/tile_finish_' },
      { tab: 'checkpoint', label: 'Chkpt',    imgBase: 'assets/markers/tile_checkpoint_' },
    ];

    for (const def of defs) {
      const active = this.palTab === def.tab;
      const btn = document.createElement('button');
      btn.style.cssText = [
        'flex:1', 'min-width:0', 'display:flex', 'flex-direction:column',
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
        'flex:1', 'min-width:0', 'display:flex', 'flex-direction:column',
        'align-items:center', 'justify-content:center',
        'gap:2px', 'padding:3px 2px', 'border-radius:6px', 'cursor:pointer',
        active ? 'background:#1a2a1a;border:1.5px solid #44aa55;'
               : 'background:#111120;border:1px solid #2a2a44;',
      ].join(';');
      const c = document.createElement('canvas');
      c.width = ICO; c.height = ICO;
      // width:100% makes the canvas fill the button; aspect-ratio keeps it square.
      c.style.cssText = 'width:100%;aspect-ratio:1;display:block;';
      draw(c, active);
      btn.appendChild(c);
      if (label) {
        const sp = document.createElement('span');
        sp.textContent = label;
        sp.style.cssText = `font:bold 9px Arial,sans-serif;line-height:1;color:${active ? '#88ff66' : '#5566aa'};`;
        btn.appendChild(sp);
      }
      return btn;
    };

    // Helper: sprite image button (finish/checkpoint).
    // Sprites rotated 45° to sit on the top-left→bottom-right diagonal of the piece icons.
    // displayPx: CSS display size of the image; pass a smaller value for the circle
    // checkpoint so it appears at the same pixel density as the gate (120px sprite).
    const mkSpriteBtn = (src: string, label: string, color: string, displayPx = ICO): HTMLButtonElement => {
      const btn = document.createElement('button');
      btn.style.cssText = [
        'flex:1', 'min-width:0', 'display:flex', 'flex-direction:column',
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
        const sp = document.createElement('div'); sp.style.cssText = 'flex:1;min-width:0;'; row.appendChild(sp);
      }
      el.appendChild(row);
    }

    // ─ Tight corner ─
    if (this.palTab === 'tight') {
      const row = this.mkRow(); row.style.gap = '3px';
      for (const ang of CORNER_ANGLES) {
        const b = mkCanvasBtn((c, g) => drawCornerIcon(c, 'corner', ang, this.palFlip, this.palWalls, g), `${ang}°`, this.palAngle === ang);
        b.addEventListener('click', () => {
          this.palAngle = ang;
          this.addPieceFromPalette({ type:'corner', angle:ang, walls:this.palWalls, flip:this.palFlip });
        });
        row.appendChild(b);
      }
      el.appendChild(row);
    }

    // ─ Big corner ─
    if (this.palTab === 'big') {
      const row = this.mkRow(); row.style.gap = '3px';
      for (const ang of CORNER_ANGLES) {
        const b = mkCanvasBtn((c, g) => drawCornerIcon(c, 'big_corner', ang, this.palFlip, this.palWalls, g), `${ang}°`, this.palAngle === ang);
        b.addEventListener('click', () => {
          this.palAngle = ang;
          this.addPieceFromPalette({ type:'big_corner', angle:ang, walls:this.palWalls, flip:this.palFlip });
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
    const isCornerTab = tab === 'tight' || tab === 'big';
    const isPieceTab  = tab === 'straight' || tab === 'tight' || tab === 'big';

    const showFlip   = (!sel && isCornerTab) || isCornerSel;
    const showWall   = (!sel && isPieceTab)  || !!selPiece;
    const showRotate = !!sel;
    const showCopy   = !!selPiece;
    const showDelete = !!selPiece || sel?.kind === 'finish' || sel?.kind === 'checkpoint';
    const showLabel  = !!sel && sel.kind !== 'piece';

    if (!showFlip && !showWall && !showRotate) {
      el.style.display = 'none';
      return;
    }
    el.style.display = 'flex';

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
      togBtn.addEventListener('click', () => {
        const cycle: WallVariant[] = ['both', 'outer', 'inner'];
        const next = cycle[(cycle.indexOf(curWalls) + 1) % cycle.length];
        if (selPiece) this.changePieceWalls(next);
        else { this.palWalls = next; this.rebuildContent(); }
      });
      el.appendChild(togBtn);
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

    // Flip — sets palFlip (no selection) or piece flip (corner selected)
    if (showFlip) {
      const curFlip = isCornerSel ? ((selPiece as CornerDef).flip ?? false) : this.palFlip;
      el.appendChild(mkB(ic('flip-horizontal', 'Flip'), 'Flip',
        '#ccccff', '#22224a', '#6666cc',
        () => {
          if (isCornerSel) this.changePieceFlip(!curFlip);
          else { this.palFlip = !curFlip; this.rebuildContent(); }
        }));
    }

    // Spacer — pushes rotate/copy/delete to the right
    { const sp = document.createElement('div'); sp.style.cssText = 'flex:1;min-width:4px;'; el.appendChild(sp); }

    // Rotate - angle + — visible whenever anything is selected
    if (showRotate) {
      const rot =
        sel!.kind === 'car'          ? this.curStartH
        : sel!.kind === 'finish'     ? (this.finishMarker?.rotation ?? 0)
        : sel!.kind === 'checkpoint' ? (this.checkpoints[(sel as { kind: 'checkpoint'; idx: number }).idx]?.rotation ?? 0)
        : selPiece!.rotation;
      el.appendChild(mkB(ic('rotate-left'),  'Rotate −15°', '#aaaacc', '#111128', '#2a2a44', () => this.rotateSelected(-15)));
      const angEl = document.createElement('span');
      angEl.id = 'ed-ctrl-angle';
      angEl.textContent = `${rot}°`;
      angEl.style.cssText = 'color:#8888aa;font:12px Arial,sans-serif;min-width:34px;text-align:center;flex-shrink:0;';
      el.appendChild(angEl);
      el.appendChild(mkB(ic('rotate-right'), 'Rotate +15°', '#aaaacc', '#111128', '#2a2a44', () => this.rotateSelected(15)));
    }

    // Copy / Paste — pieces only
    if (showCopy) {
      el.appendChild(mkB(ic('content-copy'),  'Copy piece', '#aaaaff', '#0a0a22', '#333366', () => this.copySelected()));
      if (this.clipboard)
        el.appendChild(mkB(ic('content-paste'), 'Paste copy', '#aaaaff', '#0a0a22', '#333366', () => this.paste()));
    }

    // Delete — pieces + finish + checkpoint (not car start)
    if (showDelete) {
      let delFn: () => void;
      if (selPiece) {
        delFn = () => this.deleteSelectedPiece();
      } else if (sel!.kind === 'finish') {
        delFn = () => { this.saveUndo(); this.finishMarker = null; this.updateFinishImg(); this.deselectAll(); this.isDirty = true; };
      } else {
        const cidx = (sel as { kind: 'checkpoint'; idx: number }).idx;
        delFn = () => { this.saveUndo(); this.checkpoints.splice(cidx, 1); this.updateCheckpointImgs(); this.deselectAll(); this.isDirty = true; };
      }
      el.appendChild(mkB(ic('delete'), 'Delete', '#ff8888', '#1a0808', '#663333', delFn));
    }
  }

  // ── DOM helpers ───────────────────────────────────────────────────────────────

  private mkRow(): HTMLDivElement {
    const r = document.createElement('div');
    r.style.cssText = 'display:flex;gap:5px;';
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

  private scrollToShowPiece(idx: number): void {
    const p = this.pieces[idx];
    if (!p) return;
    const cam = this.cameras.main;
    const W = this.scale.width, H = this.scale.height;
    const pH = this.paletteH();
    const margin = Math.min(W, H - HEADER_H - pH) * 0.12;

    // Bounding box of piece center + both connectors, padded by HALF_TRACK so
    // the track walls (not just the spine) clear the palette and header.
    const { entry, exit } = worldConnectors(p);
    const minWX = Math.min(p.x, entry.x, exit.x) - HALF_TRACK;
    const maxWX = Math.max(p.x, entry.x, exit.x) + HALF_TRACK;
    const minWY = Math.min(p.y, entry.y, exit.y) - HALF_TRACK;
    const maxWY = Math.max(p.y, entry.y, exit.y) + HALF_TRACK;

    let { scrollX, scrollY } = cam;
    const z = cam.zoom;

    const sx0 = (minWX - scrollX) * z;
    const sx1 = (maxWX - scrollX) * z;
    if (sx0 < margin)       scrollX -= (margin - sx0) / z;
    if (sx1 > W - margin)   scrollX += (sx1 - (W - margin)) / z;

    const topBound = HEADER_H + margin;
    const botBound = H - pH - margin;
    const sy0 = (minWY - scrollY) * z;
    const sy1 = (maxWY - scrollY) * z;
    if (sy0 < topBound)     scrollY -= (topBound - sy0) / z;
    if (sy1 > botBound)     scrollY += (sy1 - botBound) / z;

    cam.setScroll(scrollX, scrollY);
  }

  // ── Save / drafts ─────────────────────────────────────────────────────────────

  private openDrafts(): void {
    if (!this.isDirty) { this.scene.start('TrackSelect', { activeTab: 'drafts' }); return; }
    this.showConfirm('Discard unsaved changes?', 'Discard',
      () => this.scene.start('TrackSelect', { activeTab: 'drafts' }),
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
        await saveDraft(name, JSON.stringify(payload), this.mineTrackId ?? undefined);
        this.isDirty = false;
        overlay.remove();
        this.scene.start('TrackSelect', { activeTab: 'drafts' });
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
    const t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = [
      'position:fixed', `bottom:${this.paletteH() + 10}px`, 'left:50%',
      'transform:translateX(-50%)', 'background:#2a2a50', 'border:1px solid #5555aa',
      'border-radius:6px', 'padding:8px 16px', 'color:#ccccff', 'font:13px Arial,sans-serif',
      'z-index:400', 'pointer-events:none', 'white-space:nowrap',
    ].join(';');
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2500);
  }

  override update(_time: number, delta: number): void {
    // Advance marching-ants dash offset; redraw only when a piece is selected and not being moved
    if (this.selCanvasTex && this.selection?.kind === 'piece') {
      this.selDashOffset = (this.selDashOffset + delta * 0.03) % 18;
      this.redrawSelectionDashes();
    }
  }
}
