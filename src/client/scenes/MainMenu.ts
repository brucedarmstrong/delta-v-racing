import { Scene, GameObjects } from 'phaser';

declare const __BUILD__: string;
import { trackBounds, type PlacedPiece } from '../track/TrackLayout';
import { buildTrackTexture } from '../track/TrackCanvasRenderer';
import { NEON_GREEN } from '../track/TrackSkin';
import { OVAL_SMALL } from '../tracks/oval_small';

export class MainMenu extends Scene {
  private placed: PlacedPiece[] = [];
  private title: GameObjects.Text | null = null;

  constructor() {
    super('MainMenu');
  }

  init(): void {
    this.placed = [];
    this.title = null;
  }

  create() {
    this.cameras.main.setBackgroundColor(0x0a0a16);

    this.placed = OVAL_SMALL;
    buildTrackTexture(this, this.placed, NEON_GREEN);

    this.title = this.add
      .text(0, 0, `delta-v racing\ntap to play\n${__BUILD__}`, {
        fontFamily: 'Arial Black',
        fontSize: '28px',
        color: '#ccccff',
        stroke: '#000000',
        strokeThickness: 6,
        align: 'center',
      })
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setDepth(20);

    this.fitCamera();
    this.scale.on('resize', () => this.fitCamera());

    // Scene-level pointer listener — fires for any tap/click anywhere on the canvas.
    // On each pointer event, update the title so we can see if input is reaching Phaser.
    this.input.on('pointerdown', () => {
      console.log('[MainMenu] pointerdown received');
      if (this.title) this.title.setText('starting...');
      this.time.delayedCall(50, () => {
        console.log('[MainMenu] calling scene.start(Game)');
        this.scene.start('Game');
      });
    });

    console.log('[MainMenu] create() done, waiting for pointer');
  }

  private fitCamera(): void {
    const { width, height } = this.scale;
    this.cameras.main.setSize(width, height);

    const b = trackBounds(this.placed);
    const margin = 30;
    const zoom = Math.min(
      width  / (b.width  + margin * 2),
      height / (b.height + margin * 2),
    );
    this.cameras.main.setZoom(zoom);
    this.cameras.main.centerOn(b.cx, b.cy);

    if (this.title) {
      this.title.setPosition(width / 2, height * 0.90);
    }
  }
}
