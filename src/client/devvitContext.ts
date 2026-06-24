import { context } from '@devvit/web/client';

// Reddit username of the current viewer. Empty string when running outside
// of the Devvit runtime (local dev) or when the user is not logged in.
export const username: string = context.username ?? '';

export const isLoggedIn = username.length > 0;
