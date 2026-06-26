import { Hono } from 'hono';
import { context, redis, reddit } from '@devvit/web/server';
import type {
  AiGhostRequest,
  AiGhostResponse,
  AiSkillLevel,
  RaceGhostsResponse,
  CommunityTrackMeta,
  CommunityTrackResponse,
  CommunityTracksResponse,
  DecrementResponse,
  IncrementResponse,
  InitResponse,
  LeaderboardAroundEntry,
  LeaderboardAroundResponse,
  LeaderboardEntry,
  LeaderboardResponse,
  OverallLeaderboardEntry,
  OverallLeaderboardResponse,
  UploadGhostRequest,
  UploadGhostResponse,
  UploadTrackRequest,
  UploadTrackResponse,
} from '../../shared/api';

type ErrorResponse = {
  status: 'error';
  message: string;
};

export const api = new Hono();

api.get('/init', async (c) => {
  const { postId } = context;

  if (!postId) {
    console.error('API Init Error: postId not found in devvit context');
    return c.json<ErrorResponse>(
      {
        status: 'error',
        message: 'postId is required but missing from context',
      },
      400
    );
  }

  try {
    const [count, username] = await Promise.all([
      redis.get('count'),
      reddit.getCurrentUsername(),
    ]);

    return c.json<InitResponse>({
      type: 'init',
      postId: postId,
      count: count ? parseInt(count) : 0,
      username: username ?? 'anonymous',
    });
  } catch (error) {
    console.error(`API Init Error for post ${postId}:`, error);
    let errorMessage = 'Unknown error during initialization';
    if (error instanceof Error) {
      errorMessage = `Initialization failed: ${error.message}`;
    }
    return c.json<ErrorResponse>(
      { status: 'error', message: errorMessage },
      400
    );
  }
});

api.post('/increment', async (c) => {
  const { postId } = context;
  if (!postId) {
    return c.json<ErrorResponse>(
      {
        status: 'error',
        message: 'postId is required',
      },
      400
    );
  }

  const count = await redis.incrBy('count', 1);
  return c.json<IncrementResponse>({
    count,
    postId,
    type: 'increment',
  });
});

api.post('/decrement', async (c) => {
  const { postId } = context;
  if (!postId) {
    return c.json<ErrorResponse>(
      {
        status: 'error',
        message: 'postId is required',
      },
      400
    );
  }

  const count = await redis.incrBy('count', -1);
  return c.json<DecrementResponse>({
    count,
    postId,
    type: 'decrement',
  });
});

// ── Ghost upload ──────────────────────────────────────────────────────────────

api.post('/ghost', async (c) => {
  const username = await reddit.getCurrentUsername();
  if (!username) {
    return c.json<ErrorResponse>({ status: 'error', message: 'Not logged in' }, 401);
  }

  let body: UploadGhostRequest;
  try {
    body = await c.req.json<UploadGhostRequest>();
  } catch {
    return c.json<ErrorResponse>({ status: 'error', message: 'Invalid JSON body' }, 400);
  }

  const { trackId, score, ghost } = body;
  if (!trackId || typeof score !== 'number' || !ghost) {
    return c.json<ErrorResponse>({ status: 'error', message: 'Missing required fields' }, 400);
  }

  // Only store ghost and update leaderboard if this beats the existing score.
  const lbKey = `lb:${trackId}`;
  const existing = await redis.zScore(lbKey, username);
  const isPersonalBest = existing === undefined || score < existing;

  if (isPersonalBest) {
    await redis.set(`ghost:${trackId}:${username}`, ghost);
    await redis.zAdd(lbKey, { score, member: username });
    // Register this track so the overall leaderboard knows it exists.
    await redis.hSet('lb:tracks', { [trackId]: '1' });
  }

  // Return the player's rank (1-based; lower score wins).
  const rank = await redis.zRank(lbKey, username);

  console.log(`[ghost] ${username} on ${trackId}: score=${score.toFixed(2)} pb=${isPersonalBest} rank=#${(rank ?? 0) + 1} bytes=${ghost.length}`);

  return c.json<UploadGhostResponse>({
    type: 'upload_ghost',
    username,
    trackId,
    score,
    rank: (rank ?? 0) + 1,
    isPB: isPersonalBest,
    previousBest: isPersonalBest ? undefined : existing,
  });
});

