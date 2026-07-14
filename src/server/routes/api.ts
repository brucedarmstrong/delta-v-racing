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
  DeleteCommunityTrackResponse,
  DecrementResponse,
  IncrementResponse,
  InitResponse,
  IsModResponse,
  LeaderboardAroundEntry,
  LeaderboardAroundResponse,
  LeaderboardEntry,
  LeaderboardResponse,
  MineTrackMeta,
  MineTrackResponse,
  MineTracksResponse,
  TrackStatsResponse,
  UserStatsCategory,
  UserStatsResponse,
  OverallLeaderboardEntry,
  OverallLeaderboardResponse,
  SaveMineTrackRequest,
  SaveMineTrackResponse,
  UploadGhostRequest,
  UploadGhostResponse,
  UploadTrackRequest,
  UploadTrackResponse,
  PromoteDailyResponse,
  DailyTrackEntry,
  DailyTracksResponse,
  DirectDailyRequest,
  DirectDailyResponse,
  MigrationExportResponse,
  MigrationImportRequest,
  MigrationImportResponse,
  MigrationGhost,
  MigrationAiGhost,
  SeedGhostsRequest,
  SeedGhostsResponse,
  SeedAiGhostsRequest,
  SeedAiGhostsResponse,
} from '../../shared/api';

type ErrorResponse = {
  status: 'error';
  message: string;
};

// ── Track name validation ─────────────────────────────────────────────────────

const BANNED_WORDS = [
  'fuck','shit','cunt','cock','dick','pussy','ass','bitch','bastard',
  'nigger','nigga','faggot','fag','retard','whore','slut','twat',
  'piss','cum','jizz','rape','porn','nazi',
];

function normalizeForFilter(s: string): string {
  return s.toLowerCase()
    .replace(/0/g, 'o').replace(/1/g, 'i').replace(/3/g, 'e')
    .replace(/4/g, 'a').replace(/5/g, 's').replace(/@/g, 'a').replace(/\$/g, 's')
    .replace(/[^a-z]/g, '');
}

function hasBannedWord(name: string): boolean {
  const n = normalizeForFilter(name);
  return BANNED_WORDS.some(w => n.includes(w));
}

function validateTrackName(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length < 2)  return 'Track name must be at least 2 characters.';
  if (trimmed.length > 40) return 'Track name must be 40 characters or fewer.';
  if (hasBannedWord(trimmed)) return 'Track name contains inappropriate content.';
  return null;
}

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

// Known startX/startY for all built-in tracks. Multiples of 24 — so startGX === startX/24.
const STANDARD_TRACK_STARTS: Record<string, { startX: number; startY: number }> = {
  oval_small:    { startX: 1080, startY:  504 },
  short_track:   { startX:  432, startY:  216 },
  track4:        { startX:  216, startY:  672 },
  canada:        { startX: 1440, startY:  432 },
  nurburgring:   { startX: 1656, startY:  576 },
  '532':         { startX: 1176, startY:  744 },
  acey1:         { startX:  144, startY:  312 },
  acey2:         { startX:  864, startY:  408 },
  criss_cross:   { startX: 1296, startY:  504 },
  rusty_springs: { startX:  696, startY:  120 },
  spiral:        { startX: 1008, startY:   96 },
  bigone:        { startX:  240, startY:  240 },
  '88':          { startX:  240, startY:  528 },
  pods:          { startX:  504, startY:  192 },
  circuit_a:     { startX:  864, startY:  408 },
  speedway:      { startX:  552, startY:  144 },
  diagonal:      { startX:  408, startY:  168 },
  '2026_go_getter': { startX: 336, startY: 576 },
  '2026_mickey': { startX:  336, startY:  504 },
  '2026_square': { startX:  600, startY:  528 },
  '2026_test':   { startX:  336, startY:  288 },
  '2026_shorty': { startX:  336, startY:  432 },
  tutorial:      { startX:  384, startY:  312 },
  track3:        { startX:  408, startY:  168 },
};

