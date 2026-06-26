import type { TrackEntry } from '../tracks/trackRegistry';
import type {
  CommunityTrackResponse,
  CommunityTracksResponse,
  CommunityTrackMeta,
  MineTrackMeta,
  MineTrackResponse,
  MineTracksResponse,
  SaveMineTrackRequest,
  SaveMineTrackResponse,
  UploadTrackRequest,
  UploadTrackResponse,
} from '../../shared/api';
import type { PlacedPiece } from './TrackLayout';
import type { TrackMarker } from './convertGmsTrack';

export type TrackPayload = {
  startX:       number;
  startY:       number;
  startHeading?: number; // degrees; 0=north, 90=east, 180=south (default)
  pieces:       PlacedPiece[];
  markers:      TrackMarker[];
};

export async function uploadTrack(
  track: TrackEntry,
): Promise<{ id: string; author: string; uploadedAt: number }> {
  const payload: TrackPayload = {
    startX:  track.startX,
    startY:  track.startY,
    pieces:  track.pieces,
    markers: track.markers,
  };

  const body: UploadTrackRequest = {
    name: track.name,
    data: JSON.stringify(payload),
  };

  const res = await fetch('/api/track', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json() as UploadTrackResponse;
  return { id: json.id, author: json.author, uploadedAt: json.uploadedAt };
}

export async function fetchCommunityTracks(offset = 0): Promise<CommunityTrackMeta[]> {
  const res = await fetch(`/api/tracks/community?offset=${offset}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json() as CommunityTracksResponse;
  return json.tracks;
}

// ── Mine track (user drafts) ──────────────────────────────────────────────────

export async function saveMineTrack(
  name: string,
  data: string,
  existingId?: string,
): Promise<{ id: string; createdAt: number }> {
  const body: SaveMineTrackRequest = { name, data, ...(existingId ? { id: existingId } : {}) };
  const res = await fetch('/api/mine-track', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const e = await res.json() as { message?: string }; if (e.message) msg = e.message; } catch {}
    throw new Error(msg);
  }
  const json = await res.json() as SaveMineTrackResponse;
  return { id: json.id, createdAt: json.createdAt };
}

export async function fetchMineTracks(): Promise<MineTrackMeta[]> {
  const res = await fetch('/api/mine-tracks');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json() as MineTracksResponse;
  return json.tracks;
}

export async function fetchMineTrack(id: string): Promise<{ meta: MineTrackMeta; data: string }> {
  const res = await fetch(`/api/mine-track/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json() as MineTrackResponse;
  return { meta: json.meta, data: json.data };
}

export async function deleteMineTrack(id: string): Promise<void> {
  const res = await fetch(`/api/mine-track/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export async function verifyMineTrack(id: string): Promise<void> {
  const res = await fetch(`/api/mine-track/${encodeURIComponent(id)}/verify`, { method: 'PATCH' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

// ── Local drafts (localStorage fallback when Devvit save fails) ───────────────

const LOCAL_DRAFTS_KEY = 'dv-drafts';

export type LocalDraft = {
  id:        string;     // always 'local-{timestamp}'
  name:      string;
  createdAt: number;
  data:      string;     // JSON TrackPayload
  verified?: boolean;
};

export function getLocalDrafts(): LocalDraft[] {
  try { return JSON.parse(localStorage.getItem(LOCAL_DRAFTS_KEY) ?? '[]') as LocalDraft[]; }
  catch { return []; }
}

function setLocalDraft(draft: LocalDraft): void {
  const all = getLocalDrafts().filter(d => d.id !== draft.id);
  all.unshift(draft);
  localStorage.setItem(LOCAL_DRAFTS_KEY, JSON.stringify(all));
}

export function deleteLocalDraft(id: string): void {
  localStorage.setItem(LOCAL_DRAFTS_KEY,
    JSON.stringify(getLocalDrafts().filter(d => d.id !== id)));
}

export function markLocalDraftVerified(id: string): void {
  const all = getLocalDrafts();
  const d = all.find(x => x.id === id);
  if (d) { d.verified = true; localStorage.setItem(LOCAL_DRAFTS_KEY, JSON.stringify(all)); }
}

export async function saveDraft(
  name: string,
  data: string,
  existingId?: string,
): Promise<{ id: string; local: boolean }> {
  const serverId = existingId?.startsWith('local-') ? undefined : existingId;
  try {
    const result = await saveMineTrack(name, data, serverId);
    if (existingId?.startsWith('local-')) deleteLocalDraft(existingId);
    return { id: result.id, local: false };
  } catch {
    const localId  = existingId?.startsWith('local-') ? existingId : `local-${Date.now()}`;
    const existing = existingId?.startsWith('local-')
      ? getLocalDrafts().find(d => d.id === existingId)
      : undefined;
    setLocalDraft({
      id: localId, name,
      createdAt: existing?.createdAt ?? Date.now(),
      data, verified: existing?.verified,
    });
    return { id: localId, local: true };
  }
}

export async function publishMineTrack(mineId: string, communityId: string): Promise<void> {
  const res = await fetch(`/api/mine-track/${encodeURIComponent(mineId)}/publish`, {
    method:  'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ communityId }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

// ── Community ─────────────────────────────────────────────────────────────────

export async function fetchCommunityTrack(id: string): Promise<TrackEntry> {
  const res = await fetch(`/api/track/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const json    = await res.json() as CommunityTrackResponse;
  const payload = JSON.parse(json.data) as TrackPayload;

  return {
    id:      json.meta.id,
    name:    json.meta.name,
    author:  json.meta.author,
    startX:  payload.startX,
    startY:  payload.startY,
    pieces:  payload.pieces,
    markers: payload.markers,
  };
}
