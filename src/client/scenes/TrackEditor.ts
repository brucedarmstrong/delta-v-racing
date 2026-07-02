import { Scene, GameObjects } from 'phaser';
import { drawBarriersOnCanvas } from '../track/TrackCanvasRenderer';
import {
  buildTrackWithCursor, trackBounds,
  type CornerDef, type PieceDef, type PlacedPiece,
} from '../track/TrackLayout';
import {
  CORRIDOR,
  CORNER_ANGLES, STRAIGHT_SIZES,
  type CornerAngle, type CornerFamily,
} from '../track/TrackGeometry';
import type { TrackMarker } from '../track/convertGmsTrack';
import type { TrackEntry } from '../tracks/trackRegistry';
import { saveDraft } from '../track/TrackUpload';
import type { TrackPayload } from '../track/TrackUpload';

const BG        = 0x0a0a16;
const HEADER_H  = 60;
const PALETTE_H = 246;
const DEFAULT_START_X = 0, DEFAULT_START_Y = 0, DEFAULT_START_HEADING = 180;

export class TrackEditor extends Scene {
  // Track chain state
  private defs:         PieceDef[]    = [];
  private placed:       PlacedPiece[] = [];
  private cursor        = { x: DEFAULT_START_X, y: DEFAULT_START_Y, heading: DEFAULT_START_HEADING };
  private finishMarker:  TrackMarker | null = null;
  private checkpoints:   TrackMarker[]     = [];

  // Mutable start position / heading (editor can change these)
  private curStartX       = DEFAULT_START_X;
  private curStartY       = DEFAULT_START_Y;
  private curStartHeading = DEFAULT_START_HEADING;

  // Car selection + drag state
  private isCarSelected   = false;
  private isDraggingStart = false;

  // Finish line selection + drag state
  private isFinishSelected      = false;
  private isDraggingFinish      = false;

  // Checkpoint selection + drag state
  private selectedCheckpointIdx = -1;
  private isDraggingCheckpoint  = false;

  // Ordered undo stack — tracks the sequence in which pieces/markers were added
  private undoStack: Array<'piece' | 'finish' | 'checkpoint'> = [];

  // Dirty flag — true when track has unsaved changes
  private isDirty = false;

  // Rotate button refs — enabled when car OR finish is selected
  private rotateCcwBtn: HTMLButtonElement | null = null;
  private rotateCwBtn:  HTMLButtonElement | null = null;

  // Selection ring (world-space graphics, redrawn when selection changes)
  private selectionGfx!: GameObjects.Graphics;

  // Palette state
  private palTab:    'straight' | 'corner' = 'straight';
  private palFamily: CornerFamily           = 'corner';
  private palFlip    = false;
  private palAngle:  CornerAngle = 90;

  // Camera / drag state — same pattern as Game.ts
  private dragStartX  = 0;
  private dragStartY  = 0;
  private dragScrollX = 0;
  private dragScrollY = 0;
  private isDragging  = false;
  private touches     = new Map<number, { x: number; y: number }>();
  private pinchDist   = 0;
  private pinchZoom   = 1;

  // Phaser world-space rendering
  private markerGfx!:     GameObjects.Graphics;
  private barrierImg:     GameObjects.Image | null = null;
  private finishImg:      GameObjects.Image | null = null;
  private checkpointImgs: GameObjects.Image[]      = [];
  private startCarImg:    GameObjects.Image | null = null;

  // DOM
  private palEl:  HTMLElement | null = null;
  private hintEl: HTMLElement | null = null;

  // Mine track context (set when editing an existing draft)
  private mineTrackId: string | null = null;

  constructor() { super('TrackEditor'); }

  preload(): void {
    for (const key of ['tile_finish_0', 'tile_checkpoint_0', 'tile_checkpoint_circle_0']) {
      if (!this.textures.exists(key)) this.load.image(key, `assets/markers/${key}.png`);
    }
  }

  init(data?: { mineTrackId?: string; track?: TrackEntry; startHeading?: number }): void {
    this.defs               = [];
    this.placed             = [];
    this.finishMarker       = null;
    this.checkpoints        = [];
    this.isDirty            = false;
    this.mineTrackId        = data?.mineTrackId ?? null;
    this.isCarSelected         = false;
    this.isDraggingStart       = false;
    this.isFinishSelected      = false;
    this.isDraggingFinish      = false;
    this.selectedCheckpointIdx = -1;
    this.isDraggingCheckpoint  = false;
    this.undoStack             = [];
    this.startCarImg        = null; // Phaser destroys it on shutdown; clear our reference

    // Car start position — independent of the track-building origin.
    this.curStartX       = data?.track?.startX ?? DEFAULT_START_X;
    this.curStartY       = data?.track?.startY ?? DEFAULT_START_Y;
    this.curStartHeading = data?.startHeading  ?? DEFAULT_START_HEADING;

    // Track always builds from a fixed origin; cursor starts there.
    this.cursor = { x: DEFAULT_START_X, y: DEFAULT_START_Y, heading: DEFAULT_START_HEADING };

    const track = data?.track;
    if (track) {
      this.defs = track.pieces.map(p => {
        if (p.type === 'straight') {
          return { type: p.type, size: p.size, walls: p.walls } as PieceDef;
        }
        return { type: p.type, angle: (p as CornerDef).angle, walls: p.walls, flip: (p as CornerDef).flip } as PieceDef;
      });
      const result = buildTrackWithCursor({
        startX: DEFAULT_START_X, startY: DEFAULT_START_Y,
        startHeading: DEFAULT_START_HEADING, pieces: this.defs,
      });
      this.placed = result.placed;
      this.cursor = result.cursor;
      this.finishMarker = track.markers.find(m => m.kind === 'finish') ?? null;
      this.checkpoints  = track.markers.filter(m => m.kind === 'checkpoint');
      // Rebuild undo stack from loaded state (pieces first, then finish, then checkpoints)
      for (let i = 0; i < this.defs.length; i++) this.undoStack.push('piece');
      if (this.finishMarker) this.undoStack.push('finish');
      for (const _ of this.checkpoints) this.undoStack.push('checkpoint');
    }
  }

