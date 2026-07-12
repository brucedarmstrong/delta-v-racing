import { Scene } from 'phaser';
import { username } from '../devvitContext';
import type { OverallLeaderboardEntry, OverallLeaderboardResponse } from '../../shared/api';

const BG       = 0x0a0a16;
const SURFACE  = 0x12122a;
const BORDER   = 0x3a3a6a;
const HEADER_H = 52;
const HELP_ZONE_W = 44; // width of the tappable "?" zone in the top-right of the header

export class Leaderboard extends Scene {
  private headerGfx: Phaser.GameObjects.Graphics | null = null;
  private backText:  Phaser.GameObjects.Text     | null = null;
  private titleText: Phaser.GameObjects.Text     | null = null;
  private helpText:  Phaser.GameObjects.Text     | null = null;
  private listEl:    HTMLElement | null = null;
  private helpOverlayEl: HTMLElement | null = null;

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
    this.helpText = this.add.text(0, 0, '?', {
      fontFamily: 'Arial', fontSize: '16px', fontStyle: 'bold', color: '#8888cc',
    }).setScrollFactor(0).setOrigin(0.5, 0.5).setDepth(11);

    this.layout();
    const onResize = () => this.layout();
    this.scale.on('resize', onResize);

    this.events.on('shutdown', () => {
      this.scale.off('resize', onResize);
      this.listEl?.remove();
      this.listEl = null;
      this.helpOverlayEl?.remove();
      this.helpOverlayEl = null;
    });

    this.input.on('pointerdown', (ptr: Phaser.Input.Pointer) => {
      if (ptr.y >= HEADER_H) return;
      if (ptr.x >= this.scale.width - HELP_ZONE_W) { this.showHelp(); return; }
      this.scene.start('ModeSelect');
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
    this.helpText?.setPosition(W - HELP_ZONE_W / 2, HEADER_H / 2);
  }

  private showHelp(): void {
    this.helpOverlayEl?.remove();

    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.80);z-index:500;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); this.helpOverlayEl = null; } });

    const card = document.createElement('div');
    card.style.cssText = 'background:#12122a;border:1px solid #3a3a6a;border-radius:10px;width:100%;max-width:340px;padding:16px 16px 20px;position:relative;';

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText = 'position:absolute;top:10px;right:10px;background:none;border:none;color:#8888aa;font-size:18px;cursor:pointer;padding:4px;line-height:1;';
    closeBtn.addEventListener('click', () => { overlay.remove(); this.helpOverlayEl = null; });

    const heading = document.createElement('div');
    heading.textContent = 'How Scoring Works';
    heading.style.cssText = 'color:#aaaaff;font:bold 15px Arial,sans-serif;margin-bottom:14px;';

    const body = document.createElement('div');
    body.style.cssText = 'font:13px Arial,sans-serif;color:#ccccdd;line-height:1.6;';
    body.innerHTML = `
      <p style="margin:0 0 10px;">Each track has its own leaderboard, ranked by best time. The top 10 finishers on <strong>every</strong> track earn points:</p>
      <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:4px 8px;margin-bottom:10px;font:12px Arial,sans-serif;text-align:center;">
        <div style="color:#ffd700;font-weight:bold;">1st: 25</div>
        <div style="color:#c0c0c0;font-weight:bold;">2nd: 18</div>
        <div style="color:#cd7f32;font-weight:bold;">3rd: 15</div>
        <div style="color:#8899bb;">4th: 12</div>
        <div style="color:#8899bb;">5th: 10</div>
        <div style="color:#8899bb;">6th: 8</div>
        <div style="color:#8899bb;">7th: 6</div>
        <div style="color:#8899bb;">8th: 4</div>
        <div style="color:#8899bb;">9th: 2</div>
        <div style="color:#8899bb;">10th: 1</div>
      </div>
      <p style="margin:0 0 10px;">Your total <strong>Points</strong> is the sum of everything you've earned across every track — placing well on more tracks beats being #1 on just one.</p>
      <p style="margin:0;">Your <strong>Tracks</strong> count is how many different tracks you've placed top 10 on.</p>
    `;

    card.appendChild(closeBtn);
    card.appendChild(heading);
    card.appendChild(body);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    this.helpOverlayEl = overlay;
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
