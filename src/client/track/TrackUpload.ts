import type { TrackEntry } from '../tracks/trackRegistry';
import type {
  CommunityTrackResponse,
  CommunityTracksResponse,
  CommunityTrackMeta,
  UploadTrackRequest,
  UploadTrackResponse,
} from '../../shared/api';
import type { PlacedPiece } from './TrackLayout';
import type { TrackMarker } from './convertGmsTrack';

export type TrackPayload = {
  startX:  number;
  startY:  number;
  pieces:  PlacedPiece[];
  markers: TrackMarker[];
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
