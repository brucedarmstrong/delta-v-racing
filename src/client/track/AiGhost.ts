import { solveTrack, type SkillLevel } from './GhostSolver';
import { serializeGhost, deserializeGhost, type GhostData } from './GhostData';
import type { TrackEntry } from '../tracks/trackRegistry';

const ALL_SKILLS: SkillLevel[] = ['perfect', 'skilled', 'average', 'rookie'];

// ── Server fetch ──────────────────────────────────────────────────────────────

export async function fetchAiGhost(trackId: string, skill: SkillLevel): Promise<string | null> {
  try {
    const res = await fetch(`/api/ai-ghost/${encodeURIComponent(trackId)}/${skill}`);
    if (!res.ok) return null;
    const data = await res.json() as { ghost?: string };
    return data.ghost ?? null;
  } catch {
    return null;
  }
}

// ── Server upload ─────────────────────────────────────────────────────────────

async function uploadAiGhost(trackId: string, skill: SkillLevel, ghost: string): Promise<void> {
  try {
    await fetch('/api/ai-ghost', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ trackId, skill, ghost }),
    });
  } catch (e) {
    console.warn(`[ai ghost] upload failed for ${trackId}/${skill}`, e);
  }
}

// ── Fetch-or-generate (single skill) ─────────────────────────────────────────

// Tries the server cache first. On miss, solves locally and uploads for future players.
// Returns the deserialized GhostData, or null if the track is unsolvable.
export async function fetchOrGenerateAiGhost(
  trackId: string,
  skill:   SkillLevel,
  entry:   TrackEntry,
  gridPx:  number,
): Promise<GhostData | null> {
  const cached = await fetchAiGhost(trackId, skill);
  if (cached) return deserializeGhost(cached);

  const ghost = solveTrack(entry, skill, gridPx);
  if (!ghost) return null;

  const serialized = serializeGhost(ghost);
  uploadAiGhost(trackId, skill, serialized); // fire-and-forget
  return ghost;
}

// ── Bulk generate + upload (all skill levels) ─────────────────────────────────

// Call this at track-editor upload time to pre-populate AI ghosts for all skill levels.
// Also useful for seeding built-in tracks (call from a dev utility or game bootstrap).
// Only generates skills that are not already cached on the server.
export async function generateAndUploadAiGhosts(
  entry:   TrackEntry,
  skills:  SkillLevel[] = ALL_SKILLS,
  gridPx   = 24,
): Promise<void> {
  for (const skill of skills) {
    const existing = await fetchAiGhost(entry.id, skill);
    if (existing) continue; // already cached

    const ghost = solveTrack(entry, skill, gridPx);
    if (!ghost) continue;

    await uploadAiGhost(entry.id, skill, serializeGhost(ghost));
  }
}
