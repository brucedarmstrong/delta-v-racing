import { Scene, GameObjects } from 'phaser';

const BG      = 0x0a0a16;
const SURFACE = 0x12122a;
const BORDER  = 0x3a3a6a;

export class TrackEditor extends Scene {
  private headerGfx!:  GameObjects.Graphics;
  private headerText!: GameObjects.Text;
  private backText!:   GameObjects.Text;
  private bodyText!:   GameObjects.Text;
  private backHit = { x: 0, y: 0, w: 100, h: 60 };

  constructor() { super('TrackEditor'); }

  create() {
    const cam = this.cameras.main;
    cam.setBackgroundColor(BG);
    cam.setScroll(0, 0);
    cam.setZoom(1);

    this.headerGfx  = this.add.graphics().setScrollFactor(0).setDepth(10);
    this.headerText = this.add.text(0, 0, 'TRACK EDITOR', {
      fontFamily: 'Arial Black', fontSize: '18px',
      color: '#e8e8ff', stroke: '#000000', strokeThickness: 3,
    }).setScrollFactor(0).setOrigin(0.5).setDepth(11);
    this.backText = this.add.text(0, 0, '‹ Back', {
      fontFamily: 'Arial Black', fontSize: '16px', color: '#8888ff',
    }).setScrollFactor(0).setOrigin(0, 0.5).setDepth(11);

    this.bodyText = this.add.text(0, 0, 'Coming Soon', {
      fontFamily: 'Arial', fontSize: '20px', color: '#555588',
    }).setScrollFactor(0).setOrigin(0.5).setDepth(11);

    this.layout();
    this.scale.on('resize', () => this.layout());

    this.input.on('pointerdown', (ptr: Phaser.Input.Pointer) => {
      const h = this.backHit;
      if (ptr.x >= h.x && ptr.x <= h.x + h.w &&
          ptr.y >= h.y && ptr.y <= h.y + h.h) {
        this.scene.start('ModeSelect');
      }
    });
  }

  private layout(): void {
    const W = this.scale.width;
    const H = this.scale.height;
    const headerH = 60;
    const pad = 14;

    this.headerGfx.clear();
    this.headerGfx.fillStyle(SURFACE, 1);
    this.headerGfx.fillRect(0, 0, W, headerH);
    this.headerGfx.lineStyle(1, BORDER, 1);
    this.headerGfx.lineBetween(0, headerH, W, headerH);

    this.headerText.setPosition(W / 2, headerH / 2);
    this.backText.setPosition(pad + 4, headerH / 2);
    this.backHit = { x: 0, y: 0, w: 100, h: headerH };

    this.bodyText.setPosition(W / 2, headerH + (H - headerH) / 2);
  }
}