  create() {
    const cam = this.cameras.main;
    cam.setBackgroundColor(BG);
    cam.setZoom(0.65);
    cam.centerOn(DEFAULT_START_X, DEFAULT_START_Y);

    // ── DOM header (DOM avoids setScrollFactor(0) + camera-zoom scaling issue)
    const hdrEl = document.createElement('div');
    hdrEl.style.cssText = [
      'position:fixed', 'top:0', 'left:0', 'right:0',
      `height:${HEADER_H}px`,
      'background:#12122a', 'border-bottom:1px solid #3a3a6a',
      'display:flex', 'align-items:center',
      'z-index:100', 'user-select:none', '-webkit-user-select:none',
    ].join(';');

    const backBtn = document.createElement('button');
    backBtn.textContent = '‹ Back';
    backBtn.style.cssText = [
      'background:none', 'border:none', 'cursor:pointer',
      'color:#8888ff', 'font:bold 16px "Arial Black",Arial,sans-serif',
      'padding:0 16px', `height:${HEADER_H}px`,
    ].join(';');
    backBtn.addEventListener('click', () => this.scene.start('ModeSelect'));

    const titleEl = document.createElement('span');
    titleEl.textContent = 'EDITOR';
    titleEl.style.cssText = [
      'position:absolute', 'left:50%', 'transform:translateX(-50%)',
      'color:#e8e8ff', 'font:bold 18px "Arial Black",Arial,sans-serif',
      'pointer-events:none',
    ].join(';');

    const mkHdrBtn = (label: string, clr: string, bg: string, border: string, fn: () => void) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = [
        'background:' + bg, 'border:1px solid ' + border, 'cursor:pointer',
        'color:' + clr, 'font:bold 13px Arial,sans-serif',
        'padding:6px 12px', 'border-radius:6px', 'margin-right:8px',
        `height:${HEADER_H - 16}px`,
      ].join(';');
      b.addEventListener('click', fn);
      return b;
    };

    const hdrRight = document.createElement('div');
    hdrRight.style.cssText = 'margin-left:auto; display:flex; align-items:center;';
    hdrRight.appendChild(mkHdrBtn('📂', '#aaaaff', '#0a0a22', '#333366', () => this.openDrafts()));
    hdrRight.appendChild(mkHdrBtn('↩', '#ffaa44', '#1a0e00', '#553300', () => this.undo()));
    hdrRight.appendChild(mkHdrBtn('✓', '#66ff99', '#001a08', '#226633', () => this.showSaveDialog()));

    hdrEl.appendChild(backBtn);
    hdrEl.appendChild(titleEl);
    hdrEl.appendChild(hdrRight);
    document.body.appendChild(hdrEl);

    // ── Empty-state hint
    const hintEl = document.createElement('div');
    hintEl.textContent = 'Tap a piece below to start building';
    hintEl.style.cssText = [
      'position:fixed', `bottom:${PALETTE_H + 40}px`,
      'left:0', 'right:0', 'text-align:center',
      'color:rgba(120,120,200,0.6)', 'font:14px Arial,sans-serif',
      'pointer-events:none', 'z-index:30',
    ].join(';');
    document.body.appendChild(hintEl);
    this.hintEl = hintEl;

    // ── World-space grid (drawn once; camera pan/zoom handles the rest)
    const gridGfx = this.add.graphics();
    gridGfx.lineStyle(1, 0x1c1c4c, 1);
    const EXT = 4800, CELL = 24;
    for (let x = -EXT; x <= EXT; x += CELL) gridGfx.lineBetween(x, -EXT, x, EXT);
    for (let y = -EXT; y <= EXT; y += CELL) gridGfx.lineBetween(-EXT, y, EXT, y);

    // ── World-space markers + cursor (redrawn on track change)
    this.markerGfx    = this.add.graphics().setDepth(5);
    this.selectionGfx = this.add.graphics().setDepth(7); // above car (6)

    // ── Input — identical to GridTest / Game.ts; no DOM canvas, no raw pointer events
    this.input.addPointer(1);

