import { Scene, GameObjects } from 'phaser';
import { buildTrackTexture, drawBarriersOnCanvas } from '../track/TrackCanvasRenderer';
import { type GhostMove, type GhostData, serializeGhost, deserializeGhost } from '../track/GhostData';
import { NEON_GREEN } from '../track/TrackSkin';
import { TRACK_REGISTRY, STANDARD_TRACKS, type TrackEntry } from '../tracks/trackRegistry';
import { type PlacedPiece, trackBounds } from '../track/TrackLayout';
import { intersectsBarrier, pointInsideBarrier } from '../track/TrackCollision';
import { CORRIDOR } from '../track/TrackGeometry';
import type { TrackMarker } from '../track/convertGmsTrack';
import { username, isLoggedIn } from '../devvitContext';
import { fetchOrGenerateAiGhost, generateAndUploadAiGhosts } from '../track/AiGhost';

// ── Grid / camera constants ────────────────────────────────────────────────────
// gridPx is mutable so the debug slider can adjust it at runtime.
// pickR is always floor(gridPx/2)-1, guaranteeing no circle overlap.
let gridPx = 24;

// Tint + trail colour assigned to each racing ghost slot (up to 3).
const GHOST_COLORS = [
  { tint: 0x44aaff, trail: 0x44dddd }, // cyan-blue
  { tint: 0xffaa33, trail: 0xff9933 }, // amber
  { tint: 0xcc55ff, trail: 0xaa44cc }, // violet
] as const;

type GhostState = {
  data:      GhostData;
  carImg:    GameObjects.Image;
  trailGfx:  GameObjects.Graphics;
  gx:        number;
  gy:        number;
  moveIdx:   number;
  tint:      number;
  trailTint: number;
};

const MIN_ZOOM = 0.4;
const MAX_ZOOM = 5.0;

// Slow-motion multiplier applied from crash contact until car reappears.
// Set to 1 to disable once the animation is tuned.
const CRASH_SLO = 0.4;

// Last-used track ID persists across grid-slider scene restarts.
let lastTrackId = 'oval_small';

// Persistent reference to the Phaser game so the slider can restart the scene
// without capturing a scene-instance `this` that becomes stale after restart.
let phaserGame: Phaser.Game | null = null;

export class Game extends Scene {
  // Track data set from init()
  private trackEntry!:  TrackEntry;
  private trackPieces!: PlacedPiece[];
  private trackMarkers!: TrackMarker[];
  private startWX = 0;
  private startWY = 0;

  // Turn-based state
  private gx                 = 0;
  private gy                 = 0;
  private velX               = 1;
  private velY               = 0;
  private turn               = 0;
  private crashes            = 0;
  private picking            = false;
  private crashing           = false; // true while crash animation is running
  private pendingForcedCrash = false; // true during the X-display pause after commitMove

  // Pan / zoom state
  private dragStartX     = 0;
  private dragStartY     = 0;
  private dragScrollX    = 0;
  private dragScrollY    = 0;
  private isDragging     = false;
  private touches        = new Map<number, { x: number; y: number }>();
  private pinchStartDist = 0;
  private pinchStartZoom = 0;

  // Phaser objects
  private carImg!:   GameObjects.Image;
  private velGfx!:   GameObjects.Graphics;
  private pickGfx!:  GameObjects.Graphics;
  private dotGfx!:   GameObjects.Graphics;
  private trailGfx!: GameObjects.Graphics;

  // Ghost recording
  private ghostMoves:   GhostMove[] = [];
  private currentGhost: GhostData | null = null;

  // Ghost playback — one entry per racing opponent, up to 3.
  private ghostStates:   GhostState[] = [];
  private pendingGhosts: GhostData[] | null = null; // set by init(), consumed by createInner()

  // DOM HUD — immune to Phaser camera zoom/scroll (setScrollFactor(0) only prevents scroll, not zoom)
  private hudDiv:      HTMLElement | null = null;
  private pauseBtnEl:  HTMLElement | null = null;

  // Checkpoint / finish state
  private markerImgList:     GameObjects.Image[]    = [];
  private checkpointIndices: number[]               = [];
  private checkpointTouched: boolean[]              = [];
  private finishIndex        = -1;
  private finishActive       = false;
  private won                = false;

  // Last move origin/target — used by triggerWin to compute finesse fraction.
  private moveFromWX = 0;
  private moveFromWY = 0;
  private moveToWX   = 0;
  private moveToWY   = 0;

  // Mouse hover state during picking phase (null = no target under cursor).
  private hoverTarget: { tx: number; ty: number; valid: boolean } | null = null;

  // Pause menu
  private paused           = false;
  private savedTweenScale  = 1;
  private savedTimeScale   = 1;
  private pauseOverlayEl:   HTMLElement | null = null;
  private finishOverlayEl:  HTMLElement | null = null;
  private viewTrackBackBtn: HTMLElement | null = null;

  // Minimap — plain DOM <canvas> fixed to the viewport, immune to Phaser camera effects
  private minimapCanvas:   HTMLCanvasElement        | null = null;
  private minimapCtx:      CanvasRenderingContext2D | null = null;
  private minimapTrackImg: ImageData                | null = null;
  private mmW  = 0;
  private mmH  = 0;
  private mmWL = 0;
  private mmWT = 0;
  private mmWW = 0;
  private mmWH = 0;

  constructor() { super('Game'); }

  init(data?: { trackId?: string; track?: TrackEntry; ghosts?: GhostData[] }) {
    let entry: TrackEntry;
    if (data?.track) {
      entry = data.track;
      lastTrackId = entry.id;
    } else {
      const id = data?.trackId ?? lastTrackId;
      lastTrackId = id;
      entry = TRACK_REGISTRY.get(id) ?? TRACK_REGISTRY.values().next().value!;
    }
    this.trackEntry   = entry;
    this.trackPieces  = entry.pieces;
    this.trackMarkers = entry.markers;
    this.startWX      = entry.startX;
    this.startWY      = entry.startY;
    this.pendingGhosts = data?.ghosts ?? null;
  }

  preload() {
    const keys = [
      'tile_finish_0', 'tile_finish_1',
      'tile_checkpoint_0', 'tile_checkpoint_1',
      'tile_checkpoint_circle_0', 'tile_checkpoint_circle_1',
    ];
    for (const key of keys) {
      if (!this.textures.exists(key)) {
        this.load.image(key, `assets/markers/${key}.png`);
      }
    }
  }

  create() {
    try {
      this.createInner();
    } catch (e) {
      console.error('[Game] create threw:', e);
      this.add.text(20, 20, 'ERROR:\n' + String(e), {
        fontSize: '14px', color: '#ff4444', wordWrap: { width: 400 },
      });
    }
  }

