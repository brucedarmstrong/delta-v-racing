import { Scene, GameObjects } from 'phaser';
import { buildTrackTexture } from '../track/TrackCanvasRenderer';
import { NEON_GREEN } from '../track/TrackSkin';
import { TRACK_REGISTRY, type TrackEntry } from '../tracks/trackRegistry';
import { type PlacedPiece, trackBounds } from '../track/TrackLayout';
import { isOnSurface } from '../track/TrackCollision';
import { CORRIDOR } from '../track/TrackGeometry';
import type { TrackMarker } from '../track/convertGmsTrack';

// ── Grid / camera constants ────────────────────────────────────────────────────
// gridPx is mutable so the debug slider can adjust it at runtime.
// pickR is always floor(gridPx/2)-1, guaranteeing no circle overlap.
let gridPx = 24;

const MIN_ZOOM = 0.4;
const MAX_ZOOM = 5.0;

// Slow-motion multiplier applied from crash contact until car reappears.
// Set to 1 to disable once the animation is tuned.
const CRASH_SLO = 0.2;

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

  // Pause menu
  private paused           = false;
  private savedTweenScale  = 1;
  private savedTimeScale   = 1;
  private pauseOverlayEl:  HTMLElement | null = null;

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

  init(data?: { trackId?: string }) {
    const id = data?.trackId ?? lastTrackId;
    lastTrackId = id;
    const entry = TRACK_REGISTRY.get(id) ?? TRACK_REGISTRY.values().next().value!;
    this.trackEntry   = entry;
    this.trackPieces  = entry.pieces;
    this.trackMarkers = entry.markers;
    this.startWX      = entry.startX;
    this.startWY      = entry.startY;
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

    this.dotGfx = this.add.graphics().setDepth(1);
    this.drawDotGrid();

    this.addTrackMarkers();

    this.makeSpark();
    this.makeCarTexture();

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
    const b   = trackBounds(this.trackPieces);
    const pad = gridPx * 3;

    this.mmWL = b.x - pad;
    this.mmWT = b.y - pad;
    this.mmWW = b.width  + pad * 2;
    this.mmWH = b.height + pad * 2;
    this.mmW  = 200;
    this.mmH  = Math.round(this.mmW * this.mmWH / this.mmWW);

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

    // Scan the world and paint on-surface pixels as green dots.
    ctx.fillStyle = '#33aa33';
    const step = 5;
    for (let wy = this.mmWT; wy <= this.mmWT + this.mmWH; wy += step) {
      for (let wx = this.mmWL; wx <= this.mmWL + this.mmWW; wx += step) {
        if (isOnSurface(wx, wy, this.trackPieces)) {
          const lx = (wx - this.mmWL) / this.mmWW * this.mmW;
          const ly = (wy - this.mmWT) / this.mmWH * this.mmH;
          ctx.fillRect(lx, ly, 2, 2);
        }
      }
    }

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

        // Car dot
        const dotX = (this.carImg.x - this.mmWL) / this.mmWW * this.mmW;
        const dotY = (this.carImg.y - this.mmWT) / this.mmWH * this.mmH;
        ctx.beginPath();
        ctx.arc(dotX, dotY, 6, 0, Math.PI * 2);
        ctx.fillStyle   = '#ff2222';
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
          if (isOnSurface(twx, twy, this.trackPieces)) {
            this.commitMove(tx, ty, dx, dy);
          } else {
            // Player deliberately picked an off-track target.
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
    const natX = this.gx + this.velX;
    const natY = this.gy + this.velY;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (isOnSurface((natX + dx) * gridPx, (natY + dy) * gridPx, this.trackPieces)) {
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

    const crashWX = crashGX * gridPx;
    const crashWY = crashGY * gridPx;
    const safe    = this.findNearestValid(crashWX, crashWY);
    const safeGX  = safe?.gx ?? this.gx;
    const safeGY  = safe?.gy ?? this.gy;
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
    for (let i = 1; i <= 20; i++) {
      const t  = i / 20;
      const wx = fromWX + (toWX - fromWX) * t;
      const wy = fromWY + (toWY - fromWY) * t;
      if (!isOnSurface(wx, wy, this.trackPieces)) break;
      lastWX = wx;
      lastWY = wy;
    }
    return { wx: lastWX, wy: lastWY };
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
          if (isOnSurface(gx * gridPx, gy * gridPx, this.trackPieces)) return { gx, gy };
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

    const { width, height } = this.scale;
    const crashStr = this.crashes > 0 ? `\n${this.crashes} crash${this.crashes > 1 ? 'es' : ''}` : '';
    this.add.text(
      width / 2, height / 2,
      `FINISH!\nTurn ${this.turn}${crashStr}`,
      {
        fontFamily: 'Arial Black',
        fontSize:   '42px',
        color:      '#ffee00',
        stroke:     '#000000',
        strokeThickness: 8,
        align:      'center',
      },
    )
    .setScrollFactor(0)
    .setOrigin(0.5)
    .setDepth(30);
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
    return `turn ${this.turn}${c}`;
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

  private framePicker() {
    const pickR = Math.floor(gridPx / 2) - 1;
    const pad   = pickR + 8;
    const natX  = this.gx + this.velX;
    const natY  = this.gy + this.velY;

    const x0 = Math.min(this.gx, natX - 1) * gridPx - pad;
    const y0 = Math.min(this.gy, natY - 1) * gridPx - pad;
    const x1 = Math.max(this.gx, natX + 1) * gridPx + pad;
    const y1 = Math.max(this.gy, natY + 1) * gridPx + pad;

    const view = this.cameras.main.worldView;
    const alreadyVisible =
      view.x <= x0 && view.right  >= x1 &&
      view.y <= y0 && view.bottom >= y1;

    const done = () => { this.picking = true; this.drawUI(); };

    if (alreadyVisible) { done(); return; }

    this.panTo((x0 + x1) / 2, (y0 + y1) / 2, 240, done);
  }

  // ── Drawing ───────────────────────────────────────────────────────────────────

  private drawUI() {
    this.velGfx.clear();
    this.pickGfx.clear();

    const carWX = this.gx * gridPx;
    const carWY = this.gy * gridPx;
    const natWX = (this.gx + this.velX) * gridPx;
    const natWY = (this.gy + this.velY) * gridPx;

    this.velGfx.lineStyle(1.5, 0xffee00, 0.7);
    this.velGfx.beginPath();
    this.velGfx.moveTo(carWX, carWY);
    this.velGfx.lineTo(natWX, natWY);
    this.velGfx.strokePath();
    this.velGfx.fillStyle(0xffee00, 0.6);
    this.velGfx.fillCircle(natWX, natWY, 2.5);

    const natGX = this.gx + this.velX;
    const natGY = this.gy + this.velY;
    const pickR = Math.floor(gridPx / 2) - 1;

    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const tx = natGX + dx, ty = natGY + dy;
        const twx = tx * gridPx, twy = ty * gridPx;
        const valid     = isOnSurface(twx, twy, this.trackPieces);
        const isNatural = dx === 0 && dy === 0;

        if (!valid) {
          // Dark-red circle with X — always shown, always clickable (intentional crash).
          const arm = Math.max(Math.round(pickR * 0.55), 3);
          this.pickGfx.fillStyle(0x550000, 0.80);
          this.pickGfx.fillCircle(twx, twy, pickR);
          this.pickGfx.lineStyle(1.5, 0xaa0000, 0.90);
          this.pickGfx.strokeCircle(twx, twy, pickR);
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
        this.pickGfx.fillStyle(fill, 0.80);
        this.pickGfx.fillCircle(twx, twy, pickR);
        this.pickGfx.lineStyle(1, 0xffffff, 0.35);
        this.pickGfx.strokeCircle(twx, twy, pickR);
      }
    }
  }

  private drawDotGrid() {
    this.dotGfx.clear();
    this.dotGfx.fillStyle(0x8888aa, 0.25);

    const b      = trackBounds(this.trackPieces);
    const margin = gridPx * 2;
    const x0 = Math.floor((b.x - margin) / gridPx);
    const y0 = Math.floor((b.y - margin) / gridPx);
    const x1 = Math.ceil((b.x + b.width  + margin) / gridPx);
    const y1 = Math.ceil((b.y + b.height + margin) / gridPx);

    for (let gx = x0; gx <= x1; gx++) {
      for (let gy = y0; gy <= y1; gy++) {
        const wx = gx * gridPx, wy = gy * gridPx;
        if (isOnSurface(wx, wy, this.trackPieces)) {
          this.dotGfx.fillCircle(wx, wy, 1.4);
        }
      }
    }
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
