import type { TrackDef } from '../track/TrackLayout';

// Simple rectangular oval for testing the track renderer.
// Starting position chosen so the oval is roughly centred on a 1024×768 canvas.
// Two straight_100 pieces per side; four tight 90° right-hand corners.
//
// Verified closed: cursor returns to (400, 150) heading east after all 12 pieces.
export const OVAL: TrackDef = {
  startX: 400,
  startY: 150,
  startHeading: 90, // east
  pieces: [
    { type: 'straight', size: 100, walls: 'both' },
    { type: 'straight', size: 100, walls: 'both' },
    { type: 'corner',   angle: 90, walls: 'both' }, // east → south
    { type: 'straight', size: 100, walls: 'both' },
    { type: 'straight', size: 100, walls: 'both' },
    { type: 'corner',   angle: 90, walls: 'both' }, // south → west
    { type: 'straight', size: 100, walls: 'both' },
    { type: 'straight', size: 100, walls: 'both' },
    { type: 'corner',   angle: 90, walls: 'both' }, // west → north
    { type: 'straight', size: 100, walls: 'both' },
    { type: 'straight', size: 100, walls: 'both' },
    { type: 'corner',   angle: 90, walls: 'both' }, // north → east
  ],
};
