import * as Phaser from 'phaser';
import type { PlacedPiece, CornerDef } from './TrackLayout';
import { cornerKey, straightKey, type PieceInfo } from './PieceTextureFactory';

export function renderTrack(
  scene: Phaser.Scene,
  pieces: PlacedPiece[],
  infos: Record<string, PieceInfo>,
): void {
  for (const p of pieces) {
    const key = p.type === 'straight'
      ? straightKey(p.size, p.walls)
      : cornerKey(p.type, (p as CornerDef).angle, p.walls);

    const info = infos[key];
    if (!info) continue;

    const img = scene.add.image(p.x, p.y, key);
    img.setOrigin(info.originX, info.originY);
    if (p.type !== 'straight' && (p as CornerDef).flip) img.setFlipX(true);
    img.setAngle(p.rotation);
  }
}
