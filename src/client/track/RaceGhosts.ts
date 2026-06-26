import { deserializeGhost, type GhostData } from './GhostData';
import { fetchOrGenerateAiGhost } from './AiGhost';
import type { SkillLevel } from './GhostSolver';
import type { TrackEntry } from '../tracks/trackRegistry';

// BFS-based skills (skilled/perfect) are too slow to run in the browser on
// complex tracks — they are generated at upload time via generateAndUploadAiGhosts.
const AI_FILL_SKILLS: SkillLevel[] = ['average', 'rookie'];

// Fetches up to 3 race ghosts for a track.
//
// Server returns a mix of random human ghosts + cached AI fills.
// If the server returns nothing (brand-new track with no ghosts at all),
// the client generates AI ghosts locally and uploads them for future players.
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
      });
      if (ghosts.length > 0) return ghosts;
    }
  } catch { /* fall through to local generation */ }

  // Server returned nothing — generate AI ghosts locally.
  // This only happens on a completely fresh track (no human OR cached AI ghosts).
  const fills = await Promise.all(
    AI_FILL_SKILLS.map(skill => fetchOrGenerateAiGhost(trackId, skill, entry, gridPx, true)),
  );
  return fills.filter((g): g is GhostData => g !== null);
}