api.get('/debug/ghost-grid-check', async (c) => {
  type GhostRecord = { v: number; trackId: string; startGX: number; startGY: number };
  type CheckEntry = {
    trackId:   string;
    username:  string;
    startGX:   number;
    startGY:   number;
    expectedGX: number | null;
    expectedGY: number | null;
    ok:        boolean;
    note:      string;
  };

  const trackIds = await redis.hKeys('lb:tracks');
  const results: CheckEntry[] = [];

  for (const trackId of trackIds) {
    // Determine expected grid start from built-in table or community Redis record.
    let expGX: number | null = null;
    let expGY: number | null = null;
    let note = '';

    const builtIn = STANDARD_TRACK_STARTS[trackId];
    if (builtIn) {
      expGX = builtIn.startX / 24;
      expGY = builtIn.startY / 24;
    } else {
      const raw = await redis.get(`track:${trackId}`);
      if (raw) {
        try {
          const rec = JSON.parse(raw) as { data: string };
          const payload = JSON.parse(rec.data) as { startX: number; startY: number };
          expGX = Math.round(payload.startX / 24);
          expGY = Math.round(payload.startY / 24);
        } catch { note = 'corrupt community record'; }
      } else {
        note = 'community record missing';
      }
    }

    const lbKey = `lb:${trackId}`;
    const total = await redis.zCard(lbKey);
    if (total === 0) continue;
    const members = await redis.zRange(lbKey, 0, total - 1, { by: 'rank' });

    for (const { member: uname } of members) {
      const ghostRaw = await redis.get(`ghost:${trackId}:${uname}`);
      if (!ghostRaw) continue;
      let ghost: GhostRecord;
      try { ghost = JSON.parse(ghostRaw) as GhostRecord; }
      catch { results.push({ trackId, username: uname, startGX: -1, startGY: -1, expectedGX: expGX, expectedGY: expGY, ok: false, note: 'parse error' }); continue; }

      const ok = expGX !== null && expGY !== null
        ? ghost.startGX === expGX && ghost.startGY === expGY
        : false;

      results.push({
        trackId, username: uname,
        startGX: ghost.startGX, startGY: ghost.startGY,
        expectedGX: expGX, expectedGY: expGY,
        ok,
        note: note || (expGX === null ? 'no reference' : ok ? 'ok' : `MISMATCH — expected gx=${expGX} gy=${expGY}`),
      });
    }
  }

  const bad = results.filter(r => !r.ok);
  return c.json({ total: results.length, mismatches: bad.length, bad, all: results });
});

api.post('/debug/purge-bad-ghosts', async (c) => {
  type GhostRecord = { startGX: number; startGY: number };
  const deleted: string[] = [];
  const kept:    string[] = [];

  const trackIds = await redis.hKeys('lb:tracks');

  for (const trackId of trackIds) {
    let expGX: number | null = null;
    let expGY: number | null = null;

    const builtIn = STANDARD_TRACK_STARTS[trackId];
    if (builtIn) {
      expGX = builtIn.startX / 24;
      expGY = builtIn.startY / 24;
    } else {
      const raw = await redis.get(`track:${trackId}`);
      if (raw) {
        try {
          const rec = JSON.parse(raw) as { data: string };
          const payload = JSON.parse(rec.data) as { startX: number; startY: number };
          expGX = Math.round(payload.startX / 24);
          expGY = Math.round(payload.startY / 24);
        } catch { /* skip — can't verify */ }
      }
    }

    if (expGX === null) continue; // can't verify this track, leave it alone

    const lbKey = `lb:${trackId}`;
    const total = await redis.zCard(lbKey);
    if (total === 0) continue;
    const members = await redis.zRange(lbKey, 0, total - 1, { by: 'rank' });

    for (const { member: uname } of members) {
      const ghostRaw = await redis.get(`ghost:${trackId}:${uname}`);
      if (!ghostRaw) continue;
      let ghost: GhostRecord;
      try { ghost = JSON.parse(ghostRaw) as GhostRecord; }
      catch { continue; }

      if (ghost.startGX !== expGX || ghost.startGY !== expGY) {
        await redis.del(`ghost:${trackId}:${uname}`);
        await redis.zRem(lbKey, [uname]);
        deleted.push(`${trackId}/${uname} (gx=${ghost.startGX} gy=${ghost.startGY}, expected ${expGX}/${expGY})`);
        console.log(`[purge] deleted ghost ${trackId}/${uname}: gx=${ghost.startGX} vs expected ${expGX}`);
      } else {
        kept.push(`${trackId}/${uname}`);
      }
    }
  }

  return c.json({ deleted: deleted.length, kept: kept.length, deletedList: deleted });
});

