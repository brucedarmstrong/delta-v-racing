import { requestExpandedMode } from '@devvit/web/client';
import { username, appVersion } from './devvitContext';

const usernameEl   = document.getElementById('username')    as HTMLDivElement;
const playBtn      = document.getElementById('play-btn')    as HTMLButtonElement;
const buildStampEl = document.getElementById('build-stamp') as HTMLDivElement;

if (username) {
  usernameEl.textContent = `u/${username}`;
}

buildStampEl.textContent = appVersion;

playBtn.addEventListener('click', (e) => {
  requestExpandedMode(e, 'game');
});
