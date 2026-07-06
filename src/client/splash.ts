import { requestExpandedMode } from '@devvit/web/client';
import { username, appVersion, postData } from './devvitContext';
import { drawBarriersOnCanvas, drawMarkersOnCanvas } from './track/TrackBarrierCanvas';
import { trackBounds } from './track/TrackLayout';
import type { CommunityTrackResponse } from '../shared/api';
import type { TrackPayload } from './track/TrackUpload';

const usernameEl    = document.getElementById('username')          as HTMLDivElement;
const playBtn       = document.getElementById('play-btn')          as HTMLButtonElement;
const communityBtn  = document.getElementById('community-btn')     as HTMLButtonElement;
const lbBtn         = document.getElementById('leaderboard-btn')   as HTMLButtonElement;
const createBtn     = document.getElementById('create-btn')        as HTMLButtonElement;
const buildStampEl  = document.getElementById('build-stamp')       as HTMLDivElement;
const trackInfoEl   = document.getElementById('track-info')        as HTMLDivElement;
const trackThumb    = document.getElementById('track-thumb')       as HTMLCanvasElement;
const trackNameEl   = document.getElementById('track-info-name')   as HTMLDivElement;
const trackAuthorEl = document.getElementById('track-info-author') as HTMLDivElement;

if (username) {
  usernameEl.textContent = `u/${username}`;
}

buildStampEl.textContent = appVersion;

// ── Ghost path animation ──────────────────────────────────────────────────────

const GHOST_COLORS = ['#00e5ff', '#ff9900', '#dd44ff'];
const GRID_PX      = 24;
const TURN_MS      = 220; // animation ms per race turn

type Vec2 = { x: number; y: number };

type ThumbParams = {
  canvas:  HTMLCanvasElement;
  ctx:     CanvasRenderingContext2D;
  pieces:  TrackPayload['pieces'];
  markers: TrackPayload['markers'];
  startX:  number;
  startY:  number;
  startH:  number;
  originX: number;
  originY: number;
  scale:   number;
  offX:    number;
  offY:    number;
};

function drawStaticThumb(p: ThumbParams): void {
  p.ctx.clearRect(0, 0, p.canvas.width, p.canvas.height);
  drawBarriersOnCanvas(p.ctx, p.pieces, p.originX, p.originY,
                       p.scale, p.scale, p.offX, p.offY, '#33bb55', 1.5);
  drawMarkersOnCanvas(p.ctx, p.startX, p.startY, p.startH, p.markers,
                      p.originX, p.originY, p.scale, p.scale, p.offX, p.offY);
}

