import { Scene, GameObjects } from 'phaser';
import { buildTrackTexture } from '../track/TrackCanvasRenderer';
import { NEON_GREEN } from '../track/TrackSkin';
import { OVAL_SMALL } from '../tracks/oval_small';
import { trackBounds } from '../track/TrackLayout';
import { isOnSurface } from '../track/TrackCollision';

// ── Grid / camera constants ────────────────────────────────────────────────────
// gridPx is mutable so the debug slider can adjust it at runtime.
// pickR is always floor(gridPx/2)-1, guaranteeing no circle overlap.
let gridPx = 24;

const MIN_ZOOM = 0.4;
const MAX_ZOOM = 5.0;

// Anchor: world-pixel coordinates of the starting point (centre of top straight).
const START_WX = 588;
const START_WY = 156;

// Persistent reference to the Phaser game so the slider can restart the scene
// without capturing a scene-instance `this` that becomes stale after restart.
let phaserGame: Phaser.Game | null = null;

export class Game extends Scene {
  // Turn-based state
  private gx      = 0;
  private gy      = 0;
  private velX    = 1;
  private velY    = 0;
  private turn    = 0;
  private crashes = 0;
  private picking = false;

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
  private hudText!:  GameObjects.Text;

  constructor() { super('Game'); }

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

    buildTrackTexture(this, OVAL_SMALL, NEON_GREEN);

    // Snap starting position to nearest grid intersection.
    this.gx   = Math.round(START_WX / gridPx);
    this.gy   = Math.round(START_WY / gridPx);
    this.velX = 1;
    this.velY = 0;
    this.turn = 0;
    this.crashes = 0;
    this.picking = false;

    this.dotGfx = this.add.graphics().setDepth(1);
    this.drawDotGrid();

    this.makeSpark();
    this.makeCarTexture();

    const startWX = this.gx * gridPx;
    const startWY = this.gy * gridPx;

    this.carImg  = this.add.image(startWX, startWY, 'car').setAngle(90).setDepth(10);
    this.velGfx  = this.add.graphics().setDepth(8);
    this.pickGfx = this.add.graphics().setDepth(9);

    this.hudText = this.add.text(8, 8, this.hudString(), {
      fontFamily: 'monospace', fontSize: '14px', color: '#ccccff',
      stroke: '#000000', strokeThickness: 3,
    }).setScrollFactor(0).setDepth(20);

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

    this.addGridSlider();

