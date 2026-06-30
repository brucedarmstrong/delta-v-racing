import { requestExpandedMode } from '@devvit/web/client';
import { username, appVersion, postData } from './devvitContext';
import { drawBarriersOnCanvas, drawMarkersOnCanvas } from './track/TrackBarrierCanvas';
import { trackBounds } from './track/TrackLayout';
import type { CommunityTrackResponse } from '../shared/api';
import type { TrackPayload } from './track/TrackUpload';

const usernameEl    = document.getElementById('username')        as HTMLDivElement;
const playBtn       = document.getElementById('play-btn')        as HTMLButtonElement;
const communityBtn  = document.getElementById('community-btn')   as HTMLButtonElement;
const lbBtn         = document.getElementById('leaderboard-btn') as HTMLButtonElement;
const createBtn     = document.getElementById('create-btn')      as HTMLButtonElement;
const buildStampEl  = document.getElementById('build-stamp')     as HTMLDivElement;
const trackInfoEl   = document.getElementById('track-info')      as HTMLDivElement;
const trackThumb    = document.getElementById('track-thumb')     as HTMLCanvasElement;
const trackNameEl   = document.getElementById('track-info-name') as HTMLDivElement;
const trackAuthorEl = document.getElementById('track-info-author') as HTMLDivElement;

if (username) {
  usernameEl.textContent = `u/${username}`;
}

buildStampEl.textContent = appVersion;

// Track post: show track info card with thumbnail and swap PLAY label.
if (postData?.trackId) {
  trackInfoEl.style.display = 'flex';
  trackNameEl.textContent   = postData.trackName ?? '';
  trackAuthorEl.textContent = postData.author ? `by ${postData.author}` : '';
  playBtn.textContent       = 'RACE THIS TRACK';

  fetch(`/api/track/${encodeURIComponent(postData.trackId)}`)
    .then(r => r.json() as Promise<CommunityTrackResponse>)
    .then(json => {
      const payload = JSON.parse(json.data) as TrackPayload;
      const { pieces, markers = [], startX = 0, startY = 0, startHeading = 90 } = payload;
      const b = trackBounds(pieces);
      const pad = 16;
      const scaleX = (trackThumb.width  - pad * 2) / b.width;
      const scaleY = (trackThumb.height - pad * 2) / b.height;
      const scale  = Math.min(scaleX, scaleY);
      const ctx = trackThumb.getContext('2d')!;
      ctx.clearRect(0, 0, trackThumb.width, trackThumb.height);
      const offX = (trackThumb.width  - b.width  * scale) / 2;
      const offY = (trackThumb.height - b.height * scale) / 2;
      drawBarriersOnCanvas(ctx, pieces, b.x, b.y, scale, scale, offX, offY, '#33bb55', 1.5);
      drawMarkersOnCanvas(ctx, startX, startY, startHeading, markers, b.x, b.y, scale, scale, offX, offY);
    })
    .catch(() => { /* thumbnail stays blank */ });
}

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
