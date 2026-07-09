import { requestExpandedMode } from '@devvit/web/client';
import { username, appVersion, postData } from './devvitContext';
import { drawBarriersOnCanvas, drawMarkersOnCanvas } from './track/TrackBarrierCanvas';
import { trackBounds } from './track/TrackLayout';
import { convertGmsTrack, convertGmsMarkers, type GmsTrack } from './track/convertGmsTrack';
import ovalSmallJson from './tracks/gms/Oval_Small.json';
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
const attractThumb  = document.getElementById('attract-thumb')     as HTMLCanvasElement;
const trackNameEl   = document.getElementById('track-info-name')   as HTMLDivElement;
const trackAuthorEl = document.getElementById('track-info-author') as HTMLDivElement;

if (username) {
  usernameEl.textContent = `u/${username}`;
}

buildStampEl.textContent = appVersion;

// ── Ghost path animation ──────────────────────────────────────────────────────

// Trail colors match the game's ghost slot colours (Game.ts GhostState.trailTint).
const GHOST_COLORS = ['#44dddd', '#ff9933', '#aa44cc'];
const GRID_PX      = 24;
const TURN_MS      = 220;  // animation ms per race turn
const FADE_MS      = 700;  // ms to fade the full trail out before restarting
const LINE_ALPHA   = 0.45; // matches game ghost trail line alpha
const DOT_ALPHA    = 0.55; // matches game ghost trail dot alpha

type Vec2 = { x: number; y: number };

type GhostAnim = {
  path:      Vec2[];
  color:     string;
  phase:     'running' | 'fading';
  stepF:     number;   // fractional step through path (0 → path.length-1)
  fadeAlpha: number;   // 1→0 during fading phase
};

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

