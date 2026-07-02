import { Hono } from 'hono';
import type { OnAppInstallRequest, TriggerResponse } from '@devvit/web/shared';
import type { TaskResponse } from '@devvit/scheduler';
import { context, redis, reddit } from '@devvit/web/server';
import { createPost } from '../core/post';

export const triggers = new Hono();

triggers.post('/on-app-install', async (c) => {
  try {
    const post = await createPost();
    const input = await c.req.json<OnAppInstallRequest>();

    return c.json<TriggerResponse>(
      {
        status: 'success',
        message: `Post created in subreddit ${context.subredditName} with id ${post.id} (trigger: ${input.type})`,
      },
      200
    );
  } catch (error) {
    console.error(`Error creating post: ${error}`);
    return c.json<TriggerResponse>(
      {
        status: 'error',
        message: 'Failed to create post',
      },
      400
    );
  }
});

triggers.post('/cleanup-deleted-posts', async (c) => {
  const total = await redis.zCard('tracks:community');
  if (total === 0) return c.json<TaskResponse>({});

  const ids  = await redis.zRange('tracks:community', 0, total - 1, { by: 'rank' });
  const raws = await redis.mGet(ids.map(({ member }) => `track:${member}`));

  let checked = 0;
  let removed = 0;

  for (let i = 0; i < ids.length; i++) {
    const trackId = ids[i]!.member;
    const raw = raws[i];
    if (!raw) continue;

    let record: { id: string; name: string; author: string; postUrl?: string };
    try { record = JSON.parse(raw); } catch { continue; }

    if (!record.postUrl) continue; // seeded tracks have no post

    // Extract base36 post ID from URL: /r/sub/comments/POST_ID/title/
    const pathParts = new URL(record.postUrl).pathname.split('/').filter(Boolean);
    const shortId = pathParts[3]; // index: r, sub, comments, POST_ID
    if (!shortId) continue;

    checked++;
    let postGone = false;
    try {
      const post = await reddit.getPostById(`t3_${shortId}` as `t3_${string}`);
      if (post.isRemoved()) postGone = true;
    } catch {
      postGone = true;
    }

    if (postGone) {
      await redis.zRem('tracks:community', [trackId]);
      await redis.del(`track:${trackId}`);
      await redis.del(`track-name:${record.author}:${record.name.trim().toLowerCase()}`);
      await redis.del(`track-post:t3_${shortId}`);
      removed++;
      console.log(`[cleanup] removed track ${trackId} (post gone: ${record.postUrl})`);
    }
  }

  console.log(`[cleanup] checked=${checked} removed=${removed}`);
  return c.json<TaskResponse>({});
});
