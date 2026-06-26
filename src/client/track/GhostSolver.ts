import { intersectsBarrier } from './TrackCollision';
import { CORRIDOR } from './TrackGeometry';
import type { PlacedPiece } from './TrackLayout';
import type { TrackMarker } from './convertGmsTrack';
import type { TrackEntry } from '../tracks/trackRegistry';
import type { GhostData, GhostMove } from './GhostData';

export type SkillLevel = 'perfect' | 'skilled' | 'average' | 'rookie';

// Maximum Chebyshev speed per skill level.
const SPEED_CAP: Record<SkillLevel, number> = {
  perfect: 8,
  skilled: 4,
  average: 3,
  rookie:  2,
};

// Greedy lookahead depth. 0 = use BFS instead.
const LOOKAHEAD: Record<SkillLevel, number> = {
  perfect: 0,
  skilled: 0,
  average: 2,
  rookie:  1,
};

const MAX_GREEDY_TURNS = 600;
const DEFAULT_GRID_PX  = 24;

// ── Marker crossing ───────────────────────────────────────────────────────────

// Mirrors Game.ts crossesMarker exactly.
function markerContains(m: TrackMarker, wx: number, wy: number, gridPx: number): boolean {
  const dx = wx - m.x, dy = wy - m.y;
  if (m.shape === 'circle') return Math.hypot(dx, dy) <= gridPx + 10;
  const rad = m.rotation * (Math.PI / 180);
  const lx  =  dx * Math.cos(rad) + dy * Math.sin(rad);
  const ly  = -dx * Math.sin(rad) + dy * Math.cos(rad);
  return Math.abs(lx) <= CORRIDOR / 2 && Math.abs(ly) <= gridPx;
}

// Samples 8 points along the grid-space segment and tests each in world space.
function moveCrossesMarker(
  fromGX: number, fromGY: number,
  toGX:   number, toGY:   number,
  m: TrackMarker, gridPx: number,
): boolean {
  for (let i = 0; i <= 8; i++) {
    const t = i / 8;
    if (markerContains(
      m,
      (fromGX + (toGX - fromGX) * t) * gridPx,
      (fromGY + (toGY - fromGY) * t) * gridPx,
      gridPx,
    )) return true;
  }
  return false;
}

// ── BFS solver (perfect / skilled) ───────────────────────────────────────────

function bfsSolve(
  startGX: number, startGY: number,
  pieces: PlacedPiece[],
  checkpoints: TrackMarker[],
  finish: TrackMarker,
  gridPx: number,
  maxSpeed: number,
): GhostMove[] | null {
  const allCpMask = (1 << checkpoints.length) - 1;

  // Compact string key — velocities are offset by +8 so all values are non-negative.
  const key = (gx: number, gy: number, vx: number, vy: number, cp: number) =>
    `${gx},${gy},${vx + 8},${vy + 8},${cp}`;

  type State = { gx: number; gy: number; vx: number; vy: number; cp: number };
  type Parent = { parentKey: string; move: GhostMove } | null;

  const initialKey = key(startGX, startGY, 0, 0, 0);
  const parent     = new Map<string, Parent>();
  parent.set(initialKey, null);

  const queue: State[] = [{ gx: startGX, gy: startGY, vx: 0, vy: 0, cp: 0 }];
  let head = 0;

  while (head < queue.length) {
    const { gx, gy, vx, vy, cp } = queue[head++];
    const curKey = key(gx, gy, vx, vy, cp);

    for (let dvx = -1; dvx <= 1; dvx++) {
      for (let dvy = -1; dvy <= 1; dvy++) {
        const nvx = vx + dvx, nvy = vy + dvy;
        if (Math.max(Math.abs(nvx), Math.abs(nvy)) > maxSpeed) continue;

        const ngx = gx + nvx, ngy = gy + nvy;
        if (Math.abs(ngx) > 512 || Math.abs(ngy) > 512) continue;
        if (intersectsBarrier(gx * gridPx, gy * gridPx, ngx * gridPx, ngy * gridPx, pieces)) continue;

        // Check checkpoint crossings along this move.
        let newCp = cp;
        for (let i = 0; i < checkpoints.length; i++) {
          if (!(newCp & (1 << i)) && moveCrossesMarker(gx, gy, ngx, ngy, checkpoints[i], gridPx)) {
            newCp |= (1 << i);
          }
        }

        const move: GhostMove = { gx: ngx, gy: ngy, crash: false };

        // Goal: all checkpoints touched AND this move crosses the finish.
        if (newCp === allCpMask && moveCrossesMarker(gx, gy, ngx, ngy, finish, gridPx)) {
          // Reconstruct path from parent chain.
          const moves: GhostMove[] = [move];
          let k = curKey;
          for (;;) {
            const p = parent.get(k);
            if (!p) break;
            moves.unshift(p.move);
            k = p.parentKey;
          }
          return moves;
        }

        const nk = key(ngx, ngy, nvx, nvy, newCp);
        if (!parent.has(nk)) {
          parent.set(nk, { parentKey: curKey, move });
          queue.push({ gx: ngx, gy: ngy, vx: nvx, vy: nvy, cp: newCp });
        }
      }
    }
  }

  return null;
}