    this.input.on('pointerdown', (ptr: Phaser.Input.Pointer) => {
      if (ptr.y > this.scale.height - PALETTE_H) return;
      this.touches.set(ptr.id, { x: ptr.x, y: ptr.y });
      if (this.touches.size >= 2) {
        this.isDraggingStart      = false;
        this.isDraggingCheckpoint = false;
        const [a, b] = [...this.touches.values()];
        this.pinchDist = Math.hypot(b.x - a.x, b.y - a.y);
        this.pinchZoom = cam.zoom;
        return;
      }
      // ptr.worldX/Y is Phaser's own camera-corrected world position — always correct.
      const hitRadius = 48; // world units; ~31 screen px at default zoom 0.65
      if (Math.hypot(ptr.worldX - this.curStartX, ptr.worldY - this.curStartY) < hitRadius) {
        // Tap/press on car — select it and begin drag
        if (this.isFinishSelected)           this.deselectFinish();
        if (this.selectedCheckpointIdx >= 0) this.deselectCheckpoint();
        if (!this.isCarSelected)             this.selectCar();
        this.isDraggingStart = true;
        return;
      }
      if (this.finishMarker &&
          Math.hypot(ptr.worldX - this.finishMarker.x, ptr.worldY - this.finishMarker.y) < hitRadius) {
        // Tap/press on finish line — select it and begin drag
        if (this.isCarSelected)              this.deselectCar();
        if (this.selectedCheckpointIdx >= 0) this.deselectCheckpoint();
        if (!this.isFinishSelected)          this.selectFinish();
        this.isDraggingFinish = true;
        return;
      }
      // Check checkpoints
      for (let i = 0; i < this.checkpoints.length; i++) {
        const cp = this.checkpoints[i];
        if (Math.hypot(ptr.worldX - cp.x, ptr.worldY - cp.y) < hitRadius) {
          if (this.isCarSelected)    this.deselectCar();
          if (this.isFinishSelected) this.deselectFinish();
          this.selectCheckpoint(i);
          this.isDraggingCheckpoint = true;
          return;
        }
      }
      // Tapped elsewhere — deselect everything, start camera pan
      if (this.isCarSelected)              this.deselectCar();
      if (this.isFinishSelected)           this.deselectFinish();
      if (this.selectedCheckpointIdx >= 0) this.deselectCheckpoint();
      this.isDraggingStart      = false;
      this.isDraggingFinish     = false;
      this.isDraggingCheckpoint = false;
      this.isDragging           = false;
      this.dragStartX           = ptr.x;
      this.dragStartY           = ptr.y;
      this.dragScrollX          = cam.scrollX;
      this.dragScrollY          = cam.scrollY;
    });

    this.input.on('pointermove', (ptr: Phaser.Input.Pointer) => {
      if (this.touches.has(ptr.id)) this.touches.set(ptr.id, { x: ptr.x, y: ptr.y });
      if (this.touches.size >= 2) {
        const [a, b] = [...this.touches.values()];
        const dist = Math.hypot(b.x - a.x, b.y - a.y);
        if (this.pinchDist > 0) {
          cam.setZoom(Math.min(Math.max(this.pinchZoom * dist / this.pinchDist, 0.12), 4));
        }
        return;
      }
      if (!ptr.isDown) return;
      if (this.isDraggingStart) {
        this.curStartX = ptr.worldX;
        this.curStartY = ptr.worldY;
        this.updateStartCarImg();
        return;
      }
      if (this.isDraggingFinish && this.finishMarker) {
        this.finishMarker.x = ptr.worldX;
        this.finishMarker.y = ptr.worldY;
        this.updateFinishImg();
        this.updateSelectionRing();
        return;
      }
      if (this.isDraggingCheckpoint && this.selectedCheckpointIdx >= 0) {
        const cp  = this.checkpoints[this.selectedCheckpointIdx];
        const img = this.checkpointImgs[this.selectedCheckpointIdx];
        if (cp && img) {
          cp.x = ptr.worldX;
          cp.y = ptr.worldY;
          img.setPosition(ptr.worldX, ptr.worldY);
          this.updateSelectionRing();
        }
        return;
      }
      const dx = ptr.x - this.dragStartX;
      const dy = ptr.y - this.dragStartY;
      if (!this.isDragging && Math.abs(dx) + Math.abs(dy) > 5) this.isDragging = true;
      if (this.isDragging) {
        const z = cam.zoom;
        cam.setScroll(this.dragScrollX - dx / z, this.dragScrollY - dy / z);
      }
    });

    this.input.on('pointerup', (ptr: Phaser.Input.Pointer) => {
      const wasPinching = this.touches.size >= 2;
      this.touches.delete(ptr.id);
      if (wasPinching) {
        this.pinchDist = 0;
        const rem = [...this.touches.values()][0];
        if (rem) {
          this.dragStartX  = rem.x;
          this.dragStartY  = rem.y;
          this.dragScrollX = cam.scrollX;
          this.dragScrollY = cam.scrollY;
        }
      }
      if (this.isDraggingStart || this.isDraggingFinish || this.isDraggingCheckpoint) this.isDirty = true;
      this.isDraggingStart      = false;
      this.isDraggingFinish     = false;
      this.isDraggingCheckpoint = false;
      this.isDragging           = false;
    });

