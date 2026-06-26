import { Scene, GameObjects } from 'phaser';
import { STANDARD_TRACKS, type TrackEntry } from '../tracks/trackRegistry';
import { trackBounds } from '../track/TrackLayout';
import { drawBarriersOnCanvas } from '../track/TrackCanvasRenderer';
import {
  fetchCommunityTrack, fetchCommunityTracks,
  fetchMineTrack, fetchMineTracks, deleteMineTrack, publishMineTrack,
  type TrackPayload,
} from '../track/TrackUpload';
import { fetchRaceGhosts } from '../track/RaceGhosts';
import { generateAndUploadAiGhosts } from '../track/AiGhost';
import { isLoggedIn } from '../devvitContext';
import type { CommunityTrackMeta, MineTrackMeta } from '../../shared/api';

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
  private listEl:         HTMLElement | null = null;
  private contextMenuEl:  HTMLElement | null = null;
  private communityTracks: CommunityTrackMeta[] = [];
  private communityLoaded  = false;
  private mineTracks:      MineTrackMeta[]      = [];
  private mineLoaded       = false;

  constructor() { super('TrackSelect'); }

  init(data?: { activeTab?: Tab }): void {
    if (data?.activeTab) {
      this.activeTab = data.activeTab;
    }
    // Reset cached lists so switching scenes refreshes data.
    this.communityLoaded = false;
    this.mineLoaded      = false;
    this.mineTracks      = [];
    this.communityTracks = [];
  }

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
      this.closeContextMenu();
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
        action: () => {
          this.activeTab = tab.id;
          this.layout();
        },
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

    if (this.activeTab === 'standard') {
      for (const track of STANDARD_TRACKS) {
        el.appendChild(this.buildCard(track));
      }
    } else if (this.activeTab === 'community') {
      if (!this.communityLoaded) {
        const msg = document.createElement('div');
        msg.textContent = 'Loading…';
        msg.style.cssText = 'text-align:center;color:#555588;font:20px Arial;margin-top:80px;';
        el.appendChild(msg);
        fetchCommunityTracks().then(tracks => {
          this.communityTracks  = tracks;
          this.communityLoaded  = true;
          this.buildList();
        }).catch(() => {
          msg.textContent = 'Failed to load community tracks.';
        });
      } else if (this.communityTracks.length === 0) {
        const msg = document.createElement('div');
        msg.textContent = 'No community tracks yet.';
        msg.style.cssText = 'text-align:center;color:#555588;font:20px Arial;margin-top:80px;';
        el.appendChild(msg);
      } else {
        for (const meta of this.communityTracks) {
          el.appendChild(this.buildCommunityCard(meta));
        }
      }
    } else if (this.activeTab === 'mine') {
      if (!isLoggedIn) {
        const msg = document.createElement('div');
        msg.textContent = 'Log in to save and upload tracks.';
        msg.style.cssText = 'text-align:center;color:#555588;font:16px Arial;margin-top:80px;padding:0 24px;';
        el.appendChild(msg);
      } else if (!this.mineLoaded) {
        const msg = document.createElement('div');
        msg.textContent = 'Loading…';
        msg.style.cssText = 'text-align:center;color:#555588;font:20px Arial;margin-top:80px;';
        el.appendChild(msg);
        fetchMineTracks().then(tracks => {
          this.mineTracks = tracks;
          this.mineLoaded = true;
          this.buildList();
        }).catch(() => {
          msg.textContent = 'Failed to load your tracks.';
        });
      } else if (this.mineTracks.length === 0) {
        const msg = document.createElement('div');
        msg.innerHTML = 'No saved tracks yet.<br><br>Tap CREATE to build one!';
        msg.style.cssText = 'text-align:center;color:#555588;font:16px Arial;margin-top:80px;padding:0 24px;line-height:1.5;';
        el.appendChild(msg);
      } else {
        for (const meta of this.mineTracks) {
          el.appendChild(this.buildMineCard(meta));
        }
      }
    } else {
      // Daily tab — Coming Soon
      const msg = document.createElement('div');
      msg.textContent = 'Coming Soon';
      msg.style.cssText = 'text-align:center;color:#555588;font:20px Arial;margin-top:80px;';
      el.appendChild(msg);
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
      'user-select:none', '-webkit-user-select:none',
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

    card.addEventListener('click', () => {
      arrow.textContent = '…';
      card.style.opacity = '0.6';
      card.style.pointerEvents = 'none';
      fetchRaceGhosts(track.id, track)
        .then(ghosts  => this.scene.start('Game', { trackId: track.id, ghosts }))
        .catch(()     => this.scene.start('Game', { trackId: track.id }));
    });

    return card;
  }

  private static ensureSpinStyle(): void {
    if (document.getElementById('dv-spin-style')) return;
    const s = document.createElement('style');
    s.id = 'dv-spin-style';
    s.textContent = '@keyframes dv-spin{to{transform:rotate(360deg)}}';
    document.head.appendChild(s);
  }

  private buildMineCard(meta: MineTrackMeta): HTMLElement {
    const card = document.createElement('div');
    card.style.cssText = [
      'display:flex', 'align-items:flex-start', 'gap:12px',
      'background:#12122a', 'border:1px solid #3a3a6a', 'border-radius:6px',
      'padding:10px', 'margin-bottom:10px',
      'user-select:none', '-webkit-user-select:none',
    ].join(';');

    // Thumbnail — populated after fetch
    const canvas  = document.createElement('canvas');
    canvas.width  = THUMB_W;
    canvas.height = THUMB_H;
    canvas.style.cssText = 'flex-shrink:0;border:1px solid #3a3a6a;border-radius:3px;background:#0a0a16;';

    const info = document.createElement('div');
    info.style.cssText = 'flex:1;min-width:0;display:flex;flex-direction:column;gap:6px;';

    const name = document.createElement('div');
    name.textContent = meta.name;
    name.style.cssText = 'font:bold 16px "Arial Black",Arial,sans-serif;color:#e8e8ff;';

    const date = document.createElement('div');
    const d = new Date(meta.createdAt);
    date.textContent = `Saved ${d.toLocaleDateString(undefined, { month:'short', day:'numeric', year:'numeric' })}`;
    date.style.cssText = 'font:12px Arial,sans-serif;color:#555588;';

    // Action buttons row
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:6px;';

    const mkBtn = (label: string, clr: string, bg: string, border: string) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = [
        'flex:1', 'padding:7px 4px',
        `color:${clr}`, `background:${bg}`, `border:1px solid ${border}`,
        'border-radius:5px', 'font:bold 12px Arial,sans-serif', 'cursor:pointer',
        'white-space:nowrap',
      ].join(';');
      return b;
    };

    const playBtn   = mkBtn('▶ Play',   '#88ffaa', '#001a08', '#226633');
    const editBtn   = mkBtn('✎ Edit',   '#aaaaff', '#0a0a22', '#333366');
    const deleteBtn = mkBtn('✕ Del',    '#ff8888', '#1a0808', '#663333');

    // Upload button (full-width, below the 3 action buttons)
    const uploadBtn = document.createElement('button');
    const isUploaded = !!meta.uploadedId;
    const canUpload  = meta.verified && !isUploaded;

    uploadBtn.textContent = isUploaded ? '✓ Published'
      : meta.verified     ? '↑ Upload to Community'
      :                     '↑ Upload (play first)';
    uploadBtn.disabled = !canUpload;
    uploadBtn.style.cssText = [
      'width:100%', 'padding:8px 4px',
      `color:${isUploaded ? '#55aa55' : canUpload ? '#88aaff' : '#444466'}`,
      `background:${isUploaded ? '#0a1a0a' : canUpload ? '#0a0a22' : '#0a0a14'}`,
      `border:1px solid ${isUploaded ? '#226622' : canUpload ? '#334488' : '#222244'}`,
      'border-radius:5px', 'font:bold 12px Arial,sans-serif',
      `cursor:${canUpload ? 'pointer' : 'default'}`,
    ].join(';');

    btnRow.appendChild(playBtn);
    btnRow.appendChild(editBtn);
    btnRow.appendChild(deleteBtn);

    info.appendChild(name);
    info.appendChild(date);
    info.appendChild(btnRow);
    info.appendChild(uploadBtn);

    card.appendChild(canvas);
    card.appendChild(info);

    // ── Handlers ──

    playBtn.addEventListener('click', () => {
      playBtn.textContent = '…';
      playBtn.disabled = true;
      fetchMineTrack(meta.id)
        .then(({ meta: m, data }) => {
          const payload  = JSON.parse(data) as TrackPayload;
          const entry: TrackEntry = {
            id:      m.id,
            name:    m.name,
            author:  '',
            startX:  payload.startX,
            startY:  payload.startY,
            pieces:  payload.pieces,
            markers: payload.markers,
          };
          this.scene.start('Game', { track: entry, mineTrackId: m.id });
        })
        .catch(() => {
          playBtn.textContent = '▶ Play';
          playBtn.disabled = false;
        });
    });

    editBtn.addEventListener('click', () => {
      editBtn.textContent = '…';
      editBtn.disabled = true;
      fetchMineTrack(meta.id)
        .then(({ meta: m, data }) => {
          const payload = JSON.parse(data) as TrackPayload;
          const entry: TrackEntry = {
            id:      m.id,
            name:    m.name,
            author:  '',
            startX:  payload.startX,
            startY:  payload.startY,
            pieces:  payload.pieces,
            markers: payload.markers,
          };
          this.scene.start('TrackEditor', { mineTrackId: m.id, track: entry, startHeading: payload.startHeading });
        })
        .catch(() => {
          editBtn.textContent = '✎ Edit';
          editBtn.disabled = false;
        });
    });

    deleteBtn.addEventListener('click', () => {
      if (!confirm(`Delete "${meta.name}"?`)) return;
      deleteBtn.textContent = '…';
      deleteBtn.disabled = true;
      deleteMineTrack(meta.id)
        .then(() => {
          this.mineTracks = this.mineTracks.filter(t => t.id !== meta.id);
          this.buildList();
        })
        .catch(() => {
          deleteBtn.textContent = '✕ Del';
          deleteBtn.disabled = false;
        });
    });

    if (canUpload) {
      uploadBtn.addEventListener('click', () => {
        // Lock all card actions while upload is in progress.
        const cardBtns = [playBtn, editBtn, deleteBtn, uploadBtn];
        for (const b of cardBtns) b.disabled = true;

        // Replace button content with a CSS spinner.
        uploadBtn.innerHTML = '';
        const spinner = document.createElement('span');
        spinner.style.cssText = [
          'display:inline-block', 'width:14px', 'height:14px',
          'border:2px solid #334488', 'border-top-color:#88aaff',
          'border-radius:50%', 'animation:dv-spin 0.8s linear infinite',
          'vertical-align:middle',
        ].join(';');
        TrackSelect.ensureSpinStyle();
        uploadBtn.appendChild(spinner);

        const restoreOnError = () => {
          for (const b of cardBtns) b.disabled = false;
          uploadBtn.innerHTML = '';
          uploadBtn.textContent = '↑ Upload to Community';
        };

        fetchMineTrack(meta.id)
          .then(async ({ meta: m, data }) => {
            const payload = JSON.parse(data) as TrackPayload;
            const entry: TrackEntry = {
              id:      '',
              name:    m.name,
              author:  '',
              startX:  payload.startX,
              startY:  payload.startY,
              pieces:  payload.pieces,
              markers: payload.markers,
            };
            const res = await fetch('/api/track', {
              method:  'POST',
              headers: { 'Content-Type': 'application/json' },
              body:    JSON.stringify({ name: entry.name, data }),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json = await res.json() as { id: string };
            const communityId = json.id;

            await generateAndUploadAiGhosts({ ...entry, id: communityId }, ['average', 'rookie']);
            await publishMineTrack(m.id, communityId);

            const idx = this.mineTracks.findIndex(t => t.id === m.id);
            if (idx !== -1) this.mineTracks[idx] = { ...this.mineTracks[idx], uploadedId: communityId };
            this.buildList();
          })
          .catch(restoreOnError);
      });
    }

    // Load thumbnail in background
    fetchMineTrack(meta.id)
      .then(({ data }) => {
        const payload = JSON.parse(data) as TrackPayload;
        const ctx = canvas.getContext('2d');
        if (ctx) this.drawThumbnail(canvas, {
          id: meta.id, name: meta.name, author: '',
          startX: payload.startX, startY: payload.startY,
          pieces: payload.pieces, markers: payload.markers,
        });
      })
      .catch(() => { /* thumbnail stays blank */ });

    return card;
  }

  private buildCommunityCard(meta: CommunityTrackMeta): HTMLElement {
    const card = document.createElement('div');
    card.style.cssText = [
      'display:flex', 'align-items:center', 'gap:12px',
      'background:#12122a', 'border:1px solid #3a3a6a', 'border-radius:6px',
      'padding:10px', 'margin-bottom:10px', 'cursor:pointer',
      '-webkit-tap-highlight-color:rgba(100,100,200,0.2)',
      'user-select:none', '-webkit-user-select:none',
    ].join(';');

    // Placeholder thumbnail (no pieces yet — drawn after fetch)
    const canvas  = document.createElement('canvas');
    canvas.width  = THUMB_W;
    canvas.height = THUMB_H;
    canvas.style.cssText = 'flex-shrink:0;border:1px solid #3a3a6a;border-radius:3px;background:#0a0a16;';

    const info = document.createElement('div');
    info.style.cssText = 'flex:1;min-width:0;';

    const name = document.createElement('div');
    name.textContent = meta.name;
    name.style.cssText = 'font:bold 17px "Arial Black",Arial,sans-serif;color:#e8e8ff;margin-bottom:8px;';

    const author = document.createElement('div');
    author.textContent = `by ${meta.author}`;
    author.style.cssText = 'font:13px Arial,sans-serif;color:#6666aa;';

    info.appendChild(name);
    info.appendChild(author);

    const arrow = document.createElement('div');
    arrow.textContent = '›';
    arrow.style.cssText = 'font:28px Arial,sans-serif;color:#5555aa;flex-shrink:0;line-height:1;';

    card.appendChild(canvas);
    card.appendChild(info);
    card.appendChild(arrow);

    card.addEventListener('click', () => {
      arrow.textContent = '…';
      card.style.opacity = '0.6';
      card.style.pointerEvents = 'none';
      fetchCommunityTrack(meta.id)
        .then(track =>
          fetchRaceGhosts(meta.id, track)
            .then(ghosts => this.scene.start('Game', { track, ghosts }))
            .catch(()    => this.scene.start('Game', { track }))
        )
        .catch(() => {
          arrow.textContent = '!';
          card.style.opacity = '';
          card.style.pointerEvents = '';
        });
    });

    // Fetch full track data in the background to draw the thumbnail.
    fetchCommunityTrack(meta.id)
      .then(track => {
        const ctx = canvas.getContext('2d');
        if (ctx) this.drawThumbnail(canvas, track);
      })
      .catch(() => { /* thumbnail stays blank */ });

    return card;
  }

  private closeContextMenu(): void {
    this.contextMenuEl?.remove();
    this.contextMenuEl = null;
  }

  private drawThumbnail(canvas: HTMLCanvasElement, track: TrackEntry): void {
    const ctx = canvas.getContext('2d')!;
    const tw  = THUMB_W, th = THUMB_H;

    const b   = trackBounds(track.pieces);
    const pad = 24 * 2;
    const WL  = b.x - pad, WT = b.y - pad;
    const WW  = b.width + pad * 2, WH = b.height + pad * 2;

    const scale = Math.min(tw / WW, th / WH);
    const offX  = (tw - WW * scale) / 2;
    const offY  = (th - WH * scale) / 2;

    ctx.fillStyle = '#0a0a16';
    ctx.fillRect(0, 0, tw, th);
    drawBarriersOnCanvas(ctx, track.pieces, WL, WT, scale, scale, offX, offY, '#33bb55', 1.5);

    const toC = (wx: number, wy: number): [number, number] => [
      offX + (wx - WL) * scale,
      offY + (wy - WT) * scale,
    ];

    const dot = (wx: number, wy: number, r: number, fill: string, stroke?: string) => {
      const [cx, cy] = toC(wx, wy);
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.fill();
      if (stroke) {
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 0.75;
        ctx.stroke();
      }
    };

    // Checkpoints — yellow dots
    for (const m of track.markers) {
      if (m.kind === 'checkpoint') dot(m.x, m.y, 2.5, '#ffdd00');
    }

    // Finish — red dot with white ring
    const finish = track.markers.find(m => m.kind === 'finish');
    if (finish) dot(finish.x, finish.y, 3.5, '#ff3333', '#ffffff');

    // Start — cyan dot, drawn last so it's always visible
    dot(track.startX, track.startY, 3, '#00eeff', '#ffffff');
  }
}
