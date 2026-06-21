export type TrackSkin = {
  wallColor: string; // CSS colour — primary neon line
  glowColor: string; // CSS colour — outer bloom
  wallWidth: number; // core stroke width in pixels
  glowBlur: number;  // Canvas shadowBlur radius for outer glow
};

function hsl(h: number, s: number, l: number): string {
  return `hsl(${h},${s}%,${l}%)`;
}

export function fromHue(hue: number, wallWidth = 2, glowBlur = 14): TrackSkin {
  return {
    wallColor: hsl(hue, 100, 60),
    glowColor: hsl(hue, 100, 12),
    wallWidth,
    glowBlur,
  };
}

export const NEON_GREEN: TrackSkin = fromHue(120);