// Draws the trail from pts[0] up to the interpolated current position.
// globalAlpha is multiplied into the trail and dot colours for fade-out.
function drawGhostTrail(
  ctx:         CanvasRenderingContext2D,
  pts:         Vec2[],
  stepF:       number,
  color:       string,
  lineW:       number,
  dotR:        number,
  globalAlpha: number,
): void {
  const ia  = Math.min(Math.floor(stepF), pts.length - 2);
  const frac = stepF - Math.floor(stepF);
  const ib  = Math.min(ia + 1, pts.length - 1);
  const hx  = pts[ia].x + (pts[ib].x - pts[ia].x) * frac; // current (head) x
  const hy  = pts[ia].y + (pts[ib].y - pts[ia].y) * frac; // current (head) y

  if (ia < 0) {
    // Nothing drawn yet — just the leading dot
    ctx.beginPath();
    ctx.arc(pts[0].x, pts[0].y, dotR, 0, Math.PI * 2);
    ctx.fillStyle = color + Math.round(globalAlpha * 255).toString(16).padStart(2, '0');
    ctx.fill();
    return;
  }

  const lineAlphaHex = Math.round(LINE_ALPHA * globalAlpha * 255).toString(16).padStart(2, '0');
  const dotAlphaHex  = Math.round(DOT_ALPHA  * globalAlpha * 255).toString(16).padStart(2, '0');
  const headAlphaHex = Math.round(globalAlpha * 255).toString(16).padStart(2, '0');

  // All trail line segments in one batched stroke call
  ctx.beginPath();
  ctx.strokeStyle = color + lineAlphaHex;
  ctx.lineWidth   = lineW;
  ctx.lineCap     = 'round';
  for (let j = 0; j < ia; j++) {
    ctx.moveTo(pts[j].x, pts[j].y);
    ctx.lineTo(pts[j + 1].x, pts[j + 1].y);
  }
  // Current (partial) segment to interpolated head position
  ctx.moveTo(pts[ia].x, pts[ia].y);
  ctx.lineTo(hx, hy);
  ctx.stroke();

  // All waypoint dots in one batched fill call
  ctx.fillStyle = color + dotAlphaHex;
  ctx.beginPath();
  for (let j = 0; j <= ia; j++) {
    ctx.moveTo(pts[j].x + dotR, pts[j].y);
    ctx.arc(pts[j].x, pts[j].y, dotR, 0, Math.PI * 2);
  }
  ctx.fill();

  // Leading dot — slightly larger and fully opaque
  ctx.beginPath();
  ctx.arc(hx, hy, dotR * 1.4, 0, Math.PI * 2);
  ctx.fillStyle = color + headAlphaHex;
  ctx.fill();
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

      const lineW = Math.max(1,   2 * p.scale);
      const dotR  = Math.max(1.5, 3 * p.scale);

      // Stagger: ghost i starts i/n of the way through its path so they
      // appear spread around the track on first load.
      const anims: GhostAnim[] = paths.map((path, gi) => ({
        path,
        color:     GHOST_COLORS[gi % GHOST_COLORS.length],
        phase:     'running' as const,
        stepF:     (gi / paths.length) * (path.length - 1),
        fadeAlpha: 1,
      }));

      let lastT = performance.now();
      let rafId: number;

      function frame(): void {
        const now = performance.now();
        const dt  = Math.min(now - lastT, 100); // cap at 100ms to handle tab-switch
        lastT = now;

        drawStaticThumb(p);

        for (const anim of anims) {
          if (anim.phase === 'running') {
            anim.stepF += dt / TURN_MS;
            const maxStep = anim.path.length - 1;
            if (anim.stepF >= maxStep) {
              anim.stepF    = maxStep;
              anim.phase    = 'fading';
              anim.fadeAlpha = 1;
            }
            drawGhostTrail(p.ctx, anim.path, anim.stepF, anim.color, lineW, dotR, 1);
          } else {
            // Fading: draw full trail at decreasing alpha, then restart
            anim.fadeAlpha -= dt / FADE_MS;
            if (anim.fadeAlpha <= 0) {
              anim.phase = 'running';
              anim.stepF = 0;
              anim.fadeAlpha = 1;
            } else {
              drawGhostTrail(p.ctx, anim.path, anim.path.length - 1,
                             anim.color, lineW, dotR, anim.fadeAlpha);
            }
          }
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
  // Community-post view: hide attract thumb, show track info card instead.
  attractThumb.style.display = 'none';

  const trackId = postData.trackId;
  trackInfoEl.style.display = 'flex';
  trackNameEl.textContent   = postData.trackName ?? '';
  trackAuthorEl.textContent = postData.author ? `by ${postData.author}` : '';
  playBtn.textContent       = 'RACE THIS TRACK';

  fetch(`/api/track/${encodeURIComponent(trackId)}`)
    .then(r => r.json() as Promise<CommunityTrackResponse>)
    .then(json => {
      const payload = JSON.parse(json.data) as TrackPayload;
      const { pieces, markers = [], startX = 0, startY = 0, startHeading = 90 } = payload;
      const b      = trackBounds(pieces);
      const pad    = 16;
      const scaleX = (trackThumb.width  - pad * 2) / b.width;
      const scaleY = (trackThumb.height - pad * 2) / b.height;
      const scale  = Math.min(scaleX, scaleY);
      const ctx    = trackThumb.getContext('2d')!;
      const offX   = (trackThumb.width  - b.width  * scale) / 2;
      const offY   = (trackThumb.height - b.height * scale) / 2;

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

// ── Attract-mode thumbnail (Oval Small, always shown unless a community post overrides) ──

if (!postData?.trackId) {
  const pieces  = convertGmsTrack(ovalSmallJson as unknown as GmsTrack);
  const markers = convertGmsMarkers(ovalSmallJson as unknown as GmsTrack);
  const b       = trackBounds(pieces);
  const pad     = 14;
  const scaleX  = (attractThumb.width  - pad * 2) / b.width;
  const scaleY  = (attractThumb.height - pad * 2) / b.height;
  const scale   = Math.min(scaleX, scaleY);
  const ctx     = attractThumb.getContext('2d')!;
  const offX    = (attractThumb.width  - b.width  * scale) / 2;
  const offY    = (attractThumb.height - b.height * scale) / 2;

  const p: ThumbParams = {
    canvas: attractThumb, ctx,
    pieces, markers,
    startX: 1080, startY: 504, startH: 90,
    originX: b.x, originY: b.y,
    scale, offX, offY,
  };

  drawStaticThumb(p);
  startGhostAnimation(p, 'oval_small');
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
