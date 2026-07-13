import { redis } from '@devvit/web/server';

// Reddit event payloads don't consistently prefix ids with the "t3_" fullname
// prefix (top-level *Id fields usually do, ids nested in V2 objects often
// don't) — normalize so lookups against track-post:{postId} always match.
export function toPostFullname(id: string): `t3_${string}` {
  return (id.startsWith('t3_') ? id : `t3_${id}`) as `t3_${string}`;
}

// Unlists a community track when its backing Reddit post is gone (removed by
// a moderator, deleted by its author, or deleted by an admin). Returns the
// track id that was removed, or null if postId isn't linked to a track.
export async function removeCommunityTrackByPostId(postId: string): Promise<string | null> {
  const key     = `track-post:${postId}`;
  const trackId = await redis.get(key);
  if (!trackId) return null;

  const raw = await redis.get(`track:${trackId}`);
  if (raw) {
    try {
      const rec = JSON.parse(raw) as { name: string; author: string };
      await redis.del(`track-name:${rec.author}:${rec.name.trim().toLowerCase()}`);
    } catch { /* skip if corrupt */ }
    await redis.del(`track:${trackId}`);
  }

  await redis.zRem('tracks:community', [trackId]);
  await redis.del(key);

  return trackId;
}
