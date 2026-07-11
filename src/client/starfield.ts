// PhaserStarField — twinkling/shooting-star field for Phaser scenes.
//
// Uses textures.createCanvas (offscreen Canvas 2D uploaded as WebGL texture)
// instead of a DOM <canvas> overlay, avoiding the Chrome compositor crash when
// Canvas 2D and Phaser WebGL share the same viewport (Phaser 4 workaround #10).

import type Phaser from 'phaser';

type StarDot   = { x: number; y: number; r: number; baseA: number; twinkleAmt: number; phase: number; freq: number; color: string };
type ShootStar = { x: number; y: number; vx: number; vy: number; alpha: number; trailLen: number };

export interface StarFieldOpts {
  /** Phaser scene depth. Default: -5. */
  depth?:    number;
  /**
   * Fraction of camera scroll to shift star positions each frame (0 = static).
   * Stars wrap at screen edges → infinite seamless parallax.
   * Default: 0.
   */
  parallax?: number;
  /**
   * Constant background drift, in px/second, independent of camera scroll —
   * gives a "slowly drifting through space" feel even when the camera (and
   * world) aren't moving. Stars wrap at screen edges same as parallax.
   * Default: 0.
   */
  driftX?: number;
  driftY?: number;
  /** Unique Phaser texture key — must differ between concurrent scenes. Default: 'phaserStarField'. */
  texKey?:   string;
}

export class PhaserStarField {
  private readonly scene:    Phaser.Scene;
  private readonly parallax: number;
  private readonly driftX:   number;
  private readonly driftY:   number;
  private readonly texKey:   string;
  private readonly depth:    number;
  private driftOffX = 0;
  private driftOffY = 0;
  private tex!:    Phaser.Textures.CanvasTexture;
  private img!:    Phaser.GameObjects.Image;
  private rafId  = 0;
  private lastT  = 0;
  private dots:   StarDot[]   = [];
  private shoots: ShootStar[] = [];
  private shootCD = 4000 + Math.random() * 4000;
  private readonly ANGLE = Math.random() * Math.PI * 2;

