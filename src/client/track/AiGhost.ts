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

// Mod-only: wipes every cached AI ghost skill level for a track (e.g. one
// turned out to have an invalid path — a stale cache entry from before a
// collision fix, or generated before the track itself was edited). Server
// re-checks mod status; this just surfaces the result. Returns the skills
// that were actually removed (empty array if nothing was cached).
export async function removeAiGhosts(trackId: string): Promise<SkillLevel[]> {
  const res = await fetch(`/api/mod/ai-ghost/${encodeURIComponent(trackId)}`, { method: 'DELETE' });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const e = await res.json() as { message?: string }; if (e.message) msg = e.message; } catch { /* keep default msg */ }
    throw new Error(msg);
  }
  const data = await res.json() as { removed?: SkillLevel[] };
  return data.removed ?? [];
}

// ── Fetch-or-generate (single skill) ─────────────────────────────────────────

// Tries the server cache first. On miss, solves locally and uploads for future players.
// Returns the deserialized GhostData, or null if the track is unsolvable.
export async function fetchOrGenerateAiGhost(
  trackId:         string,
  skill:           SkillLevel,
  entry:           TrackEntry,
  gridPx:          number,
  skipServerCheck = false,
): Promise<GhostData | null> {
  if (!skipServerCheck) {
    const cached = await fetchAiGhost(trackId, skill);
    if (cached) return deserializeGhost(cached);
  }

  const ghost = solveTrack(entry, skill, gridPx);
  if (!ghost) return null;

  const serialized = serializeGhost(ghost);
  void uploadAiGhost(trackId, skill, serialized); // fire-and-forget
  return ghost;
}

// ── Bulk generate + upload (all skill levels) ─────────────────────────────────

// Call this at track-editor upload time to pre-populate AI ghosts for all skill levels.
// Also useful for seeding built-in tracks (call from a dev utility or game bootstrap).
// Only generates skills that are not already cached on the server.
// Returns the skills that end up with a cached ghost (pre-existing or newly
// solved+uploaded this call) — callers that need to guarantee at least one
// ghost exists (e.g. right after publishing) use this to decide whether a
// stronger fallback skill is needed.
export async function generateAndUploadAiGhosts(
  entry:   TrackEntry,
  skills:  SkillLevel[] = ALL_SKILLS,
  gridPx   = 24,
): Promise<SkillLevel[]> {
  const seeded: SkillLevel[] = [];
  for (const skill of skills) {
    const existing = await fetchAiGhost(entry.id, skill);
    if (existing) { seeded.push(skill); continue; }

    const ghost = solveTrack(entry, skill, gridPx);
    if (!ghost) continue;

    await uploadAiGhost(entry.id, skill, serializeGhost(ghost));
    seeded.push(skill);
  }
  return seeded;
}
