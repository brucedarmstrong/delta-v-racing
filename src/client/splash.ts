import '@mdi/font/css/materialdesignicons.min.css';
import { requestExpandedMode } from '@devvit/web/client';
import { username, isLoggedIn, appVersion, postData } from './devvitContext';
import { drawBarriersOnCanvas, drawMarkersOnCanvas, onMarkerSpritesReady } from './track/TrackBarrierCanvas';
import { drawMiniCar } from './track/CarShape';
import { trackBounds } from './track/TrackLayout';
import { convertGmsTrack, convertGmsMarkers, type GmsTrack } from './track/convertGmsTrack';
import ovalSmallJson from './tracks/gms/Oval_Small.json';
import type { CommunityTrackResponse, TrackStatsResponse, UserStatsCategory, UserStatsResponse, MigrationExportResponse } from '../shared/api';
import type { TrackPayload } from './track/TrackUpload';
import { fetchIsMod, fetchMigrationExport, importMigrationData, importGhosts, importAiGhosts } from './track/TrackUpload';
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

const playBtn       = document.getElementById('play-btn')          as HTMLButtonElement;
const profileBtn    = document.getElementById('profile-btn')       as HTMLButtonElement;
const communityBtn  = document.getElementById('community-btn')     as HTMLButtonElement;
const lbBtn         = document.getElementById('leaderboard-btn')   as HTMLButtonElement;
const createBtn     = document.getElementById('create-btn')        as HTMLButtonElement;
const buildStampEl  = document.getElementById('build-stamp')       as HTMLDivElement;
const trackInfoEl   = document.getElementById('track-info')        as HTMLDivElement;
const trackThumb    = document.getElementById('track-thumb')       as HTMLCanvasElement;
const attractThumb  = document.getElementById('attract-thumb')     as HTMLCanvasElement;
const trackNameEl   = document.getElementById('track-info-name')   as HTMLDivElement;
const trackAuthorEl = document.getElementById('track-info-author') as HTMLDivElement;
const trackStatsEl  = document.getElementById('track-stats')       as HTMLDivElement;
const statPiecesEl  = document.getElementById('stat-pieces')       as HTMLDivElement;
const statPlayersEl = document.getElementById('stat-players')      as HTMLDivElement;
const statAvgEl     = document.getElementById('stat-avg')          as HTMLDivElement;
const trackCompletedEl = document.getElementById('track-completed') as HTMLDivElement;

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

  fetch(`/api/track/${encodeURIComponent(trackId)}/stats`)
    .then(r => r.json() as Promise<TrackStatsResponse>)
    .then(stats => {
      trackStatsEl.style.display = 'flex';
      statPiecesEl.textContent  = String(stats.pieceCount);
      statPlayersEl.textContent = String(stats.playerCount);
      statAvgEl.textContent     = stats.averageScore != null ? stats.averageScore.toFixed(2) : '–';

      if (username) {
        trackCompletedEl.style.display = 'block';
        trackCompletedEl.textContent   = stats.completed ? '✓ Completed' : 'Not completed yet';
        trackCompletedEl.className     = `track-completed ${stats.completed ? 'is-done' : 'is-not-done'}`;
      }
    })
    .catch(() => { /* stats stay hidden */ });
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

// ── Profile stats dialog ─────────────────────────────────────────────────────

let profileDialogEl: HTMLElement | null = null;

function closeProfileDialog(): void {
  profileDialogEl?.remove();
  profileDialogEl = null;
}