// Purge AI ghosts that hit the greedy solver's 600-turn cap without finishing.
// Safe to call repeatedly — good AI ghosts (BFS-solved) have far fewer moves and
// won't be touched. Purged slots regenerate correctly on next player visit.
api.post('/debug/purge-incomplete-ai-ghosts', async (c) => {
  const GREEDY_SKILLS: AiSkillLevel[] = ['average', 'rookie'];
  const CAP = 600; // MAX_GREEDY_TURNS from GhostSolver.ts
  const trackIds = await redis.hKeys('lb:tracks');
  const purged: string[] = [];

  for (const trackId of trackIds) {
    for (const skill of GREEDY_SKILLS) {
      const raw = await redis.get(`ai-ghost:${trackId}:${skill}`);
      if (!raw) continue;
      try {
        const g = JSON.parse(raw) as { moves?: unknown[] };
        if (Array.isArray(g.moves) && g.moves.length >= CAP) {
          await redis.del(`ai-ghost:${trackId}:${skill}`);
          purged.push(`${trackId}/${skill} (${g.moves.length} moves)`);
        }
      } catch { /* skip malformed */ }
    }
  }

  console.log(`[purge-ai] removed ${purged.length} incomplete AI ghosts`);
  return c.json({ type: 'purge_incomplete_ai_ghosts', purged: purged.length, list: purged });
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

  const nameError = validateTrackName(name);
  if (nameError) {
    return c.json<ErrorResponse>({ status: 'error', message: nameError }, 400);
  }

  // Block duplicate names from the same author.
  const nameKey = `track-name:${username}:${name.trim().toLowerCase()}`;
  const nameTaken = await redis.get(nameKey);
  if (nameTaken) {
    return c.json<ErrorResponse>({
      status: 'error',
      message: `You already have a community track called "${name.trim()}". Rename your draft before uploading.`,
    }, 409);
  }

  const uploadedAt = Date.now();
  const id = `${username}_${uploadedAt}`;

  // Create a Reddit post for this track so it can be upvoted individually.
  const subreddit = await reddit.getSubredditByName(context.subredditName!);
  const post = await subreddit.submitCustomPost({
    title:    `${name.trim()} — by u/${username}`,
    postData: { trackId: id, trackName: name.trim(), author: username },
  });
  const postUrl = `https://www.reddit.com${post.permalink}`;

  const record = JSON.stringify({ id, name: name.trim(), author: username, uploadedAt, data, postUrl });
  await redis.set(`track:${id}`, record);
  await redis.zAdd('tracks:community', { score: uploadedAt, member: id });
  await redis.set(nameKey, id);
  await redis.set(`track-post:${post.id}`, id);

  return c.json<UploadTrackResponse>({ type: 'upload_track', id, author: username, uploadedAt, postUrl });
});

api.post('/seed-tracks', async (c) => {
  if (!(await isModerator())) {
    return c.json<ErrorResponse>({ status: 'error', message: 'Moderator access required' }, 403);
  }
  let body: { tracks: Array<{ id: string; name: string; author: string; data: string; uploadedAt: number }> };
  try { body = await c.req.json(); } catch {
    return c.json<ErrorResponse>({ status: 'error', message: 'Invalid JSON' }, 400);
  }
  for (const t of body.tracks) {
    const record = JSON.stringify({ id: t.id, name: t.name, author: t.author, uploadedAt: t.uploadedAt, data: t.data });
    await redis.set(`track:${t.id}`, record);
    await redis.zAdd('tracks:community', { score: t.uploadedAt, member: t.id });
  }
  return c.json({ type: 'seed_tracks', count: body.tracks.length });
});

// TODO(pre-production): dev-subreddit -> prod-subreddit data transfer, for the
// one-time hackathon launch move. Delete both routes once the migration has
// been run against the production install.
api.get('/migration/export', async (c) => {
  if (!(await isModerator())) {
    return c.json<ErrorResponse>({ status: 'error', message: 'Moderator access required' }, 403);
  }
  const username = context.username;
  if (!username) return c.json<ErrorResponse>({ status: 'error', message: 'Not logged in' }, 401);

  const communityTotal = await redis.zCard('tracks:community');
  const communityIds = communityTotal > 0
    ? (await redis.zRange('tracks:community', 0, communityTotal - 1, { by: 'rank' })).map(e => e.member)
    : [];
  const communityRaws = communityIds.length > 0 ? await redis.mGet(communityIds.map(id => `track:${id}`)) : [];
  const communityTracks = communityRaws
    .filter((raw): raw is string => !!raw)
    .map(raw => JSON.parse(raw))
    .map(t => ({ id: t.id, name: t.name, author: t.author, uploadedAt: t.uploadedAt, data: t.data }));

  const mineTotal = await redis.zCard(`mine:${username}`);
  const mineIds = mineTotal > 0
    ? (await redis.zRange(`mine:${username}`, 0, mineTotal - 1, { by: 'rank' })).map(e => e.member)
    : [];
  const mineRaws = mineIds.length > 0 ? await redis.mGet(mineIds.map(id => `mine-track:${id}`)) : [];
  const myDrafts = mineRaws.filter((raw): raw is string => !!raw).map(raw => JSON.parse(raw));

  // Leaderboards + player ghosts, for every track that has one.
  const lbTracks = await redis.hGetAll('lb:tracks') as Record<string, string>;
  const lbTrackIds = Object.keys(lbTracks);
  const ghosts: MigrationGhost[] = [];
  for (const trackId of lbTrackIds) {
    const total = await redis.zCard(`lb:${trackId}`);
    if (total === 0) continue;
    const entries = await redis.zRange(`lb:${trackId}`, 0, total - 1, { by: 'rank' });
    const ghostRaws = await redis.mGet(entries.map(e => `ghost:${trackId}:${e.member}`));
    entries.forEach((e, i) => {
      const g = ghostRaws[i];
      if (g) ghosts.push({ trackId, username: e.member, score: e.score, ghost: g });
    });
  }

  // AI ghosts have no index of their own (keyed only by trackId+skill), so
  // probe every track we already know about across all skill levels.
  const aiCandidateIds = new Set<string>([...lbTrackIds, ...communityIds]);
  const aiGhosts: MigrationAiGhost[] = [];
  for (const trackId of aiCandidateIds) {
    const skills = [...VALID_SKILLS];
    const raws = await redis.mGet(skills.map(skill => `ai-ghost:${trackId}:${skill}`));
    skills.forEach((skill, i) => {
      const g = raws[i];
      if (g) aiGhosts.push({ trackId, skill, ghost: g });
    });
  }

  return c.json<MigrationExportResponse>({ type: 'migration_export', communityTracks, myDrafts, ghosts, aiGhosts });
});