api.delete('/debug/ghost/:trackId/:username', async (c) => {
  const { trackId, username } = c.req.param();
  await redis.del(`ghost:${trackId}:${username}`);
  await redis.zRem(`lb:${trackId}`, [username]);
  console.log(`[debug delete] removed ${username} from ${trackId}`);
  return c.json({ type: 'debug_delete', trackId, username });
});

api.get('/debug/dump', async (c) => {
  const dump: Record<string, unknown> = {};

  // ── Leaderboards ───────────────────────────────────────────────────────────
  const trackIds = await redis.hKeys('lb:tracks');
  dump['lb:tracks'] = trackIds;

  await Promise.all(trackIds.map(async (trackId) => {
    const lbKey   = `lb:${trackId}`;
    const total   = await redis.zCard(lbKey);
    const entries = total > 0
      ? await redis.zRange(lbKey, 0, total - 1, { by: 'rank' })
      : [];
    dump[lbKey] = entries.map(({ member, score }, i) => ({
      rank: i + 1, username: member, score,
    }));
  }));

  // ── AI ghost cache ─────────────────────────────────────────────────────────
  const AI_SKILLS: AiSkillLevel[] = ['perfect', 'skilled', 'average', 'rookie'];
  await Promise.all(trackIds.flatMap(trackId =>
    AI_SKILLS.map(async (skill) => {
      const raw = await redis.get(`ai-ghost:${trackId}:${skill}`);
      if (raw) dump[`ai-ghost:${trackId}:${skill}`] = `${raw.length} bytes`;
    }),
  ));

  // ── Community tracks ───────────────────────────────────────────────────────
  const communityTotal = await redis.zCard('tracks:community');
  if (communityTotal > 0) {
    const ids  = await redis.zRange('tracks:community', 0, communityTotal - 1, { by: 'rank', reverse: true });
    const raws = await redis.mGet(ids.map(({ member }) => `track:${member}`));
    dump['tracks:community'] = raws.map((raw, i) => {
      if (!raw) return { id: ids[i]!.member, error: 'missing' };
      try {
        const r = JSON.parse(raw) as { id: string; name: string; author: string; uploadedAt: number };
        return { id: r.id, name: r.name, author: r.author, uploadedAt: r.uploadedAt };
      } catch {
        return { id: ids[i]!.member, error: 'corrupt' };
      }
    });
  }

  return c.json(dump);
});

// ── Ghost download ────────────────────────────────────────────────────────────

api.get('/ghost/:trackId/:username', async (c) => {
  const { trackId, username } = c.req.param();
  const key = `ghost:${trackId}:${username}`;
  const raw = await redis.get(key);

  if (!raw) {
    return c.json<ErrorResponse>({ status: 'error', message: 'Ghost not found' }, 404);
  }

  // TEMPORARY: log the full ghost contents for verification
  console.log(`[ghost download] key=${key} bytes=${raw.length}`);
  console.log(`[ghost download] contents=${raw}`);

  return c.json({ type: 'ghost', trackId, username, ghost: raw });
});

// ── AI ghosts ─────────────────────────────────────────────────────────────────

const VALID_SKILLS = new Set<AiSkillLevel>(['perfect', 'skilled', 'average', 'rookie']);

api.post('/ai-ghost', async (c) => {
  let body: AiGhostRequest;
  try {
    body = await c.req.json<AiGhostRequest>();
  } catch {
    return c.json<ErrorResponse>({ status: 'error', message: 'Invalid JSON body' }, 400);
  }

  const { trackId, skill, ghost } = body;
  if (!trackId || !VALID_SKILLS.has(skill) || !ghost) {
    return c.json<ErrorResponse>({ status: 'error', message: 'Missing or invalid fields' }, 400);
  }

  await redis.set(`ai-ghost:${trackId}:${skill}`, ghost);
  console.log(`[ai ghost] stored ${trackId}/${skill} bytes=${ghost.length}`);

  return c.json<AiGhostResponse>({ type: 'ai_ghost', trackId, skill, ghost });
});