function mkCategoryRow(icon: string, label: string, stats: UserStatsCategory): HTMLElement {
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid #22224a;';

  const iconEl = document.createElement('i');
  iconEl.className = `mdi mdi-${icon}`;
  iconEl.style.cssText = 'font-size:22px;color:#8899ff;flex:0 0 auto;width:26px;text-align:center;';

  const body = document.createElement('div');
  body.style.cssText = 'flex:1;min-width:0;';

  const labelEl = document.createElement('div');
  labelEl.textContent = label;
  labelEl.style.cssText = 'font:bold 13px "Arial Black",Arial,sans-serif;color:#ccddff;margin-bottom:3px;';

  const figuresEl = document.createElement('div');
  figuresEl.style.cssText = 'font:12px Arial,sans-serif;color:#8888aa;display:flex;gap:12px;flex-wrap:wrap;';
  figuresEl.innerHTML = `
    <span>Finished <b style="color:#ccccee">${stats.finished}</b></span>
    <span>Rank <b style="color:#ccccee">${stats.rank != null ? `#${stats.rank}` : '—'}</b></span>
    <span>Points <b style="color:#ccccee">${stats.points}</b></span>
  `;

  body.appendChild(labelEl);
  body.appendChild(figuresEl);
  row.appendChild(iconEl);
  row.appendChild(body);
  return row;
}

function mkCreatedRow(icon: string, label: string, count: number): HTMLElement {
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;align-items:center;gap:12px;padding:10px 0;';

  const iconEl = document.createElement('i');
  iconEl.className = `mdi mdi-${icon}`;
  iconEl.style.cssText = 'font-size:22px;color:#8899ff;flex:0 0 auto;width:26px;text-align:center;';

  const body = document.createElement('div');
  body.style.cssText = 'flex:1;min-width:0;';

  const labelEl = document.createElement('div');
  labelEl.textContent = label;
  labelEl.style.cssText = 'font:bold 13px "Arial Black",Arial,sans-serif;color:#ccddff;margin-bottom:3px;';

  const figuresEl = document.createElement('div');
  figuresEl.style.cssText = 'font:12px Arial,sans-serif;color:#8888aa;';
  figuresEl.innerHTML = `<b style="color:#ccccee">${count}</b> track${count === 1 ? '' : 's'}`;

  body.appendChild(labelEl);
  body.appendChild(figuresEl);
  row.appendChild(iconEl);
  row.appendChild(body);
  return row;
}

function showProfileStatsDialog(): void {
  closeProfileDialog();

  const overlay = document.createElement('div');
  overlay.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:2000',
    'display:flex', 'align-items:center', 'justify-content:center',
    'background:rgba(0,0,0,0.82)', 'padding:16px', 'box-sizing:border-box',
  ].join(';');
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeProfileDialog(); });
  profileDialogEl = overlay;

  const card = document.createElement('div');
  card.style.cssText = [
    'background:#12122a', 'border:1.5px solid #6666cc', 'border-radius:10px',
    'padding:20px 20px 18px', 'max-width:340px', 'width:100%',
    'box-sizing:border-box', 'position:relative', 'font-family:Arial,sans-serif',
  ].join(';');

  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  closeBtn.style.cssText = 'position:absolute;top:10px;right:10px;background:none;border:none;color:#8888aa;font-size:18px;cursor:pointer;padding:4px;line-height:1;';
  closeBtn.addEventListener('click', closeProfileDialog);

  const heading = document.createElement('div');
  heading.textContent = 'Profile Stats';
  heading.style.cssText = 'font:bold 18px "Arial Black",Arial,sans-serif;color:#aaccff;margin-bottom:2px;';

  card.appendChild(closeBtn);
  card.appendChild(heading);

  if (!isLoggedIn) {
    const msg = document.createElement('div');
    msg.textContent = 'Log in to Reddit to see your stats.';
    msg.style.cssText = 'font:13px Arial,sans-serif;color:#8888aa;padding:8px 0 4px;';
    card.appendChild(msg);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    return;
  }

  const usernameLine = document.createElement('div');
  usernameLine.textContent = `u/${username}`;
  usernameLine.style.cssText = 'font:13px Arial,sans-serif;color:#8899ff;margin-bottom:14px;';
  card.appendChild(usernameLine);

  const body = document.createElement('div');
  body.style.cssText = 'font:14px Arial,sans-serif;color:#aaaacc;';
  body.textContent = 'Loading…';
  card.appendChild(body);

  overlay.appendChild(card);
  document.body.appendChild(overlay);

  fetch('/api/user/stats')
    .then(r => r.json() as Promise<UserStatsResponse>)
    .then(stats => {
      body.textContent = '';
      body.appendChild(mkCategoryRow('calendar-month', 'Daily Tracks', stats.daily));
      body.appendChild(mkCategoryRow('earth', 'Community Tracks', stats.community));
      body.appendChild(mkCreatedRow('pencil-ruler', 'Created', stats.created));

      const seeAllBtn = document.createElement('button');
      seeAllBtn.textContent = 'See all your tracks ›';
      seeAllBtn.style.cssText = [
        'display:block', 'width:100%', 'padding:11px 0', 'margin-top:16px',
        'background:#22224a', 'color:#ccccff', 'border:1.5px solid #6666cc',
        'border-radius:6px', 'font:bold 14px Arial,sans-serif', 'cursor:pointer',
      ].join(';');
      seeAllBtn.addEventListener('click', (e) => {
        closeProfileDialog();
        localStorage.setItem('dv-route', 'community');
        localStorage.setItem('dv-route-mine', '1');
        requestExpandedMode(e, 'game');
      });
      body.appendChild(seeAllBtn);
    })
    .catch(() => {
      body.textContent = 'Failed to load stats.';
      body.style.color = '#885555';
    });
}

profileBtn.addEventListener('click', showProfileStatsDialog);

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

// ── Migration tool (temporary, dev -> prod track transfer) ──────────────────
// TODO(pre-production): delete this section plus the /api/migration/* routes
// and TrackUpload fetch helpers once the launch migration has been run.

function showMigrationDialog(): void {
  const overlay = document.createElement('div');
  overlay.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:3000',
    'display:flex', 'align-items:center', 'justify-content:center',
    'background:rgba(0,0,0,0.85)', 'padding:16px', 'box-sizing:border-box',
  ].join(';');
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  const card = document.createElement('div');
  card.style.cssText = [
    'background:#12122a', 'border:1.5px solid #6666cc', 'border-radius:10px',
    'padding:20px', 'max-width:520px', 'width:100%', 'max-height:85vh', 'overflow:auto',
    'box-sizing:border-box', 'font-family:Arial,sans-serif', 'color:#ccccee',
  ].join(';');

  const heading = document.createElement('div');
  heading.textContent = 'Migration Tool (mod only)';
  heading.style.cssText = 'font:bold 16px "Arial Black",Arial,sans-serif;color:#aaccff;margin-bottom:10px;';
  card.appendChild(heading);

  const status = document.createElement('div');
  status.style.cssText = 'font:12px Arial,sans-serif;color:#8888aa;margin-bottom:10px;min-height:16px;';
  card.appendChild(status);

  const exportBtn = document.createElement('button');
  exportBtn.textContent = 'Export from this subreddit';
  exportBtn.style.cssText = 'padding:8px 14px;margin-bottom:8px;background:#22224a;color:#ccccff;border:1.5px solid #6666cc;border-radius:6px;font:bold 13px Arial,sans-serif;cursor:pointer;';
  card.appendChild(exportBtn);

  const exportArea = document.createElement('textarea');
  exportArea.readOnly = true;
  exportArea.placeholder = 'Click Export, then copy this and paste it into the Import box on the target subreddit.';
  exportArea.style.cssText = 'width:100%;height:120px;box-sizing:border-box;margin-bottom:16px;font:11px monospace;background:#0a0a1a;color:#aaccff;border:1px solid #444488;border-radius:6px;padding:8px;';
  card.appendChild(exportArea);

  exportBtn.addEventListener('click', () => {
    status.textContent = 'Exporting…';
    fetchMigrationExport()
      .then(data => {
        exportArea.value = JSON.stringify(data);
        exportArea.select();
        status.textContent = `Exported ${data.communityTracks.length} community track(s), ${data.myDrafts.length} draft(s), `
          + `${data.ghosts.length} ghost(s), ${data.aiGhosts.length} AI ghost(s).`;
      })
      .catch(() => { status.textContent = 'Export failed.'; });
  });

  const importArea = document.createElement('textarea');
  importArea.placeholder = 'Paste exported JSON here, then click Import.';
  importArea.style.cssText = 'width:100%;height:120px;box-sizing:border-box;margin-bottom:8px;font:11px monospace;background:#0a0a1a;color:#aaccff;border:1px solid #444488;border-radius:6px;padding:8px;';
  card.appendChild(importArea);

  const importBtn = document.createElement('button');
  importBtn.textContent = 'Import into this subreddit';
  importBtn.style.cssText = 'padding:8px 14px;background:#22224a;color:#ccccff;border:1.5px solid #6666cc;border-radius:6px;font:bold 13px Arial,sans-serif;cursor:pointer;';
  card.appendChild(importBtn);

  importBtn.addEventListener('click', () => {
    let payload: Partial<MigrationExportResponse>;
    try { payload = JSON.parse(importArea.value); } catch {
      status.textContent = 'Invalid JSON.';
      return;
    }
    status.textContent = 'Importing…';
    Promise.all([
      importMigrationData({ communityTracks: payload.communityTracks ?? [], myDrafts: payload.myDrafts ?? [] }),
      importGhosts(payload.ghosts ?? []),
      importAiGhosts(payload.aiGhosts ?? []),
    ])
      .then(([tracks, ghosts, aiGhosts]) => {
        status.textContent = `Imported ${tracks.communityCount} community track(s), ${tracks.draftCount} draft(s), `
          + `${ghosts.count} ghost(s), ${aiGhosts.count} AI ghost(s).`;
      })
      .catch(() => { status.textContent = 'Import failed.'; });
  });

  const closeBtn = document.createElement('button');
  closeBtn.textContent = 'Close';
  closeBtn.style.cssText = 'display:block;margin-top:16px;padding:8px 14px;background:none;color:#8888aa;border:1px solid #444488;border-radius:6px;font:13px Arial,sans-serif;cursor:pointer;';
  closeBtn.addEventListener('click', () => overlay.remove());
  card.appendChild(closeBtn);

  overlay.appendChild(card);
  document.body.appendChild(overlay);
}

if (new URLSearchParams(location.search).get('migrate') === '1') {
  fetchIsMod().then(isMod => { if (isMod) showMigrationDialog(); });
}
