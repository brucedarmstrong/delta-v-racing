import { Scene } from 'phaser';
import { appVersion, postData } from '../devvitContext';
import { fetchCommunityTrack } from '../track/TrackUpload';
import { fetchRaceGhosts } from '../track/RaceGhosts';
import { PhaserStarField } from '../starfield';

const BG      = 0x0a0a16;
const SURFACE = 0x12122a;
const BORDER  = 0x3a3a6a;

type BtnDef = { label: string; action: () => void };
type BtnObj = BtnDef & { gfx: Phaser.GameObjects.Graphics; text: Phaser.GameObjects.Text; bx: number; by: number; bw: number; bh: number };

const GRID_CELL   = 24;
const GRID_MAJOR  = 5;
const GRID_PERIOD = GRID_CELL * GRID_MAJOR; // 120 px
const GRID_DX     = -3;   // px/s westward
const GRID_DY     = -8;   // px/s northward (NNW, ~1:2.7 ratio)

export class ModeSelect extends Scene {
  private btns:          BtnObj[]                 = [];
  private title:         Phaser.GameObjects.Text | null = null;
  private sub:           Phaser.GameObjects.Text | null = null;
  private verText:       Phaser.GameObjects.Text | null = null;
  private ftueEl:        HTMLElement | null = null;
  private ftueResetTaps  = 0;
  private ftueResetTimer: ReturnType<typeof setTimeout> | null = null;

  private gridGfx:   Phaser.GameObjects.Graphics | null = null;
  private gridOX     = 0;
  private gridOY     = 0;
  private starField: PhaserStarField | null = null;

  constructor() { super('ModeSelect'); }

  create(data?: { skipAutoRace?: boolean }) {
    // Deep-link routing — splash secondary buttons set dv-route even on track posts.
    const route = localStorage.getItem('dv-route');
    if (route) {
      localStorage.removeItem('dv-route');
      if (route === 'community')   { this.scene.start('TrackSelect', { activeTab: 'community' }); return; }
      if (route === 'leaderboard') { this.scene.start('Leaderboard'); return; }
      if (route === 'create')      { this.scene.start('TrackEditor'); return; }
    }

    // After-tutorial redirect: when a new user on a post track chose to take the
    // tutorial first, we stored their track here. Now launch it.
    const pending = localStorage.getItem('dv-pending-track');
    if (pending) {
      localStorage.removeItem('dv-pending-track');
      localStorage.setItem('dv-ftue', '1');
      fetchCommunityTrack(pending)
        .then(track =>
          fetchRaceGhosts(pending, track)
            .then(ghosts => this.scene.start('Game', { track, ghosts }))
            .catch(()    => this.scene.start('Game', { track }))
        )
        .catch(() => this.buildMenu(data));
      return;
    }

    // Track-post entry: boot directly into race mode.
    // New users see the FTUE overlay first so they can choose to take the tutorial.
    if (postData?.trackId && !data?.skipAutoRace) {
      const trackId = postData.trackId;
      this.cameras.main.setBackgroundColor(BG);
      this.cameras.main.setScroll(0, 0);
      this.cameras.main.setZoom(1);

      const launchTrack = () => {
        fetchCommunityTrack(trackId)
          .then(track =>
            fetchRaceGhosts(trackId, track)
              .then(ghosts => this.scene.start('Game', { track, ghosts }))
              .catch(()    => this.scene.start('Game', { track }))
          )
          .catch(() => this.buildMenu(data));
      };

      if (!localStorage.getItem('dv-ftue')) {
        this.showFirstRunOverlay({ pendingTrackId: trackId, onSkip: launchTrack });
      } else {
        launchTrack();
      }
      return;
    }

    this.buildMenu(data);
  }

  update(_time: number, delta: number): void {
    if (!this.gridGfx) return;
    this.gridOX = ((this.gridOX + GRID_DX * delta / 1000) % GRID_PERIOD + GRID_PERIOD) % GRID_PERIOD;
    this.gridOY = ((this.gridOY + GRID_DY * delta / 1000) % GRID_PERIOD + GRID_PERIOD) % GRID_PERIOD;
    this.drawScrollingGrid();
  }

