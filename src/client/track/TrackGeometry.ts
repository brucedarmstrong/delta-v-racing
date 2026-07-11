/**
 * Track piece geometry constants, all in pixels, derived from calcAnchorPoints.gml.
 *
 * Half-track = 53 px (from straight bbox: walls at x=7 and x=112, origin x=60).
 * Corner centreline r = (sprite_width - 10) * center, where center=0.5 (tight) or 0.75 (big).
 * Wall radii = centreline r ± HALF_TRACK.
 */

export const HALF_TRACK = 53; // wall centre to track centreline
export const CORRIDOR = HALF_TRACK * 2; // 106 px, outer wall centre to inner wall centre

export const TIGHT = {
  outerR: 113, // HALF_TRACK + centrelineR  (60 + 53)
  innerR: 7, //  centrelineR - HALF_TRACK  (60 - 53)
  clR: 60,
} as const;

export const BIG = {
  outerR: 233, // 180 + 53
  innerR: 127, // 180 - 53
  clR: 180,
} as const;

// Same clR ratio as TIGHT->BIG (×3) applied again: BIG->HUGE.
export const HUGE = {
  outerR: 593, // 540 + 53
  innerR: 487, // 540 - 53
  clR: 540,
} as const;

/**
 * Usable corridor length (px) for each straight variant.
 * Derived from sprite height h: corridorLen = h - 20 (10 px margin each end).
 * Sprite heights: 50, 80, 110, 140 → 30, 60, 90, 120 px.
 */
export const STRAIGHT_LEN = { 25: 30, 50: 60, 75: 90, 100: 120 } as const;

export type CornerFamily = 'corner' | 'big_corner' | 'huge_corner';
export type CornerAngle = 15 | 30 | 45 | 60 | 75 | 90;
export type StraightSize = 25 | 50 | 75 | 100;
export type WallVariant = 'both' | 'outer' | 'inner';

export const CORNER_ANGLES: CornerAngle[] = [15, 30, 45, 60, 75, 90];
export const STRAIGHT_SIZES: StraightSize[] = [25, 50, 75, 100];
export const WALL_VARIANTS: WallVariant[] = ['both', 'outer', 'inner'];
export const CORNER_FAMILIES: CornerFamily[] = ['corner', 'big_corner', 'huge_corner'];

// Single source of truth for {outerR, innerR, clR} by corner family — replaces
// the `type === 'corner' ? TIGHT : BIG` ternary that used to be duplicated
// across every consumer (collision, rendering, connectors, editor UI).
export const CORNER_RADII: Record<CornerFamily, { outerR: number; innerR: number; clR: number }> = {
  corner: TIGHT, big_corner: BIG, huge_corner: HUGE,
};
