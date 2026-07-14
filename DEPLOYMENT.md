# Production Deployment

How to ship a build to **r/delta_v_racing** (production), including migrating
data over from **r/delta_v_racing_dev**.

Devvit installs are per-subreddit and isolated — each install gets its own
Redis namespace. `devvit.json`'s `dev.subreddit` field only controls where
`npm run dev` (`devvit playtest`) hot-reloads; it has no effect on where the
app can be installed. Prod stays frozen on whatever version was last shipped
to it until you explicitly update it — ongoing dev work on
`delta_v_racing_dev` never touches it.

## 1. Pre-deploy check

```
npm run type-check
npm run lint
```

Grep for `TODO(pre-production)` and resolve anything that isn't the migration
tool (see step 6) — e.g. temporary testing-only relaxations that need to be
locked back down before a real launch.

## 2. Ship a build

```
npm run login      # if not already authenticated as the right account
npm run deploy      # type-check + lint + devvit upload -> new version
```

## 3. Install to production

```
devvit install delta_v_racing
```

Requires you to be a moderator of the target subreddit. This is a fresh,
empty install the first time — nothing carries over from dev automatically.

## 4. Migrate data (community tracks, drafts, ghosts)

The app has a one-time, mod-only migration tool for exactly this move:
`GET/POST /api/migration/export` + `/import` in
`src/server/routes/api.ts`, backed by a hidden dialog in `src/client/splash.ts`.

The dialog is triggered by **tapping the version number (bottom of the splash
screen) 5x within 1.5 seconds** — same hidden-gesture pattern as the FTUE
reset tap in `ModeSelect.ts`. (A `?migrate=1` URL param does *not* work:
Devvit renders the post's content in a sandboxed webview with its own URL, so
query params on the outer reddit.com post page never reach the script.)

On **r/delta_v_racing_dev**, as a moderator:
1. Open the post, tap the version number 5x quickly.
2. Click **Export** — pulls community tracks, your own drafts, leaderboard
   ghosts, and AI ghosts into one JSON blob.
3. Copy the JSON.

On **r/delta_v_racing**, as a moderator:
4. Open the post, tap the version number 5x quickly.
5. Paste the JSON into the Import box, click **Import**.
6. Check the status line for counts (tracks / drafts / ghosts / AI ghosts) to
   confirm nothing came back empty.

Note: only the exporting moderator's own drafts are included by design —
there's no index of other users' private draft tracks to enumerate, and
pulling them would be a privacy overreach for a mod-triggered tool.

## 5. Verify on prod

- Community Tracks list shows the migrated tracks.
- My Tracks shows your drafts.
- Leaderboards show existing times/ghosts on a migrated track.
- Moderator menu items appear for you on the new subreddit.
- The "Join r/delta_v_racing" button on the splash screen works (needs a real
  Devvit session — can't be verified outside `devvit playtest`/a live install).

## 6. Clean up the migration tool

Once the migration is confirmed working, remove the temporary tooling before
any *future* prod update:

```
grep -rn "TODO(pre-production)" src/
```

Delete `/api/migration/export`, `/api/migration/import`, the `?migrate=1`
dialog in `splash.ts`, and the related types/fetch helpers. `/api/seed-ghosts`
and `/api/seed-ai-ghosts` can stay if you want to keep them as general seeding
tools, or go too — your call.

## 7. Ongoing dev workflow

Nothing changes. `npm run dev` keeps targeting `delta_v_racing_dev` per
`devvit.json`, independent of whatever's installed on prod.