  private createInner() {
    phaserGame = this.game;

    this.cameras.main.setBackgroundColor(0x0a0a16);

    buildTrackTexture(this, this.trackPieces, NEON_GREEN);

    // Snap starting position to nearest grid intersection.
    this.gx   = Math.round(this.startWX / gridPx);
    this.gy   = Math.round(this.startWY / gridPx);
    this.velX = 0;
    this.velY = 0;
    this.turn = 0;
    this.crashes = 0;
    this.picking = false;

    this.dotGfx   = this.add.graphics().setDepth(-1);
    this.drawGrid();
    this.ghostMoves   = [];
    this.currentGhost = null;
    this.ghostStates  = [];
    this.trailGfx = this.add.graphics().setDepth(3);

    this.makeSpark();
    this.makeCarTexture();
    this.makeGhostTextures();

    if (this.pendingGhosts) {
      this.initGhosts(this.pendingGhosts);
    } else {
      this.fetchPersonalBest();
    }

    this.addTrackMarkers();

    const startWX = this.gx * gridPx;
    const startWY = this.gy * gridPx;

    this.carImg  = this.add.image(startWX, startWY, 'car').setAngle(90).setDepth(10);
    this.velGfx  = this.add.graphics().setDepth(8);
    this.pickGfx = this.add.graphics().setDepth(9);

    // HUD counter — DOM element so camera zoom can't affect it.
    const hud = document.createElement('div');
    hud.style.cssText = [
      'position:fixed', 'top:12px', 'left:62px',
      'font:bold 14px/1 monospace', 'color:#ccccff',
      'text-shadow:-1px -1px 0 #000,1px -1px 0 #000,-1px 1px 0 #000,1px 1px 0 #000',
      'pointer-events:none', 'user-select:none', 'z-index:999',
    ].join(';');
    hud.textContent = this.hudString();
    document.body.appendChild(hud);
    this.hudDiv = hud;

    this.cameras.main.setZoom(2.5);
    this.cameras.main.centerOn(startWX, startWY);

    // Enable a second pointer so Phaser tracks two simultaneous touches for pinch.
    this.input.addPointer(1);

    // Mouse-wheel zoom (desktop). Use ptr.deltaY to avoid Phaser 3/4 param-order differences.
    this.input.on('wheel', (ptr: Phaser.Input.Pointer) => {
      if (!ptr.deltaY) return;
      const z    = this.cameras.main.zoom;
      const next = z * (ptr.deltaY > 0 ? 1 / 1.12 : 1.12);
      this.cameras.main.setZoom(Math.min(Math.max(next, MIN_ZOOM), MAX_ZOOM));
    });

    // pointerdown: start pinch (2 fingers) or record drag origin (1 finger).
    this.input.on('pointerdown', (ptr: Phaser.Input.Pointer) => {
      // DOM pause overlay intercepts its own clicks; just guard game input.
      if (this.paused) return;
      this.touches.set(ptr.id, { x: ptr.x, y: ptr.y });

      if (this.touches.size >= 2) {
        const [a, b] = [...this.touches.values()];
        if (!a || !b) return;
        this.pinchStartDist = Math.hypot(b.x - a.x, b.y - a.y);
        this.pinchStartZoom = this.cameras.main.zoom;
        this.isDragging     = true;
        this.cameras.main.stopFollow();
        return;
      }

      if (!this.picking) return;
      this.isDragging = false;
      this.dragStartX = ptr.x;
      this.dragStartY = ptr.y;
    });

    // pointermove: pinch-zoom (2 touches) or pan (1 touch, drag confirmed).
    this.input.on('pointermove', (ptr: Phaser.Input.Pointer) => {
      if (this.touches.has(ptr.id)) this.touches.set(ptr.id, { x: ptr.x, y: ptr.y });

      if (this.touches.size >= 2) {
        const [a, b] = [...this.touches.values()];
        if (!a || !b) return;
        const dist = Math.hypot(b.x - a.x, b.y - a.y);
        if (this.pinchStartDist === 0) {
          // pointerdown for the 2nd finger was missed — init pinch here.
          this.pinchStartDist = dist;
          this.pinchStartZoom = this.cameras.main.zoom;
        } else {
          const next = this.pinchStartZoom * dist / this.pinchStartDist;
          this.cameras.main.setZoom(Math.min(Math.max(next, MIN_ZOOM), MAX_ZOOM));
        }
        return;
      }

      // Mouse hover (no button pressed, no active touch) — highlight target under cursor.
      if (this.picking && !ptr.isDown && this.touches.size === 0) {
        this.updateHover(ptr);
        return;
      }

      if (!this.picking || !ptr.isDown) return;
      const dx = ptr.x - this.dragStartX;
      const dy = ptr.y - this.dragStartY;
      if (!this.isDragging && Math.abs(dx) + Math.abs(dy) > 6) {
        this.isDragging  = true;
        this.dragScrollX = this.cameras.main.scrollX;
        this.dragScrollY = this.cameras.main.scrollY;
        this.cameras.main.stopFollow();
      }
      if (this.isDragging) {
        const z = this.cameras.main.zoom;
        this.cameras.main.setScroll(
          this.dragScrollX - dx / z,
          this.dragScrollY - dy / z,
        );
      }
    });

    // pointerup: on pinch end, reset pan baseline for remaining finger.
    this.input.on('pointerup', (ptr: Phaser.Input.Pointer) => {
      const wasPinching = this.touches.size >= 2;
      this.touches.delete(ptr.id);

      if (wasPinching) {
        this.isDragging     = true;
        this.pinchStartDist = 0;
        // If one finger remains, re-anchor pan to its current position so any
        // subsequent pointermove doesn't jump using the pre-pinch baseline.
        const remaining = [...this.touches.values()][0];
        if (remaining) {
          this.dragStartX  = remaining.x;
          this.dragStartY  = remaining.y;
          this.dragScrollX = this.cameras.main.scrollX;
          this.dragScrollY = this.cameras.main.scrollY;
        }
        return;
      }

      if (!this.picking) return;
      if (!this.isDragging) this.handlePick(ptr);
      this.isDragging = false;
    });

    this.addMinimap();
    this.addShiftSlow();
    this.addPauseUI();
    this.addGridSlider();

    // Short delay so the tap that launched this scene isn't treated as a pick.
    this.time.delayedCall(120, () => { this.framePicker(); });
  }