// ── Greedy solver (average / rookie) ─────────────────────────────────────────

type Opt = { nvx: number; nvy: number; ngx: number; ngy: number };

function dist2ToMarker(gx: number, gy: number, m: TrackMarker, gridPx: number): number {
  const tx = m.x / gridPx, ty = m.y / gridPx;
  return (gx - tx) ** 2 + (gy - ty) ** 2;
}

// Best achievable distance in one more step from (ngx, ngy, nvx, nvy).
function lookahead2Score(
  ngx: number, ngy: number, nvx: number, nvy: number,
  target: TrackMarker, pieces: PlacedPiece[], gridPx: number, maxSpeed: number,
): number {
  let best = Infinity;
  for (let dvx = -1; dvx <= 1; dvx++) {
    for (let dvy = -1; dvy <= 1; dvy++) {
      const nvx2 = nvx + dvx, nvy2 = nvy + dvy;
      if (Math.max(Math.abs(nvx2), Math.abs(nvy2)) > maxSpeed) continue;
      const ngx2 = ngx + nvx2, ngy2 = ngy + nvy2;
      if (intersectsBarrier(ngx * gridPx, ngy * gridPx, ngx2 * gridPx, ngy2 * gridPx, pieces)) continue;
      best = Math.min(best, dist2ToMarker(ngx2, ngy2, target, gridPx));
    }
  }
  return best === Infinity ? dist2ToMarker(ngx, ngy, target, gridPx) : best;
}

