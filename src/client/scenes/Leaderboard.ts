import { Scene } from 'phaser';
import { username } from '../devvitContext';
import type { OverallLeaderboardEntry, OverallLeaderboardResponse } from '../../shared/api';

const BG       = 0x0a0a16;
const SURFACE  = 0x12122a;
const BORDER   = 0x3a3a6a;
const HEADER_H = 52;

export class Leaderboard extends Scene {
  private headerGfx: Phaser.GameObjects.Graphics | null = null;
  private backText:  Phaser.GameObjects.Text     | null = null;
  private titleText: Phaser.GameObjects.Text     | null = null;
  private listEl:    HTMLElement | null = null;

  constructor() { super('Leaderboard'); }

  create() {
    const cam = this.cameras.main;
    cam.setBackgroundColor(BG);
    cam.setScroll(0, 0);
    cam.setZoom(1);

    this.headerGfx = this.add.graphics().setScrollFactor(0).setDepth(10);
    this.backText  = this.add.text(0, 0, '← Back', {
      fontFamily: 'Arial', fontSize: '15px', color: '#8888cc',
    }).setScrollFactor(0).setOrigin(0, 0.5).setDepth(11);
    this.titleText = this.add.text(0, 0, 'Overall Leaderboard', {
      fontFamily: 'Arial Black', fontSize: '18px', color: '#e8e8ff',
    }).setScrollFactor(0).setOrigin(0.5, 0.5).setDepth(11);

    this.events.on('shutdown', () => {
      this.listEl?.remove();
      this.listEl = null;
    });

    this.layout();
    this.scale.on('resize', () => this.layout());

    this.input.on('pointerdown', (ptr: Phaser.Input.Pointer) => {
      if (ptr.y < HEADER_H) {
        this.scene.start('ModeSelect');
      }
    });

    this.showLoading();
    fetch('/api/leaderboard/overall')
      .then(r => r.json() as Promise<OverallLeaderboardResponse>)
      .then(json => this.buildList(json.entries))
      .catch(() => this.showError());
  }

  private layout() {
    const W = this.scale.width;
    this.headerGfx?.clear();
    this.headerGfx?.fillStyle(SURFACE, 1);
    this.headerGfx?.fillRect(0, 0, W, HEADER_H);
    this.headerGfx?.lineStyle(1, BORDER, 1);
    this.headerGfx?.lineBetween(0, HEADER_H, W, HEADER_H);
    this.backText?.setPosition(14, HEADER_H / 2);
    this.titleText?.setPosition(W / 2, HEADER_H / 2);
  }

  private showLoading() {
    this.listEl?.remove();
    const el = this.makeContainer();
    const msg = document.createElement('div');
    msg.textContent = 'Loading…';
    msg.style.cssText = 'text-align:center;color:#555588;font:20px Arial;margin-top:60px;';
    el.appendChild(msg);
    document.body.appendChild(el);
    this.listEl = el;
  }

  private showError() {
    this.listEl?.remove();
    const el = this.makeContainer();
    const msg = document.createElement('div');
    msg.textContent = 'Failed to load leaderboard.';
    msg.style.cssText = 'text-align:center;color:#885555;font:16px Arial;margin-top:60px;';
    el.appendChild(msg);
    document.body.appendChild(el);
    this.listEl = el;
  }

  private buildList(entries: OverallLeaderboardEntry[]) {
    this.listEl?.remove();
    const el = this.makeContainer();

    if (entries.length === 0) {
      const msg = document.createElement('div');
      msg.textContent = 'No races recorded yet.';
      msg.style.cssText = 'text-align:center;color:#555588;font:16px Arial;margin-top:60px;';
      el.appendChild(msg);
      document.body.appendChild(el);
      this.listEl = el;
      return;
    }

    // Header row
    const hdr = document.createElement('div');
    hdr.style.cssText = [
      'display:grid', 'grid-template-columns:36px 1fr 80px 60px',
      'padding:6px 12px', 'color:#555588', 'font:12px Arial',
      'border-bottom:1px solid #1e1e38', 'margin-bottom:4px',
    ].join(';');
    ['#', 'Player', 'Points', 'Tracks'].forEach(label => {
      const c = document.createElement('div');
      c.textContent = label;
      hdr.appendChild(c);
    });
    el.appendChild(hdr);

    entries.forEach((entry, i) => {
      const isMe = entry.username === username;
      const row = document.createElement('div');
      row.style.cssText = [
        'display:grid', 'grid-template-columns:36px 1fr 80px 60px',
        'padding:10px 12px', 'border-radius:6px',
        'margin-bottom:4px',
        isMe
          ? 'background:#16163a;border:1px solid #3a3a8a;'
          : 'background:#111128;border:1px solid transparent;',
        'font:14px Arial', 'align-items:center',
      ].join(';');

      const rankColor = i === 0 ? '#ffd700' : i === 1 ? '#c0c0c0' : i === 2 ? '#cd7f32' : '#555588';
      const cells = [
        { text: String(i + 1),              color: rankColor,  bold: i < 3 },
        { text: entry.username,             color: isMe ? '#ccccff' : '#e8e8ff', bold: isMe },
        { text: String(entry.points),       color: '#88ccff',  bold: false },
        { text: String(entry.tracksPlayed), color: '#888899',  bold: false },
      ];

      for (const cell of cells) {
        const c = document.createElement('div');
        c.textContent = cell.text;
        c.style.cssText = `color:${cell.color};${cell.bold ? 'font-weight:bold;' : ''}overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`;
        row.appendChild(c);
      }
      el.appendChild(row);
    });

    document.body.appendChild(el);
    this.listEl = el;
  }

  private makeContainer(): HTMLElement {
    const el = document.createElement('div');
    el.style.cssText = [
      'position:fixed',
      `top:${HEADER_H}px`, 'left:0', 'right:0', 'bottom:0',
      'overflow-y:auto', '-webkit-overflow-scrolling:touch',
      'z-index:10', 'background:#0a0a16',
      'padding:10px 14px 24px', 'box-sizing:border-box',
    ].join(';');
    return el;
  }
}