  private addMinimap(): void {
    // Compute pixel-accurate barrier bounds by rendering to a small probe canvas
    // and scanning for drawn pixels.  trackBounds() is too conservative — it
    // extends outerR in all four directions from each piece center even though a
    // corner arc only occupies one quadrant, leaving large empty margins.
    const loose      = trackBounds(this.trackPieces);
    const loosePad   = 60;
    const lWL = loose.x - loosePad, lWT = loose.y - loosePad;
    const lWW = loose.width + loosePad * 2, lWH = loose.height + loosePad * 2;
    const probeScale = Math.min(1.0, 512 / Math.max(lWW, lWH));
    const probeW     = Math.ceil(lWW * probeScale);
    const probeH     = Math.ceil(lWH * probeScale);

    const probe = document.createElement('canvas');
    probe.width  = probeW;
    probe.height = probeH;
    const pc = probe.getContext('2d')!;
    pc.fillStyle = '#000000';
    pc.fillRect(0, 0, probeW, probeH);
    drawBarriersOnCanvas(pc, this.trackPieces, lWL, lWT, probeScale, probeScale, 0, 0, '#ffffff', 3);

    const { data } = pc.getImageData(0, 0, probeW, probeH);
    let pxMin = probeW, pyMin = probeH, pxMax = 0, pyMax = 0;
    for (let y = 0; y < probeH; y++) {
      for (let x = 0; x < probeW; x++) {
        if (data[(y * probeW + x) * 4] > 0) {
          if (x < pxMin) pxMin = x;
          if (x > pxMax) pxMax = x;
          if (y < pyMin) pyMin = y;
          if (y > pyMax) pyMax = y;
        }
      }
    }

    // Fall back to loose bounds if scan found nothing (shouldn't happen).
    if (pxMin > pxMax || pyMin > pyMax) {
      pxMin = 0; pyMin = 0; pxMax = probeW - 1; pyMax = probeH - 1;
    }

    const mmBorder = 12; // world-pixel border around actual barriers
    this.mmWL = lWL + pxMin / probeScale - mmBorder;
    this.mmWT = lWT + pyMin / probeScale - mmBorder;
    this.mmWW = (pxMax - pxMin) / probeScale + mmBorder * 2;
    this.mmWH = (pyMax - pyMin) / probeScale + mmBorder * 2;
    const MAX_MM_W = 200;
    const MAX_MM_H = 150;
    const scaleToFit = Math.min(MAX_MM_W / this.mmWW, MAX_MM_H / this.mmWH);
    this.mmW = Math.round(this.mmWW * scaleToFit);
    this.mmH = Math.round(this.mmWH * scaleToFit);

    // Create a plain HTML canvas fixed to the top-right of the viewport.
    // This is entirely outside Phaser so camera zoom/scroll cannot affect it.
    const canvas = document.createElement('canvas');
    canvas.width  = this.mmW;
    canvas.height = this.mmH;
    canvas.style.cssText = [
      'position:fixed',
      'top:8px',
      'right:8px',
      `width:${this.mmW}px`,
      `height:${this.mmH}px`,
      'border:1px solid rgba(102,102,170,0.8)',
      'border-radius:3px',
      'pointer-events:none',
      'z-index:1000',
    ].join(';');
    document.body.appendChild(canvas);

    const ctx = canvas.getContext('2d')!;

    // Dark background.
    ctx.fillStyle = '#0d0d20';
    ctx.fillRect(0, 0, this.mmW, this.mmH);

    // Draw barrier walls geometrically.
    drawBarriersOnCanvas(
      ctx, this.trackPieces,
      this.mmWL, this.mmWT,
      this.mmW / this.mmWW, this.mmH / this.mmWH,
      0, 0, '#33bb55', 1.5,
    );

    // Capture the static track as a reusable ImageData baseline.
    this.minimapTrackImg = ctx.getImageData(0, 0, this.mmW, this.mmH);
    this.minimapCanvas   = canvas;
    this.minimapCtx      = ctx;

    // Drive the car-dot repaint with requestAnimationFrame instead of Phaser's
    // scene update(), which may not fire reliably in all Phaser 4 configurations.
    let rafId = 0;
    const tick = () => {
      if (this.minimapCtx && this.minimapTrackImg && this.carImg && this.mmW > 0) {
        const ctx = this.minimapCtx;
        ctx.putImageData(this.minimapTrackImg, 0, 0);

        // Checkpoint dots
        for (let i = 0; i < this.checkpointIndices.length; i++) {
          const mi = this.checkpointIndices[i];
          const m  = this.trackMarkers[mi];
          const mx = (m.x - this.mmWL) / this.mmWW * this.mmW;
          const my = (m.y - this.mmWT) / this.mmWH * this.mmH;
          const touched = this.checkpointTouched[i];
          ctx.beginPath();
          ctx.arc(mx, my, 4, 0, Math.PI * 2);
          ctx.fillStyle = touched ? '#ffee00' : '#554400';
          ctx.fill();
          if (touched) {
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth   = 1;
            ctx.stroke();
          }
        }

        // Finish line square
        if (this.finishIndex >= 0) {
          const fm = this.trackMarkers[this.finishIndex];
          const fx = (fm.x - this.mmWL) / this.mmWW * this.mmW;
          const fy = (fm.y - this.mmWT) / this.mmWH * this.mmH;
          ctx.fillStyle = this.finishActive ? '#ffffff' : '#444444';
          ctx.fillRect(fx - 3, fy - 3, 6, 6);
          if (this.finishActive) {
            ctx.strokeStyle = '#ffee00';
            ctx.lineWidth   = 1;
            ctx.strokeRect(fx - 3, fy - 3, 6, 6);
          }
        }

        // Ghost dots (drawn first so player dot renders on top)
        for (const state of this.ghostStates) {
          if (!state.carImg.visible) continue;
          const gx  = (state.carImg.x - this.mmWL) / this.mmWW * this.mmW;
          const gy  = (state.carImg.y - this.mmWT) / this.mmWH * this.mmH;
          const css = '#' + state.trailTint.toString(16).padStart(6, '0');
          ctx.beginPath();
          ctx.arc(gx, gy, 4, 0, Math.PI * 2);
          ctx.fillStyle   = css;
          ctx.fill();
          ctx.strokeStyle = 'rgba(255,255,255,0.6)';
          ctx.lineWidth   = 1;
          ctx.stroke();
        }

        // Player dot (magenta, slightly larger so it reads on top)
        const dotX = (this.carImg.x - this.mmWL) / this.mmWW * this.mmW;
        const dotY = (this.carImg.y - this.mmWT) / this.mmWH * this.mmH;
        ctx.beginPath();
        ctx.arc(dotX, dotY, 6, 0, Math.PI * 2);
        ctx.fillStyle   = '#ff33ff';
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth   = 1.5;
        ctx.stroke();
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);

    // Clean up when the scene restarts (e.g. grid-slider change).
    this.events.once('shutdown', () => {
      cancelAnimationFrame(rafId);
      canvas.remove();
      this.minimapCtx      = null;
      this.minimapTrackImg = null;
      this.minimapCanvas   = null;
    });
  }

  // ── Turn handling ─────────────────────────────────────────────────────────────

  private handlePick(ptr: Phaser.Input.Pointer) {
    const wp   = this.cameras.main.getWorldPoint(ptr.x, ptr.y);
    const natX = this.gx + this.velX;
    const natY = this.gy + this.velY;
    const hitR = Math.floor(gridPx / 2) + 4;

    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const tx = natX + dx, ty = natY + dy;
        const twx = tx * gridPx, twy = ty * gridPx;
        if ((wp.x - twx) ** 2 + (wp.y - twy) ** 2 <= hitR * hitR) {
          if (!intersectsBarrier(this.gx * gridPx, this.gy * gridPx, twx, twy, this.trackPieces)) {
            this.commitMove(tx, ty, dx, dy);
          } else {
            // Player deliberately picked a barrier-crossing target.
            // If we're in a forced-crash pause the turn was already counted; otherwise count it now.
            this.commitCrash(tx, ty, !this.pendingForcedCrash);
          }
          return;
        }
      }
    }
  }

  private commitMove(newGX: number, newGY: number, dvx: number, dvy: number) {
    this.picking = false;
    this.velGfx.clear();
    this.pickGfx.clear();

    this.moveFromWX = this.gx * gridPx;
    this.moveFromWY = this.gy * gridPx;
    this.moveToWX   = newGX  * gridPx;
    this.moveToWY   = newGY  * gridPx;

    this.ghostMoves.push({ gx: newGX, gy: newGY, crash: false });
    this.drawTrailSegment(this.gx, this.gy, newGX, newGY, false);

    const newVX      = this.velX + dvx;
    const newVY      = this.velY + dvy;
    const headingDeg = Math.atan2(newVX, -newVY) * (180 / Math.PI);
    this.carImg.setAngle(headingDeg);

    this.tweens.add({
      targets:  this.carImg,
      x:        newGX * gridPx,
      y:        newGY * gridPx,
      duration: 180,
      ease:     'Quad.easeInOut',
      onUpdate:   () => this.checkMarkerCrossing(),
      onComplete: () => {
        this.gx   = newGX;
        this.gy   = newGY;
        this.velX = newVX;
        this.velY = newVY;
        this.turn++;
        this.updateHud();
        this.advanceGhosts();

        this.checkMarkerCrossing();
        if (this.won) return;

        if (this.anyValidMove()) {
          this.framePicker();
        } else {
          this.handleCrash();
        }
      },
    });
  }

  // ── Crash handling ───────────────────────────────────────────────────────────

  private anyValidMove(): boolean {
    const fromWX = this.gx * gridPx, fromWY = this.gy * gridPx;
    const natX   = this.gx + this.velX;
    const natY   = this.gy + this.velY;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!intersectsBarrier(fromWX, fromWY, (natX + dx) * gridPx, (natY + dy) * gridPx, this.trackPieces)) {
          return true;
        }
      }
    }
    return false;
  }

  private handleCrash() {
    // All 9 targets are off-track. Show them as dark-red X and wait for the player
    // to deliberately choose one — they may prefer one crash point over another.
    this.pendingForcedCrash = true;
    this.picking            = true;
    this.drawUI();
    this.panTo((this.gx + this.velX) * gridPx, (this.gy + this.velY) * gridPx, 450);
  }

  // Animate car to barrier contact, explode toward the selected target in slow-mo,
  // then recover to the nearest safe grid point at full speed.
  // countTurn: true when the player chose this as their move; false when the turn was
  // already counted by a preceding commitMove (forced crash).
  private commitCrash(crashGX: number, crashGY: number, countTurn: boolean) {
    if (this.crashing) return;
    this.crashing           = true;
    this.pendingForcedCrash = false;
    this.picking            = false;
    this.velGfx.clear();
    this.pickGfx.clear();

    this.crashes++;
    if (countTurn) this.turn++;
    this.updateHud();

    this.ghostMoves.push({ gx: crashGX, gy: crashGY, crash: true });
    this.drawTrailSegment(this.gx, this.gy, crashGX, crashGY, true);

    const crashWX = crashGX * gridPx;
    const crashWY = crashGY * gridPx;
    const safeGX  = this.gx;
    const safeGY  = this.gy;
    const safeWX  = safeGX * gridPx;
    const safeWY  = safeGY * gridPx;

    // Find the last on-surface pixel along the car's path — the barrier contact point.
    const contact   = this.findBarrierContact(this.gx * gridPx, this.gy * gridPx, crashWX, crashWY);
    const contactWX = contact.wx;
    const contactWY = contact.wy;

    // Point car toward the crash cell.
    const hdx = crashGX - this.gx, hdy = crashGY - this.gy;
    if (hdx !== 0 || hdy !== 0) {
      this.carImg.setAngle(Math.atan2(hdx, -hdy) * (180 / Math.PI));
    }

    // Pan only when necessary: if both the car and the crash target are already
    // on screen, leave the view alone. Otherwise centre on their midpoint so
    // the whole path of the move is visible before the animation starts.
    const wv = this.cameras.main.worldView;
    if (!wv.contains(this.carImg.x, this.carImg.y) || !wv.contains(crashWX, crashWY)) {
      this.panTo(
        (this.carImg.x + crashWX) / 2,
        (this.carImg.y + crashWY) / 2,
        200,
      );
    }

    // ── Phase 1: full-speed drive to barrier contact ───────────────────────────
    this.tweens.add({
      targets:  this.carImg,
      x: contactWX, y: contactWY,
      duration: 280,
      ease:     'Quad.easeIn',
      onComplete: () => {

        // ── Phase 2: slow-motion explosion from contact → selected target ──────
        this.tweens.timeScale = CRASH_SLO;
        this.time.timeScale   = CRASH_SLO;

        this.playCrashSound();

        // Particle emitter starts at contact, slides into the barrier toward the crash cell.
        const emitter = this.spawnCrashParticles(contactWX, contactWY);
        if (emitter) {
          this.tweens.add({
            targets:    emitter,
            x:          crashWX,
            y:          crashWY,
            duration:   440,
            ease:       'Quad.easeInOut',
            onComplete: () => emitter.stop(),
          });
        }

        // Fragments arc from contact point toward the selected crash cell.
        this.spawnCarFragments(contactWX, contactWY, crashWX, crashWY);

        // ── Phase 3: car regenerates at wreck endpoint, drives to safe point ───
        this.time.delayedCall(520, () => {
          emitter?.destroy();

          // Restore normal speed before recovery so the drive feels snappy.
          this.tweens.timeScale = 1;
          this.time.timeScale   = 1;

          // Briefly materialise at the wreck endpoint (the selected crash cell).
          this.carImg.setPosition(crashWX, crashWY);
          this.carImg.setAlpha(0.8);
          this.carImg.setVisible(true);

          // Full-speed drive from wreck endpoint to safe point.
          this.tweens.add({
            targets:  this.carImg,
            x: safeWX, y: safeWY,
            duration: 280,
            ease:     'Quad.easeInOut',
            onComplete: () => {
              this.gx   = safeGX;
              this.gy   = safeGY;
              this.velX = 0;
              this.velY = 0;
              this.carImg.setAlpha(1);
              this.crashing = false;
              this.advanceGhosts();
              this.checkMarkerCrossing();
              if (!this.won) this.framePicker();
            },
          });
        });
      },
    });
  }

  // Walk from fromW toward toW in 20 steps; return the last pixel that is on-surface.
  // This gives the approximate point where the car's path crosses the barrier edge.
  private findBarrierContact(
    fromWX: number, fromWY: number,
    toWX:   number, toWY:   number,
  ): { wx: number; wy: number } {
    let lastWX = fromWX, lastWY = fromWY;
    for (let i = 1; i <= 40; i++) {
      const t  = i / 40;
      const wx = fromWX + (toWX - fromWX) * t;
      const wy = fromWY + (toWY - fromWY) * t;
      if (pointInsideBarrier(wx, wy, this.trackPieces)) break;
      lastWX = wx;
      lastWY = wy;
    }
    return { wx: lastWX, wy: lastWY };
  }

  /**
   * Walk the finishing move in 200 steps and return the parameter t ∈ [0,1]
   * at which the path first crosses the finish gate.
   * t=0 means the car was already on the line; t=1 means contact at the target.
   */
  private findFinishContactFraction(
    fromWX: number, fromWY: number,
    toWX:   number, toWY:   number,
  ): number {
    if (this.finishIndex < 0) return 1;
    const fm    = this.trackMarkers[this.finishIndex];
    const steps = 200;
    for (let i = 0; i <= steps; i++) {
      const t  = i / steps;
      const wx = fromWX + (toWX - fromWX) * t;
      const wy = fromWY + (toWY - fromWY) * t;
      if (this.crossesMarker(fm, wx, wy)) return t;
    }
    return 1;
  }

  private findNearestValid(crashWX: number, crashWY: number): { gx: number; gy: number } | null {
    const cx = Math.round(crashWX / gridPx);
    const cy = Math.round(crashWY / gridPx);
    // Expand in Chebyshev rings (matches the 8-connected grid structure).
    for (let r = 0; r <= 15; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const gx = cx + dx, gy = cy + dy;
          if (!pointInsideBarrier(gx * gridPx, gy * gridPx, this.trackPieces)) return { gx, gy };
        }
      }
    }
    return null;
  }

  private spawnCrashParticles(
    wx: number, wy: number,
  ): Phaser.GameObjects.Particles.ParticleEmitter | null {
    try {
      const emitter = this.add.particles(wx, wy, 'spark', {
        speed:     { min: 20, max: 80 },
        angle:     { min: 0, max: 360 },
        scale:     { start: 2.0, end: 0 },
        alpha:     { start: 1,   end: 0 },
        tint:      [0xffffff, 0xff6600, 0xffaa00, 0xffff44, 0xff2200],
        lifespan:  700,
        gravityY:  30,
        frequency: 20,
        quantity:  3,
      });
      // Initial impact burst while the emitter is still at the contact point.
      emitter.emitParticle(30);
      return emitter;
    } catch (e) {
      console.warn('[crash particles]', e);
      return null;
    }
  }

  private spawnCarFragments(wx: number, wy: number, targetWX: number, targetWY: number): void {
    const heading = this.carImg.angle;
    const headRad = heading * (Math.PI / 180);
    const cos = Math.cos(headRad), sin = Math.sin(headRad);

    const HW = Math.round(gridPx * 0.50);
    const HH = Math.round(gridPx * 0.85);

    const rot = (lx: number, ly: number): [number, number] =>
      [lx * cos - ly * sin, lx * sin + ly * cos];

    // Two triangles split along the car's centreline.
    const halves: Array<{ verts: [number, number][]; sideways: [number, number] }> = [
      { verts: [[0, -HH], [-HW, HH], [0, HH * 0.35]], sideways: [-1, 0] },
      { verts: [[0, -HH], [0, HH * 0.35], [HW, HH]],  sideways: [1,  0] },
    ];

    this.carImg.setVisible(false);

    for (const half of halves) {
      const lCX = half.verts.reduce((s, v) => s + v[0], 0) / half.verts.length;
      const lCY = half.verts.reduce((s, v) => s + v[1], 0) / half.verts.length;
      const [wCX, wCY] = rot(lCX, lCY);

      const gfx = this.add.graphics()
        .setPosition(wx + wCX, wy + wCY)
        .setAngle(heading)
        .setDepth(12);

      gfx.fillStyle(0xff44cc, 1.0);
      gfx.fillPoints(
        half.verts.map(([x, y]) => ({ x: x - lCX, y: y - lCY })),
        true,
      );

      // Each fragment travels toward the safe point with a small sideways scatter.
      const [swX, swY] = rot(...half.sideways);
      const scatter    = gridPx * 0.6;
      const spin       = (Math.random() > 0.5 ? 1 : -1) * (180 + Math.random() * 200);

      this.tweens.add({
        targets:    gfx,
        x:          targetWX + swX * scatter,
        y:          targetWY + swY * scatter,
        angle:      heading + spin,
        alpha:      0,
        duration:   460 + Math.random() * 120,
        ease:       'Quad.easeInOut',
        onComplete: () => gfx.destroy(),
      });
    }
  }

  // ── Track markers (checkpoints + finish line) ─────────────────────────────────

  private addTrackMarkers(): void {
    this.markerImgList     = [];
    this.checkpointIndices = [];
    this.checkpointTouched = [];
    this.finishIndex       = -1;
    this.finishActive      = false;
    this.won               = false;

    for (let i = 0; i < this.trackMarkers.length; i++) {
      const m   = this.trackMarkers[i];
      const key = m.kind === 'finish'        ? 'tile_finish_0'
                : m.shape === 'circle'       ? 'tile_checkpoint_circle_0'
                :                              'tile_checkpoint_0';
      const img = this.add.image(m.x, m.y, key)
        .setAngle(m.rotation)
        .setOrigin(0.5)
        .setDepth(3);

      if (m.kind === 'checkpoint') {
        this.checkpointIndices.push(i);
        this.checkpointTouched.push(false);
      } else {
        this.finishIndex = i;
      }
      this.markerImgList.push(img);
    }
  }

  private checkMarkerCrossing(carWX = this.carImg.x, carWY = this.carImg.y): void {
    if (this.won) return;

    let anyNewlyTouched = false;
    for (let i = 0; i < this.checkpointIndices.length; i++) {
      if (this.checkpointTouched[i]) continue;
      const mi = this.checkpointIndices[i];
      const m  = this.trackMarkers[mi];
      if (this.crossesMarker(m, carWX, carWY)) {
        this.checkpointTouched[i] = true;
        this.markerImgList[mi].setTexture(
          m.shape === 'circle' ? 'tile_checkpoint_circle_1' : 'tile_checkpoint_1',
        );
        anyNewlyTouched = true;
      }
    }

    const allCheckpointsDone =
      this.checkpointIndices.length === 0 ||
      this.checkpointTouched.every(Boolean);

    if (anyNewlyTouched && allCheckpointsDone && !this.finishActive && this.finishIndex >= 0) {
      this.finishActive = true;
      this.markerImgList[this.finishIndex].setTexture('tile_finish_1');
    }

    if (allCheckpointsDone && this.finishIndex >= 0) {
      const fm = this.trackMarkers[this.finishIndex];
      if (this.crossesMarker(fm, carWX, carWY)) {
        this.triggerWin();
      }
    }
  }

  private crossesMarker(
    m: { x: number; y: number; rotation: number; shape: 'gate' | 'circle' },
    carWX: number, carWY: number,
  ): boolean {
    const dx = carWX - m.x;
    const dy = carWY - m.y;

    if (m.shape === 'circle') {
      // Simple radius test — circle waypoints aren't orientation-dependent.
      return Math.hypot(dx, dy) <= gridPx + 10;
    }

    // Gate: project into marker's local space.
    //   localX = along the stripe (must be within half the corridor width)
    //   localY = crossing the line (must be within one grid step)
    const angle  = m.rotation * Math.PI / 180;
    const localX =  dx * Math.cos(angle) + dy * Math.sin(angle);
    const localY = -dx * Math.sin(angle) + dy * Math.cos(angle);
    return Math.abs(localX) <= CORRIDOR / 2 && Math.abs(localY) <= gridPx;
  }

  private triggerWin(): void {
    if (this.won) return;
    this.won     = true;
    this.picking = false;
    this.velGfx.clear();
    this.pickGfx.clear();

    const finesse = this.findFinishContactFraction(
      this.moveFromWX, this.moveFromWY,
      this.moveToWX,   this.moveToWY,
    );
    const score    = this.turn + this.crashes + Math.min(finesse, 0.99);
    const scoreStr = score.toFixed(2);

    this.currentGhost = {
      v:          1,
      trackId:    this.trackEntry.id,
      score,
      startGX:    Math.round(this.startWX / gridPx),
      startGY:    Math.round(this.startWY / gridPx),
      moves:      [...this.ghostMoves],
      author:     username || undefined,
      recordedAt: Date.now(),
    };

    // ── Overlay shell ─────────────────────────────────────────────────────────
    const overlay = document.createElement('div');
    overlay.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:1002',
      'display:flex', 'align-items:center', 'justify-content:center',
      'background:rgba(0,0,0,0.6)', 'overflow-y:auto', 'padding:16px',
      'box-sizing:border-box',
    ].join(';');

    const card = document.createElement('div');
    card.style.cssText = [
      'background:#0d0d1e', 'border:1.5px solid #444488', 'border-radius:10px',
      'padding:18px 16px 14px', 'width:min(340px,100%)',
      'display:flex', 'flex-direction:column', 'gap:10px',
      'box-shadow:0 8px 32px rgba(0,0,0,0.7)',
    ].join(';');

    // Score header
    const scoreHeader = document.createElement('div');
    scoreHeader.style.cssText = 'text-align:center;';
    const finishTitle = document.createElement('div');
    finishTitle.style.cssText = "font:bold clamp(26px,7vw,44px) 'Arial Black',Arial,sans-serif;color:#ffee00;text-shadow:0 0 16px #ff8800,0 2px 4px #000;line-height:1.1;";
    finishTitle.textContent = 'FINISH!';
    const trackLabel = document.createElement('div');
    trackLabel.style.cssText = 'font:13px Arial,sans-serif;color:#8888bb;margin-top:2px;letter-spacing:0.04em;';
    trackLabel.textContent = this.trackEntry.name;
    const scoreLabel = document.createElement('div');
    scoreLabel.style.cssText = 'font:bold clamp(14px,4vw,20px) Arial,sans-serif;color:#ccddff;margin-top:4px;';
    scoreLabel.textContent = `Score: ${scoreStr}`;
    scoreHeader.appendChild(finishTitle);
    scoreHeader.appendChild(trackLabel);
    scoreHeader.appendChild(scoreLabel);
    if (this.crashes > 0) {
      const crashLabel = document.createElement('div');
      crashLabel.style.cssText = 'font:13px Arial,sans-serif;color:#ffaa44;margin-top:2px;';
      crashLabel.textContent = `${this.crashes} crash${this.crashes > 1 ? 'es' : ''}`;
      scoreHeader.appendChild(crashLabel);
    }
    card.appendChild(scoreHeader);

    // Upload status row (logged-in only)
    let statusEl: HTMLElement | null = null;
    if (isLoggedIn) {
      statusEl = document.createElement('div');
      statusEl.style.cssText = 'font:13px Arial,sans-serif;color:#8899cc;text-align:center;min-height:1.4em;';
      statusEl.textContent = 'Uploading…';
      card.appendChild(statusEl);
    }

    // Swappable content area (race results ↔ all-time leaderboard)
    const contentEl = document.createElement('div');
    card.appendChild(contentEl);

    // Persistent action buttons
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:10px;justify-content:center;margin-top:4px;flex-wrap:wrap;';

    const makeBtn = (label: string, fg: string, bg: string, border: string) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = `padding:10px 20px;font:bold 14px Arial,sans-serif;color:${fg};background:${bg};border:1px solid ${border};border-radius:6px;cursor:pointer;`;
      return b;
    };

    const playAgainBtn = makeBtn('Play Again', '#ccffcc', '#0a2a0a', '#33aa33');
    playAgainBtn.addEventListener('click', () => {
      overlay.remove(); this.finishOverlayEl = null;
      this.scene.start('Game', { trackId: this.trackEntry.id });
    });
    const exitBtn = makeBtn('Exit', '#aaaacc', '#1a1a2a', '#444466');
    exitBtn.addEventListener('click', () => {
      overlay.remove(); this.finishOverlayEl = null;
      this.scene.start('TrackSelect');
    });
    const viewBtn = makeBtn('View Track', '#aaccff', '#0a1828', '#334466');
    viewBtn.addEventListener('click', () => {
      const prevZoom = this.cameras.main.zoom;
      const prevX    = this.cameras.main.worldView.centerX;
      const prevY    = this.cameras.main.worldView.centerY;

      overlay.style.display = 'none';
      this.zoomToFitTrack();

      const backBtn = document.createElement('button');
      backBtn.textContent = '‹ Results';
      backBtn.style.cssText = [
        'position:fixed', 'bottom:20px', 'left:50%', 'transform:translateX(-50%)',
        'padding:10px 24px', 'font:bold 14px Arial,sans-serif',
        'color:#aaccff', 'background:rgba(10,24,40,0.92)', 'border:1px solid #334466',
        'border-radius:6px', 'cursor:pointer', 'z-index:1003',
      ].join(';');
      backBtn.addEventListener('click', () => {
        backBtn.remove();
        this.viewTrackBackBtn = null;
        overlay.style.display = '';
        const cam   = this.cameras.main;
        const proxy = { x: cam.worldView.centerX, y: cam.worldView.centerY, zoom: cam.zoom };
        this.tweens.add({
          targets: proxy, x: prevX, y: prevY, zoom: prevZoom,
          duration: 500, ease: 'Quad.easeInOut',
          onUpdate: () => { cam.setZoom(proxy.zoom); cam.centerOn(proxy.x, proxy.y); },
        });
      });
      document.body.appendChild(backBtn);
      this.viewTrackBackBtn = backBtn;
    });
    actions.appendChild(playAgainBtn);
    actions.appendChild(exitBtn);
    actions.appendChild(viewBtn);
    card.appendChild(actions);

    overlay.appendChild(card);
    document.body.appendChild(overlay);
    this.finishOverlayEl = overlay;

    this.renderRaceResults(contentEl, score);

    if (isLoggedIn) {
      this.uploadGhost(statusEl);
    }
  }

  // TEMPORARY: remove fake ghost entries for the current track (Shift+X)
  private cleanupDebugGhosts(): void {
    const trackId = this.trackEntry.id;
    const DEBUG_USERS = ['GhostRacer1', 'SpeedDemon99'];
    for (const u of DEBUG_USERS) {
      fetch(`/api/debug/ghost/${encodeURIComponent(trackId)}/${encodeURIComponent(u)}`, {
        method: 'DELETE',
      })
        .then(r => r.json())
        .then(d => console.log('[debug delete]', d))
        .catch(e => console.error('[debug delete]', e));
    }
    console.log(`[debug cleanup] removing ${DEBUG_USERS.join(', ')} from ${trackId}…`);
  }

  private fetchPersonalBest(): void {
    if (!isLoggedIn) {
      this.fetchAiGhostFallback();
      return;
    }
    const { id: trackId } = this.trackEntry;
    fetch(`/api/ghost/${encodeURIComponent(trackId)}/${encodeURIComponent(username)}`)
      .then(async (res) => {
        if (res.status === 404) { this.fetchAiGhostFallback(); return; }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json() as { ghost: string };
        this.initGhosts([deserializeGhost(data.ghost)]);
      })
      .catch((err) => console.warn('[personal best fetch]', err));
  }

  private fetchAiGhostFallback(): void {
    fetchOrGenerateAiGhost(this.trackEntry.id, 'average', this.trackEntry, gridPx)
      .then((ghost) => {
        if (!ghost || this.ghostStates.length > 0) return;
        this.initGhosts([ghost]);
      })
      .catch((err) => console.warn('[ai ghost fallback]', err));
  }

  private initGhosts(ghosts: GhostData[]): void {
    for (let i = 0; i < Math.min(ghosts.length, 3); i++) {
      const ghost = ghosts[i];
      const { tint, trail } = GHOST_COLORS[i];

      const carImg = this.add.image(
        ghost.startGX * gridPx,
        ghost.startGY * gridPx,
        `ghost-car-${i}`,
      ).setAngle(90).setDepth(9).setAlpha(0.55);

      const trailGfx = this.add.graphics().setDepth(2);

      const state: GhostState = {
        data: ghost, carImg, trailGfx,
        gx: ghost.startGX, gy: ghost.startGY,
        moveIdx: 0, tint, trailTint: trail,
      };

      // Fast-forward silently if the ghost loaded after the player already moved.
      for (let j = 0; j < this.turn; j++) this.stepGhostState(state, true);

      this.ghostStates.push(state);
    }
  }

  private advanceGhosts(): void {
    for (const state of this.ghostStates) this.stepGhostState(state, false);
  }

  private stepGhostState(state: GhostState, silent: boolean): void {
    if (state.moveIdx >= state.data.moves.length) {
      state.carImg.setVisible(false);
      return;
    }

    const move   = state.data.moves[state.moveIdx];
    const fromGX = state.gx;
    const fromGY = state.gy;
    state.moveIdx++;

    if (!move.crash) {
      if (!silent) {
        state.trailGfx.lineStyle(2, state.trailTint, 0.45);
        state.trailGfx.beginPath();
        state.trailGfx.moveTo(fromGX * gridPx, fromGY * gridPx);
        state.trailGfx.lineTo(move.gx * gridPx, move.gy * gridPx);
        state.trailGfx.strokePath();
        state.trailGfx.fillStyle(state.trailTint, 0.55);
        state.trailGfx.fillCircle(fromGX * gridPx, fromGY * gridPx, 3);
      }

      state.gx = move.gx;
      state.gy = move.gy;

      const dx = move.gx - fromGX, dy = move.gy - fromGY;
      if (dx !== 0 || dy !== 0) {
        state.carImg.setAngle(Math.atan2(dx, -dy) * (180 / Math.PI));
      }

      if (!silent) {
        this.tweens.add({
          targets:  state.carImg,
          x:        state.gx * gridPx,
          y:        state.gy * gridPx,
          duration: 180,
          ease:     'Quad.easeInOut',
        });
      } else {
        state.carImg.setPosition(state.gx * gridPx, state.gy * gridPx);
      }
    } else {
      // Crash — ghost stays at current position; draw dim trail to the attempted cell.
      if (!silent) {
        state.trailGfx.lineStyle(2, 0xff9933, 0.30);
        state.trailGfx.beginPath();
        state.trailGfx.moveTo(fromGX * gridPx, fromGY * gridPx);
        state.trailGfx.lineTo(move.gx * gridPx, move.gy * gridPx);
        state.trailGfx.strokePath();
      }
      // state.gx/gy unchanged — ghost returns to safe position just like the real car
    }
  }

  private uploadGhost(statusEl: HTMLElement | null): void {
    if (!this.currentGhost) return;

    const setStatus = (msg: string, color = '#8899cc') => {
      if (statusEl) { statusEl.textContent = msg; statusEl.style.color = color; }
    };

    const ghost = this.currentGhost;
    fetch('/api/ghost', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ trackId: ghost.trackId, score: ghost.score, ghost: serializeGhost(ghost) }),
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json() as { rank?: number; isPB?: boolean; previousBest?: number };
        if (data.isPB) {
          const label = data.previousBest === undefined ? 'Uploaded!' : 'New Personal Best!';
          setStatus(`${label} · Rank #${data.rank ?? '?'}`, '#88ccff');
        } else {
          setStatus(`Your best: ${data.previousBest!.toFixed(2)} · Rank #${data.rank ?? '?'}`, '#8899cc');
        }
      })
      .catch((err) => {
        console.error('[ghost upload]', err);
        setStatus('Upload failed', '#ff6655');
      });
  }

  private renderRaceResults(container: HTMLElement, playerScore: number): void {
    const ghostLabel = (author: string | undefined, slotIdx: number): string => {
      if (!author) return `Ghost ${slotIdx + 1}`;
      // Normalise old server-stored format [AI:skilled] → [bot] Skilled
      const aiMatch = author.match(/^\[AI:(\w+)\]$/);
      if (aiMatch) {
        const s = aiMatch[1];
        return `[bot] ${s.charAt(0).toUpperCase()}${s.slice(1)}`;
      }
      // Player's own PB ghost — distinguish from their live result
      if (author === username) return `${author} Ghost`;
      return author;
    };

    type Racer = { label: string; score: number; isPlayer: boolean };
    const racers: Racer[] = [
      { label: username || 'You', score: playerScore, isPlayer: true },
      ...this.ghostStates.map((s, i) => ({
        label:    ghostLabel(s.data.author, i),
        score:    s.data.score,
        isPlayer: false,
      })),
    ].sort((a, b) => a.score - b.score);

    container.innerHTML = '';

    const title = document.createElement('div');
    title.textContent = 'THIS RACE';
    title.style.cssText = 'font:bold 11px Arial,sans-serif;color:#666699;letter-spacing:0.1em;margin-bottom:6px;';
    container.appendChild(title);

    const MEDALS = ['🥇', '🥈', '🥉', '  '];
    racers.forEach((r, i) => {
      const row = document.createElement('div');
      row.style.cssText = [
        'display:flex', 'align-items:baseline', 'gap:8px',
        'padding:4px 6px', 'border-radius:4px', 'font:14px monospace',
        r.isPlayer ? 'background:rgba(68,136,255,0.15)' : '',
      ].join(';');

      const medal = document.createElement('span');
      medal.textContent = MEDALS[Math.min(i, MEDALS.length - 1)];
      medal.style.cssText = 'width:1.6em;text-align:center;flex-shrink:0;';

      const name = document.createElement('span');
      name.textContent = r.label;
      name.style.cssText = `flex:1;color:${r.isPlayer ? '#88ccff' : '#aaaacc'};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`;

      const scoreEl = document.createElement('span');
      scoreEl.textContent = r.score.toFixed(2);
      scoreEl.style.cssText = `color:${r.isPlayer ? '#aaddff' : '#888899'};flex-shrink:0;`;

      row.appendChild(medal);
      row.appendChild(name);
      row.appendChild(scoreEl);
      container.appendChild(row);
    });

    const lbBtn = document.createElement('button');
    lbBtn.textContent = 'All-Time Leaderboard ›';
    lbBtn.style.cssText = [
      'margin-top:12px', 'width:100%', 'padding:8px',
      'background:transparent', 'border:1px solid #333366', 'border-radius:5px',
      'color:#6666aa', 'font:13px Arial,sans-serif', 'cursor:pointer',
    ].join(';');
    lbBtn.addEventListener('click', () => this.switchToLeaderboard(container));
    container.appendChild(lbBtn);
  }

  private switchToLeaderboard(container: HTMLElement): void {
    container.innerHTML = '<div style="text-align:center;color:#555588;padding:16px;font:14px Arial">Loading…</div>';

    const trackId = this.trackEntry.id;
    const url = isLoggedIn
      ? `/api/leaderboard/${encodeURIComponent(trackId)}/around/${encodeURIComponent(username)}?above=3&below=3`
      : `/api/leaderboard/${encodeURIComponent(trackId)}?limit=10`;

    fetch(url)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json() as {
          entries?: Array<{ username: string; score: number; rank?: number; isMe?: boolean }>;
          total?: number;
        };
        const entries = data.entries ?? [];
        container.innerHTML = '';

        const header = document.createElement('div');
        header.style.cssText = 'display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px;';
        const headerTitle = document.createElement('span');
        headerTitle.textContent = 'ALL-TIME';
        headerTitle.style.cssText = 'font:bold 11px Arial,sans-serif;color:#666699;letter-spacing:0.1em;';
        header.appendChild(headerTitle);
        if (data.total != null) {
          const tot = document.createElement('span');
          tot.textContent = `${data.total} racers`;
          tot.style.cssText = 'font:11px Arial,sans-serif;color:#444466;';
          header.appendChild(tot);
        }
        container.appendChild(header);

        if (entries.length === 0) {
          const empty = document.createElement('div');
          empty.textContent = 'No entries yet.';
          empty.style.cssText = 'color:#555588;font:13px Arial;text-align:center;padding:8px;';
          container.appendChild(empty);
        }

        entries.forEach((e, i) => {
          const rankNum = e.rank ?? (i + 1);
          const row = document.createElement('div');
          row.style.cssText = [
            'display:flex', 'gap:8px', 'padding:4px 6px', 'border-radius:4px',
            'font:14px monospace',
            e.isMe ? 'background:rgba(68,136,255,0.15)' : '',
          ].join(';');

          const rankEl = document.createElement('span');
          rankEl.textContent = `#${rankNum}`;
          rankEl.style.cssText = 'width:2.5em;flex-shrink:0;color:#555577;';

          const name = document.createElement('span');
          name.textContent = e.username;
          name.style.cssText = `flex:1;color:${e.isMe ? '#88ccff' : '#aaaacc'};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`;

          const scoreEl = document.createElement('span');
          scoreEl.textContent = e.score.toFixed(2);
          scoreEl.style.cssText = `color:${e.isMe ? '#aaddff' : '#888899'};flex-shrink:0;`;

          row.appendChild(rankEl);
          row.appendChild(name);
          row.appendChild(scoreEl);
          container.appendChild(row);
        });

        const backBtn = document.createElement('button');
        backBtn.textContent = '‹ Race Results';
        backBtn.style.cssText = [
          'margin-top:12px', 'width:100%', 'padding:8px',
          'background:transparent', 'border:1px solid #333366', 'border-radius:5px',
          'color:#6666aa', 'font:13px Arial,sans-serif', 'cursor:pointer',
        ].join(';');
        backBtn.addEventListener('click', () => {
          if (this.currentGhost) this.renderRaceResults(container, this.currentGhost.score);
        });
        container.appendChild(backBtn);
      })
      .catch(() => {
        container.innerHTML = '<div style="color:#ff6655;text-align:center;padding:16px;font:13px Arial">Leaderboard unavailable</div>';
      });
  }

  private playCrashSound() {
    try {
      const ac      = new (window.AudioContext || (window as any).webkitAudioContext)();
      const rate    = ac.sampleRate;
      const len     = Math.floor(rate * 0.4);
      const buf     = ac.createBuffer(1, len, rate);
      const data    = buf.getChannelData(0);
      for (let i = 0; i < len; i++) {
        const t     = i / rate;
        // White-noise burst + low thump.
        const noise = (Math.random() * 2 - 1) * Math.exp(-t * 12);
        const thump = Math.sin(2 * Math.PI * 60 * t)   * Math.exp(-t * 25);
        const crack = Math.sin(2 * Math.PI * 220 * t)  * Math.exp(-t * 40);
        data[i] = noise * 0.55 + thump * 0.30 + crack * 0.15;
      }
      const src  = ac.createBufferSource();
      src.buffer = buf;
      const gain = ac.createGain();
      gain.gain.setValueAtTime(0.9, ac.currentTime);
      src.connect(gain);
      gain.connect(ac.destination);
      src.start();
      src.onended = () => ac.close();
    } catch (e) {
      console.warn('[crash sound]', e);
    }
  }

  private hudString(): string {
    const c = this.crashes > 0 ? `  crashes ${this.crashes}` : '';
    const u = username ? `  u/${username}` : '';
    return `turn ${this.turn}${c}${u}`;
  }

  // ── Camera framing ────────────────────────────────────────────────────────────

  private panTo(wx: number, wy: number, duration: number, onComplete?: () => void) {
    const cam  = this.cameras.main;
    cam.stopFollow();
    const view = cam.worldView;
    const proxy = { x: view.centerX, y: view.centerY };
    this.tweens.add({
      targets:    proxy,
      x:          wx,
      y:          wy,
      duration,
      ease:       'Quad.easeOut',
      onUpdate:   () => cam.centerOn(proxy.x, proxy.y),
      onComplete: () => onComplete?.(),
    });
  }

  private zoomToFitTrack(): void {
    const bounds  = trackBounds(this.trackPieces);
    const pad     = gridPx * 4;
    const cam     = this.cameras.main;
    const zoomX   = cam.width  / (bounds.width  + pad * 2);
    const zoomY   = cam.height / (bounds.height + pad * 2);
    const zoom    = Math.min(zoomX, zoomY, 2.5);
    const cx      = bounds.x + bounds.width  / 2;
    const cy      = bounds.y + bounds.height / 2;
    cam.stopFollow();
    const proxy   = { x: cam.worldView.centerX, y: cam.worldView.centerY, zoom: cam.zoom };
    this.tweens.add({
      targets:  proxy,
      x: cx, y: cy, zoom,
      duration: 700,
      ease:     'Quad.easeInOut',
      onUpdate: () => { cam.setZoom(proxy.zoom); cam.centerOn(proxy.x, proxy.y); },
    });
  }

  private framePicker() {
    this.hoverTarget = null;
    const pickR = Math.floor(gridPx / 2) - 1;
    const pad   = pickR + 8;
    const natX  = this.gx + this.velX;
    const natY  = this.gy + this.velY;

    // Bounding box that must be fully visible: car position + all 9 pick targets.
    const x0 = Math.min(this.gx, natX - 1) * gridPx - pad;
    const y0 = Math.min(this.gy, natY - 1) * gridPx - pad;
    const x1 = Math.max(this.gx, natX + 1) * gridPx + pad;
    const y1 = Math.max(this.gy, natY + 1) * gridPx + pad;

    const cx    = (x0 + x1) / 2;
    const cy    = (y0 + y1) / 2;
    const bboxW = x1 - x0;
    const bboxH = y1 - y0;

    const cam  = this.cameras.main;
    const view = cam.worldView;
    const done = () => { this.picking = true; this.drawUI(); };

    // Already fully on screen — no adjustment needed.
    const alreadyVisible =
      view.x <= x0 && view.right  >= x1 &&
      view.y <= y0 && view.bottom >= y1;
    if (alreadyVisible) { done(); return; }

    // Fits at current zoom but is off-screen — pan only.
    const viewW = cam.width  / cam.zoom;
    const viewH = cam.height / cam.zoom;
    if (bboxW <= viewW && bboxH <= viewH) {
      this.panTo(cx, cy, 240, done);
      return;
    }

    // Doesn't fit at current zoom — zoom out to fit while panning.
    const targetZoom = Math.max(
      Math.min(cam.width / bboxW, cam.height / bboxH) * 0.92,
      MIN_ZOOM,
    );
    cam.stopFollow();
    const proxy = { x: view.centerX, y: view.centerY, zoom: cam.zoom };
    this.tweens.add({
      targets:    proxy,
      x: cx, y: cy, zoom: targetZoom,
      duration:   300,
      ease:       'Quad.easeOut',
      onUpdate:   () => { cam.setZoom(proxy.zoom); cam.centerOn(proxy.x, proxy.y); },
      onComplete: () => done(),
    });
  }

  // ── Drawing ───────────────────────────────────────────────────────────────────

  private updateHover(ptr: Phaser.Input.Pointer): void {
    const wp   = this.cameras.main.getWorldPoint(ptr.x, ptr.y);
    const natX = this.gx + this.velX;
    const natY = this.gy + this.velY;
    const hitR = Math.floor(gridPx / 2) + 4;

    let found: { tx: number; ty: number; valid: boolean } | null = null;
    outer:
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const tx = natX + dx, ty = natY + dy;
        const twx = tx * gridPx, twy = ty * gridPx;
        if ((wp.x - twx) ** 2 + (wp.y - twy) ** 2 <= hitR * hitR) {
          const valid = !intersectsBarrier(this.gx * gridPx, this.gy * gridPx, twx, twy, this.trackPieces);
          found = { tx, ty, valid };
          break outer;
        }
      }
    }

    const prev = this.hoverTarget;
    if (found?.tx !== prev?.tx || found?.ty !== prev?.ty) {
      this.hoverTarget = found;
      this.drawUI();
    }
  }

  private drawUI() {
    this.velGfx.clear();
    this.pickGfx.clear();

    const carWX = this.gx * gridPx;
    const carWY = this.gy * gridPx;
    const natWX = (this.gx + this.velX) * gridPx;
    const natWY = (this.gy + this.velY) * gridPx;

    // Yellow line points to the hovered valid target; falls back to natural position.
    const lineToWX = this.hoverTarget?.valid ? this.hoverTarget.tx * gridPx : natWX;
    const lineToWY = this.hoverTarget?.valid ? this.hoverTarget.ty * gridPx : natWY;

    this.velGfx.lineStyle(1.5, 0xffee00, 0.7);
    this.velGfx.beginPath();
    this.velGfx.moveTo(carWX, carWY);
    this.velGfx.lineTo(lineToWX, lineToWY);
    this.velGfx.strokePath();
    this.velGfx.fillStyle(0xffee00, 0.6);
    this.velGfx.fillCircle(lineToWX, lineToWY, 2.5);

    const natGX = this.gx + this.velX;
    const natGY = this.gy + this.velY;
    const pickR = Math.floor(gridPx / 2) - 1;

    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const tx = natGX + dx, ty = natGY + dy;
        const twx = tx * gridPx, twy = ty * gridPx;
        const valid     = !intersectsBarrier(carWX, carWY, twx, twy, this.trackPieces);
        const isNatural = dx === 0 && dy === 0;
        const isHovered = this.hoverTarget?.tx === tx && this.hoverTarget?.ty === ty;

        if (!valid) {
          const r   = isHovered ? pickR + 2 : pickR;
          const arm = Math.max(Math.round(r * 0.55), 3);
          this.pickGfx.fillStyle(isHovered ? 0x880000 : 0x550000, 0.80);
          this.pickGfx.fillCircle(twx, twy, r);
          this.pickGfx.lineStyle(1.5, isHovered ? 0xff3333 : 0xaa0000, 0.90);
          this.pickGfx.strokeCircle(twx, twy, r);
          this.pickGfx.lineStyle(2, 0xdd2222, 1.0);
          this.pickGfx.beginPath();
          this.pickGfx.moveTo(twx - arm, twy - arm);
          this.pickGfx.lineTo(twx + arm, twy + arm);
          this.pickGfx.moveTo(twx + arm, twy - arm);
          this.pickGfx.lineTo(twx - arm, twy + arm);
          this.pickGfx.strokePath();
          continue;
        }

        const fill = isNatural ? 0xffee00 : 0x33ee88;
        const r    = isHovered ? pickR + 2 : pickR;
        this.pickGfx.fillStyle(fill, isHovered ? 1.0 : 0.80);
        this.pickGfx.fillCircle(twx, twy, r);
        this.pickGfx.lineStyle(isHovered ? 2 : 1, isHovered ? 0xffffff : 0xffffff, isHovered ? 1.0 : 0.35);
        this.pickGfx.strokeCircle(twx, twy, r);


      }
    }
  }

  private drawTrailSegment(fromGX: number, fromGY: number, toGX: number, toGY: number, crash: boolean): void {
    const fromWX = fromGX * gridPx, fromWY = fromGY * gridPx;
    const toWX   = toGX   * gridPx, toWY   = toGY   * gridPx;
    const color  = crash ? 0xff4422 : 0xff33ff;
    const alpha  = crash ? 0.80     : 0.65;

    // Segment line
    this.trailGfx.lineStyle(2, color, alpha);
    this.trailGfx.beginPath();
    this.trailGfx.moveTo(fromWX, fromWY);
    this.trailGfx.lineTo(toWX, toWY);
    this.trailGfx.strokePath();

    // Joint dot at the origin (future: customizable icon/pattern)
    this.trailGfx.fillStyle(color, Math.min(alpha + 0.15, 1));
    this.trailGfx.fillCircle(fromWX, fromWY, 3);
  }

  private drawGrid() {
    this.dotGfx.clear();

    const b      = trackBounds(this.trackPieces);
    const margin = Math.max(b.width, b.height, 1200);

    // Snap grid origin to gridPx so lines always fall on integer grid coords.
    const xMin = Math.floor((b.x - margin) / gridPx) * gridPx;
    const yMin = Math.floor((b.y - margin) / gridPx) * gridPx;
    const xMax = Math.ceil((b.x + b.width  + margin) / gridPx) * gridPx;
    const yMax = Math.ceil((b.y + b.height + margin) / gridPx) * gridPx;

    const major = 5; // major line every 5 cells

    // Minor lines — batch all in one path call each axis
    this.dotGfx.lineStyle(1, 0x15153a, 0.9);
    this.dotGfx.beginPath();
    for (let x = xMin; x <= xMax; x += gridPx) {
      if ((x / gridPx) % major === 0) continue;
      this.dotGfx.moveTo(x, yMin);
      this.dotGfx.lineTo(x, yMax);
    }
    for (let y = yMin; y <= yMax; y += gridPx) {
      if ((y / gridPx) % major === 0) continue;
      this.dotGfx.moveTo(xMin, y);
      this.dotGfx.lineTo(xMax, y);
    }
    this.dotGfx.strokePath();

    // Major lines
    this.dotGfx.lineStyle(1, 0x20205a, 1.0);
    this.dotGfx.beginPath();
    for (let x = xMin; x <= xMax; x += gridPx) {
      if ((x / gridPx) % major !== 0) continue;
      this.dotGfx.moveTo(x, yMin);
      this.dotGfx.lineTo(x, yMax);
    }
    for (let y = yMin; y <= yMax; y += gridPx) {
      if ((y / gridPx) % major !== 0) continue;
      this.dotGfx.moveTo(xMin, y);
      this.dotGfx.lineTo(xMax, y);
    }
    this.dotGfx.strokePath();
  }

  // ── Textures ──────────────────────────────────────────────────────────────────

  private makeSpark() {
    if (this.textures.exists('spark')) return;
    const t   = this.textures.createCanvas('spark', 8, 8)!;
    const ctx = t.getContext();
    const g   = ctx.createRadialGradient(4, 4, 0, 4, 4, 4);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(1, 'rgba(255,160,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 8, 8);
    t.refresh();
  }

  private makeCarTexture() {
    const HW  = Math.round(gridPx * 0.50);
    const HH  = Math.round(gridPx * 0.85);
    const PAD = Math.round(gridPx * 0.45);
    const W   = (HW + PAD) * 2;
    const H   = (HH + PAD) * 2;
    const cx  = W / 2, cy = H / 2;

    if (this.textures.exists('car')) this.textures.remove('car');
    const ct  = this.textures.createCanvas('car', W, H)!;
    const ctx = ct.getContext();

    ctx.shadowColor = 'hsl(300,100%,60%)';
    ctx.shadowBlur  = 10;
    ctx.fillStyle   = 'hsl(300,100%,60%)';
    ctx.beginPath();
    ctx.moveTo(cx,       cy - HH);
    ctx.lineTo(cx + HW,  cy + HH);
    ctx.lineTo(cx,       cy + HH * 0.35);
    ctx.lineTo(cx - HW,  cy + HH);
    ctx.closePath();
    ctx.fill();

    ctx.shadowBlur = 0;
    ctx.fillStyle  = 'rgba(255,255,255,0.80)';
    ctx.beginPath();
    ctx.moveTo(cx,             cy - HH + 3);
    ctx.lineTo(cx + HW * 0.45, cy + HH * 0.2);
    ctx.lineTo(cx,             cy + HH * 0.1);
    ctx.lineTo(cx - HW * 0.45, cy + HH * 0.2);
    ctx.closePath();
    ctx.fill();

    ct.refresh();
  }

  private makeGhostTextures(): void {
    const HW  = Math.round(gridPx * 0.50);
    const HH  = Math.round(gridPx * 0.85);
    const PAD = Math.round(gridPx * 0.45);
    const W   = (HW + PAD) * 2;
    const H   = (HH + PAD) * 2;
    const cx  = W / 2, cy = H / 2;

    GHOST_COLORS.forEach(({ trail }, i) => {
      const key = `ghost-car-${i}`;
      const r   = (trail >> 16) & 0xff;
      const g   = (trail >>  8) & 0xff;
      const b   =  trail        & 0xff;
      const css = `rgb(${r},${g},${b})`;

      if (this.textures.exists(key)) this.textures.remove(key);
      const ct  = this.textures.createCanvas(key, W, H)!;
      const ctx = ct.getContext();

      ctx.shadowColor = css;
      ctx.shadowBlur  = 8;
      ctx.fillStyle   = css;
      ctx.beginPath();
      ctx.moveTo(cx,       cy - HH);
      ctx.lineTo(cx + HW,  cy + HH);
      ctx.lineTo(cx,       cy + HH * 0.35);
      ctx.lineTo(cx - HW,  cy + HH);
      ctx.closePath();
      ctx.fill();

      ctx.shadowBlur = 0;
      ctx.fillStyle  = 'rgba(255,255,255,0.55)';
      ctx.beginPath();
      ctx.moveTo(cx,              cy - HH + 3);
      ctx.lineTo(cx + HW * 0.45,  cy + HH * 0.2);
      ctx.lineTo(cx,              cy + HH * 0.1);
      ctx.lineTo(cx - HW * 0.45,  cy + HH * 0.2);
      ctx.closePath();
      ctx.fill();

      ct.refresh();
    });
  }

  // ── Debug: shift-key slow-motion (temporary) ─────────────────────────────────

  private addShiftSlow(): void {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'Shift') { this.tweens.timeScale = 0.1; this.time.timeScale = 0.1; }
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === 'Shift') { this.tweens.timeScale = 1; this.time.timeScale = 1; }
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup',   up);
    this.events.once('shutdown', () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup',   up);
    });
  }

  // ── Debug grid-size slider (temporary tuning aid) ─────────────────────────────

  private addGridSlider() {
    const ID  = 'dv-grid-slider';
    const existing = document.getElementById(ID);

    if (!existing) {
      const div = document.createElement('div');
      div.id    = ID;
      div.style.cssText = [
        'position:fixed', 'bottom:12px', 'left:50%', 'transform:translateX(-50%)',
        'z-index:100', 'background:rgba(0,0,0,0.65)', 'color:#cce',
        'font:13px/1.6 monospace', 'padding:4px 12px', 'border-radius:6px',
        'display:flex', 'align-items:center', 'gap:8px', 'pointer-events:auto',
        'user-select:none',
      ].join(';');
      div.innerHTML =
        `grid <input type="range" id="dv-grid-px" min="12" max="48" step="2" ` +
        `value="${gridPx}" style="width:120px"> ` +
        `<span id="dv-grid-val">${gridPx}</span>px`;
      document.body.appendChild(div);

      document.getElementById('dv-grid-px')!.addEventListener('input', (e) => {
        gridPx = parseInt((e.target as HTMLInputElement).value, 10);
        document.getElementById('dv-grid-val')!.textContent = String(gridPx);
        // Use the module-level game reference so this closure stays valid across restarts.
        phaserGame?.scene.start('Game');
      });
    } else {
      // Scene restarted: sync the display to the current gridPx.
      (document.getElementById('dv-grid-px') as HTMLInputElement).value = String(gridPx);
      document.getElementById('dv-grid-val')!.textContent = String(gridPx);
    }
  }

  // ── Pause menu ────────────────────────────────────────────────────────────────

  private addPauseUI(): void {
    // DOM pause button — immune to camera zoom, always fixed top-left.
    const btn = document.createElement('button');
    btn.style.cssText = [
      'position:fixed', 'top:6px', 'left:6px',
      'width:46px', 'height:38px',
      'background:#3355cc', 'border:2px solid #aabbff', 'border-radius:5px',
      'cursor:pointer', 'z-index:999', 'padding:0',
      'display:flex', 'align-items:center', 'justify-content:center',
    ].join(';');
    btn.innerHTML = `<svg width="22" height="22" viewBox="0 0 22 22" xmlns="http://www.w3.org/2000/svg">
      <rect x="3"  y="2" width="6" height="18" rx="1" fill="white"/>
      <rect x="13" y="2" width="6" height="18" rx="1" fill="white"/>
    </svg>`;
    btn.addEventListener('click', () => { if (!this.paused && !this.won) this.showPause(); });
    document.body.appendChild(btn);
    this.pauseBtnEl = btn;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (this.paused) this.resumeGame();
        else if (!this.won) this.showPause();
      }
      // TEMPORARY: Shift+X cleans up fake ghosts for the current track
      if (e.key === 'X' && e.shiftKey) this.cleanupDebugGhosts();
      // TEMPORARY: Shift+G generates and uploads AI ghosts for the current track
      if (e.key === 'G' && e.shiftKey) {
        console.log(`[ai ghosts] generating for ${this.trackEntry.id}…`);
        generateAndUploadAiGhosts(this.trackEntry, undefined, gridPx)
          .then(() => console.log(`[ai ghosts] done for ${this.trackEntry.id}`))
          .catch((err: unknown) => console.error('[ai ghosts]', err));
      }
      // TEMPORARY: Shift+A generates and uploads AI ghosts for ALL standard tracks
      if (e.key === 'A' && e.shiftKey) {
        console.log(`[ai ghosts] generating for all ${STANDARD_TRACKS.length} standard tracks…`);
        (async () => {
          for (const track of STANDARD_TRACKS) {
            console.log(`[ai ghosts] → ${track.id}`);
            await generateAndUploadAiGhosts(track, undefined, gridPx);
          }
          console.log('[ai ghosts] all standard tracks done');
        })().catch((err: unknown) => console.error('[ai ghosts all]', err));
      }
    };
    window.addEventListener('keydown', onKey);

    this.events.once('shutdown', () => {
      window.removeEventListener('keydown', onKey);
      btn.remove();
      this.pauseBtnEl = null;
      this.hudDiv?.remove();
      this.hudDiv = null;
      this.pauseOverlayEl?.remove();
      this.pauseOverlayEl = null;
      this.finishOverlayEl?.remove();
      this.finishOverlayEl = null;
      this.viewTrackBackBtn?.remove();
      this.viewTrackBackBtn = null;
      for (const s of this.ghostStates) { s.carImg.destroy(); s.trailGfx.destroy(); }
      this.ghostStates = [];
    });
  }

  private updateHud(): void {
    if (this.hudDiv) this.hudDiv.textContent = this.hudString();
  }

  private showPause(): void {
    this.paused           = true;
    this.savedTweenScale  = this.tweens.timeScale;
    this.savedTimeScale   = this.time.timeScale;
    this.tweens.timeScale = 0;
    this.time.timeScale   = 0;
    if (this.minimapCanvas) this.minimapCanvas.style.display = 'none';
    if (this.pauseBtnEl)    this.pauseBtnEl.style.display    = 'none';
    if (this.hudDiv)        this.hudDiv.style.display        = 'none';
    this.pauseOverlayEl = this.buildPauseDOM();
    document.body.appendChild(this.pauseOverlayEl);
  }

  private resumeGame(): void {
    this.paused           = false;
    this.tweens.timeScale = this.savedTweenScale;
    this.time.timeScale   = this.savedTimeScale;
    this.pauseOverlayEl?.remove();
    this.pauseOverlayEl = null;
    if (this.minimapCanvas) this.minimapCanvas.style.display = '';
    if (this.pauseBtnEl)    this.pauseBtnEl.style.display    = '';
    if (this.hudDiv)        this.hudDiv.style.display        = '';
    if (!this.won && !this.crashing && this.picking) this.drawUI();
  }

  private clearPauseAndGo(fn: () => void): void {
    this.paused           = false;
    this.tweens.timeScale = 1;
    this.time.timeScale   = 1;
    this.pauseOverlayEl?.remove();
    this.pauseOverlayEl = null;
    if (this.minimapCanvas) this.minimapCanvas.style.display = '';
    if (this.pauseBtnEl)    this.pauseBtnEl.style.display    = '';
    if (this.hudDiv)        this.hudDiv.style.display        = '';
    fn();
  }

  private buildPauseDOM(): HTMLElement {
    const overlay = document.createElement('div');
    overlay.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:1002',
      'background:rgba(0,0,0,0.65)',
      'display:flex', 'align-items:center', 'justify-content:center',
    ].join(';');

    const dialog = document.createElement('div');
    dialog.style.cssText = [
      'background:#111130', 'border:1.5px solid #5555aa', 'border-radius:10px',
      'width:min(320px,calc(100% - 24px))',
      'max-height:calc(100% - 24px)',
      'overflow:hidden',
      'display:flex', 'flex-direction:column', 'align-items:stretch',
      'padding:16px 14px 14px', 'box-sizing:border-box', 'gap:8px',
    ].join(';');

    const title = document.createElement('div');
    title.textContent = 'Game Paused';
    title.style.cssText = [
      'font:bold 20px "Arial Black",Arial,sans-serif',
      'color:#e8e8ff', 'text-align:center',
      'text-shadow:0 0 6px #000,-1px -1px 0 #000,1px 1px 0 #000',
    ].join(';');

    const body = document.createElement('div');
    body.innerHTML = "The race isn't over yet.<br>What would you like to do?";
    body.style.cssText = [
      'font:13px Arial,sans-serif', 'color:#9999cc', 'text-align:center',
      'margin-bottom:4px',
    ].join(';');

    const btnStyle = (color: string) => [
      'display:block', 'width:100%', 'padding:14px 0',
      'background:#1a1a3a', 'border:1px solid #4444aa', 'border-radius:8px',
      `color:${color}`, 'font:bold 18px "Arial Black",Arial,sans-serif',
      'cursor:pointer', 'text-shadow:0 0 4px #000,-1px -1px 0 #000,1px 1px 0 #000',
    ].join(';');

    const makeBtn = (label: string, color: string, onClick: () => void) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = btnStyle(color);
      b.addEventListener('click', onClick);
      return b;
    };

    dialog.appendChild(title);
    dialog.appendChild(body);
    dialog.appendChild(makeBtn('Continue', '#66ff99', () => this.resumeGame()));
    dialog.appendChild(makeBtn('Restart',  '#ffcc44', () => this.clearPauseAndGo(() => this.scene.start('Game', { trackId: this.trackEntry.id }))));
    dialog.appendChild(makeBtn('Exit',     '#ff6666', () => this.clearPauseAndGo(() => this.scene.start('TrackSelect'))));

    overlay.appendChild(dialog);
    return overlay;
  }

  override update() { /* driven by events */ }
}
