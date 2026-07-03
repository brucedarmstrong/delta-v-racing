import { Scene } from 'phaser';
import { appVersion, postData } from '../devvitContext';
import { fetchCommunityTrack } from '../track/TrackUpload';
import { fetchRaceGhosts } from '../track/RaceGhosts';

const BG      = 0x0a0a16;
const SURFACE = 0x12122a;
const BORDER  = 0x3a3a6a;

type BtnDef = { label: string; action: () => void };
type BtnObj = BtnDef & { gfx: Phaser.GameObjects.Graphics; text: Phaser.GameObjects.Text; bx: number; by: number; bw: number; bh: number };

export class ModeSelect extends Scene {
  private btns:    BtnObj[]                    = [];
  private title:   Phaser.GameObjects.Text    | null = null;
  private sub:     Phaser.GameObjects.Text    | null = null;
  private verText: Phaser.GameObjects.Text    | null = null;

  constructor() { super('ModeSelect'); }

  create() {
    // Deep-link routing takes priority — splash secondary buttons set this even on track posts.
    const route = localStorage.getItem('dv-route');
    if (route) {
      localStorage.removeItem('dv-route');
      if (route === 'community')   { this.scene.start('TrackSelect', { activeTab: 'community' }); return; }
      if (route === 'leaderboard') { this.scene.start('Leaderboard'); return; }
      if (route === 'create')      { this.scene.start('TrackEditor'); return; }
    }

    // Track post: boot directly into race mode — no menu needed.
    if (postData?.trackId) {
      const trackId = postData.trackId;
      fetchCommunityTrack(trackId)
        .then(track =>
          fetchRaceGhosts(trackId, track)
            .then(ghosts => this.scene.start('Game', { track, ghosts }))
            .catch(()    => this.scene.start('Game', { track }))
        )
        .catch(() => {
          // Track fetch failed — fall through to normal menu.
          this.scene.restart();
        });
      return;
    }

    const cam = this.cameras.main;
    cam.setBackgroundColor(BG);
    cam.setScroll(0, 0);
    cam.setZoom(1);

    this.title = this.add.text(0, 0, 'delta-v', {
      fontFamily: 'Arial Black', fontSize: '52px',
      color: '#ffffff', stroke: '#000000', strokeThickness: 4,
    }).setScrollFactor(0).setOrigin(0.5).setDepth(10);

    this.sub = this.add.text(0, 0, 'RACING', {
      fontFamily: 'Arial Black', fontSize: '24px',
      color: '#8888ff', stroke: '#000000', strokeThickness: 3,
    }).setScrollFactor(0).setOrigin(0.5).setDepth(10);

    const defs: BtnDef[] = [
      { label: 'RACE',    action: () => this.scene.start('TrackSelect') },
      { label: 'CREATE',  action: () => this.scene.start('TrackEditor') },
      { label: 'OPTIONS', action: () => this.scene.start('OptionsMenu') },
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

    this.input.on('pointerdown', (ptr: Phaser.Input.Pointer) => {
      for (const btn of this.btns) {
        if (ptr.x >= btn.bx && ptr.x <= btn.bx + btn.bw &&
            ptr.y >= btn.by && ptr.y <= btn.by + btn.bh) {
          btn.action();
          return;
        }
      }
    });
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

    // Version label below the button stack
    this.verText?.setPosition(W / 2, by + 4);
  }
}
