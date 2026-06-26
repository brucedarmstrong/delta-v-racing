import { context } from '@devvit/web/client';

// Reddit username of the current viewer. Empty string outside Devvit runtime.
export const username: string = context?.username ?? '';

export const isLoggedIn = username.length > 0;

// Devvit app version (e.g. "v0.0.1.484"). Empty string outside Devvit runtime.
export const appVersion: string = context?.appVersion ?? '';