api.post('/migration/import', async (c) => {
  if (!(await isModerator())) {
    return c.json<ErrorResponse>({ status: 'error', message: 'Moderator access required' }, 403);
  }
  let body: MigrationImportRequest;
  try { body = await c.req.json(); } catch {
    return c.json<ErrorResponse>({ status: 'error', message: 'Invalid JSON' }, 400);
  }

  for (const t of body.communityTracks ?? []) {
    const record = JSON.stringify({ id: t.id, name: t.name, author: t.author, uploadedAt: t.uploadedAt, data: t.data });
    await redis.set(`track:${t.id}`, record);
    await redis.zAdd('tracks:community', { score: t.uploadedAt, member: t.id });
    await redis.set(`track-name:${t.author}:${t.name.trim().toLowerCase()}`, t.id);
  }

  for (const d of body.myDrafts ?? []) {
    await redis.set(`mine-track:${d.id}`, JSON.stringify(d));
    await redis.zAdd(`mine:${d.author}`, { score: d.createdAt, member: d.id });
  }

  return c.json<MigrationImportResponse>({
    type: 'migration_import',
    communityCount: (body.communityTracks ?? []).length,
    draftCount: (body.myDrafts ?? []).length,
  });
});

// Bulk-import player leaderboard ghosts (e.g. migrating from a dev environment
// to production). Unlike POST /ghost, this writes an explicit username rather
// than the current session's, so it's restricted to subreddit moderators.
api.post('/seed-ghosts', async (c) => {
  if (!(await isModerator())) {
    return c.json<ErrorResponse>({ status: 'error', message: 'Moderator access required' }, 403);
  }
  let body: SeedGhostsRequest;
  try { body = await c.req.json(); } catch {
    return c.json<ErrorResponse>({ status: 'error', message: 'Invalid JSON' }, 400);
  }
  for (const g of body.ghosts) {
    await redis.set(`ghost:${g.trackId}:${g.username}`, g.ghost);
    await redis.zAdd(`lb:${g.trackId}`, { score: g.score, member: g.username });
    await redis.hSet('lb:tracks', { [g.trackId]: '1' });
  }
  return c.json<SeedGhostsResponse>({ type: 'seed_ghosts', count: body.ghosts.length });
});

// Bulk-import AI ghosts (per track + skill level). Also mod-only, since it's
// only ever meant to be called from the migration tooling, not the client app.
api.post('/seed-ai-ghosts', async (c) => {
  if (!(await isModerator())) {
    return c.json<ErrorResponse>({ status: 'error', message: 'Moderator access required' }, 403);
  }
  let body: SeedAiGhostsRequest;
  try { body = await c.req.json(); } catch {
    return c.json<ErrorResponse>({ status: 'error', message: 'Invalid JSON' }, 400);
  }
  for (const g of body.ghosts) {
    if (!VALID_SKILLS.has(g.skill)) continue;
    await redis.set(`ai-ghost:${g.trackId}:${g.skill}`, g.ghost);
  }
  return c.json<SeedAiGhostsResponse>({ type: 'seed_ai_ghosts', count: body.ghosts.length });
});

api.get('/tracks/community', async (c) => {
  const offset = Math.max(0, parseInt(c.req.query('offset') ?? '0', 10));
  const limit  = Math.min(50, Math.max(1, parseInt(c.req.query('limit') ?? '10', 10)));
  const q      = (c.req.query('q') ?? '').trim().toLowerCase();
  const author = (c.req.query('author') ?? '').trim().toLowerCase();

  const total = await redis.zCard('tracks:community');
  if (total === 0) {
    return c.json<CommunityTracksResponse>({ type: 'community_tracks', tracks: [], total: 0 });
  }

  // Fast path: no filtering — paginate directly in Redis.
  if (!q && !author) {
    const ids     = await redis.zRange('tracks:community', offset, offset + limit - 1, { by: 'rank', reverse: true });
    const records = await redis.mGet(ids.map(({ member }) => `track:${member}`));
    const tracks: CommunityTrackMeta[] = [];
    for (const raw of records) {
      if (!raw) continue;
      try {
        const r = JSON.parse(raw) as { id: string; name: string; author: string; uploadedAt: number; postUrl?: string };
        tracks.push({ id: r.id, name: r.name, author: r.author, uploadedAt: r.uploadedAt, postUrl: r.postUrl });
      } catch { /* skip */ }
    }
    return c.json<CommunityTracksResponse>({ type: 'community_tracks', tracks, total });
  }

  // Filtered path: fetch all, filter in memory, then paginate.
  const allIds  = await redis.zRange('tracks:community', 0, total - 1, { by: 'rank', reverse: true });
  const allRaws = await redis.mGet(allIds.map(({ member }) => `track:${member}`));
  const all: CommunityTrackMeta[] = [];
  for (const raw of allRaws) {
    if (!raw) continue;
    try {
      const r = JSON.parse(raw) as { id: string; name: string; author: string; uploadedAt: number; postUrl?: string };
      all.push({ id: r.id, name: r.name, author: r.author, uploadedAt: r.uploadedAt, postUrl: r.postUrl });
    } catch { /* skip */ }
  }

  const filtered = author
    ? all.filter(t => t.author.toLowerCase() === author)
    : all.filter(t => t.name.toLowerCase().includes(q) || t.author.toLowerCase().includes(q));

  return c.json<CommunityTracksResponse>({
    type: 'community_tracks',
    tracks: filtered.slice(offset, offset + limit),
    total: filtered.length,
  });
});