function greedySolve(
  startGX: number, startGY: number,
  pieces: PlacedPiece[],
  checkpoints: TrackMarker[],
  finish: TrackMarker,
  gridPx: number,
  maxSpeed: number,
  lookahead: number,
): GhostMove[] {
  let gx = startGX, gy = startGY, vx = 0, vy = 0;
  const cpTouched = new Array<boolean>(checkpoints.length).fill(false);
  const moves: GhostMove[] = [];

  // Nearest-neighbour: pick the closest untouched checkpoint each turn,
  // since checkpoint visit order is free and part of the player's strategy.
  const getTarget = (): TrackMarker => {
    let bestM: TrackMarker | undefined;
    let bestD = Infinity;
    for (let i = 0; i < checkpoints.length; i++) {
      if (cpTouched[i]) continue;
      const d = dist2ToMarker(gx, gy, checkpoints[i], gridPx);
      if (d < bestD) { bestD = d; bestM = checkpoints[i]; }
    }
    return bestM ?? finish;
  };

  for (let turn = 0; turn < MAX_GREEDY_TURNS; turn++) {
    const target = getTarget();
    const valid:    Opt[] = [];
    const crashOpts: Opt[] = [];

    for (let dvx = -1; dvx <= 1; dvx++) {
      for (let dvy = -1; dvy <= 1; dvy++) {
        const nvx2 = vx + dvx, nvy2 = vy + dvy;
        if (Math.max(Math.abs(nvx2), Math.abs(nvy2)) > maxSpeed) continue;
        const ngx2 = gx + nvx2, ngy2 = gy + nvy2;
        if (intersectsBarrier(gx * gridPx, gy * gridPx, ngx2 * gridPx, ngy2 * gridPx, pieces)) {
          crashOpts.push({ nvx: nvx2, nvy: nvy2, ngx: ngx2, ngy: ngy2 });
        } else {
          valid.push({ nvx: nvx2, nvy: nvy2, ngx: ngx2, ngy: ngy2 });
        }
      }
    }

    let chosen: Opt;
    let isCrash = false;

    if (valid.length === 0) {
      if (crashOpts.length === 0) break;
      // Forced crash — pick the option closest to the target.
      crashOpts.sort((a, b) =>
        dist2ToMarker(a.ngx, a.ngy, target, gridPx) -
        dist2ToMarker(b.ngx, b.ngy, target, gridPx),
      );
      chosen  = crashOpts[0];
      isCrash = true;
    } else {
      const scorer = lookahead >= 2
        ? (o: Opt) => lookahead2Score(o.ngx, o.ngy, o.nvx, o.nvy, target, pieces, gridPx, maxSpeed)
        : (o: Opt) => dist2ToMarker(o.ngx, o.ngy, target, gridPx);
      valid.sort((a, b) => scorer(a) - scorer(b));
      chosen = valid[0];
    }

    moves.push({ gx: chosen.ngx, gy: chosen.ngy, crash: isCrash });

    if (isCrash) {
      vx = 0; vy = 0;
      // gx, gy unchanged — car returns to safe position.
    } else {
      const fromGX = gx, fromGY = gy;
      gx = chosen.ngx; gy = chosen.ngy;
      vx = chosen.nvx; vy = chosen.nvy;

      for (let i = 0; i < checkpoints.length; i++) {
        if (!cpTouched[i] && moveCrossesMarker(fromGX, fromGY, gx, gy, checkpoints[i], gridPx)) {
          cpTouched[i] = true;
        }
      }

      if (cpTouched.every(Boolean) && moveCrossesMarker(fromGX, fromGY, gx, gy, finish, gridPx)) {
        break;
      }
    }
  }

  return moves;
}

// ── Public API ────────────────────────────────────────────────────────────────

export function solveTrack(
  entry:   TrackEntry,
  skill:   SkillLevel,
  gridPx = DEFAULT_GRID_PX,
): GhostData | null {
  const checkpoints = entry.markers.filter(m => m.kind === 'checkpoint');
  const finish      = entry.markers.find(m => m.kind === 'finish');
  if (!finish) {
    console.warn('[solver] track has no finish marker:', entry.id);
    return null;
  }

  const startGX  = Math.round(entry.startX / gridPx);
  const startGY  = Math.round(entry.startY / gridPx);
  const maxSpeed = SPEED_CAP[skill];
  const lookahead = LOOKAHEAD[skill];

  console.log(`[solver] solving ${entry.id}/${skill} startGX=${startGX} startGY=${startGY} maxSpeed=${maxSpeed}`);
  const t0 = performance.now();

  const moves = lookahead === 0
    ? bfsSolve(startGX, startGY, entry.pieces, checkpoints, finish, gridPx, maxSpeed)
    : greedySolve(startGX, startGY, entry.pieces, checkpoints, finish, gridPx, maxSpeed, lookahead);

  const ms = (performance.now() - t0).toFixed(0);

  if (!moves || moves.length === 0) {
    console.warn(`[solver] no solution for ${entry.id}/${skill} (${ms}ms)`);
    return null;
  }

  const crashCount = moves.filter(m => m.crash).length;
  const score      = moves.length + crashCount + 0.5;

  console.log(`[solver] ${entry.id}/${skill}: ${moves.length} turns, ${crashCount} crashes, score=${score.toFixed(2)} (${ms}ms)`);

  const skillDisplay: Record<SkillLevel, string> = {
    perfect: 'Perfect', skilled: 'Skilled', average: 'Average', rookie: 'Rookie',
  };

  return {
    v:          1,
    trackId:    entry.id,
    score,
    startGX,
    startGY,
    moves,
    author:     `[bot] ${skillDisplay[skill]}`,
    recordedAt: Date.now(),
  };
}
