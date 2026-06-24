export type GhostMove = {
  gx: number;     // destination grid X
  gy: number;     // destination grid Y
  crash: boolean; // true = barrier hit; car returned to previous position after this
};

export type GhostData = {
  v: 1;           // format version — increment when the shape changes
  trackId: string;
  score: number;  // turns + crash_penalty + finesse (see Game.ts triggerWin)
  startGX: number;
  startGY: number;
  moves: GhostMove[];
};

export function serializeGhost(g: GhostData): string {
  return JSON.stringify(g);
}

export function deserializeGhost(json: string): GhostData {
  const d = JSON.parse(json) as GhostData;
  if (d.v !== 1) throw new Error(`Unknown ghost version: ${d.v}`);
  return d;
}
