// Procedurally synthesized sound effects (Web Audio API) — matching the
// game's existing "generate everything in code" approach for textures, so
// no audio asset files are needed. One shared AudioContext for the whole
// app; created lazily on first use since browsers require a user gesture
// before audio can play.

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let muted = false;

const MUTE_KEY = 'dv-sfx-muted';
try { muted = localStorage.getItem(MUTE_KEY) === '1'; } catch { /* ignore */ }

export function isSfxMuted(): boolean {
  return muted;
}

export function setSfxMuted(m: boolean): void {
  muted = m;
  try { localStorage.setItem(MUTE_KEY, m ? '1' : '0'); } catch { /* quota/unavailable — in-memory value still applies */ }
}

function ensureCtx(): AudioContext | null {
  try {
    if (!ctx) {
      const AC = window.AudioContext
        ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.5;
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => { /* ignore */ });
    return ctx;
  } catch (e) {
    console.warn('[sfx] AudioContext unavailable', e);
    return null;
  }
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

// ── Low-level synthesis helpers ─────────────────────────────────────────────

// A single oscillator with a short attack + exponential decay envelope.
// freqEnd, if given, glides the pitch from freq to freqEnd over the duration.
function tone(
  freq: number, duration: number, type: OscillatorType,
  peak = 0.25, freqEnd?: number, delay = 0,
): void {
  const ac = ensureCtx();
  if (!ac || !master || muted) return;
  const t0  = ac.currentTime + delay;
  const osc = ac.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(Math.max(1, freq), t0);
  if (freqEnd !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(1, freqEnd), t0 + duration);
  const gain = ac.createGain();
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(peak, t0 + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.001, t0 + duration);
  osc.connect(gain);
  gain.connect(master);
  osc.start(t0);
  osc.stop(t0 + duration + 0.02);
}

// Filtered white-noise burst with exponential decay — impacts, sparkle tails.
function noiseBurst(duration: number, decay: number, peak = 0.3, delay = 0, filterFreq?: number): void {
  const ac = ensureCtx();
  if (!ac || !master || muted) return;
  const len = Math.max(1, Math.floor(ac.sampleRate * duration));
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) {
    const t = i / ac.sampleRate;
    data[i] = (Math.random() * 2 - 1) * Math.exp(-t * decay);
  }
  const src = ac.createBufferSource();
  src.buffer = buf;
  let node: AudioNode = src;
  if (filterFreq) {
    const filt = ac.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = filterFreq;
    src.connect(filt);
    node = filt;
  }
  const gain = ac.createGain();
  gain.gain.setValueAtTime(peak, ac.currentTime + delay);
  node.connect(gain);
  gain.connect(master);
  src.start(ac.currentTime + delay);
}

// ── Named sound effects ──────────────────────────────────────────────────────

// Generic UI click — buttons, tabs, toggles. A fixed, brief, subtle tick —
// identical every time so rapid clicking (e.g. cycling piece sizes) stays
// unobtrusive. Unlike in-race sounds, this never varies with game state.
export function playClick(): void {
  noiseBurst(0.018, 90, 0.14, 0, 2600);
}

// A slightly richer two-tone blip for toggles/mode switches.
export function playToggle(): void {
  tone(520, 0.045, 'square', 0.10);
  tone(720, 0.05, 'square', 0.10, undefined, 0.035);
}

// Soft notification blip — toasts, non-error status messages.
export function playToast(): void {
  tone(660, 0.09, 'triangle', 0.13, 900);
}

// Low buzzy blip for invalid actions / errors.
export function playError(): void {
  tone(180, 0.14, 'sawtooth', 0.14, 130);
}

// Bright ascending two-note chime — matches the checkpoint ring pulse.
export function playCheckpoint(): void {
  tone(880, 0.09, 'triangle', 0.20);
  tone(1320, 0.14, 'triangle', 0.18, undefined, 0.06);
}

// Short rising arpeggio + a light sparkle tail — matches the finish flash/zoom.
export function playFinish(): void {
  const notes = [523.25, 659.25, 783.99, 1046.5]; // C5 E5 G5 C6
  notes.forEach((f, i) => tone(f, 0.22, 'square', 0.20, undefined, i * 0.09));
  noiseBurst(0.3, 8, 0.07, 0.32, 4000);
}

// Brighter, longer fanfare for a new personal best — timed with the confetti.
export function playPersonalBest(): void {
  const notes = [659.25, 783.99, 987.77, 1318.5, 1567.98];
  notes.forEach((f, i) => tone(f, 0.2, 'square', 0.20, undefined, i * 0.075));
}

// Subtle tick when a move is committed. Pitch rises with the car's post-move
// speed (grid units/turn) — deterministic, not randomized, so repeating the
// same move (e.g. clicking the natural/center target) sounds identical.
export function playPickMove(speed = 0): void {
  const mul = 1 + Math.min(Math.max(speed, 0), 8) * 0.09; // up to ~1.72x at speed 8
  tone(380 * mul, 0.045, 'square', 0.09);
}

// Crash impact — noise burst + low thump + mid "crack", each with randomized
// pitch/decay/duration per call so no two crashes sound identical.
export function playCrash(): void {
  const ac = ensureCtx();
  if (!ac || !master || muted) return;
  const dur         = rand(0.32, 0.46);
  const len         = Math.floor(ac.sampleRate * dur);
  const buf         = ac.createBuffer(1, len, ac.sampleRate);
  const data        = buf.getChannelData(0);
  const noiseDecay  = rand(9, 15);
  const thumpFreq   = rand(48, 75);
  const thumpDecay  = rand(20, 30);
  const crackFreq   = rand(180, 260);
  const crackDecay  = rand(32, 48);
  for (let i = 0; i < len; i++) {
    const t     = i / ac.sampleRate;
    const noise = (Math.random() * 2 - 1) * Math.exp(-t * noiseDecay);
    const thump = Math.sin(2 * Math.PI * thumpFreq * t) * Math.exp(-t * thumpDecay);
    const crack = Math.sin(2 * Math.PI * crackFreq * t) * Math.exp(-t * crackDecay);
    data[i] = noise * 0.55 + thump * 0.30 + crack * 0.15;
  }
  const src  = ac.createBufferSource();
  src.buffer = buf;
  const gain = ac.createGain();
  gain.gain.setValueAtTime(0.55, ac.currentTime);
  src.connect(gain);
  gain.connect(master);
  src.start();
}

// ── Global UI click wiring ───────────────────────────────────────────────────

// Plays a click for every <button> press anywhere in the document. Capture
// phase so it still fires even if a button's own handler stops propagation.
// Call once per HTML entry point (game.ts, splash.ts).
export function attachGlobalUiClicks(): void {
  document.addEventListener('pointerdown', (e) => {
    const target = e.target as HTMLElement | null;
    if (target?.closest('button')) playClick();
  }, { capture: true });
}
