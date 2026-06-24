import { Scene, GameObjects } from 'phaser';
import { STANDARD_TRACKS, type TrackEntry } from '../tracks/trackRegistry';
import { trackBounds } from '../track/TrackLayout';
import { isOnSurface } from '../track/TrackCollision';

const BG         = 0x0a0a16;
const SURFACE    = 0x12122a;
const BORDER     = 0x3a3a6a;
const BORDER_ACT = 0x6666cc;
const TAB_ACTIVE = 0x22224a;

const THUMB_W = 88;
const THUMB_H = 88;
const HEADER_H = 60;
const TAB_H    = 48;

type Tab = 'standard' | 'daily' | 'mine' | 'community';
const TABS: { id: Tab; label: string }[] = [
  { id: 'standard',  label: 'Standard'  },
  { id: 'daily',     label: 'Daily'     },
  { id: 'mine',      label: 'Mine'      },
  { id: 'community', label: 'Community' },
];

type HitZone = { x: number; y: number; w: number; h: number; action: () => void };

export class TrackSelect extends Scene {
  private activeTab: Tab = 'standard';

  // Phaser chrome (header + tabs only — immune to scroll issues at zoom=1)
  private headerGfx!:  GameObjects.Graphics;
  private headerText!: GameObjects.Text;
  private backText!:   GameObjects.Text;
  private tabGfx!:     GameObjects.Graphics;
  private tabTexts:    GameObjects.Text[] = [];
  private chromeHits:  HitZone[]         = [];

  // DOM list — native scroll, no Phaser zoom/coordinate issues
  private listEl: HTMLElement | null = null;

  constructor() { super('TrackSelect'); }

  create() {
    const cam = this.cameras.main;
    cam.setBackgroundColor(BG);
    cam.setScroll(0, 0);
    cam.setZoom(1);

    this.headerGfx  = this.add.graphics().setDepth(10);
    this.headerText = this.add.text(0, 0, 'SELECT TRACK', {
      fontFamily: 'Arial Black', fontSize: '18px',
      color: '#e8e8ff', stroke: '#000000', strokeThickness: 3,
    }).setOrigin(0.5).setDepth(11);
    this.backText = this.add.text(0, 0, '‹ Back', {
      fontFamily: 'Arial Black', fontSize: '16px', color: '#8888ff',
    }).setOrigin(0, 0.5).setDepth(11);

    this.tabGfx   = this.add.graphics().setDepth(10);
    this.tabTexts = TABS.map(t =>
      this.add.text(0, 0, t.label, {
        fontFamily: 'Arial', fontSize: '14px', color: '#7777aa',
      }).setOrigin(0.5).setDepth(11),
    );

    this.layout();
    this.scale.on('resize', () => this.layout());

    // Header / tab taps — fire immediately on pointerdown (no scroll ambiguity).
    this.input.on('pointerdown', (ptr: Phaser.Input.Pointer) => {
      if (ptr.y > HEADER_H + TAB_H) return; // below chrome — DOM list handles it
      for (const h of this.chromeHits) {
        if (ptr.x >= h.x && ptr.x <= h.x + h.w &&
            ptr.y >= h.y && ptr.y <= h.y + h.h) {
          h.action();
          return;
        }
      }
    });

    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') this.scene.start('ModeSelect');
    };
    window.addEventListener('keydown', onEsc);

