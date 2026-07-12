import '@mdi/font/css/materialdesignicons.min.css';
import { Boot } from './scenes/Boot';
import { GameOver } from './scenes/GameOver';
import { Game as MainGame } from './scenes/Game';
import { MainMenu } from './scenes/MainMenu';
import { ModeSelect } from './scenes/ModeSelect';
import { TrackSelect } from './scenes/TrackSelect';
import { Leaderboard } from './scenes/Leaderboard';
import { AboutScreen } from './scenes/AboutScreen';
import { TrackEditor } from './scenes/TrackEditor';
import { GridTest } from './scenes/GridTest';
import * as Phaser from 'phaser';
import { AUTO, Game } from 'phaser';
import { Preloader } from './scenes/Preloader';
import { attachGlobalUiClicks } from './audio/Sfx';

//  Find out more information about the Game Config at:
//  https://docs.phaser.io/api-documentation/typedef/types-core#gameconfig
const config: Phaser.Types.Core.GameConfig = {
  type: AUTO,
  parent: 'game-container',
  backgroundColor: '#028af8',
  scale: {
    // Keep a fixed game resolution but automatically scale it to fit within the available
    // web-view / device while maintaining aspect ratio.
    mode: Phaser.Scale.RESIZE,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width: 1024,
    height: 768,
  },
  scene: [Boot, Preloader, MainMenu, ModeSelect, TrackSelect, Leaderboard, AboutScreen, TrackEditor, GridTest, MainGame, GameOver],
};

// Global scene-transition fade: every scene.start(...) call anywhere in the
// app briefly fades a DOM overlay to black first, instead of cutting
// instantly to the next scene. Patched once, app-wide, so no individual
// scene or navigation call site needs to know about it.
const TRANSITION_MS = 150;
function ensureFxOverlay(): HTMLDivElement {
  let el = document.getElementById('scene-fx-overlay') as HTMLDivElement | null;
  if (!el) {
    el = document.createElement('div');
    el.id = 'scene-fx-overlay';
    el.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:10000', 'background:#000',
      'opacity:0', 'pointer-events:none', `transition:opacity ${TRANSITION_MS}ms ease`,
    ].join(';');
    document.body.appendChild(el);
  }
  return el;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const origSceneStart = (Phaser.Scenes.ScenePlugin.prototype as any).start;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(Phaser.Scenes.ScenePlugin.prototype as any).start = function (this: Phaser.Scenes.ScenePlugin, key?: unknown, data?: object) {
  const overlay = ensureFxOverlay();
  overlay.style.opacity = '1';
  setTimeout(() => {
    origSceneStart.call(this, key, data);
    requestAnimationFrame(() => { overlay.style.opacity = '0'; });
  }, TRANSITION_MS);
  return this;
};

const StartGame = (parent: string) => {
  return new Game({ ...config, parent });
};

document.addEventListener('DOMContentLoaded', () => {
  StartGame('game-container');
  attachGlobalUiClicks();
});