  constructor(scene: Phaser.Scene, opts: StarFieldOpts = {}) {
    this.scene    = scene;
    this.parallax = opts.parallax ?? 0;
    this.driftX   = opts.driftX   ?? 0;
    this.driftY   = opts.driftY   ?? 0;
    this.texKey   = opts.texKey   ?? 'phaserStarField';
    this.depth    = opts.depth    ?? -5;

    const { width: w, height: h } = scene.scale;
    this.buildTex(w, h);
    this.seedStars(w, h);

    scene.scale.on('resize', (sz: { width: number; height: number }) => {
      this.buildTex(sz.width, sz.height);
      this.seedStars(sz.width, sz.height);
    });
    scene.events.once('shutdown', () => this.destroy());

    const tick = (now: number) => {
      if (this.rafId === 0) return;
      this.frame(now);
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private buildTex(w: number, h: number): void {
    const pw = Math.max(1, Math.ceil(w));
    const ph = Math.max(1, Math.ceil(h));
    if (this.scene.textures.exists(this.texKey)) this.scene.textures.remove(this.texKey);
    this.tex = this.scene.textures.createCanvas(this.texKey, pw, ph)!;
    if (this.img) {
      this.img.setTexture(this.texKey);
    } else {
      this.img = this.scene.add.image(0, 0, this.texKey)
        .setOrigin(0, 0)
        .setScrollFactor(0)
        .setDepth(this.depth);
    }
  }

  private seedStars(w: number, h: number): void {
    this.dots   = [];
    this.shoots = [];
    const count  = Math.round((w * h) / 7000);
    const colors = ['255,255,255', '210,225,255', '255,245,210'];
    for (let i = 0; i < count; i++) {
      const r = Math.random() ** 2 * 1.6 + 0.3;
      this.dots.push({
        x:          Math.random() * w,
        y:          Math.random() * h,
        r,
        baseA:      Math.random() * 0.45 + 0.2,
        twinkleAmt: r > 1.0 ? 0.25 : 0.10,
        phase:      Math.random() * Math.PI * 2,
        freq:       Math.random() * 1.2 + 0.4,
        color:      colors[Math.floor(Math.random() * colors.length)],
      });
    }
  }

  private spawnShoot(w: number, h: number): void {
    const angle = this.ANGLE + (Math.random() - 0.5) * 0.35;
    const speed = 420 + Math.random() * 320;
    const vx = Math.cos(angle) * speed;
    const vy = Math.sin(angle) * speed;
    let x: number, y: number;
    if (Math.abs(vx) >= Math.abs(vy)) {
      x = vx > 0 ? -10 : w + 10;
      y = Math.random() * h;
    } else {
      x = Math.random() * w;
      y = vy > 0 ? -10 : h + 10;
    }
    this.shoots.push({ x, y, vx, vy, alpha: 0.9 + Math.random() * 0.1, trailLen: 70 + Math.random() * 70 });
  }

  private frame(now: number): void {
    const dt = this.lastT ? Math.min((now - this.lastT) / 1000, 0.1) : 0;
    this.lastT = now;

    const tex = this.tex;
    if (!tex) return;
    const ctx = tex.getContext();
    const w   = tex.width;
    const h   = tex.height;
    ctx.clearRect(0, 0, w, h);

    this.driftOffX += this.driftX * dt;
    this.driftOffY += this.driftY * dt;

    const cam  = this.scene.cameras?.main;
    const offX = (cam ? cam.scrollX * this.parallax : 0) + this.driftOffX;
    const offY = (cam ? cam.scrollY * this.parallax : 0) + this.driftOffY;

    // Twinkling dots with parallax wrapping.
    for (const s of this.dots) {
      s.phase += s.freq * dt;
      const a  = Math.max(0, s.baseA + s.twinkleAmt * Math.sin(s.phase));
      const sx = ((s.x - offX) % w + w) % w;
      const sy = ((s.y - offY) % h + h) % h;
      ctx.beginPath();
      ctx.arc(sx, sy, s.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${s.color},${a.toFixed(3)})`;
      ctx.fill();
    }

    // Shooting stars (screen-space only — no parallax wrap, they arc across and exit).
    this.shootCD -= dt * 1000;
    if (this.shootCD <= 0) {
      this.spawnShoot(w, h);
      this.shootCD = 4000 + Math.random() * 6000;
    }
    this.shoots = this.shoots.filter(ss => {
      ss.x += ss.vx * dt;
      ss.y += ss.vy * dt;
      const pad = ss.trailLen + 10;
      if (ss.x < -pad || ss.x > w + pad || ss.y < -pad || ss.y > h + pad) return false;

      const spd = Math.hypot(ss.vx, ss.vy);
      const nx  = ss.vx / spd, ny = ss.vy / spd;
      const tx  = ss.x - nx * ss.trailLen;
      const ty  = ss.y - ny * ss.trailLen;

      const grad = ctx.createLinearGradient(tx, ty, ss.x, ss.y);
      grad.addColorStop(0,    `rgba(255,255,255,0)`);
      grad.addColorStop(0.55, `rgba(255,255,255,${(ss.alpha * 0.25).toFixed(3)})`);
      grad.addColorStop(1,    `rgba(255,255,255,${ss.alpha.toFixed(3)})`);

      ctx.save();
      ctx.lineWidth   = 1.5;
      ctx.strokeStyle = grad;
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(ss.x, ss.y);
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(ss.x, ss.y, 1.8, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,255,255,${ss.alpha.toFixed(3)})`;
      ctx.fill();
      ctx.restore();
      return true;
    });

    tex.refresh();
  }

  destroy(): void {
    cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    if (this.img?.active) this.img.destroy();
    try {
      if (this.scene.textures.exists(this.texKey)) this.scene.textures.remove(this.texKey);
    } catch { /* scene may already be destroyed */ }
  }
}
