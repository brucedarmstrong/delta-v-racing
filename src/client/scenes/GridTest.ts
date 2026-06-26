import { Scene, GameObjects } from 'phaser';

// Diagnostic scene: pure Phaser rendering, no DOM canvas overlay.
// Drag/zoom pattern copied verbatim from Game.ts.
// If this crashes in Chrome too, the issue is Phaser input itself in this WebView.
// If it works, the DOM Canvas 2D overlay alongside Phaser's WebGL is the culprit.

const HEADER_H = 60;
const GRID_PX  = 40;
const GRID_EXT = 4000; // world units each direction from origin

export class GridTest extends Scene {
  private dragStartX  = 0;
  private dragStartY  = 0;
  private dragScrollX = 0;
  private dragScrollY = 0;
  private isDragging  = false;
  private touches     = new Map<number, { x: number; y: number }>();
  private pinchDist   = 0;
  private pinchZoom   = 1;

  private infoText!: GameObjects.Text;

  constructor() { super('GridTest'); }

  create() {
    this.cameras.main.setBackgroundColor('#0a0a16');
    this.cameras.main.centerOn(0, 0);

    // Grid drawn once in world space — Phaser camera pans/zooms it for free
    const grid = this.add.graphics();
    grid.lineStyle(1, 0x1e1e50, 1);
    for (let x = -GRID_EXT; x <= GRID_EXT; x += GRID_PX) {
      grid.lineBetween(x, -GRID_EXT, x, GRID_EXT);
    }
    for (let y = -GRID_EXT; y <= GRID_EXT; y += GRID_PX) {
      grid.lineBetween(-GRID_EXT, y, GRID_EXT, y);
    }

    // Origin marker
    const marker = this.add.graphics();
    marker.lineStyle(2, 0xff4444, 1);
    marker.lineBetween(-16, 0, 16, 0);
    marker.lineBetween(0, -16, 0, 16);

    // Header bar (fixed — not affected by camera)
    const hdrGfx = this.add.graphics().setScrollFactor(0).setDepth(20);
    const hdrTxt = this.add.text(0, 0, 'GRID TEST (no DOM canvas)', {
      fontFamily: 'Arial Black', fontSize: '16px',
      color: '#e8e8ff', stroke: '#000', strokeThickness: 3,
    }).setScrollFactor(0).setOrigin(0.5).setDepth(21);
    this.add.text(18, HEADER_H / 2, '‹ Back', {
      fontFamily: 'Arial Black', fontSize: '16px', color: '#8888ff',
    }).setScrollFactor(0).setOrigin(0, 0.5).setDepth(21);

    this.infoText = this.add.text(8, HEADER_H + 8, '', {
      fontFamily: 'monospace', fontSize: '13px', color: '#aaaaff',
    }).setScrollFactor(0).setDepth(21);

    const drawHdr = () => {
      const W = this.scale.width;
      hdrGfx.clear();
      hdrGfx.fillStyle(0x12122a, 1);
      hdrGfx.fillRect(0, 0, W, HEADER_H);
      hdrGfx.lineStyle(1, 0x3a3a6a, 1);
      hdrGfx.lineBetween(0, HEADER_H, W, HEADER_H);
      hdrTxt.setPosition(W / 2, HEADER_H / 2);
    };
    drawHdr();
    this.scale.on('resize', drawHdr);

    this.input.addPointer(1);

    this.input.on('pointerdown', (ptr: Phaser.Input.Pointer) => {
      if (ptr.y < HEADER_H && ptr.x < 110) { this.scene.start('ModeSelect'); return; }
      this.touches.set(ptr.id, { x: ptr.x, y: ptr.y });

      if (this.touches.size >= 2) {
        const [a, b] = [...this.touches.values()];
        this.pinchDist = Math.hypot(b.x - a.x, b.y - a.y);
        this.pinchZoom = this.cameras.main.zoom;
        return;
      }
      this.isDragging  = false;
      this.dragStartX  = ptr.x;
      this.dragStartY  = ptr.y;
      this.dragScrollX = this.cameras.main.scrollX;
      this.dragScrollY = this.cameras.main.scrollY;
    });

    this.input.on('pointermove', (ptr: Phaser.Input.Pointer) => {
      if (this.touches.has(ptr.id)) this.touches.set(ptr.id, { x: ptr.x, y: ptr.y });

      if (this.touches.size >= 2) {
        const [a, b] = [...this.touches.values()];
        const dist = Math.hypot(b.x - a.x, b.y - a.y);
        if (this.pinchDist > 0) {
          this.cameras.main.setZoom(
            Math.min(Math.max(this.pinchZoom * dist / this.pinchDist, 0.1), 8),
          );
        }
        return;
      }

      if (!ptr.isDown) return;
      const dx = ptr.x - this.dragStartX;
      const dy = ptr.y - this.dragStartY;
      if (!this.isDragging && Math.abs(dx) + Math.abs(dy) > 5) {
        this.isDragging  = true;
      }
      if (this.isDragging) {
        const z = this.cameras.main.zoom;
        this.cameras.main.setScroll(
          this.dragScrollX - dx / z,
          this.dragScrollY - dy / z,
        );
        this.infoText.setText(
          `scroll:(${this.cameras.main.scrollX.toFixed(0)}, ${this.cameras.main.scrollY.toFixed(0)})  zoom:${z.toFixed(2)}`,
        );
      }
    });

    this.input.on('pointerup', (ptr: Phaser.Input.Pointer) => {
      const wasPinching = this.touches.size >= 2;
      this.touches.delete(ptr.id);
      if (wasPinching) {
        this.pinchDist  = 0;
        const rem = [...this.touches.values()][0];
        if (rem) {
          this.dragStartX  = rem.x;
          this.dragStartY  = rem.y;
          this.dragScrollX = this.cameras.main.scrollX;
          this.dragScrollY = this.cameras.main.scrollY;
        }
      }
      this.isDragging = false;
    });

    this.input.on('wheel', (ptr: Phaser.Input.Pointer) => {
      if (!ptr.deltaY) return;
      const z = this.cameras.main.zoom;
      this.cameras.main.setZoom(
        Math.min(Math.max(z * (ptr.deltaY > 0 ? 1 / 1.12 : 1.12), 0.1), 8),
      );
    });

    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') this.scene.start('ModeSelect'); };
    window.addEventListener('keydown', onEsc);
    this.events.once('shutdown', () => window.removeEventListener('keydown', onEsc));
  }
}
