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
  postUrl?: string;   // reddit.com permalink; undefined for seeded tracks without a post
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
  postUrl: string; // permalink of the newly created Reddit post
};

export type CommunityTracksResponse = {
  type: "community_tracks";
  tracks: CommunityTrackMeta[];
  total: number;
};

export type CommunityTrackResponse = {
  type: "community_track";
  meta: CommunityTrackMeta;
  data: string; // same format as UploadTrackRequest.data
};

export type TrackStatsResponse = {
  type: "track_stats";
  trackId: string;
  pieceCount: number;
  playerCount: number;
  averageScore: number | null; // null when no one has posted a time yet
  completed: boolean;          // true if the logged-in user has a leaderboard entry
};

// ── Profile stats ──────────────────────────────────────────────────────────────

export type UserStatsCategory = {
  finished: number;    // distinct tracks in this category the user has completed
  rank: number | null; // 1-based placement among players with points in this category; null if the user has none
  points: number;      // total points earned across tracks in this category (same scoring as the overall leaderboard)
};

export type UserStatsResponse = {
  type: "user_stats";
  username: string;
  daily: UserStatsCategory;
  community: UserStatsCategory;
  created: number; // community tracks authored by this user
};

// ── Mine tracks (user's saved drafts) ────────────────────────────────────────

export type MineTrackMeta = {
  id:          string;
  name:        string;
  createdAt:   number;  // unix ms
  verified:    boolean; // user completed the track at least once
  uploadedId?: string;  // community track ID after publishing
};

export type SaveMineTrackRequest = {
  id?:  string; // if set, update existing record; omit to create new
  name: string;
  data: string; // serialized TrackPayload JSON
};

export type SaveMineTrackResponse = {
  type:      'save_mine_track';
  id:        string;
  createdAt: number;
};

export type MineTracksResponse = {
  type:   'mine_tracks';
  tracks: MineTrackMeta[];
};

export type MineTrackResponse = {
  type: 'mine_track';
  meta: MineTrackMeta;
  data: string; // serialized TrackPayload JSON
};

// ── Mod actions ───────────────────────────────────────────────────────────────

export type IsModResponse = {
  type: 'is_mod';
  isMod: boolean;
};

export type DeleteCommunityTrackResponse = {
  type: 'delete_community_track';
  trackId: string;
};

export type PromoteDailyRequest = {
  date: string; // YYYY-MM-DD
};

export type DirectDailyRequest = {
  date: string; // YYYY-MM-DD
  name: string;
  data: string; // TrackPayload JSON
};

export type DirectDailyResponse = {
  type:    'direct_daily';
  trackId: string;
  date:    string;
};

export type PromoteDailyResponse = {
  type: 'promote_daily';
  trackId: string;
  date: string;
};

export type DailyTrackEntry = {
  date:    string; // YYYY-MM-DD
  trackId: string;
  name:    string;
  author:  string;
  postUrl?: string;
};

export type DailyTracksResponse = {
  type:    'daily_tracks';
  entries: DailyTrackEntry[];
};