    this.events.once('shutdown', () => {
      window.removeEventListener('keydown', onEsc);
      this.listEl?.remove();
      this.listEl = null;
    });
  }

  private layout(): void {
    const W   = this.scale.width;
    const pad = 14;
    this.chromeHits = [];

    // Header
    this.headerGfx.clear();
    this.headerGfx.fillStyle(SURFACE, 1);
    this.headerGfx.fillRect(0, 0, W, HEADER_H);
    this.headerGfx.lineStyle(1, BORDER, 1);
    this.headerGfx.lineBetween(0, HEADER_H, W, HEADER_H);

    this.headerText.setPosition(W / 2, HEADER_H / 2);
    this.backText.setPosition(pad + 4, HEADER_H / 2);
    this.chromeHits.push({ x: 0, y: 0, w: 100, h: HEADER_H, action: () => this.scene.start('ModeSelect') });

    // Tab bar
    const tabY = HEADER_H;
    const tabW = W / TABS.length;
    this.tabGfx.clear();
    this.tabGfx.fillStyle(SURFACE, 1);
    this.tabGfx.fillRect(0, tabY, W, TAB_H);

    TABS.forEach((tab, i) => {
      const tx       = i * tabW;
      const isActive = tab.id === this.activeTab;

      if (isActive) {
        this.tabGfx.fillStyle(TAB_ACTIVE, 1);
        this.tabGfx.fillRect(tx, tabY, tabW, TAB_H);
        this.tabGfx.lineStyle(2, BORDER_ACT, 1);
        this.tabGfx.lineBetween(tx, tabY + TAB_H, tx + tabW, tabY + TAB_H);
      }

      this.tabTexts[i]
        .setPosition(tx + tabW / 2, tabY + TAB_H / 2)
        .setColor(isActive ? '#ccccff' : '#7777aa')
        .setFontSize(isActive ? '14px' : '13px');

      this.chromeHits.push({
        x: tx, y: tabY, w: tabW, h: TAB_H,
        action: () => { this.activeTab = tab.id; this.buildList(); },
      });
    });

    this.tabGfx.lineStyle(1, BORDER, 0.5);
    this.tabGfx.lineBetween(0, tabY + TAB_H, W, tabY + TAB_H);

    this.buildList();
  }

  // ── DOM list ──────────────────────────────────────────────────────────────────

  private buildList(): void {
    this.listEl?.remove();

    const listTop = HEADER_H + TAB_H;

    const el = document.createElement('div');
    el.style.cssText = [
      'position:fixed',
      `top:${listTop}px`, 'left:0', 'right:0', 'bottom:0',
      'overflow-y:auto', '-webkit-overflow-scrolling:touch',
      'z-index:10',
      'background:#0a0a16',
      'padding:10px 14px 24px',
      'box-sizing:border-box',
    ].join(';');

    if (this.activeTab !== 'standard') {
      const msg = document.createElement('div');
      msg.textContent = 'Coming Soon';
      msg.style.cssText = 'text-align:center;color:#555588;font:20px Arial;margin-top:80px;';
      el.appendChild(msg);
    } else {
      for (const track of STANDARD_TRACKS) {
        el.appendChild(this.buildCard(track));
      }
    }

    document.body.appendChild(el);
    this.listEl = el;
  }

  private buildCard(track: TrackEntry): HTMLElement {
    const card = document.createElement('div');
    card.style.cssText = [
      'display:flex', 'align-items:center', 'gap:12px',
      'background:#12122a', 'border:1px solid #3a3a6a', 'border-radius:6px',
      'padding:10px', 'margin-bottom:10px', 'cursor:pointer',
      '-webkit-tap-highlight-color:rgba(100,100,200,0.2)',
    ].join(';');

    // Thumbnail
    const canvas  = document.createElement('canvas');
    canvas.width  = THUMB_W;
    canvas.height = THUMB_H;
    canvas.style.cssText = 'flex-shrink:0;border:1px solid #3a3a6a;border-radius:3px;';
    this.drawThumbnail(canvas, track);

    // Text
    const info = document.createElement('div');
    info.style.cssText = 'flex:1;min-width:0;';

    const name = document.createElement('div');
    name.textContent = track.name;
    name.style.cssText = 'font:bold 17px "Arial Black",Arial,sans-serif;color:#e8e8ff;margin-bottom:8px;';

    const author = document.createElement('div');
    author.textContent = `by ${track.author}`;
    author.style.cssText = 'font:13px Arial,sans-serif;color:#6666aa;';

    info.appendChild(name);
    info.appendChild(author);

    // Arrow
    const arrow = document.createElement('div');
    arrow.textContent = '›';
    arrow.style.cssText = 'font:28px Arial,sans-serif;color:#5555aa;flex-shrink:0;line-height:1;';

    card.appendChild(canvas);
    card.appendChild(info);
    card.appendChild(arrow);

    card.addEventListener('click', () => this.scene.start('Game', { trackId: track.id }));

    return card;
  }

  private drawThumbnail(canvas: HTMLCanvasElement, track: TrackEntry): void {
    const ctx = canvas.getContext('2d')!;
    const tw  = THUMB_W, th = THUMB_H;

    const b   = trackBounds(track.pieces);
    const pad = 24 * 2;
    const WL  = b.x - pad,      WT = b.y - pad;
    const WW  = b.width + pad * 2, WH = b.height + pad * 2;

    const scale = Math.min(tw / WW, th / WH);
    const offX  = (tw - WW * scale) / 2;
    const offY  = (th - WH * scale) / 2;
    const step  = Math.max(2, Math.ceil(1 / scale));
    const dot   = Math.max(1, Math.ceil(scale));

    ctx.fillStyle = '#0a0a16';
    ctx.fillRect(0, 0, tw, th);
    ctx.fillStyle = '#22cc44';

    for (let wy = WT; wy <= WT + WH; wy += step) {
      for (let wx = WL; wx <= WL + WW; wx += step) {
        if (isOnSurface(wx, wy, track.pieces)) {
          ctx.fillRect(offX + (wx - WL) * scale, offY + (wy - WT) * scale, dot, dot);
        }
      }
    }
  }
}
