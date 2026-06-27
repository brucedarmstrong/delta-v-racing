import { requestExpandedMode } from '@devvit/web/client';
import { username, appVersion } from './devvitContext';

const usernameEl   = document.getElementById('username')      as HTMLDivElement;
const playBtn      = document.getElementById('play-btn')      as HTMLButtonElement;
const communityBtn = document.getElementById('community-btn') as HTMLButtonElement;
const lbBtn        = document.getElementById('leaderboard-btn') as HTMLButtonElement;
const createBtn    = document.getElementById('create-btn')    as HTMLButtonElement;
const buildStampEl = document.getElementById('build-stamp')   as HTMLDivElement;

if (username) {
  usernameEl.textContent = `u/${username}`;
}

buildStampEl.textContent = appVersion;

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
