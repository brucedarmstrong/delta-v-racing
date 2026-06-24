export type InitResponse = {
  type: "init";
  postId: string;
  count: number;
  username: string;
};

export type IncrementResponse = {
  type: "increment";
  postId: string;
  count: number;
};

export type DecrementResponse = {
  type: "decrement";
  postId: string;
  count: number;
};

export type UploadGhostRequest = {
  trackId: string;
  score: number;
  ghost: string; // serialized GhostData JSON
};

export type UploadGhostResponse = {
  type: "upload_ghost";
  username: string;
  trackId: string;
  score: number;
  rank: number; // 1-based position on the leaderboard (lower score = better)
};

export type LeaderboardEntry = {
  username: string;
  score: number;
};

export type LeaderboardResponse = {
  type: "leaderboard";
  trackId: string;
  entries: LeaderboardEntry[];
};

// ── Track upload / community ───────────────────────────────────────────────────

export type CommunityTrackMeta = {
  id: string;
  name: string;
  author: string;
  uploadedAt: number; // unix ms
};

export type UploadTrackRequest = {
  name: string;
  // JSON: { startX, startY, pieces: PlacedPiece[], markers: TrackMarker[] }
  data: string;
};

export type UploadTrackResponse = {
  type: "upload_track";
  id: string;
  author: string;
  uploadedAt: number;
};

export type CommunityTracksResponse = {
  type: "community_tracks";
  tracks: CommunityTrackMeta[];
};

export type CommunityTrackResponse = {
  type: "community_track";
  meta: CommunityTrackMeta;
  data: string; // same format as UploadTrackRequest.data
};
