import { Hono } from 'hono';
import { context, redis, reddit } from '@devvit/web/server';
import type {
  CommunityTrackMeta,
  CommunityTrackResponse,
  CommunityTracksResponse,
  DecrementResponse,
  IncrementResponse,
  InitResponse,
  LeaderboardEntry,
  LeaderboardResponse,
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

  // Store the ghost JSON keyed by track + user.
  await redis.set(`ghost:${trackId}:${username}`, ghost);

  // Update the leaderboard sorted set (lower score = better = lower rank).
  const lbKey = `lb:${trackId}`;
  await redis.zAdd(lbKey, { score, member: username });

  // Return the player's rank (1-based; lower score wins).
  const rank = await redis.zRank(lbKey, username);

  return c.json<UploadGhostResponse>({
    type: 'upload_ghost',
    username,
    trackId,
    score,
    rank: (rank ?? 0) + 1,
  });
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

// ── Leaderboard ───────────────────────────────────────────────────────────────

api.get('/leaderboard/:trackId', async (c) => {
  const { trackId } = c.req.param();
  const lbKey = `lb:${trackId}`;

  // Fetch top-25 entries, lowest score first.
  const raw = await redis.zRange(lbKey, 0, 24, { by: 'rank' });

  const entries: LeaderboardEntry[] = raw.map(({ member, score }) => ({
    username: member,
    score,
  }));

  return c.json<LeaderboardResponse>({ type: 'leaderboard', trackId, entries });
});