    this.input.on('wheel', (ptr: Phaser.Input.Pointer) => {
      if (!ptr.deltaY) return;
      const z = cam.zoom;
      cam.setZoom(Math.min(Math.max(z * (ptr.deltaY > 0 ? 1 / 1.12 : 1.12), 0.12), 4));
    });

    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') this.scene.start('ModeSelect');
    };
    window.addEventListener('keydown', onEsc);

    this.makeEditorCarTexture();
    this.createPalette();
    this.redrawMarkers();
    this.updateStartCarImg();
    this.updateFinishImg();
    this.updateCheckpointImgs();
    if (this.placed.length > 0) {
      this.updateBarrierImg();
      if (this.hintEl) this.hintEl.style.display = 'none';
    }

    this.events.once('shutdown', () => {
      window.removeEventListener('keydown', onEsc);
      hdrEl.remove();
      hintEl.remove();
      this.palEl?.remove();
      this.palEl        = null;
      this.rotateCcwBtn = null;
      this.rotateCwBtn  = null;
    });
  }

  // ── Barrier texture ───────────────────────────────────────────────────────────

  private updateBarrierImg(): void {
    if (this.barrierImg) { this.barrierImg.destroy(); this.barrierImg = null; }
    if (this.placed.length === 0) return;

    const b   = trackBounds(this.placed);
    const pad = 12;
    const w   = Math.ceil(b.width  + pad * 2);
    const h   = Math.ceil(b.height + pad * 2);
    const key = '_ed_barriers';

    if (this.textures.exists(key)) this.textures.remove(key);
    const ct = this.textures.createCanvas(key, w, h)!;
    drawBarriersOnCanvas(ct.getContext(), this.placed,
      b.x - pad, b.y - pad, 1, 1, 0, 0, '#33bb55', 2);
    ct.refresh();

    this.barrierImg = this.add.image(b.x - pad, b.y - pad, key)
      .setOrigin(0, 0).setDepth(3);
  }

  // ── Markers + cursor ──────────────────────────────────────────────────────────

  private redrawMarkers(): void {
    this.markerGfx.clear();
    // Near-closed check: cursor approaching the fixed track-building origin.
    const nearClosed = this.defs.length >= 3
      && Math.hypot(this.cursor.x - DEFAULT_START_X, this.cursor.y - DEFAULT_START_Y) < CORRIDOR * 1.5;
    this.drawWorldDot(this.cursor.x, this.cursor.y, this.cursor.heading,
      nearClosed ? 0x88ff44 : 0xffee00, 6);
  }

  private drawWorldDot(wx: number, wy: number, heading: number, color: number, r: number): void {
    const hr = heading * Math.PI / 180;
    this.markerGfx.lineStyle(1.5, color, 1);
    this.markerGfx.lineBetween(wx, wy, wx + Math.sin(hr) * 20, wy - Math.cos(hr) * 20);
    this.markerGfx.fillStyle(color, 1);
    this.markerGfx.fillCircle(wx, wy, r);
    this.markerGfx.lineStyle(1, 0xffffff, 1);
    this.markerGfx.strokeCircle(wx, wy, r);
  }

  private updateFinishImg(): void {
    this.finishImg?.destroy();
    this.finishImg = null;
    if (!this.finishMarker) return;
    this.finishImg = this.add.image(this.finishMarker.x, this.finishMarker.y, 'tile_finish_0')
      .setAngle(this.finishMarker.rotation)
      .setOrigin(0.5)
      .setDepth(4);
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

  private makeEditorCarTexture(): void {
    const KEY = 'editor_car';
    if (this.textures.exists(KEY)) return;
    const gPx = 36; // slightly larger than gameplay size for editor visibility
    const HW  = Math.round(gPx * 0.50);
    const HH  = Math.round(gPx * 0.85);
    const PAD = Math.round(gPx * 0.45);
    const W   = (HW + PAD) * 2;
    const H   = (HH + PAD) * 2;
    const cx  = W / 2, cy = H / 2;
    const ct  = this.textures.createCanvas(KEY, W, H)!;
    const ctx = ct.getContext();
    ctx.shadowColor = 'hsl(300,100%,60%)';
    ctx.shadowBlur  = 10;
    ctx.fillStyle   = 'hsl(300,100%,60%)';
    ctx.beginPath();
    ctx.moveTo(cx,      cy - HH);
    ctx.lineTo(cx + HW, cy + HH);
    ctx.lineTo(cx,      cy + HH * 0.35);
    ctx.lineTo(cx - HW, cy + HH);
    ctx.closePath();
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle  = 'rgba(255,255,255,0.80)';
    ctx.beginPath();
    ctx.moveTo(cx,              cy - HH + 3);
    ctx.lineTo(cx + HW * 0.45, cy + HH * 0.2);
    ctx.lineTo(cx,              cy + HH * 0.1);
    ctx.lineTo(cx - HW * 0.45, cy + HH * 0.2);
    ctx.closePath();
    ctx.fill();
    ct.refresh();
  }

  private updateStartCarImg(): void {
    this.startCarImg?.destroy();
    this.startCarImg = this.add.image(this.curStartX, this.curStartY, 'editor_car')
      .setAngle(this.curStartHeading) // texture points north; heading 0=N, 90=E, 180=S
      .setOrigin(0.5)
      .setDepth(6); // above finish (4) and marker gfx (5)
    this.updateSelectionRing();
  }

  private selectCar(): void {
    this.isCarSelected = true;
    if (this.rotateCcwBtn) this.rotateCcwBtn.disabled = false;
    if (this.rotateCwBtn)  this.rotateCwBtn.disabled  = false;
    this.updateSelectionRing();
  }

  private deselectCar(): void {
    this.isCarSelected = false;
    if (!this.isFinishSelected && this.selectedCheckpointIdx < 0) {
      if (this.rotateCcwBtn) this.rotateCcwBtn.disabled = true;
      if (this.rotateCwBtn)  this.rotateCwBtn.disabled  = true;
    }
    this.updateSelectionRing();
  }

  private selectFinish(): void {
    this.isFinishSelected = true;
    if (this.rotateCcwBtn) this.rotateCcwBtn.disabled = false;
    if (this.rotateCwBtn)  this.rotateCwBtn.disabled  = false;
    this.updateSelectionRing();
  }

  private deselectFinish(): void {
    this.isFinishSelected = false;
    if (!this.isCarSelected && this.selectedCheckpointIdx < 0) {
      if (this.rotateCcwBtn) this.rotateCcwBtn.disabled = true;
      if (this.rotateCwBtn)  this.rotateCwBtn.disabled  = true;
    }
    this.updateSelectionRing();
  }

  private selectCheckpoint(i: number): void {
    this.selectedCheckpointIdx = i;
    if (this.rotateCcwBtn) this.rotateCcwBtn.disabled = false;
    if (this.rotateCwBtn)  this.rotateCwBtn.disabled  = false;
    this.updateSelectionRing();
  }

  private deselectCheckpoint(): void {
    this.selectedCheckpointIdx = -1;
    if (!this.isCarSelected && !this.isFinishSelected) {
      if (this.rotateCcwBtn) this.rotateCcwBtn.disabled = true;
      if (this.rotateCwBtn)  this.rotateCwBtn.disabled  = true;
    }
    this.updateSelectionRing();
  }

  private updateSelectionRing(): void {
    this.selectionGfx.clear();
    if (this.isCarSelected) {
      const r = 36;
      this.selectionGfx.lineStyle(2, 0x00eeff, 0.9);
      this.selectionGfx.strokeCircle(this.curStartX, this.curStartY, r);
      this.selectionGfx.fillStyle(0x00eeff, 1);
      for (const [dx, dy] of [[0, -r], [r, 0], [0, r], [-r, 0]] as [number, number][]) {
        this.selectionGfx.fillCircle(this.curStartX + dx, this.curStartY + dy, 3.5);
      }
    }
    if (this.isFinishSelected && this.finishMarker) {
      const r = 36;
      this.selectionGfx.lineStyle(2, 0xffdd00, 0.9);
      this.selectionGfx.strokeCircle(this.finishMarker.x, this.finishMarker.y, r);
      this.selectionGfx.fillStyle(0xffdd00, 1);
      for (const [dx, dy] of [[0, -r], [r, 0], [0, r], [-r, 0]] as [number, number][]) {
        this.selectionGfx.fillCircle(this.finishMarker.x + dx, this.finishMarker.y + dy, 3.5);
      }
    }
    if (this.selectedCheckpointIdx >= 0) {
      const cp = this.checkpoints[this.selectedCheckpointIdx];
      if (cp) {
        const r = 36;
        this.selectionGfx.lineStyle(2, 0x00ccff, 0.9);
        this.selectionGfx.strokeCircle(cp.x, cp.y, r);
        this.selectionGfx.fillStyle(0x00ccff, 1);
        for (const [dx, dy] of [[0, -r], [r, 0], [0, r], [-r, 0]] as [number, number][]) {
          this.selectionGfx.fillCircle(cp.x + dx, cp.y + dy, 3.5);
        }
      }
    }
  }

  // ── Track editing ─────────────────────────────────────────────────────────────

  private rebuildTrack(): void {
    // Track always builds from a fixed origin; curStart* is the car position only.
    const result = buildTrackWithCursor({
      startX: DEFAULT_START_X, startY: DEFAULT_START_Y,
      startHeading: DEFAULT_START_HEADING, pieces: this.defs,
    });
    this.placed = result.placed;
    this.cursor = result.cursor;
  }

  // Preserved for future "move/rotate entire track" feature — not called from car UI.
  private rebuildFromStart(): void {
    const result = buildTrackWithCursor({
      startX: this.curStartX, startY: this.curStartY,
      startHeading: this.curStartHeading, pieces: this.defs,
    });
    this.placed = result.placed;
    this.cursor = result.cursor;
    this.updateBarrierImg();
    this.redrawMarkers();
    this.updateFinishImg();
  }

  private rotateStartHeading(delta: number): void {
    this.isDirty = true;
    if (this.selectedCheckpointIdx >= 0) {
      const cp = this.checkpoints[this.selectedCheckpointIdx];
      if (cp) {
        cp.rotation = ((cp.rotation + delta) % 360 + 360) % 360;
        this.updateCheckpointImgs();
        this.updateSelectionRing();
      }
      return;
    }
    if (this.isFinishSelected && this.finishMarker) {
      this.finishMarker.rotation = ((this.finishMarker.rotation + delta) % 360 + 360) % 360;
      this.updateFinishImg();
      this.updateSelectionRing();
      return;
    }
    if (!this.isCarSelected) return;
    this.curStartHeading = ((this.curStartHeading + delta) % 360 + 360) % 360;
    this.updateStartCarImg();
    this.updateStartHeadingDisplay();
  }

  private updateStartHeadingDisplay(): void {
    const el = document.getElementById('ed-start-heading');
    if (el) {
      el.innerHTML =
        `<span style="display:inline-block;transform:rotate(${this.curStartHeading}deg)">↑</span> ${this.curStartHeading}°`;
    }
  }

  private addPiece(def: PieceDef): void {
    this.isDirty = true;
    this.defs.push(def);
    this.undoStack.push('piece');
    this.rebuildTrack();
    this.scrollToCursor();
    this.updateBarrierImg();
    this.redrawMarkers();
    this.rebuildOpts();
    if (this.hintEl) this.hintEl.style.display = 'none';
  }

  private undo(): void {
    const last = this.undoStack.pop();
    if (!last) return;
    this.isDirty = true;
    if (last === 'finish') {
      this.finishMarker = null;
      if (this.isFinishSelected) this.deselectFinish();
      this.updateFinishImg();
      this.redrawMarkers();
    } else if (last === 'checkpoint') {
      this.checkpoints.pop();
      if (this.selectedCheckpointIdx >= this.checkpoints.length) this.deselectCheckpoint();
      this.updateCheckpointImgs();
      this.redrawMarkers();
    } else {
      if (this.defs.length === 0) return;
      this.defs.pop();
      this.rebuildTrack();
      this.scrollToCursor();
      this.updateBarrierImg();
      this.redrawMarkers();
      this.rebuildOpts();
      if (this.hintEl) this.hintEl.style.display = this.defs.length === 0 ? '' : 'none';
    }
  }

  private scrollToCursor(): void {
    const cam    = this.cameras.main;
    const W      = this.scale.width;
    const H      = this.scale.height;
    const margin = Math.min(W, H - HEADER_H - PALETTE_H) * 0.22;

    const sx = (this.cursor.x - cam.scrollX) * cam.zoom;
    const sy = (this.cursor.y - cam.scrollY) * cam.zoom;

    if (sx < margin)                        cam.setScroll(cam.scrollX - (margin - sx) / cam.zoom, cam.scrollY);
    if (sx > W - margin)                    cam.setScroll(cam.scrollX + (sx - W + margin) / cam.zoom, cam.scrollY);
    if (sy < HEADER_H + margin)             cam.setScroll(cam.scrollX, cam.scrollY - (HEADER_H + margin - sy) / cam.zoom);
    if (sy > H - PALETTE_H - margin)        cam.setScroll(cam.scrollX, cam.scrollY + (sy - (H - PALETTE_H - margin)) / cam.zoom);
  }

  private placeFinish(): void {
    if (this.defs.length === 0) { this.showToast('Add pieces first'); return; }
    this.isDirty = true;
    this.undoStack.push('finish');
    this.finishMarker = {
      kind: 'finish', shape: 'gate',
      x: this.cursor.x, y: this.cursor.y,
      rotation: this.cursor.heading,
    };
    this.updateFinishImg();
    this.redrawMarkers();
    this.showToast('Finish line placed  ⚑');
  }

  private placeCheckpoint(shape: 'gate' | 'circle'): void {
    if (this.defs.length === 0) { this.showToast('Add pieces first'); return; }
    this.isDirty = true;
    this.undoStack.push('checkpoint');
    this.checkpoints.push({
      kind: 'checkpoint', shape,
      x: this.cursor.x, y: this.cursor.y,
      rotation: this.cursor.heading,
    });
    this.updateCheckpointImgs();
    this.redrawMarkers();
    this.showToast(shape === 'gate' ? 'Rect checkpoint placed' : 'Round checkpoint placed');
  }

  // ── Palette ───────────────────────────────────────────────────────────────────

  private createPalette(): void {
    const el = document.createElement('div');
    el.style.cssText = [
      'position:fixed', 'bottom:0', 'left:0', 'right:0',
      `height:${PALETTE_H}px`,
      'background:#0d0d20',
      'border-top:1.5px solid #3a3a6a',
      'z-index:100',
      'padding:8px 10px max(env(safe-area-inset-bottom,0px),10px)',
      'box-sizing:border-box',
      'display:flex', 'flex-direction:column', 'gap:7px',
      'user-select:none', '-webkit-user-select:none',
    ].join(';');

    const tabRow = document.createElement('div');
    tabRow.id = 'ed-tabs';
    tabRow.style.cssText = 'display:flex;gap:6px;';
    el.appendChild(tabRow);

    const optEl = document.createElement('div');
    optEl.id = 'ed-opts';
    optEl.style.cssText = 'display:flex;flex-direction:column;gap:6px;flex:1;min-height:0;';
    el.appendChild(optEl);

    // ── Start heading row
    const headRow = document.createElement('div');
    headRow.style.cssText = 'display:flex;gap:6px;align-items:center;';

    const ccwBtn = document.createElement('button') as HTMLButtonElement;
    ccwBtn.textContent = '↶';
    ccwBtn.title    = 'Rotate start CCW 15°';
    ccwBtn.disabled = true;
    ccwBtn.style.cssText = 'padding:6px 12px;border-radius:5px;border:1px solid #444466;background:#111128;color:#8888ff;font:bold 16px Arial,sans-serif;cursor:pointer;';
    ccwBtn.addEventListener('click', () => this.rotateStartHeading(-15));
    this.rotateCcwBtn = ccwBtn;

    const headLabel = document.createElement('span');
    headLabel.id = 'ed-start-heading';
    headLabel.style.cssText = 'flex:1;text-align:center;color:#aaaacc;font:13px Arial,sans-serif;min-width:60px;';
    headLabel.innerHTML =
      `<span style="display:inline-block;transform:rotate(${this.curStartHeading}deg)">↑</span> ${this.curStartHeading}°`;

    const cwBtn = document.createElement('button') as HTMLButtonElement;
    cwBtn.textContent = '↷';
    cwBtn.title    = 'Rotate start CW 15°';
    cwBtn.disabled = true;
    cwBtn.style.cssText = 'padding:6px 12px;border-radius:5px;border:1px solid #444466;background:#111128;color:#8888ff;font:bold 16px Arial,sans-serif;cursor:pointer;';
    cwBtn.addEventListener('click', () => this.rotateStartHeading(15));
    this.rotateCwBtn = cwBtn;

    const hintSpan = document.createElement('span');
    hintSpan.textContent = 'tap car or finish to select';
    hintSpan.style.cssText = 'color:rgba(120,120,180,0.6);font:11px Arial,sans-serif;white-space:nowrap;';

    headRow.appendChild(ccwBtn);
    headRow.appendChild(headLabel);
    headRow.appendChild(cwBtn);
    headRow.appendChild(hintSpan);
    el.appendChild(headRow);

    const actRow = document.createElement('div');
    actRow.style.cssText = 'display:flex;gap:8px;';

    const mkAct = (label: string, clr: string, bg: string, border: string, fn: () => void) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = [
        'flex:1', 'padding:10px 4px',
        `color:${clr}`, `background:${bg}`, `border:1px solid ${border}`,
        'border-radius:6px', 'font:bold 13px Arial,sans-serif', 'cursor:pointer',
      ].join(';');
      b.addEventListener('click', fn);
      return b;
    };
    actRow.appendChild(mkAct('⚑ Finish', '#ff7070', '#1a0005', '#662233', () => this.placeFinish()));

    // Checkpoint — expand/collapse to pick shape
    const cpWrap = document.createElement('div');
    cpWrap.style.cssText = 'flex:1;display:flex;gap:8px;';

    const collapseCp = () => {
      cpWrap.innerHTML = '';
      const b = document.createElement('button');
      b.textContent = '◎ Checkpoint';
      b.style.cssText = [
        'flex:1', 'padding:10px 4px',
        'color:#00ccff', 'background:#001a1a', 'border:1px solid #005566',
        'border-radius:6px', 'font:bold 13px Arial,sans-serif', 'cursor:pointer',
      ].join(';');
      b.addEventListener('click', expandCp);
      cpWrap.appendChild(b);
    };

    const expandCp = () => {
      cpWrap.innerHTML = '';
      const mkCp = (label: string, shape: 'gate' | 'circle') => {
        const b = document.createElement('button');
        b.textContent = label;
        b.style.cssText = [
          'flex:1', 'padding:10px 4px',
          'color:#00ccff', 'background:#001a22', 'border:1.5px solid #00aacc',
          'border-radius:6px', 'font:bold 13px Arial,sans-serif', 'cursor:pointer',
        ].join(';');
        b.addEventListener('click', () => { this.placeCheckpoint(shape); collapseCp(); });
        return b;
      };
      cpWrap.appendChild(mkCp('▭ Rect', 'gate'));
      cpWrap.appendChild(mkCp('⬤ Round', 'circle'));
    };

    collapseCp();
    actRow.appendChild(cpWrap);
    el.appendChild(actRow);

    document.body.appendChild(el);
    this.palEl = el;
    this.rebuildPalette();
  }

  private rebuildPalette(): void {
    this.rebuildTabs();
    this.rebuildOpts();
  }

  private rebuildTabs(): void {
    const row = document.getElementById('ed-tabs');
    if (!row) return;
    row.innerHTML = '';
    const mkTab = (label: string, tab: 'straight' | 'corner') => {
      const active = this.palTab === tab;
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = [
        'flex:1', 'padding:8px',
        active
          ? 'background:#22224a;color:#ccccff;border:1.5px solid #6666cc;'
          : 'background:#111128;color:#6666aa;border:1px solid #2a2a44;',
        'border-radius:5px', 'font:bold 14px Arial,sans-serif', 'cursor:pointer',
      ].join(';');
      b.addEventListener('click', () => { this.palTab = tab; this.rebuildPalette(); });
      return b;
    };
    row.appendChild(mkTab('Straight', 'straight'));
    row.appendChild(mkTab('Corner',   'corner'));
  }

  private rebuildOpts(): void {
    const el = document.getElementById('ed-opts');
    if (!el) return;
    el.innerHTML = '';

    if (this.palTab === 'straight') {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:6px;';
      for (const size of STRAIGHT_SIZES) {
        const b = document.createElement('button');
        b.textContent = `${size}px`;
        b.style.cssText = this.pieceBtnStyle(false);
        b.addEventListener('click', () => this.addPiece({ type: 'straight', size, walls: 'both' }));
        row.appendChild(b);
      }
      el.appendChild(row);
    } else {
      const ctrlRow = document.createElement('div');
      ctrlRow.style.cssText = 'display:flex;gap:6px;align-items:center;';
      const mkSel = (label: string, active: boolean, fn: () => void) => {
        const b = document.createElement('button');
        b.textContent = label;
        b.style.cssText = [
          'padding:7px 11px',
          active
            ? 'background:#22224a;color:#ccccff;border:1.5px solid #6666cc;'
            : 'background:#111128;color:#6666aa;border:1px solid #2a2a44;',
          'border-radius:5px', 'font:13px Arial,sans-serif', 'cursor:pointer',
        ].join(';');
        b.addEventListener('click', () => { fn(); this.rebuildOpts(); });
        return b;
      };
      ctrlRow.appendChild(mkSel('Tight', this.palFamily === 'corner',     () => { this.palFamily = 'corner'; }));
      ctrlRow.appendChild(mkSel('Big',   this.palFamily === 'big_corner', () => { this.palFamily = 'big_corner'; }));
      const spacer = document.createElement('div');
      spacer.style.flex = '1';
      ctrlRow.appendChild(spacer);
      ctrlRow.appendChild(mkSel('◀ L', this.palFlip,  () => { this.palFlip = true; }));
      ctrlRow.appendChild(mkSel('R ▶', !this.palFlip, () => { this.palFlip = false; }));
      el.appendChild(ctrlRow);

      const angRow = document.createElement('div');
      angRow.style.cssText = 'display:flex;gap:5px;';
      for (const angle of CORNER_ANGLES) {
        const b = document.createElement('button');
        b.textContent = `${angle}°`;
        b.style.cssText = this.pieceBtnStyle(this.palAngle === angle);
        b.addEventListener('click', () => {
          this.palAngle = angle;
          this.addPiece({ type: this.palFamily, angle, walls: 'both', flip: this.palFlip });
        });
        angRow.appendChild(b);
      }
      el.appendChild(angRow);
    }
  }

  private pieceBtnStyle(active: boolean): string {
    return [
      'flex:1', 'padding:8px 3px',
      active
        ? 'background:#334422;color:#88ff44;border:1.5px solid #557733;'
        : 'background:#111128;color:#aaaacc;border:1px solid #2a2a44;',
      'border-radius:5px', 'font:13px Arial,sans-serif', 'cursor:pointer',
    ].join(';');
  }

  // ── Save ──────────────────────────────────────────────────────────────────────

  private openDrafts(): void {
    if (!this.isDirty) { this.scene.start('TrackSelect', { activeTab: 'drafts' }); return; }

    const overlay = document.createElement('div');
    overlay.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:300',
      'background:rgba(0,0,0,0.78)',
      'display:flex', 'align-items:center', 'justify-content:center',
    ].join(';');

    const card = document.createElement('div');
    card.style.cssText = [
      'background:#0d0d1e', 'border:1.5px solid #444488', 'border-radius:10px',
      'padding:20px 18px', 'width:min(300px,calc(100%-32px))',
      'display:flex', 'flex-direction:column', 'gap:14px',
    ].join(';');

    const msg = document.createElement('div');
    msg.textContent = 'Discard unsaved changes?';
    msg.style.cssText = 'font:bold 17px "Arial Black",Arial,sans-serif;color:#e8e8ff;text-align:center;';

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:10px;';

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Keep editing';
    cancelBtn.style.cssText = [
      'flex:1', 'padding:10px', 'border-radius:6px',
      'border:1px solid #444466', 'background:#1a1a2a',
      'color:#aaaacc', 'font:14px Arial,sans-serif', 'cursor:pointer',
    ].join(';');
    cancelBtn.addEventListener('click', () => overlay.remove());

    const discardBtn = document.createElement('button');
    discardBtn.textContent = 'Discard';
    discardBtn.style.cssText = [
      'flex:1', 'padding:10px', 'border-radius:6px',
      'border:1px solid #663333', 'background:#1a0808',
      'color:#ff8888', 'font:bold 14px Arial,sans-serif', 'cursor:pointer',
    ].join(';');
    discardBtn.addEventListener('click', () => {
      overlay.remove();
      this.scene.start('TrackSelect', { activeTab: 'drafts' });
    });

    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(discardBtn);
    card.appendChild(msg);
    card.appendChild(btnRow);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
  }

  private showSaveDialog(): void {
    if (!this.finishMarker) {
      this.showToast('Place a finish line first  (⚑ button)');
      return;
    }
    if (this.defs.length < 2) {
      this.showToast('Add more pieces first');
      return;
    }

    const overlay = document.createElement('div');
    overlay.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:300',
      'background:rgba(0,0,0,0.78)',
      'display:flex', 'align-items:center', 'justify-content:center',
    ].join(';');

    const card = document.createElement('div');
    card.style.cssText = [
      'background:#0d0d1e', 'border:1.5px solid #444488', 'border-radius:10px',
      'padding:20px 18px', 'width:min(320px,calc(100%-32px))',
      'display:flex', 'flex-direction:column', 'gap:12px',
    ].join(';');

    const title = document.createElement('div');
    title.textContent = 'Save Track';
    title.style.cssText = 'font:bold 20px "Arial Black",Arial,sans-serif;color:#e8e8ff;text-align:center;';

    const input = document.createElement('input');
    input.type        = 'text';
    input.placeholder = 'Track name…';
    input.maxLength   = 40;
    input.style.cssText = [
      'padding:10px', 'border-radius:6px',
      'border:1px solid #444488', 'background:#1a1a36',
      'color:#e8e8ff', 'font:16px Arial,sans-serif',
      'outline:none', 'box-sizing:border-box', 'width:100%',
    ].join(';');

    const statusEl = document.createElement('div');
    statusEl.style.cssText = 'font:13px Arial,sans-serif;color:#8899cc;text-align:center;min-height:1.2em;';

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:10px;';

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText = [
      'flex:1', 'padding:10px', 'border-radius:6px',
      'border:1px solid #444466', 'background:#1a1a2a',
      'color:#aaaacc', 'font:14px Arial,sans-serif', 'cursor:pointer',
    ].join(';');
    cancelBtn.addEventListener('click', () => overlay.remove());

    const saveBtn = document.createElement('button');
    saveBtn.textContent = 'Save';
    saveBtn.style.cssText = [
      'flex:1', 'padding:10px', 'border-radius:6px',
      'border:1px solid #336633', 'background:#0a2a0a',
      'color:#66ff99', 'font:bold 14px Arial,sans-serif', 'cursor:pointer',
    ].join(';');

    saveBtn.addEventListener('click', async () => {
      const name = input.value.trim();
      if (!name) { input.focus(); statusEl.textContent = 'Enter a track name.'; return; }

      saveBtn.disabled   = true;
      cancelBtn.disabled = true;
      statusEl.textContent = 'Saving…';

      try {
        const payload: TrackPayload = {
          startX:       this.curStartX,
          startY:       this.curStartY,
          startHeading: this.curStartHeading,
          pieces:       this.placed,
          markers:      [this.finishMarker!, ...this.checkpoints],
        };
        await saveDraft(name, JSON.stringify(payload), this.mineTrackId ?? undefined);
        this.isDirty = false;
        overlay.remove();
        this.scene.start('TrackSelect', { activeTab: 'drafts' });
      } catch (err) {
        statusEl.textContent = err instanceof Error ? err.message : 'Save failed — try again.';
        saveBtn.disabled   = false;
        cancelBtn.disabled = false;
      }
    });

    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(saveBtn);
    card.appendChild(title);
    card.appendChild(input);
    card.appendChild(statusEl);
    card.appendChild(btnRow);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    setTimeout(() => input.focus(), 50);
  }

  // ── Utilities ─────────────────────────────────────────────────────────────────

  private showToast(msg: string): void {
    const t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = [
      'position:fixed', `bottom:${PALETTE_H + 10}px`, 'left:50%',
      'transform:translateX(-50%)',
      'background:#2a2a50', 'border:1px solid #5555aa', 'border-radius:6px',
      'padding:8px 16px', 'color:#ccccff', 'font:13px Arial,sans-serif',
      'z-index:400', 'pointer-events:none', 'white-space:nowrap',
    ].join(';');
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2200);
  }

  override update(): void { /* event-driven */ }
}