  private buildMenu(data?: { skipAutoRace?: boolean }): void {
    void data; // no current use after routing; kept for future passes

    const cam = this.cameras.main;
    cam.setBackgroundColor(BG);
    cam.setScroll(0, 0);
    cam.setZoom(1);

    this.starField?.destroy();
    this.starField = new PhaserStarField(this, { depth: -2, parallax: 0, texKey: 'starfield_menu' });

    this.startGrid();

    this.title = this.add.text(0, 0, 'delta-v', {
      fontFamily: 'Arial Black', fontSize: '52px',
      color: '#ffffff', stroke: '#000000', strokeThickness: 4,
    }).setScrollFactor(0).setOrigin(0.5).setDepth(10);

    this.sub = this.add.text(0, 0, 'RACING', {
      fontFamily: 'Arial Black', fontSize: '24px',
      color: '#8888ff', stroke: '#000000', strokeThickness: 3,
    }).setScrollFactor(0).setOrigin(0.5).setDepth(10);

    const defs: BtnDef[] = [
      { label: 'RACE',   action: () => this.scene.start('TrackSelect') },
      { label: 'CREATE', action: () => this.scene.start('TrackEditor') },
      { label: 'ABOUT',  action: () => this.scene.start('AboutScreen') },
    ];

    this.btns = defs.map(d => ({
      ...d,
      gfx:  this.add.graphics().setScrollFactor(0).setDepth(10),
      text: this.add.text(0, 0, d.label, {
        fontFamily: 'Arial Black', fontSize: '24px',
        color: '#e8e8ff', stroke: '#000000', strokeThickness: 3,
      }).setScrollFactor(0).setOrigin(0.5).setDepth(11),
      bx: 0, by: 0, bw: 0, bh: 0,
    }));

    this.verText = this.add.text(0, 0, appVersion, {
      fontFamily: 'Arial', fontSize: '13px', color: '#555588',
    }).setScrollFactor(0).setOrigin(0.5).setDepth(10);

    this.layout();
    this.scale.on('resize', () => this.layout());

    if (!localStorage.getItem('dv-ftue')) {
      this.showFirstRunOverlay();
    }

    this.input.on('pointerdown', (ptr: Phaser.Input.Pointer) => {
      for (const btn of this.btns) {
        if (ptr.x >= btn.bx && ptr.x <= btn.bx + btn.bw &&
            ptr.y >= btn.by && ptr.y <= btn.by + btn.bh) {
          btn.action();
          return;
        }
      }
      // Hidden FTUE reset: tap the version text 5× within 1.5 s
      if (this.verText) {
        const vt = this.verText;
        const hw = vt.width / 2 + 24;
        const hh = vt.height / 2 + 20;
        if (Math.abs(ptr.x - vt.x) <= hw && Math.abs(ptr.y - vt.y) <= hh) {
          this.handleFtueResetTap();
        }
      }
    });

    this.events.once('shutdown', () => {
      // stopGrid() is handled by Phaser destroying the scene's objects;
      // just null the ref so update() stops drawing.
      this.gridGfx = null;
      this.ftueEl?.remove();
      this.ftueEl = null;
      if (this.ftueResetTimer) clearTimeout(this.ftueResetTimer);
    });
  }

  // opts absent  → plain menu overlay, single "Let's race!" dismiss button
  // opts present → post-entry variant with "Take Tutorial" + "Jump Right In"
  private showFirstRunOverlay(opts?: { pendingTrackId?: string; onSkip?: () => void }): void {
    localStorage.setItem('dv-ftue', '1');

    const overlay = document.createElement('div');
    overlay.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:9000',
      'display:flex', 'align-items:center', 'justify-content:center',
      'background:rgba(0,0,0,0.82)',
    ].join(';');
    this.ftueEl = overlay;

    const card = document.createElement('div');
    card.style.cssText = [
      'background:#12122a', 'border:1.5px solid #6666cc', 'border-radius:10px',
      'padding:28px 22px 22px', 'max-width:320px', 'width:88%',
      'box-sizing:border-box', 'text-align:center', 'font-family:Arial,sans-serif',
    ].join(';');

    const heading = document.createElement('div');
    heading.textContent = 'New here?';
    heading.style.cssText = 'font:bold 22px "Arial Black",Arial,sans-serif;color:#aaccff;margin-bottom:12px;';

    const body = document.createElement('div');
    body.style.cssText = 'font:14px Arial,sans-serif;line-height:1.6;color:#aaaacc;white-space:pre-wrap;margin-bottom:22px;';

    const dismiss = (fn?: () => void) => {
      overlay.remove();
      this.ftueEl = null;
      fn?.();
    };