// ── Mod endpoints ─────────────────────────────────────────────────────────────

async function isModerator(): Promise<boolean> {
  const uname = context.username;
  if (!uname) return false;
  try {
    const mods = await reddit.getModerators({ subredditName: context.subredditName!, username: uname }).all();
    return mods.length > 0;
  } catch {
    return false;
  }
}

api.get('/user/is-mod', async (c) => {
  return c.json<IsModResponse>({ type: 'is_mod', isMod: await isModerator() });
});

api.delete('/community-track/:id', async (c) => {
  const uname = context.username;
  if (!uname) return c.json<ErrorResponse>({ status: 'error', message: 'Not logged in' }, 401);

  // Gate on mod status
  let isMod = false;
  try {
    const mods = await reddit.getModerators({ subredditName: context.subredditName!, username: uname }).all();
    isMod = mods.length > 0;
  } catch { /* treat as not-mod */ }
  if (!isMod) return c.json<ErrorResponse>({ status: 'error', message: 'Moderators only' }, 403);

  const { id } = c.req.param();
  const raw = await redis.get(`track:${id}`);
  if (!raw) return c.json<ErrorResponse>({ status: 'error', message: 'Track not found' }, 404);

  let postUrl: string | undefined;
  try {
    const rec = JSON.parse(raw) as { name: string; author: string; postUrl?: string };
    postUrl = rec.postUrl;
    await redis.del(`track-name:${rec.author}:${rec.name.trim().toLowerCase()}`);
  } catch { /* skip name key on corrupt record */ }

  await redis.del(`track:${id}`);
  await redis.zRem('tracks:community', [id]);

  if (postUrl) {
    try {
      const pathParts = new URL(postUrl).pathname.split('/').filter(Boolean);
      const shortId = pathParts[3]; // /r/sub/comments/SHORT_ID/title
      if (shortId) {
        await redis.del(`track-post:t3_${shortId}`);
        await reddit.remove(`t3_${shortId}` as `t3_${string}`, false);
      }
    } catch { /* post may already be gone */ }
  }

  console.log(`[mod delete] trackId=${id} by ${uname}`);
  return c.json<DeleteCommunityTrackResponse>({ type: 'delete_community_track', trackId: id });
});

api.patch('/community-track/:id/promote-daily', async (c) => {
  const uname = context.username;
  if (!uname) return c.json<ErrorResponse>({ status: 'error', message: 'Not logged in' }, 401);

  let isMod = false;
  try {
    const mods = await reddit.getModerators({ subredditName: context.subredditName!, username: uname }).all();
    isMod = mods.length > 0;
  } catch { /* treat as not-mod */ }
  if (!isMod) return c.json<ErrorResponse>({ status: 'error', message: 'Moderators only' }, 403);

  const { id } = c.req.param();
  const raw = await redis.get(`track:${id}`);
  if (!raw) return c.json<ErrorResponse>({ status: 'error', message: 'Track not found' }, 404);

  let body: { date?: string };
  try { body = await c.req.json(); } catch { body = {}; }
  const { date } = body;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return c.json<ErrorResponse>({ status: 'error', message: 'Invalid date (expected YYYY-MM-DD)' }, 400);
  }

  await redis.hSet('daily:schedule', { [date]: id });
  return c.json<PromoteDailyResponse>({ type: 'promote_daily', trackId: id, date });
});

