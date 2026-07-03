import { Scene, GameObjects } from 'phaser';

const BG      = 0x0a0a16;
const SURFACE = 0x12122a;
const BORDER  = 0x3a3a6a;

export class AboutScreen extends Scene {
  private headerGfx!:  GameObjects.Graphics;
  private headerText!: GameObjects.Text;
  private backText!:   GameObjects.Text;
  private bodyEl:      HTMLElement | null = null;
  private backHit = { x: 0, y: 0, w: 100, h: 60 };

  constructor() { super('AboutScreen'); }

  create() {
    const cam = this.cameras.main;
    cam.setBackgroundColor(BG);
    cam.setScroll(0, 0);
    cam.setZoom(1);

    this.headerGfx  = this.add.graphics().setScrollFactor(0).setDepth(10);
    this.headerText = this.add.text(0, 0, 'ABOUT', {
      fontFamily: 'Arial Black', fontSize: '18px',
      color: '#e8e8ff', stroke: '#000000', strokeThickness: 3,
    }).setScrollFactor(0).setOrigin(0.5).setDepth(11);
    this.backText = this.add.text(0, 0, '‹ Back', {
      fontFamily: 'Arial Black', fontSize: '16px', color: '#8888ff',
    }).setScrollFactor(0).setOrigin(0, 0.5).setDepth(11);

    this.buildBody();
    this.layout();
    this.scale.on('resize', () => this.layout());

    this.input.on('pointerdown', (ptr: Phaser.Input.Pointer) => {
      const h = this.backHit;
      if (ptr.x >= h.x && ptr.x <= h.x + h.w &&
          ptr.y >= h.y && ptr.y <= h.y + h.h) {
        this.bodyEl?.remove();
        this.bodyEl = null;
        this.scene.start('ModeSelect');
      }
    });

    this.events.once('shutdown', () => { this.bodyEl?.remove(); this.bodyEl = null; });
  }

  private buildBody(): void {
    const el = document.createElement('div');
    el.style.cssText = [
      'position:fixed', 'top:60px', 'left:0', 'right:0', 'bottom:0',
      'overflow-y:auto', 'padding:20px 20px 40px',
      'box-sizing:border-box', 'color:#ccccee',
      'font:15px Arial,sans-serif', 'line-height:1.6',
    ].join(';');

    const sections: Array<{ heading: string; body: string }> = [
      {
        heading: 'What is delta-v racing?',
        body: 'delta-v racing is a turn-based vector racing game played on Reddit. '
            + 'Each turn you pick a destination for your car — the catch is that your '
            + 'velocity carries over, so you must plan ahead to navigate corners without '
            + 'crashing. Fewer turns to the finish line means a better score.',
      },
      {
        heading: 'How to play',
        body: 'Tap a dot on the grid to move there. Green dots are valid moves; '
            + 'red dots would crash. Your current speed is shown as a vector arrow. '
            + 'Race ghost cars from other players — beat their turn count to climb '
            + 'the leaderboard.',
      },
      {
        heading: 'Controls',
        body: '• Tap / click — select your next move\n'
            + '• Pinch — zoom in or out\n'
            + '• Drag (one finger) — pan the camera\n'
            + '• Mouse wheel — zoom (desktop)',
      },
      {
        heading: 'Track editor',
        body: 'Build your own track using the CREATE button. Place straights, curves, '
            + 'and chicanes, then set a finish line and optional checkpoints. '
            + 'Use AI Verify to confirm the track is completable, then upload it '
            + 'to the Community list for everyone to race.',
      },
      {
        heading: 'Daily tracks',
        body: 'Each day a featured track is highlighted in the Daily tab. '
            + 'Race it, post your best time, and see how you rank against the community.',
      },
      {
        heading: 'Credits',
        body: 'Built for the Reddit Hackathon 2026.\n'
            + 'Game engine: Phaser 4  ·  Platform: Devvit\n'
            + 'Design & development: brucedarmstrong',
      },
    ];

    for (const s of sections) {
      const h = document.createElement('div');
      h.textContent = s.heading;
      h.style.cssText = 'font:bold 15px "Arial Black",Arial,sans-serif;color:#aaccff;margin:18px 0 6px;';
      el.appendChild(h);

      const p = document.createElement('div');
      p.style.cssText = 'color:#aaaacc;white-space:pre-line;';
      p.textContent = s.body;
      el.appendChild(p);
    }

    document.body.appendChild(el);
    this.bodyEl = el;
  }

  private layout(): void {
    const W = this.scale.width;
    const headerH = 60;
    const pad = 14;

    this.headerGfx.clear();
    this.headerGfx.fillStyle(SURFACE, 1);
    this.headerGfx.fillRect(0, 0, W, headerH);
    this.headerGfx.lineStyle(1, BORDER, 1);
    this.headerGfx.lineBetween(0, headerH, W, headerH);

    this.headerText.setPosition(W / 2, headerH / 2);
    this.backText.setPosition(pad + 4, headerH / 2);
    this.backHit = { x: 0, y: 0, w: 120, h: headerH };
  }
}
