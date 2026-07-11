import * as Phaser from 'phaser';
import {
  CORNER_RADII, HALF_TRACK, STRAIGHT_LEN,
  CornerFamily, CornerAngle, StraightSize, WallVariant,
  CORNER_ANGLES, STRAIGHT_SIZES, WALL_VARIANTS, CORNER_FAMILIES,
} from './TrackGeometry';
import type { TrackSkin } from './TrackSkin';

// Extra pixels of canvas padding around content so glow doesn't clip at edges.
const PAD = 24;

export type PieceInfo = {
  key: string;
  originX: number; // Phaser setOrigin x (0–1)
  originY: number; // Phaser setOrigin y (0–1)
};

// ─── Texture key helpers ──────────────────────────────────────────────────────

export function cornerKey(family: CornerFamily, angle: CornerAngle, walls: WallVariant): string {
  return `track_${family}_${angle}_${walls}`;
}

export function straightKey(size: StraightSize, walls: WallVariant): string {
  return `track_straight_${size}_${walls}`;
}

// ─── Neon stroke helper ───────────────────────────────────────────────────────

function strokeNeon(
  ctx: CanvasRenderingContext2D,
  path: () => void,
  skin: TrackSkin,
): void {
  const wall = skin.wallColor;
  const glow = skin.glowColor;

  // Pass 1 — outer bloom
  ctx.save();
  ctx.shadowColor = glow;
  ctx.shadowBlur = skin.glowBlur;
  ctx.strokeStyle = glow;
  ctx.lineWidth = skin.wallWidth * 4;
  ctx.lineCap = 'round';
  path();
  ctx.stroke();
  ctx.restore();

  // Pass 2 — inner neon colour
  ctx.save();
  ctx.shadowColor = wall;
  ctx.shadowBlur = skin.glowBlur * 0.5;
  ctx.strokeStyle = wall;
  ctx.lineWidth = skin.wallWidth;
  ctx.lineCap = 'round';
  path();
  ctx.stroke();
  ctx.restore();

  // Pass 3 — bright white core
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.70)';
  ctx.lineWidth = Math.max(1, skin.wallWidth - 1);
  ctx.lineCap = 'round';
  path();
  ctx.stroke();
  ctx.restore();
}

// ─── Corner texture ───────────────────────────────────────────────────────────

/**
 * Generate a canvas texture for one corner piece variant.
 *
 * Arc geometry (local coords, arc centre at origin):
 *   - The arc sweeps CW on screen from angle π (pointing LEFT) by `angleDeg` degrees.
 *   - Outer arc radius = outerR  (far from arc centre, sweeps upper-left region).
 *   - Inner arc radius = innerR  (close to arc centre, tiny arc near the apex).
 *   - Content occupies x ∈ [−outerR, 0], y ∈ [−outerR·sin θ, 0].
 *
 * The returned PieceInfo.originX/Y place the Phaser sprite so its Phaser origin
 * falls on the arc centre, matching the GameMaker sprite origin convention.
 */
function makeCornerTexture(
  scene: Phaser.Scene,
  family: CornerFamily,
  angleDeg: CornerAngle,
  walls: WallVariant,
  skin: TrackSkin,
): PieceInfo {
  const { outerR, innerR } = CORNER_RADII[family];
  const θ = angleDeg * (Math.PI / 180);

  // Texture dimensions: content + PAD on all sides.
  const contentW = outerR;
  const contentH = Math.ceil(outerR * Math.sin(θ));
  const texW = contentW + PAD * 2;
  const texH = contentH + PAD * 2;

  // Arc centre offset within the texture canvas.
  const ox = contentW + PAD; // right of content + left padding
  const oy = contentH + PAD; // bottom of content + top padding

  const key = cornerKey(family, angleDeg, walls);
  const ct = scene.textures.createCanvas(key, texW, texH)!;
  const ctx = ct.getContext();
  ctx.clearRect(0, 0, texW, texH);

  // Angles: CW from LEFT (π) by θ radians.
  const start = Math.PI;
  const end = Math.PI + θ;

  if (walls === 'both' || walls === 'outer') {
    strokeNeon(ctx, () => {
      ctx.beginPath();
      ctx.arc(ox, oy, outerR, start, end, false); // false = CW on screen
    }, skin);
  }
  if (walls === 'both' || walls === 'inner') {
    strokeNeon(ctx, () => {
      ctx.beginPath();
      ctx.arc(ox, oy, innerR, start, end, false);
    }, skin);
  }

  ct.refresh();

  return { key, originX: ox / texW, originY: oy / texH };
}

// ─── Straight texture ─────────────────────────────────────────────────────────

/**
 * Generate a canvas texture for one straight piece variant.
 *
 * The piece runs vertically (along Y) in local space.
 * 'outer' = left wall  (x = −HALF_TRACK from centre).
 * 'inner' = right wall (x = +HALF_TRACK from centre).
 * Origin is the geometric centre of the piece (setOrigin 0.5, 0.5).
 */
function makeStraightTexture(
  scene: Phaser.Scene,
  size: StraightSize,
  walls: WallVariant,
  skin: TrackSkin,
): PieceInfo {
  const len = STRAIGHT_LEN[size];
  const texW = HALF_TRACK * 2 + PAD * 2;
  const texH = len + PAD * 2;

  const cx = texW / 2; // horizontal centre
  const top = PAD;
  const bot = PAD + len;
  const leftX = cx - HALF_TRACK;
  const rightX = cx + HALF_TRACK;

  const key = straightKey(size, walls);
  const ct = scene.textures.createCanvas(key, texW, texH)!;
  const ctx = ct.getContext();
  ctx.clearRect(0, 0, texW, texH);

  if (walls === 'both' || walls === 'outer') {
    strokeNeon(ctx, () => {
      ctx.beginPath();
      ctx.moveTo(leftX, top);
      ctx.lineTo(leftX, bot);
    }, skin);
  }
  if (walls === 'both' || walls === 'inner') {
    strokeNeon(ctx, () => {
      ctx.beginPath();
      ctx.moveTo(rightX, top);
      ctx.lineTo(rightX, bot);
    }, skin);
  }

  ct.refresh();

  return { key, originX: 0.5, originY: 0.5 };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Generate every track piece texture and register it with Phaser's texture manager.
 * Call this in Preloader.create() before starting any scene that renders track pieces.
 *
 * Produces 66 textures:
 *   (3 corner families × 6 angles + 4 straights) × 3 wall variants
 *   = (18 + 4) × 3 = 66 textures
 *
 * @returns Record mapping each texture key to its PieceInfo (key + Phaser origin).
 */
export function generateTrackTextures(
  scene: Phaser.Scene,
  skin: TrackSkin,
): Record<string, PieceInfo> {
  const out: Record<string, PieceInfo> = {};

  for (const walls of WALL_VARIANTS) {
    for (const size of STRAIGHT_SIZES) {
      const info = makeStraightTexture(scene, size, walls, skin);
      out[info.key] = info;
    }
    for (const angle of CORNER_ANGLES) {
      for (const family of CORNER_FAMILIES) {
        const info = makeCornerTexture(scene, family, angle, walls, skin);
        out[info.key] = info;
      }
    }
  }

  return out;
}
