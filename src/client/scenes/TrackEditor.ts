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
import { saveMineTrack } from '../track/TrackUpload';
import type { TrackPayload } from '../track/TrackUpload';

const BG        = 0x0a0a16;
const HEADER_H  = 60;
const PALETTE_H = 246;
const SNAP_PX   = 24; // grid snap for start position

const DEFAULT_START_X = 0, DEFAULT_START_Y = 0, DEFAULT_START_HEADING = 180;

const HEADING_ARROWS: Record<number, string> = {
  0: '↑', 45: '↗', 90: '→', 135: '↘',
  180: '↓', 225: '↙', 270: '←', 315: '↖',
};

export class TrackEditor extends Scene {
  // Track chain state
  private defs:         PieceDef[]    = [];
  private placed:       PlacedPiece[] = [];
  private cursor        = { x: DEFAULT_START_X, y: DEFAULT_START_Y, heading: DEFAULT_START_HEADING };
  private finishMarker: TrackMarker | null = null;

  // Mutable start position / heading (editor can change these)
  private curStartX       = DEFAULT_START_X;
  private curStartY       = DEFAULT_START_Y;
  private curStartHeading = DEFAULT_START_HEADING;

  // Start-dot drag state
  private isDraggingStart  = false;
  private startDragInitX   = 0;
  private startDragInitY   = 0;

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
  private markerGfx!:  GameObjects.Graphics;
  private barrierImg:  GameObjects.Image | null = null;
  private finishImg:   GameObjects.Image | null = null;

  // DOM
  private palEl:  HTMLElement | null = null;
  private hintEl: HTMLElement | null = null;

  // Mine track context (set when editing an existing draft)
  private mineTrackId: string | null = null;

  constructor() { super('TrackEditor'); }

  preload(): void {
    if (!this.textures.exists('tile_finish_0')) {
      this.load.image('tile_finish_0', 'assets/markers/tile_finish_0.png');
    }
  }

  init(data?: { mineTrackId?: string; track?: TrackEntry; startHeading?: number }): void {
    this.defs             = [];
    this.placed           = [];
    this.finishMarker     = null;
    this.mineTrackId      = data?.mineTrackId ?? null;
    this.isDraggingStart  = false;

    this.curStartX        = data?.track?.startX  ?? DEFAULT_START_X;
    this.curStartY        = data?.track?.startY  ?? DEFAULT_START_Y;
    this.curStartHeading  = data?.startHeading   ?? DEFAULT_START_HEADING;
    this.cursor           = { x: this.curStartX, y: this.curStartY, heading: this.curStartHeading };

    const track = data?.track;
    if (track) {
      this.defs = track.pieces.map(p => {
        if (p.type === 'straight') {
          return { type: p.type, size: p.size, walls: p.walls } as PieceDef;
        }
        return { type: p.type, angle: (p as CornerDef).angle, walls: p.walls, flip: (p as CornerDef).flip } as PieceDef;
      });
      const result = buildTrackWithCursor({
        startX: this.curStartX, startY: this.curStartY,
        startHeading: this.curStartHeading, pieces: this.defs,
      });
      this.placed = result.placed;
      this.cursor = result.cursor;
      this.finishMarker = track.markers.find(m => m.kind === 'finish') ?? null;
    }
  }

