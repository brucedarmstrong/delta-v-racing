import type { PlacedPiece } from './TrackLayout';
import type { StraightSize, CornerAngle } from './TrackGeometry';
import { WALL_VARIANTS } from './TrackGeometry';

export type TrackMarker = {
  kind: 'checkpoint' | 'finish';
  shape: 'gate' | 'circle'; // gate = full-width stripe; circle = small waypoint dot
  x: number;
  y: number;
  rotation: number; // degrees CW from north, same convention as PlacedPiece
};

type GmsPoint = {
  sprite: string;
  name: string;
  x: number;
  y: number;
  angle: number;
  xscale?: number;
  yscale?: number;
  variant?: number;
};

export type GmsTrack = {
  points: Record<string, GmsPoint>;
  info?: Record<string, unknown>;
};

/**
 * Convert a GameMaker Studio track JSON to PlacedPiece[].
 *
 * GMS angle convention: CCW positive, 0=east. Our rotation: CW positive.
 * Formula: our_rotation = (-gms_angle % 360 + 360) % 360
 *
 * GMS stores x/y at the arc center for corners and the piece center for
 * straights — the same origin convention we use — so coordinates transfer
 * directly. No flip is needed: all four corner quadrants are represented
 * purely via rotation in GMS.
 *
 * Two corner objects at the same (x, y) are NOT duplicates; they are
 * sequential 90° arcs that together form a 180° U-turn.
 */
export function convertGmsTrack(json: GmsTrack): PlacedPiece[] {
  const pieces: PlacedPiece[] = [];

  for (const pt of Object.values(json.points)) {
    if (pt.name !== 'obj_straight' && pt.name !== 'obj_corner') continue;

    const { x, y, angle, sprite } = pt;
    const rotation = ((-angle) % 360 + 360) % 360;
    const walls = WALL_VARIANTS[Math.round(pt.variant ?? 0)] ?? 'both';

    if (sprite.startsWith('tile_big_corner_')) {
      const cornerAngle = parseInt(sprite.slice('tile_big_corner_'.length), 10) as CornerAngle;
      pieces.push({ type: 'big_corner', angle: cornerAngle, walls, flip: false, x, y, rotation });
    } else if (sprite.startsWith('tile_corner_')) {
      const cornerAngle = parseInt(sprite.slice('tile_corner_'.length), 10) as CornerAngle;
      pieces.push({ type: 'corner', angle: cornerAngle, walls, flip: false, x, y, rotation });
    } else if (sprite.startsWith('tile_straight_')) {
      const size = parseInt(sprite.slice('tile_straight_'.length), 10) as StraightSize;
      pieces.push({ type: 'straight', size, walls, x, y, rotation });
    }
  }

  return pieces;
}

export function convertGmsMarkers(json: GmsTrack): TrackMarker[] {
  const markers: TrackMarker[] = [];
  for (const pt of Object.values(json.points)) {
    if (pt.name !== 'obj_checkpoint' && pt.name !== 'obj_finish') continue;
    const rotation = ((-pt.angle) % 360 + 360) % 360;
    if (pt.name === 'obj_checkpoint') {
      const shape: 'gate' | 'circle' = pt.sprite === 'tile_checkpoint_circle' ? 'circle' : 'gate';
      markers.push({ kind: 'checkpoint', shape, x: pt.x, y: pt.y, rotation });
    } else {
      markers.push({ kind: 'finish', shape: 'gate', x: pt.x, y: pt.y, rotation });
    }
  }
  return markers;
}
