import { Hono } from 'hono';
import type { UiResponse } from '@devvit/web/shared';
import { context } from '@devvit/web/server';
import { createPost } from '../core/post';
import { removeCommunityTrackByPostId } from '../core/trackCleanup';

export const menu = new Hono();

menu.post('/post-create', async (c) => {
  try {
    const post = await createPost();

    return c.json<UiResponse>(
      {
        navigateTo: `https://reddit.com/r/${context.subredditName}/comments/${post.id}`,
      },
      200
    );
  } catch (error) {
    console.error(`Error creating post: ${error}`);
    return c.json<UiResponse>(
      {
        showToast: 'Failed to create post',
      },
      400
    );
  }
});

menu.post('/remove-track', async (c) => {
  const { postId } = context;
  if (!postId) {
    return c.json<UiResponse>({ showToast: 'No post context' }, 400);
  }

  const trackId = await removeCommunityTrackByPostId(postId);
  if (!trackId) {
    return c.json<UiResponse>({ showToast: 'No track is linked to this post' }, 200);
  }

  console.log(`[mod remove-track] postId=${postId} trackId=${trackId}`);
  return c.json<UiResponse>({ showToast: 'Track removed from community list' }, 200);
});
