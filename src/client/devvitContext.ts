import { context } from '@devvit/web/client';

// Reddit username of the current viewer. Empty string outside Devvit runtime.
export const username: string = context?.username ?? '';

export const isLoggedIn = username.length > 0;

// Devvit app version (e.g. "v0.0.1.484"). Empty string outside Devvit runtime.
export const appVersion: string = context?.appVersion ?? '';

// Post ID of the current Reddit post (t3_xxxxx). Empty string outside Devvit runtime.
export const postId: string = context?.postId ?? '';

// Data embedded at post-creation time via submitCustomPost({ postData: {...} }).
// For track posts: { trackId, trackName, author }. Undefined for the hub post.
export const postData: Record<string, string> | undefined =
  context?.postData as Record<string, string> | undefined;