api.get('/ai-ghost/:trackId/:skill', async (c) => {
  const { trackId } = c.req.param();
  const skill = c.req.param('skill') as AiSkillLevel;

  if (!VALID_SKILLS.has(skill)) {
    return c.json<ErrorResponse>({ status: 'error', message: 'Invalid skill level' }, 400);
  }

  const raw = await redis.get(`ai-ghost:${trackId}:${skill}`);
  if (!raw) {
    return c.json<ErrorResponse>({ status: 'error', message: 'AI ghost not found' }, 404);
  }

  return c.json<AiGhostResponse>({ type: 'ai_ghost', trackId, skill, ghost: raw });
});

// ── Track upload / community ──────────────────────────────────────────────────

api.post('/track', async (c) => {
  const username = await reddit.getCurrentUsername();
  if (!username) {
    return c.json<ErrorResponse>({ status: 'error', message: 'Not logged in' }, 401);
  }

  let body: UploadTrackRequest;
  try {
    body = await c.req.json<UploadTrackRequest>();
  } catch {
    return c.json<ErrorResponse>({ status: 'error', message: 'Invalid JSON body' }, 400);
  }

  const { name, data } = body;
  if (!name || !data) {
    return c.json<ErrorResponse>({ status: 'error', message: 'Missing required fields' }, 400);
  }

  const uploadedAt = Date.now();
  const id = `${username}_${uploadedAt}`;

  const record = JSON.stringify({ id, name, author: username, uploadedAt, data });
  await redis.set(`track:${id}`, record);
  await redis.zAdd('tracks:community', { score: uploadedAt, member: id });

  return c.json<UploadTrackResponse>({ type: 'upload_track', id, author: username, uploadedAt });
});

api.get('/tracks/community', async (c) => {
  const offset = Math.max(0, parseInt(c.req.query('offset') ?? '0', 10));
  const count  = 25;

  const ids = await redis.zRange(
    'tracks:community', offset, offset + count - 1,
    { by: 'rank', reverse: true },
  );

  if (ids.length === 0) {
    return c.json<CommunityTracksResponse>({ type: 'community_tracks', tracks: [] });
  }

  const keys    = ids.map(({ member }) => `track:${member}`);
  const records = await redis.mGet(keys);

  const tracks: CommunityTrackMeta[] = [];
  for (const raw of records) {
    if (!raw) continue;
    try {
      const r = JSON.parse(raw) as { id: string; name: string; author: string; uploadedAt: number };
      tracks.push({ id: r.id, name: r.name, author: r.author, uploadedAt: r.uploadedAt });
    } catch { /* skip corrupt entries */ }
  }

  return c.json<CommunityTracksResponse>({ type: 'community_tracks', tracks });
});

api.get('/track/:id', async (c) => {
  const { id } = c.req.param();
  const raw = await redis.get(`track:${id}`);
  if (!raw) {
    return c.json<ErrorResponse>({ status: 'error', message: 'Track not found' }, 404);
  }

  try {
    const r = JSON.parse(raw) as {
      id: string; name: string; author: string; uploadedAt: number; data: string;
    };
    return c.json<CommunityTrackResponse>({
      type: 'community_track',
      meta: { id: r.id, name: r.name, author: r.author, uploadedAt: r.uploadedAt },
      data: r.data,
    });
  } catch {
    return c.json<ErrorResponse>({ status: 'error', message: 'Corrupt track data' }, 500);
  }
});

// ── Race ghost composition ────────────────────────────────────────────────────

const AI_FILL_ORDER: AiSkillLevel[] = ['skilled', 'average', 'rookie'];

api.get('/race-ghosts/:trackId', async (c) => {
  const { trackId } = c.req.param();
  const lbKey = `lb:${trackId}`;

  // Pick up to 3 random human ghosts from the leaderboard pool.
  const ghosts: string[] = [];
  const total = await redis.zCard(lbKey);

  if (total > 0) {
    const pool = await redis.zRange(lbKey, 0, Math.min(24, total - 1), { by: 'rank' });
    // Fisher-Yates shuffle so selection isn't biased toward top performers.
    const members = pool.map(({ member }) => member);
    for (let i = members.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [members[i], members[j]] = [members[j], members[i]];
    }
    const selected = members.slice(0, 3);
    const raws     = await redis.mGet(selected.map(u => `ghost:${trackId}:${u}`));
    raws.forEach((raw, i) => {
      if (!raw) return;
      try {
        const g = JSON.parse(raw) as Record<string, unknown>;
        g.author = selected[i];
        ghosts.push(JSON.stringify(g));
      } catch { ghosts.push(raw); }
    });
  }

  // Fill remaining slots from cached AI ghosts.
  const needed = 3 - ghosts.length;
  if (needed > 0) {
    const aiKeys = AI_FILL_ORDER.slice(0, needed).map(s => `ai-ghost:${trackId}:${s}`);
    const aiRaws = await redis.mGet(aiKeys);
    for (const raw of aiRaws) { if (raw) ghosts.push(raw); }
  }

  return c.json<RaceGhostsResponse>({ type: 'race_ghosts', trackId, ghosts });
});