  create() {
    const cam = this.cameras.main;
    cam.setBackgroundColor(BG);
    cam.setZoom(0.65);
    cam.centerOn(this.curStartX, this.curStartY);

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
    titleEl.textContent = 'TRACK EDITOR';
    titleEl.style.cssText = [
      'position:absolute', 'left:50%', 'transform:translateX(-50%)',
      'color:#e8e8ff', 'font:bold 18px "Arial Black",Arial,sans-serif',
      'pointer-events:none',
    ].join(';');

    hdrEl.appendChild(backBtn);
    hdrEl.appendChild(titleEl);
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
    this.markerGfx = this.add.graphics().setDepth(5);

    // ── Input — identical to GridTest / Game.ts; no DOM canvas, no raw pointer events
    this.input.addPointer(1);

    this.input.on('pointerdown', (ptr: Phaser.Input.Pointer) => {
      if (ptr.y > this.scale.height - PALETTE_H) return;
      this.touches.set(ptr.id, { x: ptr.x, y: ptr.y });
      if (this.touches.size >= 2) {
        this.isDraggingStart = false;
        const [a, b] = [...this.touches.values()];
        this.pinchDist = Math.hypot(b.x - a.x, b.y - a.y);
        this.pinchZoom = cam.zoom;
        return;
      }
      // Check if pointer is near the start dot in world space
      const wx = cam.scrollX + ptr.x / cam.zoom;
      const wy = cam.scrollY + ptr.y / cam.zoom;
      const distToStart = Math.hypot(wx - this.curStartX, wy - this.curStartY);
      const hitRadius = Math.max(16, 16 / cam.zoom); // at least 16px screen-space hit area
      if (distToStart < hitRadius) {
        this.isDraggingStart = true;
        this.startDragInitX  = ptr.x;
        this.startDragInitY  = ptr.y;
        return;
      }
      this.isDraggingStart = false;
      this.isDragging      = false;
      this.dragStartX      = ptr.x;
      this.dragStartY      = ptr.y;
      this.dragScrollX     = cam.scrollX;
      this.dragScrollY     = cam.scrollY;
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
        const wx = cam.scrollX + ptr.x / cam.zoom;
        const wy = cam.scrollY + ptr.y / cam.zoom;
        this.curStartX = Math.round(wx / SNAP_PX) * SNAP_PX;
        this.curStartY = Math.round(wy / SNAP_PX) * SNAP_PX;
        this.rebuildFromStart();
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
      if (this.isDraggingStart) {
        const totalMove = Math.hypot(ptr.x - this.startDragInitX, ptr.y - this.startDragInitY);
        if (totalMove < 8) {
          // Tap on start dot → rotate +45° CW (undo the positional move)
          this.curStartX = Math.round(this.curStartX / SNAP_PX) * SNAP_PX;
          this.curStartY = Math.round(this.curStartY / SNAP_PX) * SNAP_PX;
          this.rotateStartHeading(45);
        }
        this.isDraggingStart = false;
        return;
      }
      this.isDragging = false;
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

    this.createPalette();
    this.redrawMarkers();
    this.updateFinishImg();
    if (this.placed.length > 0) {
      this.updateBarrierImg();
      if (this.hintEl) this.hintEl.style.display = 'none';
    }

    this.events.once('shutdown', () => {
      window.removeEventListener('keydown', onEsc);
      hdrEl.remove();
      hintEl.remove();
      this.palEl?.remove();
      this.palEl = null;
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

    // Start dot — radius 8 signals it's interactive (tap=rotate, drag=move)
    this.drawWorldDot(this.curStartX, this.curStartY, this.curStartHeading, 0x00eeff, 8);

    const nearClosed = this.defs.length >= 3
      && Math.hypot(this.cursor.x - this.curStartX, this.cursor.y - this.curStartY) < CORRIDOR * 1.5;
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

  // ── Track editing ─────────────────────────────────────────────────────────────

  private rebuildTrack(): void {
    const result = buildTrackWithCursor({
      startX: this.curStartX, startY: this.curStartY,
      startHeading: this.curStartHeading, pieces: this.defs,
    });
    this.placed = result.placed;
    this.cursor = result.cursor;
  }

  private rebuildFromStart(): void {
    this.rebuildTrack();
    this.updateBarrierImg();
    this.redrawMarkers();
    this.updateFinishImg();
  }

  private rotateStartHeading(delta: number): void {
    this.curStartHeading = ((this.curStartHeading + delta) % 360 + 360) % 360;
    this.rebuildFromStart();
    this.updateStartHeadingDisplay();
  }

  private updateStartHeadingDisplay(): void {
    const el = document.getElementById('ed-start-heading');
    if (el) {
      const arrow = HEADING_ARROWS[this.curStartHeading] ?? '?';
      el.textContent = `${arrow} ${this.curStartHeading}°`;
    }
  }

  private addPiece(def: PieceDef): void {
    this.defs.push(def);
    this.rebuildTrack();
    this.scrollToCursor();
    this.updateBarrierImg();
    this.redrawMarkers();
    this.rebuildOpts();
    if (this.hintEl) this.hintEl.style.display = 'none';
  }

  private undo(): void {
    if (this.finishMarker) {
      this.finishMarker = null;
      this.updateFinishImg();
      this.redrawMarkers();
      return;
    }
    if (this.defs.length === 0) return;
    this.defs.pop();
    this.rebuildTrack();
    this.scrollToCursor();
    this.updateBarrierImg();
    this.redrawMarkers();
    this.rebuildOpts();
    if (this.hintEl) this.hintEl.style.display = this.defs.length === 0 ? '' : 'none';
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
    this.finishMarker = {
      kind: 'finish', shape: 'gate',
      x: this.cursor.x, y: this.cursor.y,
      rotation: this.cursor.heading,
    };
    this.updateFinishImg();
    this.redrawMarkers();
    this.showToast('Finish line placed  ⚑');
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

    const ccwBtn = document.createElement('button');
    ccwBtn.textContent = '↶';
    ccwBtn.title = 'Rotate start CCW 45°';
    ccwBtn.style.cssText = 'padding:6px 12px;border-radius:5px;border:1px solid #444466;background:#111128;color:#8888ff;font:bold 16px Arial,sans-serif;cursor:pointer;';
    ccwBtn.addEventListener('click', () => this.rotateStartHeading(-45));

    const headLabel = document.createElement('span');
    headLabel.id = 'ed-start-heading';
    headLabel.style.cssText = 'flex:1;text-align:center;color:#aaaacc;font:13px Arial,sans-serif;min-width:60px;';
    const initArrow = HEADING_ARROWS[this.curStartHeading] ?? '?';
    headLabel.textContent = `${initArrow} ${this.curStartHeading}°`;

    const cwBtn = document.createElement('button');
    cwBtn.textContent = '↷';
    cwBtn.title = 'Rotate start CW 45°';
    cwBtn.style.cssText = 'padding:6px 12px;border-radius:5px;border:1px solid #444466;background:#111128;color:#8888ff;font:bold 16px Arial,sans-serif;cursor:pointer;';
    cwBtn.addEventListener('click', () => this.rotateStartHeading(45));

    const hintSpan = document.createElement('span');
    hintSpan.textContent = 'tap ⊙ to rotate · drag to move';
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
    actRow.appendChild(mkAct('↩ Undo',   '#ffaa44', '#1a0e00', '#553300', () => this.undo()));
    actRow.appendChild(mkAct('⚑ Finish', '#ff7070', '#1a0005', '#662233', () => this.placeFinish()));
    actRow.appendChild(mkAct('✓ Save',   '#66ff99', '#001a08', '#226633', () => this.showSaveDialog()));
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
          markers:      [this.finishMarker!],
        };
        await saveMineTrack(name, JSON.stringify(payload), this.mineTrackId ?? undefined);
        overlay.remove();
        this.scene.start('TrackSelect', { activeTab: 'mine' });
      } catch {
        statusEl.textContent = 'Save failed — try again.';
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
