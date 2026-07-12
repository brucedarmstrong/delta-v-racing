import { requestExpandedMode } from '@devvit/web/client';
import { username, appVersion, postData } from './devvitContext';
import { drawBarriersOnCanvas, drawMarkersOnCanvas, onMarkerSpritesReady } from './track/TrackBarrierCanvas';
import { drawMiniCar } from './track/CarShape';
import { trackBounds } from './track/TrackLayout';
import { convertGmsTrack, convertGmsMarkers, type GmsTrack } from './track/convertGmsTrack';
import ovalSmallJson from './tracks/gms/Oval_Small.json';
import type { CommunityTrackResponse } from '../shared/api';
import type { TrackPayload } from './track/TrackUpload';
import { attachGlobalUiClicks } from './audio/Sfx';

attachGlobalUiClicks();

// ── Star field ────────────────────────────────────────────────────────────────

type StarDot   = { x: number; y: number; r: number; baseA: number; twinkleAmt: number; phase: number; freq: number; color: string };
type ShootStar = { x: number; y: number; vx: number; vy: number; alpha: number; trailLen: number };

const starsCanvas = document.getElementById('stars-canvas') as HTMLCanvasElement;
const sCtx        = starsCanvas.getContext('2d')!;
let   starDots:   StarDot[]   = [];
let   shootStars: ShootStar[] = [];
let   shootCooldown = 4000 + Math.random() * 4000; // ms until first shooting star
const SHOOT_ANGLE   = Math.random() * Math.PI * 2; // fixed direction for this session

function initStarField(): void {
  starsCanvas.width  = window.innerWidth;
  starsCanvas.height = window.innerHeight;
  const w = starsCanvas.width, h = starsCanvas.height;
  starDots = [];
  const count = Math.round((w * h) / 7000);
  const colors = ['255,255,255', '210,225,255', '255,245,210'];
  for (let i = 0; i < count; i++) {
    const r = Math.random() ** 2 * 1.6 + 0.3; // bias toward small
    starDots.push({
      x:          Math.random() * w,
      y:          Math.random() * h,
      r,
      baseA:      Math.random() * 0.45 + 0.2,
      twinkleAmt: r > 1.0 ? 0.25 : 0.10,
      phase:      Math.random() * Math.PI * 2,
      freq:       Math.random() * 1.2 + 0.4,
      color:      colors[Math.floor(Math.random() * colors.length)],
    });
  }
}

function spawnShootingStar(): void {
  const w = starsCanvas.width, h = starsCanvas.height;
  // Small per-star jitter so they fan slightly, like a real meteor shower radiant.
  const angle = SHOOT_ANGLE + (Math.random() - 0.5) * 0.35;
  const speed = 420 + Math.random() * 320;
  const vx = Math.cos(angle) * speed;
  const vy = Math.sin(angle) * speed;
  // Entry point: random position along the edge the star enters from.
  let x: number, y: number;
  if (Math.abs(vx) >= Math.abs(vy)) {
    x = vx > 0 ? -10 : w + 10;
    y = Math.random() * h;
  } else {
    x = Math.random() * w;
    y = vy > 0 ? -10 : h + 10;
  }
  shootStars.push({ x, y, vx, vy, alpha: 0.9 + Math.random() * 0.1, trailLen: 70 + Math.random() * 70 });
}

let lastStarT = 0;
function tickStars(now: number): void {
  const dt = lastStarT ? Math.min((now - lastStarT) / 1000, 0.1) : 0;
  lastStarT = now;

  shootCooldown -= dt * 1000;
  if (shootCooldown <= 0) {
    spawnShootingStar();
    shootCooldown = 4000 + Math.random() * 6000;
  }

  const w = starsCanvas.width, h = starsCanvas.height;
  sCtx.clearRect(0, 0, w, h);

  // Twinkling dots
  for (const s of starDots) {
    s.phase += s.freq * dt;
    const a = Math.max(0, s.baseA + s.twinkleAmt * Math.sin(s.phase));
    sCtx.beginPath();
    sCtx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    sCtx.fillStyle = `rgba(${s.color},${a.toFixed(3)})`;
    sCtx.fill();
  }

  // Shooting stars
  shootStars = shootStars.filter(ss => {
    ss.x += ss.vx * dt;
    ss.y += ss.vy * dt;
    const pad = ss.trailLen + 10;
    if (ss.x < -pad || ss.x > w + pad || ss.y < -pad || ss.y > h + pad) return false;

    const spd = Math.sqrt(ss.vx * ss.vx + ss.vy * ss.vy);
    const nx  = ss.vx / spd, ny = ss.vy / spd;
    const tx  = ss.x - nx * ss.trailLen;
    const ty  = ss.y - ny * ss.trailLen;

    const grad = sCtx.createLinearGradient(tx, ty, ss.x, ss.y);
    grad.addColorStop(0,    `rgba(255,255,255,0)`);
    grad.addColorStop(0.55, `rgba(255,255,255,${(ss.alpha * 0.25).toFixed(3)})`);
    grad.addColorStop(1,    `rgba(255,255,255,${ss.alpha.toFixed(3)})`);

    sCtx.save();
    sCtx.lineWidth   = 1.5;
    sCtx.strokeStyle = grad;
    sCtx.beginPath();
    sCtx.moveTo(tx, ty);
    sCtx.lineTo(ss.x, ss.y);
    sCtx.stroke();

    // Bright head
    sCtx.beginPath();
    sCtx.arc(ss.x, ss.y, 1.8, 0, Math.PI * 2);
    sCtx.fillStyle = `rgba(255,255,255,${ss.alpha.toFixed(3)})`;
    sCtx.fill();
    sCtx.restore();

    return true;
  });

  requestAnimationFrame(tickStars);
}

initStarField();
window.addEventListener('resize', initStarField);
requestAnimationFrame(tickStars);

// ── DOM element references ─────────────────────────────────────────────────────

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
  const carSize = dotR * 2.6;

  if (ia < 0) {
    // Nothing drawn yet — just the leading car, facing its first move.
    const first = pts[1] ?? pts[0];
    drawMiniCar(ctx, pts[0].x, pts[0].y, first.x - pts[0].x, first.y - pts[0].y, color, globalAlpha, carSize);
    return;
  }

  const lineAlphaHex = Math.round(LINE_ALPHA * globalAlpha * 255).toString(16).padStart(2, '0');
  const dotAlphaHex  = Math.round(DOT_ALPHA  * globalAlpha * 255).toString(16).padStart(2, '0');

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

  // Leading marker — a mini car facing the direction of travel, in place of
  // the plain dot, matching the real car/ghost sprite shape.
  drawMiniCar(ctx, hx, hy, pts[ib].x - pts[ia].x, pts[ib].y - pts[ia].y, color, globalAlpha, carSize);
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
      onMarkerSpritesReady(() => drawStaticThumb(p));
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
  onMarkerSpritesReady(() => drawStaticThumb(p));
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