// ── Leaderboard ───────────────────────────────────────────────────────────────

const POINTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];

api.get('/leaderboard/overall', async (c) => {
  // Discover all tracks that have at least one ghost uploaded.
  const trackIds = await redis.hKeys('lb:tracks');
  if (trackIds.length === 0) {
    return c.json<OverallLeaderboardResponse>({ type: 'overall_leaderboard', entries: [] });
  }

  // Fetch top-10 from each track's leaderboard in parallel.
  const perTrack = await Promise.all(
    trackIds.map(id => redis.zRange(`lb:${id}`, 0, POINTS.length - 1, { by: 'rank' })),
  );

  // Aggregate points per player.
  const totals = new Map<string, { points: number; tracksPlayed: number }>();
  for (const entries of perTrack) {
    entries.forEach(({ member }, idx) => {
      const pts = POINTS[idx] ?? 0;
      const cur = totals.get(member) ?? { points: 0, tracksPlayed: 0 };
      totals.set(member, { points: cur.points + pts, tracksPlayed: cur.tracksPlayed + 1 });
    });
  }

  // Sort highest points first.
  const sorted: OverallLeaderboardEntry[] = [...totals.entries()]
    .map(([username, { points, tracksPlayed }]) => ({ username, points, tracksPlayed }))
    .sort((a, b) => b.points - a.points);

  return c.json<OverallLeaderboardResponse>({ type: 'overall_leaderboard', entries: sorted });
});

api.get('/leaderboard/:trackId/around/:username', async (c) => {
  const { trackId, username } = c.req.param();
  const above = Math.min(10, Math.max(0, parseInt(c.req.query('above') ?? '3', 10)));
  const below = Math.min(10, Math.max(0, parseInt(c.req.query('below') ?? '3', 10)));
  const lbKey = `lb:${trackId}`;

  const [myRankRaw, total] = await Promise.all([
    redis.zRank(lbKey, username),
    redis.zCard(lbKey),
  ]);

  if (myRankRaw == null) {
    // User has no entry — return top entries so the leaderboard isn't empty.
    const raw = await redis.zRange(lbKey, 0, above + below, { by: 'rank' });
    const entries: LeaderboardAroundEntry[] = raw.map(({ member, score }, i) => ({
      username: member, score, rank: i + 1, isMe: member === username,
    }));
    return c.json<LeaderboardAroundResponse>({
      type: 'leaderboard_around', trackId, username, myRank: null, total, entries,
    });
  }

  const start = Math.max(0, myRankRaw - above);
  const end   = myRankRaw + below;
  const raw   = await redis.zRange(lbKey, start, end, { by: 'rank' });
  const entries: LeaderboardAroundEntry[] = raw.map(({ member, score }, i) => ({
    username: member, score, rank: start + i + 1, isMe: member === username,
  }));

  return c.json<LeaderboardAroundResponse>({
    type: 'leaderboard_around', trackId, username,
    myRank: myRankRaw + 1, total, entries,
  });
});

api.get('/leaderboard/:trackId', async (c) => {
  const { trackId } = c.req.param();
  const lbKey  = `lb:${trackId}`;
  const offset = Math.max(0, parseInt(c.req.query('offset') ?? '0', 10));
  const limit  = Math.min(100, Math.max(1, parseInt(c.req.query('limit') ?? '25', 10)));

  const [raw, total] = await Promise.all([
    redis.zRange(lbKey, offset, offset + limit - 1, { by: 'rank' }),
    redis.zCard(lbKey),
  ]);

  const entries: LeaderboardEntry[] = raw.map(({ member, score }) => ({
    username: member, score,
  }));

  return c.json<LeaderboardResponse>({ type: 'leaderboard', trackId, entries, total, offset });
});
