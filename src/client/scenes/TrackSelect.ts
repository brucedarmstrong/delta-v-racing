import { Scene, GameObjects } from 'phaser';
import { STANDARD_TRACKS, type TrackEntry } from '../tracks/trackRegistry';
import { trackBounds } from '../track/TrackLayout';
import { drawBarriersOnCanvas } from '../track/TrackCanvasRenderer';
import {
  fetchCommunityTrack, fetchCommunityTracks, seedCommunityTracks,
  fetchMineTrack, fetchMineTracks, deleteMineTrack, saveMineTrack,
  getLocalDrafts, deleteLocalDraft,
  type TrackPayload, type LocalDraft,
} from '../track/TrackUpload';
import { fetchRaceGhosts } from '../track/RaceGhosts';
import { generateAndUploadAiGhosts } from '../track/AiGhost';
import { username, isLoggedIn } from '../devvitContext';
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

type Tab = 'standard' | 'daily' | 'drafts' | 'community';
const TABS: { id: Tab; label: string }[] = [
  { id: 'standard',  label: 'Standard'  },
  { id: 'daily',     label: 'Daily'     },
  { id: 'drafts',    label: 'Drafts'    },
  { id: 'community', label: 'Community' },
];

type DraftEntry = {
  id:        string;
  name:      string;
  createdAt: number;
  verified:  boolean;
  local:     boolean;    // true = localStorage only (Devvit save failed)
  data?:     string;     // embedded for local entries; undefined for server entries
};

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
  private listEl:          HTMLElement | null = null;
  private searchBarEl:     HTMLElement | null = null;  // community search, outside scroll container
  private contextMenuEl:   HTMLElement | null = null;
  private communityTracks: CommunityTrackMeta[] = [];
  private communityLoaded  = false;
  private communityPage    = 0;
  private communityTotal   = 0;
  private communityQuery   = '';
  private drafts:          DraftEntry[] = [];
  private draftsLoaded     = false;
  private mineFilter       = false;   // community tab: show only current user's tracks

  constructor() { super('TrackSelect'); }

  init(data?: { activeTab?: Tab }): void {
    if (data?.activeTab) this.activeTab = data.activeTab;
    this.communityLoaded = false;
    this.communityPage   = 0;
    this.communityTotal  = 0;
    this.communityQuery  = '';
    this.mineFilter      = false;
    this.draftsLoaded    = false;
    this.drafts          = [];
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

    this.input.on('pointerdown', (ptr: Phaser.Input.Pointer) => {
      if (ptr.y > HEADER_H + TAB_H) return;
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
      this.searchBarEl?.remove();
      this.searchBarEl = null;
      this.closeContextMenu();
    });
  }

  private layout(): void {
    const W   = this.scale.width;
    const pad = 14;
    this.chromeHits = [];

    this.headerGfx.clear();
    this.headerGfx.fillStyle(SURFACE, 1);
    this.headerGfx.fillRect(0, 0, W, HEADER_H);
    this.headerGfx.lineStyle(1, BORDER, 1);
    this.headerGfx.lineBetween(0, HEADER_H, W, HEADER_H);

    this.headerText.setPosition(W / 2, HEADER_H / 2);
    this.backText.setPosition(pad + 4, HEADER_H / 2);
    this.chromeHits.push({ x: 0, y: 0, w: 100, h: HEADER_H, action: () => this.scene.start('ModeSelect') });

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

    // Skip DOM rebuild when the search input is focused — on Android, the
    // keyboard opening fires a resize that would destroy the input mid-typing.
    const searchInput = this.searchBarEl?.querySelector('input');
    if (searchInput && document.activeElement === searchInput) return;

    this.buildList();
  }

  // ── DOM list ──────────────────────────────────────────────────────────────────

  private buildList(): void {
    this.listEl?.remove();
    this.searchBarEl?.remove();
    this.searchBarEl = null;

    const PAGE_SIZE  = 10;
    const SEED_COUNT = STANDARD_TRACKS.filter(t => t.id !== 'tutorial').length;
    const AUTHOR_MAP: Record<string, string> = {
      'Boomsmith': 'u/Boomsmith-OG',
      'Custom':    'u/delta-v-racing',
      'Player':    'u/MaxDoor',
    };

    // ── Community tab: search bar lives in its own fixed element ABOVE the
    // scrollable list so the Android keyboard can't displace it into a scroll.
    let listTop = HEADER_H + TAB_H;
    if (this.activeTab === 'community') {
      const SEARCH_H  = 52;
      const bar       = document.createElement('div');
      bar.style.cssText = [
        'position:fixed',
        `top:${listTop}px`, 'left:0', 'right:0',
        `height:${SEARCH_H}px`,
        'background:#0a0a16', 'z-index:15',
        'padding:8px 14px', 'box-sizing:border-box',
        'border-bottom:1px solid #1e1e38',
      ].join(';');

      const inp = document.createElement('input');
      inp.type        = 'search';
      inp.placeholder = 'Search by name or author…';
      inp.value       = this.communityQuery;
      inp.setAttribute('autocomplete',   'off');
      inp.setAttribute('autocorrect',    'off');
      inp.setAttribute('autocapitalize', 'off');
      inp.setAttribute('spellcheck',     'false');
      inp.style.cssText = [
        'width:100%', 'height:100%', 'box-sizing:border-box',
        'padding:0 12px', 'border-radius:6px',
        'background:#111128', 'color:#e8e8ff',
        'border:1px solid #3a3a6a', 'font:14px Arial,sans-serif',
        'outline:none', '-webkit-appearance:none',
      ].join(';');

      let searchTimer: ReturnType<typeof setTimeout> | null = null;
      inp.addEventListener('input', () => {
        if (searchTimer) clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
          this.communityQuery  = inp.value.trim();
          this.communityPage   = 0;
          this.mineFilter      = false;
          this.communityLoaded = false;
          this.buildList();
        }, 350);
      });

      bar.appendChild(inp);
      document.body.appendChild(bar);
      this.searchBarEl = bar;
      listTop += SEARCH_H;
    }

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
      // ── Mine filter pills + seed button row
      const controlRow = document.createElement('div');
      controlRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:12px;flex-wrap:wrap;';

      if (isLoggedIn) {
        const mkPill = (label: string, active: boolean, fn: () => void) => {
          const b = document.createElement('button');
          b.textContent = label;
          b.style.cssText = [
            'padding:5px 14px', 'border-radius:16px',
            active
              ? 'background:#22224a;color:#ccccff;border:1.5px solid #6666cc;'
              : 'background:#111128;color:#555588;border:1px solid #2a2a44;',
            'font:13px Arial,sans-serif', 'cursor:pointer',
          ].join(';');
          b.addEventListener('click', fn);
          return b;
        };
        controlRow.appendChild(mkPill('All', !this.mineFilter, () => {
          this.mineFilter = false; this.communityPage = 0;
          this.communityQuery = ''; this.communityLoaded = false; this.buildList();
        }));
        controlRow.appendChild(mkPill('Mine', this.mineFilter, () => {
          this.mineFilter = true; this.communityPage = 0;
          this.communityQuery = ''; this.communityLoaded = false; this.buildList();
        }));
      }

      // Seed button: always visible when library has fewer tracks than the
      // standard set (handles the case where some tracks exist from testing).
      if (isLoggedIn && this.communityLoaded && this.communityTotal < SEED_COUNT && !this.communityQuery && !this.mineFilter) {
        const seedBtn = document.createElement('button');
        seedBtn.textContent = '⊕ Seed Library';
        seedBtn.style.cssText = [
          'margin-left:auto', 'padding:5px 12px', 'border-radius:16px',
          'background:#0a0a22', 'color:#6688cc',
          'border:1px solid #2a2a55', 'font:13px Arial,sans-serif', 'cursor:pointer',
        ].join(';');
        seedBtn.addEventListener('click', () => {
          seedBtn.textContent = '…Seeding';
          seedBtn.disabled    = true;
          const toSeed = STANDARD_TRACKS
            .filter(t => t.id !== 'tutorial')
            .map((t, i, arr) => ({
              id:         t.id,
              name:       t.name,
              author:     AUTHOR_MAP[t.author] ?? t.author,
              data:       JSON.stringify({ startX: t.startX, startY: t.startY, pieces: t.pieces, markers: t.markers }),
              uploadedAt: 1_700_000_000_000 + (arr.length - i) * 1000,
            }));
          seedCommunityTracks(toSeed)
            .then(() => { this.communityLoaded = false; this.buildList(); })
            .catch(() => { seedBtn.textContent = '⊕ Seed Library'; seedBtn.disabled = false; });
        });
        controlRow.appendChild(seedBtn);
      }

      if (isLoggedIn) el.appendChild(controlRow);

      if (!this.communityLoaded) {
        const msg = document.createElement('div');
        msg.textContent = 'Loading…';
        msg.style.cssText = 'text-align:center;color:#555588;font:20px Arial;margin-top:60px;';
        el.appendChild(msg);

        const params = this.mineFilter && username
          ? { offset: this.communityPage * PAGE_SIZE, limit: PAGE_SIZE, author: username }
          : { offset: this.communityPage * PAGE_SIZE, limit: PAGE_SIZE, q: this.communityQuery };

        fetchCommunityTracks(params).then(({ tracks, total }) => {
          this.communityTracks = tracks;
          this.communityTotal  = total;
          this.communityLoaded = true;
          this.buildList();
        }).catch(() => { msg.textContent = 'Failed to load community tracks.'; });

      } else if (this.communityTracks.length === 0) {
        const emptyMsg = document.createElement('div');
        emptyMsg.style.cssText = 'text-align:center;color:#555588;font:16px Arial;margin-top:60px;padding:0 16px;';
        emptyMsg.textContent = this.mineFilter
          ? 'You haven\'t published any tracks yet.'
          : this.communityQuery
            ? 'No tracks match your search.'
            : 'No community tracks yet.';
        el.appendChild(emptyMsg);

      } else {
        for (const meta of this.communityTracks) el.appendChild(this.buildCommunityCard(meta));

        // ── Pagination nav
        if (this.communityTotal > PAGE_SIZE) {
          const totalPages = Math.ceil(this.communityTotal / PAGE_SIZE);
          const curPage    = this.communityPage;

          const nav = document.createElement('div');
          nav.style.cssText = [
            'display:flex', 'align-items:center', 'justify-content:space-between',
            'margin-top:14px', 'padding:8px 0',
          ].join(';');

          const mkNavBtn = (label: string, enabled: boolean, fn: () => void) => {
            const b = document.createElement('button');
            b.textContent = label;
            b.disabled    = !enabled;
            b.style.cssText = [
              'padding:8px 18px', 'border-radius:6px',
              enabled
                ? 'background:#12122a;color:#aaaaff;border:1px solid #3a3a6a;cursor:pointer;'
                : 'background:#0a0a14;color:#333355;border:1px solid #1a1a2a;cursor:default;',
              'font:bold 14px Arial,sans-serif',
            ].join(';');
            if (enabled) b.addEventListener('click', fn);
            return b;
          };

          const pageLabel = document.createElement('div');
          pageLabel.textContent = `Page ${curPage + 1} of ${totalPages}`;
          pageLabel.style.cssText = 'font:13px Arial,sans-serif;color:#555588;';

          nav.appendChild(mkNavBtn('← Prev', curPage > 0, () => {
            this.communityPage--; this.communityLoaded = false; this.buildList();
          }));
          nav.appendChild(pageLabel);
          nav.appendChild(mkNavBtn('Next →', curPage < totalPages - 1, () => {
            this.communityPage++; this.communityLoaded = false; this.buildList();
          }));
          el.appendChild(nav);
        }
      }

    } else if (this.activeTab === 'drafts') {
      if (!isLoggedIn) {
        const msg = document.createElement('div');
        msg.textContent = 'Log in to save and upload tracks.';
        msg.style.cssText = 'text-align:center;color:#555588;font:16px Arial;margin-top:80px;padding:0 24px;';
        el.appendChild(msg);
      } else if (!this.draftsLoaded) {
        const msg = document.createElement('div');
        msg.textContent = 'Loading…';
        msg.style.cssText = 'text-align:center;color:#555588;font:20px Arial;margin-top:80px;';
        el.appendChild(msg);

        const localEntries: DraftEntry[] = getLocalDrafts().map(d => ({
          id: d.id, name: d.name, createdAt: d.createdAt,
          verified: d.verified ?? false, local: true, data: d.data,
        }));

        fetchMineTracks()
          .then(tracks => {
            const serverEntries: DraftEntry[] = tracks.map(t => ({
              id: t.id, name: t.name, createdAt: t.createdAt,
              verified: t.verified, local: false,
            }));
            this.drafts = [...localEntries, ...serverEntries]
              .sort((a, b) => b.createdAt - a.createdAt);
            this.draftsLoaded = true;
            this.buildList();
          })
          .catch(() => {
            // Server unavailable — show only local drafts
            this.drafts = localEntries.sort((a, b) => b.createdAt - a.createdAt);
            this.draftsLoaded = true;
            this.buildList();
          });
      } else if (this.drafts.length === 0) {
        const msg = document.createElement('div');
        msg.innerHTML = 'No drafts yet.<br><br>Tap CREATE to build a track!';
        msg.style.cssText = 'text-align:center;color:#555588;font:16px Arial;margin-top:80px;padding:0 24px;line-height:1.5;';
        el.appendChild(msg);
      } else {
        for (const draft of this.drafts) el.appendChild(this.buildDraftCard(draft));
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

  // ── Standard track card ───────────────────────────────────────────────────────

  private buildCard(track: TrackEntry): HTMLElement {
    const card = document.createElement('div');
    card.style.cssText = [
      'display:flex', 'align-items:center', 'gap:12px',
      'background:#12122a', 'border:1px solid #3a3a6a', 'border-radius:6px',
      'padding:10px', 'margin-bottom:10px', 'cursor:pointer',
      '-webkit-tap-highlight-color:rgba(100,100,200,0.2)',
      'user-select:none', '-webkit-user-select:none',
    ].join(';');

    const canvas  = document.createElement('canvas');
    canvas.width  = THUMB_W;
    canvas.height = THUMB_H;
    canvas.style.cssText = 'flex-shrink:0;border:1px solid #3a3a6a;border-radius:3px;';
    this.drawThumbnail(canvas, track);

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

  // ── Draft card (Drafts tab) ───────────────────────────────────────────────────

  private static ensureSpinStyle(): void {
    if (document.getElementById('dv-spin-style')) return;
    const s = document.createElement('style');
    s.id = 'dv-spin-style';
    s.textContent = '@keyframes dv-spin{to{transform:rotate(360deg)}}';
    document.head.appendChild(s);
  }

  private buildDraftCard(draft: DraftEntry): HTMLElement {
    const card = document.createElement('div');
    card.style.cssText = [
      'display:flex', 'align-items:flex-start', 'gap:12px',
      'background:#12122a', 'border:1px solid #3a3a6a', 'border-radius:6px',
      'padding:10px', 'margin-bottom:10px',
      'user-select:none', '-webkit-user-select:none',
    ].join(';');

    const canvas  = document.createElement('canvas');
    canvas.width  = THUMB_W;
    canvas.height = THUMB_H;
    canvas.style.cssText = 'flex-shrink:0;border:1px solid #3a3a6a;border-radius:3px;background:#0a0a16;';

    const info = document.createElement('div');
    info.style.cssText = 'flex:1;min-width:0;display:flex;flex-direction:column;gap:6px;';

    const nameRow = document.createElement('div');
    nameRow.style.cssText = 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;';

    const nameEl = document.createElement('div');
    nameEl.textContent = draft.name;
    nameEl.style.cssText = 'font:bold 16px "Arial Black",Arial,sans-serif;color:#e8e8ff;';
    nameRow.appendChild(nameEl);

    if (draft.local) {
      const badge = document.createElement('span');
      badge.textContent = '⚠ Save failed';
      badge.style.cssText = [
        'font:bold 11px Arial,sans-serif', 'color:#ffaa44',
        'background:#1a0e00', 'border:1px solid #553300',
        'border-radius:10px', 'padding:2px 7px', 'white-space:nowrap',
      ].join(';');
      nameRow.appendChild(badge);
    }

    const date = document.createElement('div');
    const d = new Date(draft.createdAt);
    date.textContent = `Saved ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
    date.style.cssText = 'font:12px Arial,sans-serif;color:#555588;';

    // Action buttons
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

    const canUpload = draft.verified;
    const uploadBtn = document.createElement('button');
    uploadBtn.textContent = draft.verified ? '↑ Upload to Community' : '↑ Upload (play first)';
    uploadBtn.disabled = !canUpload;
    uploadBtn.style.cssText = [
      'width:100%', 'padding:8px 4px',
      `color:${canUpload ? '#88aaff' : '#444466'}`,
      `background:${canUpload ? '#0a0a22' : '#0a0a14'}`,
      `border:1px solid ${canUpload ? '#334488' : '#222244'}`,
      'border-radius:5px', 'font:bold 12px Arial,sans-serif',
      `cursor:${canUpload ? 'pointer' : 'default'}`,
    ].join(';');

    btnRow.appendChild(playBtn);
    btnRow.appendChild(editBtn);
    btnRow.appendChild(deleteBtn);

    info.appendChild(nameRow);
    info.appendChild(date);
    info.appendChild(btnRow);
    info.appendChild(uploadBtn);

    card.appendChild(canvas);
    card.appendChild(info);

    // ── Helper: resolve track data (local = inline, server = fetch) ──
    const resolveData = async (): Promise<{ data: string; serverId: string | null }> => {
      if (draft.local) return { data: draft.data!, serverId: null };
      const result = await fetchMineTrack(draft.id);
      return { data: result.data, serverId: draft.id };
    };

    // ── Handlers ──

    playBtn.addEventListener('click', async () => {
      playBtn.textContent = '…';
      playBtn.disabled = true;
      try {
        const { data } = await resolveData();
        const payload  = JSON.parse(data) as TrackPayload;
        const entry: TrackEntry = {
          id: draft.id, name: draft.name, author: '',
          startX: payload.startX, startY: payload.startY,
          pieces: payload.pieces, markers: payload.markers,
        };
        this.scene.start('Game', { track: entry, mineTrackId: draft.id });
      } catch {
        playBtn.textContent = '▶ Play';
        playBtn.disabled = false;
      }
    });

    editBtn.addEventListener('click', async () => {
      editBtn.textContent = '…';
      editBtn.disabled = true;
      try {
        const { data } = await resolveData();
        const payload = JSON.parse(data) as TrackPayload;
        const entry: TrackEntry = {
          id: draft.id, name: draft.name, author: '',
          startX: payload.startX, startY: payload.startY,
          pieces: payload.pieces, markers: payload.markers,
        };
        this.scene.start('TrackEditor', {
          mineTrackId: draft.id, track: entry, startHeading: payload.startHeading,
        });
      } catch {
        editBtn.textContent = '✎ Edit';
        editBtn.disabled = false;
      }
    });

    deleteBtn.addEventListener('click', async () => {
      if (!confirm(`Delete "${draft.name}"?`)) return;
      deleteBtn.textContent = '…';
      deleteBtn.disabled = true;
      try {
        if (draft.local) {
          deleteLocalDraft(draft.id);
        } else {
          await deleteMineTrack(draft.id);
        }
        this.drafts = this.drafts.filter(d => d.id !== draft.id);
        this.buildList();
      } catch {
        deleteBtn.textContent = '✕ Del';
        deleteBtn.disabled = false;
      }
    });

    if (canUpload) {
      uploadBtn.addEventListener('click', () => {
        const cardBtns = [playBtn, editBtn, deleteBtn, uploadBtn];
        for (const b of cardBtns) b.disabled = true;

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

        // statusEl shows persistent rejection reasons below the upload button.
        let statusEl = card.querySelector<HTMLElement>('.upload-status');
        if (!statusEl) {
          statusEl = document.createElement('div');
          statusEl.className = 'upload-status';
          statusEl.style.cssText = 'font:12px Arial,sans-serif;color:#ff9966;margin-top:4px;display:none;';
          uploadBtn.insertAdjacentElement('afterend', statusEl);
        }

        const restoreOnError = async (res?: Response) => {
          for (const b of cardBtns) b.disabled = false;
          uploadBtn.innerHTML = '';
          uploadBtn.textContent = '↑ Upload to Community';
          if (res) {
            try {
              const err = await res.json() as { message?: string };
              if (err.message && statusEl) {
                statusEl.textContent = err.message;
                statusEl.style.display = '';
              }
            } catch { /* ignore parse errors */ }
          }
        };

        (async () => {
          let data: string;
          let serverId: string;

          if (draft.local) {
            // Sync to server first
            try {
              const result = await saveMineTrack(draft.name, draft.data!);
              deleteLocalDraft(draft.id);
              serverId = result.id;
              data = draft.data!;
            } catch {
              await restoreOnError(new Response(
                JSON.stringify({ message: 'Server unavailable — try again later.' }), { status: 503 },
              ));
              return;
            }
          } else {
            serverId = draft.id;
            try {
              const result = await fetchMineTrack(serverId);
              data = result.data;
            } catch {
              await restoreOnError();
              return;
            }
          }

          try {
            const payload = JSON.parse(data) as TrackPayload;
            const entry: TrackEntry = {
              id: '', name: draft.name, author: '',
              startX: payload.startX, startY: payload.startY,
              pieces: payload.pieces, markers: payload.markers,
            };

            const uploadRes = await fetch('/api/track', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: entry.name, data }),
            });
            if (!uploadRes.ok) { await restoreOnError(uploadRes); return; }
            const json = await uploadRes.json() as { id: string };
            const communityId = json.id;

            await generateAndUploadAiGhosts({ ...entry, id: communityId }, ['average', 'rookie']);
            await deleteMineTrack(serverId);

            this.drafts = this.drafts.filter(d => d.id !== draft.id);
            this.buildList();
          } catch {
            await restoreOnError();
          }
        })();
      });
    }

    // Load thumbnail
    (async () => {
      try {
        const { data } = await resolveData();
        const payload = JSON.parse(data) as TrackPayload;
        const ctx = canvas.getContext('2d');
        if (ctx) this.drawThumbnail(canvas, {
          id: draft.id, name: draft.name, author: '',
          startX: payload.startX, startY: payload.startY,
          pieces: payload.pieces, markers: payload.markers,
        });
      } catch { /* thumbnail stays blank */ }
    })();

    return card;
  }

  // ── Community card ────────────────────────────────────────────────────────────

  private buildCommunityCard(meta: CommunityTrackMeta): HTMLElement {
    const card = document.createElement('div');
    card.style.cssText = [
      'display:flex', 'align-items:center', 'gap:12px',
      'background:#12122a', 'border:1px solid #3a3a6a', 'border-radius:6px',
      'padding:10px', 'margin-bottom:10px', 'cursor:pointer',
      '-webkit-tap-highlight-color:rgba(100,100,200,0.2)',
      'user-select:none', '-webkit-user-select:none',
    ].join(';');

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

    fetchCommunityTrack(meta.id)
      .then(track => {
        const ctx = canvas.getContext('2d');
        if (ctx) this.drawThumbnail(canvas, track);
      })
      .catch(() => { /* thumbnail stays blank */ });

    return card;
  }

  // ── Utilities ─────────────────────────────────────────────────────────────────

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

    for (const m of track.markers) {
      if (m.kind === 'checkpoint') dot(m.x, m.y, 2.5, '#ffdd00');
    }
    const finish = track.markers.find(m => m.kind === 'finish');
    if (finish) dot(finish.x, finish.y, 3.5, '#ff3333', '#ffffff');
    dot(track.startX, track.startY, 3, '#00eeff', '#ffffff');
  }
}