    // Short delay so the tap that launched this scene isn't treated as a pick.
    this.time.delayedCall(120, () => { this.framePicker(); });
  }

  // ── Turn handling ─────────────────────────────────────────────────────────────

  private handlePick(ptr: Phaser.Input.Pointer) {
    const wp   = this.cameras.main.getWorldPoint(ptr.x, ptr.y);
    const natX = this.gx + this.velX;
    const natY = this.gy + this.velY;
    const hitR = Math.floor(gridPx / 2) + 4; // slightly larger than visual for easier tapping

    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const tx = natX + dx, ty = natY + dy;
        const twx = tx * gridPx, twy = ty * gridPx;
        if ((wp.x - twx) ** 2 + (wp.y - twy) ** 2 <= hitR * hitR
            && isOnSurface(twx, twy, OVAL_SMALL)) {
          this.commitMove(tx, ty, dx, dy);
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
      onComplete: () => {
        this.gx   = newGX;
        this.gy   = newGY;
        this.velX = newVX;
        this.velY = newVY;
        this.turn++;
        this.hudText.setText(this.hudString());

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
        if (isOnSurface((natX + dx) * gridPx, (natY + dy) * gridPx, OVAL_SMALL)) {
          return true;
        }
      }
    }
    return false;
  }

  private handleCrash() {
    this.crashes++;
    this.hudText.setText(this.hudString());

    const crashWX = (this.gx + this.velX) * gridPx;
    const crashWY = (this.gy + this.velY) * gridPx;
    const safe    = this.findNearestValid(crashWX, crashWY);
    const safeGX  = safe?.gx ?? this.gx;
    const safeGY  = safe?.gy ?? this.gy;

    // Show all 9 targets as crash indicators and pan to the crash point concurrently.
    // The targets cluster around the crash point so panning keeps them in view.
    this.drawCrashTargets();
    this.panTo(crashWX, crashWY, 450);

    this.time.delayedCall(850, () => {
      this.velGfx.clear();
      this.pickGfx.clear();

      // Car drives to crash point; pan is already settled.
      this.tweens.add({
        targets:  this.carImg,
        x: crashWX, y: crashWY,
        duration: 280,
        ease:     'Quad.easeIn',
        onComplete: () => {
          this.playCrashSound();
          const emitter = this.spawnCrashParticles(crashWX, crashWY);

          // Slide to safe recovery point; explosion still alive overhead.
          this.tweens.add({
            targets:  this.carImg,
            x: safeGX * gridPx, y: safeGY * gridPx,
            duration: 320,
            ease:     'Quad.easeOut',
            onComplete: () => {
              this.time.delayedCall(600, () => emitter?.destroy());
              this.gx   = safeGX;
              this.gy   = safeGY;
              this.velX = 0;
              this.velY = 0;
              this.framePicker();
            },
          });
        },
      });
    });
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
          if (isOnSurface(gx * gridPx, gy * gridPx, OVAL_SMALL)) return { gx, gy };
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
        speed:    { min: 40, max: 160 },
        angle:    { min: 0, max: 360 },
        scale:    { start: 2.0, end: 0 },
        alpha:    { start: 1,   end: 0 },
        tint:     [0xffffff, 0xff6600, 0xffaa00, 0xffff44, 0xff2200],
        lifespan: 900,
        gravityY: 60,
      });
      emitter.explode(60);
      return emitter;
    } catch (e) {
      console.warn('[crash particles]', e);
      return null;
    }
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
        const valid     = isOnSurface(twx, twy, OVAL_SMALL);
        const isNatural = dx === 0 && dy === 0;

        if (!valid) {
          this.pickGfx.fillStyle(0x222233, 0.5);
          this.pickGfx.fillCircle(twx, twy, Math.max(pickR - 3, 2));
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

  private drawCrashTargets() {
    this.velGfx.clear();
    this.pickGfx.clear();

    const carWX = this.gx * gridPx;
    const carWY = this.gy * gridPx;
    const natWX = (this.gx + this.velX) * gridPx;
    const natWY = (this.gy + this.velY) * gridPx;

    // Velocity vector
    this.velGfx.lineStyle(1.5, 0xffee00, 0.7);
    this.velGfx.beginPath();
    this.velGfx.moveTo(carWX, carWY);
    this.velGfx.lineTo(natWX, natWY);
    this.velGfx.strokePath();
    this.velGfx.fillStyle(0xffee00, 0.6);
    this.velGfx.fillCircle(natWX, natWY, 2.5);

    const natGX  = this.gx + this.velX;
    const natGY  = this.gy + this.velY;
    const pickR  = Math.floor(gridPx / 2) - 1;
    const arm    = Math.max(Math.round(pickR * 0.55), 3);

    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const twx = (natGX + dx) * gridPx;
        const twy = (natGY + dy) * gridPx;

        // Dark-red filled circle with red border
        this.pickGfx.fillStyle(0x550000, 0.80);
        this.pickGfx.fillCircle(twx, twy, pickR);
        this.pickGfx.lineStyle(1.5, 0xaa0000, 0.90);
        this.pickGfx.strokeCircle(twx, twy, pickR);

        // X mark
        this.pickGfx.lineStyle(2, 0xdd2222, 1.0);
        this.pickGfx.beginPath();
        this.pickGfx.moveTo(twx - arm, twy - arm);
        this.pickGfx.lineTo(twx + arm, twy + arm);
        this.pickGfx.moveTo(twx + arm, twy - arm);
        this.pickGfx.lineTo(twx - arm, twy + arm);
        this.pickGfx.strokePath();
      }
    }
  }

  private drawDotGrid() {
    this.dotGfx.clear();
    this.dotGfx.fillStyle(0x8888aa, 0.25);

    const b      = trackBounds(OVAL_SMALL);
    const margin = gridPx * 2;
    const x0 = Math.floor((b.x - margin) / gridPx);
    const y0 = Math.floor((b.y - margin) / gridPx);
    const x1 = Math.ceil((b.x + b.width  + margin) / gridPx);
    const y1 = Math.ceil((b.y + b.height + margin) / gridPx);

    for (let gx = x0; gx <= x1; gx++) {
      for (let gy = y0; gy <= y1; gy++) {
        const wx = gx * gridPx, wy = gy * gridPx;
        if (isOnSurface(wx, wy, OVAL_SMALL)) {
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

  override update() { /* driven by events */ }
}
