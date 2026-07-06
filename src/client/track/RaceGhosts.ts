import { deserializeGhost, type GhostData } from './GhostData';
import { fetchOrGenerateAiGhost } from './AiGhost';
import { moveCrossesMarker } from './GhostSolver';
import type { SkillLevel } from './GhostSolver';
import type { TrackEntry } from '../tracks/trackRegistry';

// BFS-based skills (skilled/perfect) are too slow to run in the browser on
// complex tracks — they are generated at upload time via generateAndUploadAiGhosts.
const AI_FILL_SKILLS: SkillLevel[] = ['average', 'rookie'];

// Returns true only if the ghost's move sequence actually crosses the finish line
// with all checkpoints satisfied. Incomplete ghosts (e.g. greedy solver that hit
// the 600-turn cap without finishing) are rejected here so they never reach players.
function ghostFinished(ghost: GhostData, entry: TrackEntry, gridPx: number): boolean {
  const checkpoints = entry.markers.filter(m => m.kind === 'checkpoint');
  const finish      = entry.markers.find(m => m.kind === 'finish');
  if (!finish) return false;

  const cpTouched = new Array<boolean>(checkpoints.length).fill(false);
  let gx = ghost.startGX, gy = ghost.startGY;

  for (const m of ghost.moves) {
    if (m.crash) continue; // crash = car returned to previous position
    const fromGX = gx, fromGY = gy;
    gx = m.gx; gy = m.gy;

    for (let i = 0; i < checkpoints.length; i++) {
      if (!cpTouched[i] && moveCrossesMarker(fromGX, fromGY, gx, gy, checkpoints[i], gridPx)) {
        cpTouched[i] = true;
      }
    }

    if (cpTouched.every(Boolean) && moveCrossesMarker(fromGX, fromGY, gx, gy, finish, gridPx)) {
      return true;
    }
  }

  return false;
}

// Fetches up to 3 race ghosts for a track.
//
// Server returns a mix of random human ghosts + cached AI fills.
// Incomplete ghosts (didn't cross the finish) are silently dropped.
// If the server returns nothing usable, the client generates AI ghosts
// locally and uploads them for future players.
export async function fetchRaceGhosts(
  trackId: string,
  entry:   TrackEntry,
  gridPx = 24,
): Promise<GhostData[]> {
  try {
    const res = await fetch(`/api/race-ghosts/${encodeURIComponent(trackId)}`);
    if (res.ok) {
      const data = await res.json() as { ghosts?: string[] };
      const ghosts = (data.ghosts ?? []).flatMap(s => {
        try { return [deserializeGhost(s)]; } catch { return []; }
      }).filter(g => ghostFinished(g, entry, gridPx));

      if (ghosts.length > 0) return ghosts;
    }
  } catch { /* fall through to local generation */ }

  // Server returned nothing usable — generate AI ghosts locally.
  // This only happens on a completely fresh track (no human OR cached AI ghosts).
  const fills = await Promise.all(
    AI_FILL_SKILLS.map(skill => fetchOrGenerateAiGhost(trackId, skill, entry, gridPx, true)),
  );
  return fills.filter((g): g is GhostData => g !== null);
}