// Promote a mod-created draft directly to Daily without adding it to Community.
api.post('/daily-track/direct', async (c) => {
  const uname = context.username;
  if (!uname) return c.json<ErrorResponse>({ status: 'error', message: 'Not logged in' }, 401);

  let isMod = false;
  try {
    const mods = await reddit.getModerators({ subredditName: context.subredditName!, username: uname }).all();
    isMod = mods.length > 0;
  } catch { /* treat as not-mod */ }
  if (!isMod) return c.json<ErrorResponse>({ status: 'error', message: 'Moderators only' }, 403);

  let body: DirectDailyRequest;
  try { body = await c.req.json(); } catch {
    return c.json<ErrorResponse>({ status: 'error', message: 'Invalid JSON' }, 400);
  }
  const { date, name, data } = body;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return c.json<ErrorResponse>({ status: 'error', message: 'Invalid date (expected YYYY-MM-DD)' }, 400);
  }
  if (!name?.trim() || !data) {
    return c.json<ErrorResponse>({ status: 'error', message: 'Missing name or data' }, 400);
  }

  const uploadedAt = Date.now();
  const id = `daily_${uname}_${uploadedAt}`;
  // Store track data but do NOT add to tracks:community sorted set.
  const record = JSON.stringify({ id, name: name.trim(), author: uname, uploadedAt, data });
  await redis.set(`track:${id}`, record);
  await redis.hSet('daily:schedule', { [date]: id });

  return c.json<DirectDailyResponse>({ type: 'direct_daily', trackId: id, date });
});