    const mkBtn = (label: string, primary: boolean, fn: () => void) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = [
        'display:block', 'width:100%', 'padding:11px 0',
        primary
          ? 'background:#22224a;color:#ccccff;border:1.5px solid #6666cc;'
          : 'background:transparent;color:#666699;border:1px solid #3a3a6a;',
        'border-radius:6px', 'font:bold 15px Arial,sans-serif',
        'cursor:pointer', 'margin-top:10px',
      ].join(';');
      b.addEventListener('click', fn);
      return b;
    };

    if (opts?.pendingTrackId) {
      body.textContent =
        'delta-v racing is a turn-based game where your velocity carries over every move.\n\n' +
        'Want a quick tutorial before jumping in?';

      const tutBtn = mkBtn('Take the Tutorial  ›', true, () => dismiss(() => {
        localStorage.setItem('dv-pending-track', opts.pendingTrackId!);
        this.scene.start('TrackSelect', { activeTab: 'tutorial' });
      }));
      const skipBtn = mkBtn('Jump Right In', false, () => dismiss(opts.onSkip));

      card.appendChild(heading);
      card.appendChild(body);
      card.appendChild(tutBtn);
      card.appendChild(skipBtn);
    } else {
      body.textContent =
        'delta-v racing is a turn-based racing game where your velocity carries over every move.\n\n' +
        'Head to RACE → Tutorial tab to learn the basics in 3 short lessons.';

      card.appendChild(heading);
      card.appendChild(body);
      card.appendChild(mkBtn('Let\'s race!', true, () => dismiss()));
    }

    overlay.appendChild(card);
    document.body.appendChild(overlay);
  }

  private startGrid(): void {
    this.gridGfx = this.add.graphics().setDepth(-1);
    this.gridOX  = 0;
    this.gridOY  = 0;
    this.drawScrollingGrid(); // initial draw so it's visible before first update()
  }

  private stopGrid(): void {
    this.gridGfx?.destroy();
    this.gridGfx = null;
  }

  private drawScrollingGrid(): void {
    const g = this.gridGfx;
    if (!g) return;
    g.clear();

    const W  = this.scale.width;
    const H  = this.scale.height;
    const ox = this.gridOX;
    const oy = this.gridOY;

    // Minor line start positions (first line just off left/top edge)
    const startX = -GRID_CELL + ((ox % GRID_CELL + GRID_CELL) % GRID_CELL);
    const startY = -GRID_CELL + ((oy % GRID_CELL + GRID_CELL) % GRID_CELL);

    // Minor lines — every GRID_CELL, skip majors
    g.lineStyle(1, 0x15153a, 0.9);
    g.beginPath();
    for (let x = startX; x <= W + GRID_CELL; x += GRID_CELL) {
      if (Math.round((x - ox) / GRID_CELL) % GRID_MAJOR === 0) continue;
      g.moveTo(x, 0); g.lineTo(x, H);
    }
    for (let y = startY; y <= H + GRID_CELL; y += GRID_CELL) {
      if (Math.round((y - oy) / GRID_CELL) % GRID_MAJOR === 0) continue;
      g.moveTo(0, y); g.lineTo(W, y);
    }
    g.strokePath();

    // Major lines — every GRID_PERIOD
    const majStartX = -GRID_PERIOD + ((ox % GRID_PERIOD + GRID_PERIOD) % GRID_PERIOD);
    const majStartY = -GRID_PERIOD + ((oy % GRID_PERIOD + GRID_PERIOD) % GRID_PERIOD);
    g.lineStyle(1, 0x20205a, 1.0);
    g.beginPath();
    for (let x = majStartX; x <= W + GRID_PERIOD; x += GRID_PERIOD) {
      g.moveTo(x, 0); g.lineTo(x, H);
    }
    for (let y = majStartY; y <= H + GRID_PERIOD; y += GRID_PERIOD) {
      g.moveTo(0, y); g.lineTo(W, y);
    }
    g.strokePath();
  }

  private handleFtueResetTap(): void {
    this.ftueResetTaps++;
    if (this.ftueResetTimer) clearTimeout(this.ftueResetTimer);

    if (this.ftueResetTaps >= 5) {
      this.ftueResetTaps = 0;
      localStorage.removeItem('dv-ftue');
      localStorage.removeItem('dv-pending-track');
      this.showToast('FTUE reset — reload to test');
      return;
    }

    this.ftueResetTimer = setTimeout(() => { this.ftueResetTaps = 0; }, 1500);
  }

  private showToast(msg: string): void {
    const el = document.createElement('div');
    el.textContent = msg;
    el.style.cssText = [
      'position:fixed', 'bottom:32px', 'left:50%',
      'transform:translateX(-50%) translateY(12px)', 'opacity:0',
      'transition:opacity 0.2s ease, transform 0.2s ease',
      'background:#22224a', 'color:#aaccff', 'border:1px solid #6666cc',
      'border-radius:6px', 'padding:8px 18px', 'font:13px Arial,sans-serif',
      'z-index:9500', 'pointer-events:none', 'white-space:nowrap',
    ].join(';');
    document.body.appendChild(el);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      el.style.opacity   = '1';
      el.style.transform = 'translateX(-50%) translateY(0)';
    }));
    setTimeout(() => {
      el.style.opacity   = '0';
      el.style.transform = 'translateX(-50%) translateY(-8px)';
    }, 2020);
    setTimeout(() => el.remove(), 2300);
  }

  private layout(): void {
    const W = this.scale.width;
    const H = this.scale.height;

    const titleSize = Math.round(Math.min(W * 0.14, 58));
    this.title?.setFontSize(`${titleSize}px`).setPosition(W / 2, H * 0.22);
    this.sub?.setPosition(W / 2, H * 0.22 + titleSize * 0.95);

    const btnW = Math.min(W * 0.78, 340);
    const btnH = Math.round(Math.min(H * 0.09, 72));
    const gap  = Math.round(btnH * 0.28);
    const bx   = (W - btnW) / 2;
    let   by   = H * 0.50;

    for (const btn of this.btns) {
      btn.bx = bx; btn.by = by; btn.bw = btnW; btn.bh = btnH;

      btn.gfx.clear();
      btn.gfx.fillStyle(SURFACE, 1);
      btn.gfx.fillRect(bx, by, btnW, btnH);
      btn.gfx.lineStyle(1.5, BORDER, 1);
      btn.gfx.strokeRect(bx, by, btnW, btnH);

      btn.text.setPosition(W / 2, by + btnH / 2);
      by += btnH + gap;
    }

    this.verText?.setPosition(W / 2, by + 4);
  }
}
