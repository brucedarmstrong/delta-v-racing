import { requestExpandedMode } from '@devvit/web/client';
import { username } from './devvitContext';

const usernameEl = document.getElementById('username') as HTMLDivElement;
const playBtn    = document.getElementById('play-btn')  as HTMLButtonElement;

if (username) {
  usernameEl.textContent = `u/${username}`;
}

playBtn.addEventListener('click', (e) => {
  requestExpandedMode(e, 'game');
});