function startGhostAnimation(p: ThumbParams, trackId: string): void {
  fetch(`/api/race-ghosts/${encodeURIComponent(trackId)}`)
    .then(r => r.json() as Promise<{ ghosts?: string[] }>)
    .then(data => {
      const raw = data.ghosts ?? [];
      if (raw.length === 0) return;

      type RawMove  = { gx: number; gy: number; crash: boolean };
      type RawGhost = { v: number; startGX: number; startGY: number; moves: RawMove[] };

      const toX = (gx: number) => p.offX + (gx * GRID_PX - p.originX) * p.scale;
      const toY = (gy: number) => p.offY + (gy * GRID_PX - p.originY) * p.scale;

      const paths: Vec2[][] = raw.flatMap(s => {
        try {
          const g = JSON.parse(s) as RawGhost;
          if (g.v !== 1) return [];
          const pts: Vec2[] = [{ x: toX(g.startGX), y: toY(g.startGY) }];
          for (const m of g.moves) {
            if (!m.crash) pts.push({ x: toX(m.gx), y: toY(m.gy) });
          }
          return pts.length >= 2 ? [pts] : [];
        } catch { return []; }
      });

      if (paths.length === 0) return;

      const maxSteps = Math.max(...paths.map(pts => pts.length - 1));
      const periodMs = maxSteps * TURN_MS;
      const t0       = performance.now();
      const dotR     = Math.max(2, 3 * p.scale);
      let   rafId: number;

      function frame(): void {
        const elapsed = performance.now() - t0;

        drawStaticThumb(p);

        for (let gi = 0; gi < paths.length; gi++) {
          const pts     = paths[gi];
          const stagger = (gi / paths.length) * periodMs;
          const t       = (elapsed + stagger) % periodMs;
          const prog    = t / TURN_MS;
          const iFloor  = Math.floor(prog);
          const frac    = prog - iFloor;
          const ia      = Math.min(iFloor,     pts.length - 2);
          const ib      = Math.min(iFloor + 1, pts.length - 1);
          const ax      = pts[ia].x;
          const ay      = pts[ia].y;
          const x       = ax + (pts[ib].x - ax) * frac;
          const y       = ay + (pts[ib].y - ay) * frac;
          const color   = GHOST_COLORS[gi % GHOST_COLORS.length];

          // Fading trail dots at previous waypoints
          for (let back = 2; back >= 1; back--) {
            const ti = Math.max(0, ia - back + 1);
            const alpha = Math.round((0.3 / back) * 255).toString(16).padStart(2, '0');
            p.ctx.beginPath();
            p.ctx.arc(pts[ti].x, pts[ti].y, dotR * 0.65, 0, Math.PI * 2);
            p.ctx.fillStyle = color + alpha;
            p.ctx.fill();
          }

          // Main dot
          p.ctx.beginPath();
          p.ctx.arc(x, y, dotR, 0, Math.PI * 2);
          p.ctx.fillStyle = color;
          p.ctx.fill();
        }

        rafId = requestAnimationFrame(frame);
      }

      rafId = requestAnimationFrame(frame);
      window.addEventListener('beforeunload', () => cancelAnimationFrame(rafId), { once: true });
    })
    .catch(() => { /* ghost fetch failed — thumbnail stays static */ });
}

// ── Track post ────────────────────────────────────────────────────────────────

if (postData?.trackId) {
  const trackId = postData.trackId;
  trackInfoEl.style.display = 'flex';
  trackNameEl.textContent   = postData.trackName ?? '';
  trackAuthorEl.textContent = postData.author ? `by ${postData.author}` : '';
  playBtn.textContent       = 'RACE THIS TRACK';

  fetch(`/api/track/${encodeURIComponent(trackId)}`)
    .then(r => r.json() as Promise<CommunityTrackResponse>)
    .then(json => {
      const payload  = JSON.parse(json.data) as TrackPayload;
      const { pieces, markers = [], startX = 0, startY = 0, startHeading = 90 } = payload;
      const b        = trackBounds(pieces);
      const pad      = 16;
      const scaleX   = (trackThumb.width  - pad * 2) / b.width;
      const scaleY   = (trackThumb.height - pad * 2) / b.height;
      const scale    = Math.min(scaleX, scaleY);
      const ctx      = trackThumb.getContext('2d')!;
      const offX     = (trackThumb.width  - b.width  * scale) / 2;
      const offY     = (trackThumb.height - b.height * scale) / 2;

      const p: ThumbParams = {
        canvas: trackThumb, ctx,
        pieces, markers,
        startX, startY, startH: startHeading ?? 90,
        originX: b.x, originY: b.y,
        scale, offX, offY,
      };

      drawStaticThumb(p);
      startGhostAnimation(p, trackId);
    })
    .catch(() => { /* thumbnail stays blank */ });
}

// ── Navigation buttons ────────────────────────────────────────────────────────

playBtn.addEventListener('click', (e) => {
  requestExpandedMode(e, 'game');
});

communityBtn.addEventListener('click', (e) => {
  localStorage.setItem('dv-route', 'community');
  requestExpandedMode(e, 'game');
});

lbBtn.addEventListener('click', (e) => {
  localStorage.setItem('dv-route', 'leaderboard');
  requestExpandedMode(e, 'game');
});

createBtn.addEventListener('click', (e) => {
  localStorage.setItem('dv-route', 'create');
  requestExpandedMode(e, 'game');
});