api.get('/daily-tracks', async (c) => {
  const schedule = await redis.hGetAll('daily:schedule') as Record<string, string>;
  const dateEntries = Object.entries(schedule);
  if (dateEntries.length === 0) {
    return c.json<DailyTracksResponse>({ type: 'daily_tracks', entries: [] });
  }

  const trackIds = dateEntries.map(([, id]) => id);
  const raws = await redis.mGet(trackIds.map(id => `track:${id}`));

  const entries: DailyTrackEntry[] = [];
  dateEntries.forEach(([date, trackId], i) => {
    const raw = raws[i];
    if (!raw) return;
    try {
      const r = JSON.parse(raw) as { name: string; author: string; postUrl?: string };
      entries.push({ date, trackId, name: r.name, author: r.author, postUrl: r.postUrl });
    } catch { /* skip corrupt records */ }
  });

  entries.sort((a, b) => b.date.localeCompare(a.date));
  return c.json<DailyTracksResponse>({ type: 'daily_tracks', entries });
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

api.get('/track/:id/stats', async (c) => {
  const { id } = c.req.param();
  const raw = await redis.get(`track:${id}`);
  if (!raw) {
    return c.json<ErrorResponse>({ status: 'error', message: 'Track not found' }, 404);
  }

  let pieceCount: number;
  try {
    const r = JSON.parse(raw) as { data: string };
    const payload = JSON.parse(r.data) as { pieces?: unknown[] };
    pieceCount = payload.pieces?.length ?? 0;
  } catch {
    return c.json<ErrorResponse>({ status: 'error', message: 'Corrupt track data' }, 500);
  }

  const lbKey = `lb:${id}`;
  const [playerCount, username] = await Promise.all([
    redis.zCard(lbKey),
    reddit.getCurrentUsername(),
  ]);

  let averageScore: number | null = null;
  let completed = false;

  if (playerCount > 0) {
    const [entries, myScore] = await Promise.all([
      redis.zRange(lbKey, 0, playerCount - 1, { by: 'rank' }),
      username ? redis.zScore(lbKey, username) : Promise.resolve(undefined),
    ]);
    averageScore = entries.reduce((sum, e) => sum + e.score, 0) / entries.length;
    completed = myScore !== undefined;
  }

  return c.json<TrackStatsResponse>({
    type: 'track_stats', trackId: id, pieceCount, playerCount, averageScore, completed,
  });
});

// ── Mine tracks (user drafts, not yet published) ──────────────────────────────

type MineTrackRecord = MineTrackMeta & { author: string; data: string };

api.post('/mine-track', async (c) => {
  const username = await reddit.getCurrentUsername();
  if (!username) {
    return c.json<ErrorResponse>({ status: 'error', message: 'Not logged in' }, 401);
  }

  let body: SaveMineTrackRequest;
  try {
    body = await c.req.json<SaveMineTrackRequest>();
  } catch {
    return c.json<ErrorResponse>({ status: 'error', message: 'Invalid JSON body' }, 400);
  }

  const { name, data } = body;
  if (!name || !data) {
    return c.json<ErrorResponse>({ status: 'error', message: 'Missing required fields' }, 400);
  }

  const nameError = validateTrackName(name);
  if (nameError) {
    return c.json<ErrorResponse>({ status: 'error', message: nameError }, 400);
  }

  let id = body.id;
  let createdAt: number;
  let verified = false;
  let uploadedId: string | undefined;

  if (id) {
    // Update existing — verify ownership first.
    const existing = await redis.get(`mine-track:${id}`);
    if (!existing) {
      return c.json<ErrorResponse>({ status: 'error', message: 'Track not found' }, 404);
    }
    const rec = JSON.parse(existing) as MineTrackRecord;
    if (rec.author !== username) {
      return c.json<ErrorResponse>({ status: 'error', message: 'Forbidden' }, 403);
    }
    // Preserve non-data fields from the existing record.
    createdAt  = rec.createdAt;
    verified   = rec.verified;
    uploadedId = rec.uploadedId;
  } else {
    id        = `${username}_${Date.now()}`;
    createdAt = Date.now();
  }

  const record: MineTrackRecord = {
    id, name, author: username, createdAt, verified,
    ...(uploadedId ? { uploadedId } : {}),
    data,
  };
  await redis.set(`mine-track:${id}`, JSON.stringify(record));
  await redis.zAdd(`mine:${username}`, { score: createdAt, member: id });

  return c.json<SaveMineTrackResponse>({ type: 'save_mine_track', id, createdAt });
});

api.get('/mine-tracks', async (c) => {
  const username = await reddit.getCurrentUsername();
  if (!username) {
    return c.json<ErrorResponse>({ status: 'error', message: 'Not logged in' }, 401);
  }

  const total = await redis.zCard(`mine:${username}`);
  if (total === 0) {
    return c.json<MineTracksResponse>({ type: 'mine_tracks', tracks: [] });
  }

  // Newest first (reverse).
  const ids  = await redis.zRange(`mine:${username}`, 0, total - 1, { by: 'rank', reverse: true });
  const raws = await redis.mGet(ids.map(({ member }) => `mine-track:${member}`));

  const tracks: MineTrackMeta[] = [];
  for (const raw of raws) {
    if (!raw) continue;
    try {
      const r = JSON.parse(raw) as MineTrackRecord;
      tracks.push({
        id: r.id, name: r.name, createdAt: r.createdAt,
        verified: r.verified,
        ...(r.uploadedId ? { uploadedId: r.uploadedId } : {}),
      });
    } catch { /* skip corrupt */ }
  }

  return c.json<MineTracksResponse>({ type: 'mine_tracks', tracks });
});

api.get('/mine-track/:id', async (c) => {
  const username = await reddit.getCurrentUsername();
  if (!username) {
    return c.json<ErrorResponse>({ status: 'error', message: 'Not logged in' }, 401);
  }

  const { id } = c.req.param();
  const raw = await redis.get(`mine-track:${id}`);
  if (!raw) {
    return c.json<ErrorResponse>({ status: 'error', message: 'Track not found' }, 404);
  }

  const r = JSON.parse(raw) as MineTrackRecord;
  if (r.author !== username) {
    return c.json<ErrorResponse>({ status: 'error', message: 'Forbidden' }, 403);
  }

  return c.json<MineTrackResponse>({
    type: 'mine_track',
    meta: {
      id: r.id, name: r.name, createdAt: r.createdAt, verified: r.verified,
      ...(r.uploadedId ? { uploadedId: r.uploadedId } : {}),
    },
    data: r.data,
  });
});

api.delete('/mine-track/:id', async (c) => {
  const username = await reddit.getCurrentUsername();
  if (!username) {
    return c.json<ErrorResponse>({ status: 'error', message: 'Not logged in' }, 401);
  }

  const { id } = c.req.param();
  const raw = await redis.get(`mine-track:${id}`);
  if (!raw) {
    return c.json<ErrorResponse>({ status: 'error', message: 'Track not found' }, 404);
  }

  const r = JSON.parse(raw) as MineTrackRecord;
  if (r.author !== username) {
    return c.json<ErrorResponse>({ status: 'error', message: 'Forbidden' }, 403);
  }

  await redis.del(`mine-track:${id}`);
  await redis.zRem(`mine:${username}`, [id]);

  return c.json({ type: 'delete_mine_track', id });
});

api.patch('/mine-track/:id/verify', async (c) => {
  const username = await reddit.getCurrentUsername();
  if (!username) {
    return c.json<ErrorResponse>({ status: 'error', message: 'Not logged in' }, 401);
  }

  const { id } = c.req.param();
  const raw = await redis.get(`mine-track:${id}`);
  if (!raw) {
    return c.json<ErrorResponse>({ status: 'error', message: 'Track not found' }, 404);
  }

  const r = JSON.parse(raw) as MineTrackRecord;
  if (r.author !== username) {
    return c.json<ErrorResponse>({ status: 'error', message: 'Forbidden' }, 403);
  }

  r.verified = true;
  await redis.set(`mine-track:${id}`, JSON.stringify(r));

  return c.json({ type: 'verify_mine_track', id });
});

api.patch('/mine-track/:id/publish', async (c) => {
  const username = await reddit.getCurrentUsername();
  if (!username) {
    return c.json<ErrorResponse>({ status: 'error', message: 'Not logged in' }, 401);
  }

  const { id } = c.req.param();
  let communityId: string;
  try {
    const body = await c.req.json<{ communityId: string }>();
    communityId = body.communityId;
    if (!communityId) throw new Error('missing');
  } catch {
    return c.json<ErrorResponse>({ status: 'error', message: 'Missing communityId' }, 400);
  }

  const raw = await redis.get(`mine-track:${id}`);
  if (!raw) {
    return c.json<ErrorResponse>({ status: 'error', message: 'Track not found' }, 404);
  }

  const r = JSON.parse(raw) as MineTrackRecord;
  if (r.author !== username) {
    return c.json<ErrorResponse>({ status: 'error', message: 'Forbidden' }, 403);
  }

  r.uploadedId = communityId;
  await redis.set(`mine-track:${id}`, JSON.stringify(r));

  return c.json({ type: 'publish_mine_track', id, communityId });
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
    // Batch-fetch all candidates; take first 3 that actually have ghost data.
    // (A leaderboard entry may exist without ghost data if the upload failed.)
    const raws = await redis.mGet(members.map(u => `ghost:${trackId}:${u}`));
    for (let i = 0; i < raws.length && ghosts.length < 3; i++) {
      const raw = raws[i];
      if (!raw) continue;
      try {
        const g = JSON.parse(raw) as Record<string, unknown>;
        g.author = members[i];
        ghosts.push(JSON.stringify(g));
      } catch { /* skip malformed */ }
    }
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

// Aggregate top-10 points per player across a set of track leaderboards.
// Shared by the overall leaderboard and the per-category profile stats.
async function pointsTotalsForTracks(trackIds: string[]): Promise<Map<string, { points: number; tracksPlayed: number }>> {
  const totals = new Map<string, { points: number; tracksPlayed: number }>();
  if (trackIds.length === 0) return totals;

  const perTrack = await Promise.all(
    trackIds.map(id => redis.zRange(`lb:${id}`, 0, POINTS.length - 1, { by: 'rank' })),
  );
  for (const entries of perTrack) {
    entries.forEach(({ member }, idx) => {
      const pts = POINTS[idx] ?? 0;
      const cur = totals.get(member) ?? { points: 0, tracksPlayed: 0 };
      totals.set(member, { points: cur.points + pts, tracksPlayed: cur.tracksPlayed + 1 });
    });
  }
  return totals;
}

api.get('/leaderboard/overall', async (c) => {
  // Discover all tracks that have at least one ghost uploaded.
  const trackIds = await redis.hKeys('lb:tracks');
  const totals = await pointsTotalsForTracks(trackIds);

  // Sort highest points first.
  const sorted: OverallLeaderboardEntry[] = [...totals.entries()]
    .map(([username, { points, tracksPlayed }]) => ({ username, points, tracksPlayed }))
    .sort((a, b) => b.points - a.points);

  return c.json<OverallLeaderboardResponse>({ type: 'overall_leaderboard', entries: sorted });
});

// ── Profile stats ─────────────────────────────────────────────────────────────

async function categoryStats(trackIds: string[], username: string): Promise<UserStatsCategory> {
  if (trackIds.length === 0) return { finished: 0, rank: null, points: 0 };

  const [totals, myScores] = await Promise.all([
    pointsTotalsForTracks(trackIds),
    Promise.all(trackIds.map(id => redis.zScore(`lb:${id}`, username))),
  ]);

  const sorted = [...totals.entries()].sort((a, b) => b[1].points - a[1].points);
  const myIdx  = sorted.findIndex(([u]) => u === username);

  return {
    finished: myScores.filter(s => s !== undefined).length,
    rank:     myIdx >= 0 ? myIdx + 1 : null,
    points:   totals.get(username)?.points ?? 0,
  };
}

api.get('/user/stats', async (c) => {
  const username = await reddit.getCurrentUsername();
  if (!username) {
    return c.json<ErrorResponse>({ status: 'error', message: 'Not logged in' }, 401);
  }

  const [dailySchedule, communityTotal, lbTrackIds] = await Promise.all([
    redis.hGetAll('daily:schedule') as Promise<Record<string, string>>,
    redis.zCard('tracks:community'),
    redis.hKeys('lb:tracks'),
  ]);

  const dailyTrackIdSet = new Set(Object.values(dailySchedule));
  const communityIds = communityTotal > 0
    ? (await redis.zRange('tracks:community', 0, communityTotal - 1, { by: 'rank' })).map(e => e.member)
    : [];
  const communityTrackIdSet = new Set(communityIds);

  // A track promoted to Daily is scored under Daily only, not double-counted under Community.
  const dailyLbIds     = lbTrackIds.filter(id => dailyTrackIdSet.has(id));
  const communityLbIds = lbTrackIds.filter(id => !dailyTrackIdSet.has(id) && communityTrackIdSet.has(id));

  const [daily, community, createdRaws] = await Promise.all([
    categoryStats(dailyLbIds, username),
    categoryStats(communityLbIds, username),
    communityIds.length > 0 ? redis.mGet(communityIds.map(id => `track:${id}`)) : Promise.resolve([]),
  ]);

  const created = createdRaws.filter(raw => {
    if (!raw) return false;
    try { return (JSON.parse(raw) as { author: string }).author === username; }
    catch { return false; }
  }).length;

  return c.json<UserStatsResponse>({ type: 'user_stats', username, daily, community, created });
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
