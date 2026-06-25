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
  rank: number;          // 1-based position on the leaderboard (lower score = better)
  isPB: boolean;         // true if this run improved the personal best
  previousBest?: number; // set when isPB is false — the score that remains as the PB
};

export type LeaderboardEntry = {
  username: string;
  score: number;
};

export type LeaderboardResponse = {
  type: "leaderboard";
  trackId: string;
  entries: LeaderboardEntry[];
  total: number;
  offset: number;
};

export type LeaderboardAroundEntry = {
  username: string;
  score: number;
  rank: number;   // 1-based
  isMe: boolean;
};

export type LeaderboardAroundResponse = {
  type: "leaderboard_around";
  trackId: string;
  username: string;
  myRank: number | null; // null if user has no entry on this board
  total: number;
  entries: LeaderboardAroundEntry[];
};

export type OverallLeaderboardEntry = {
  username: string;
  points: number;
  tracksPlayed: number;
};

export type OverallLeaderboardResponse = {
  type: "overall_leaderboard";
  entries: OverallLeaderboardEntry[];
};

// ── Race ghost composition ────────────────────────────────────────────────────

export type RaceGhostsResponse = {
  type:    'race_ghosts';
  trackId: string;
  ghosts:  string[]; // serialized GhostData, 0–3 entries (human + AI fills)
};

// ── AI ghost ──────────────────────────────────────────────────────────────────

export type AiSkillLevel = 'perfect' | 'skilled' | 'average' | 'rookie';

export type AiGhostRequest = {
  trackId: string;
  skill:   AiSkillLevel;
  ghost:   string; // serialized GhostData JSON
};

export type AiGhostResponse = {
  type:    'ai_ghost';
  trackId: string;
  skill:   AiSkillLevel;
  ghost:   string;
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
