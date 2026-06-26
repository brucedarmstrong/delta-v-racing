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
    this.scene.start('ModeSelect');
  }
}
