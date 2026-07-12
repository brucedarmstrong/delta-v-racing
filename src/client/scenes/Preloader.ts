import { Scene } from 'phaser';
import { generateTrackTextures } from '../track/PieceTextureFactory';
import { NEON_GREEN } from '../track/TrackSkin';

export class Preloader extends Scene {
  constructor() {
    super('Preloader');
  }

  create() {
    this.cameras.main.setBackgroundColor(0x0a0a16);
    generateTrackTextures(this, NEON_GREEN);

    // Phaser Text objects rasterize to a canvas the instant add.text() runs —
    // unlike DOM text, they don't wait for a web font to finish loading and
    // never re-render once one arrives later, so a scene created before the
    // custom fonts are ready gets permanently baked in with a fallback font
    // (this is what was happening: ModeSelect's title/buttons looked
    // different from the DOM-rendered screens because they're Phaser Text,
    // not DOM). Block past this scene until the fonts are ready, with a
    // timeout fallback so a slow/failed font fetch can't hang the app.
    const fontsReady = Promise.all([
      document.fonts.load('900 40px "Arial Black"'),
      document.fonts.load('400 16px "Arial"'),
      document.fonts.load('600 16px "Arial"'),
      document.fonts.load('700 16px "Arial"'),
    ]).then(() => undefined).catch(() => undefined);
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, 1500));

    void Promise.race([fontsReady, timeout]).then(() => {
      this.scene.start('ModeSelect');
    });
  }
}
