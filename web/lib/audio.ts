// Self-contained chiptune audio — no asset files, no licensing. A looping arcade track plus
// small SFX, synthesized with the Web Audio API. Everything is created lazily on first use and
// must be kicked off by a user gesture (browsers block autoplay).

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let playing = false;
let timer: ReturnType<typeof setInterval> | null = null;
let nextTime = 0;
let step = 0;

// A cheerful 16-step loop (eighth notes). 0 = rest. Swap these for a real track later.
const LEAD = [659.25, 0, 783.99, 659.25, 440, 0, 523.25, 587.33, 659.25, 0, 587.33, 523.25, 440, 0, 392, 0];
const BASS = [110, 0, 110, 0, 87.31, 0, 87.31, 0, 130.81, 0, 130.81, 0, 98, 0, 98, 0];
const STEP = 0.16; // seconds per eighth note (~115 bpm)

function ensure() {
  if (ctx) return;
  const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = 0.14;
  master.connect(ctx.destination);
}

function tone(freq: number, at: number, dur: number, type: OscillatorType, vol: number) {
  if (!freq || !ctx || !master) return;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, at);
  g.gain.linearRampToValueAtTime(vol, at + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  osc.connect(g);
  g.connect(master);
  osc.start(at);
  osc.stop(at + dur + 0.02);
}

function schedule() {
  if (!ctx) return;
  while (nextTime < ctx.currentTime + 0.12) {
    const i = step % LEAD.length;
    tone(LEAD[i], nextTime, STEP * 0.9, "square", 0.5);
    tone(BASS[i], nextTime, STEP * 0.95, "triangle", 0.8);
    nextTime += STEP;
    step++;
  }
}

export const music = {
  isPlaying: () => playing,
  start() {
    ensure();
    if (!ctx || playing) return;
    void ctx.resume();
    playing = true;
    nextTime = ctx.currentTime + 0.05;
    timer = setInterval(schedule, 25);
  },
  stop() {
    playing = false;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  },
  toggle() {
    if (playing) this.stop();
    else this.start();
    return playing;
  },
};

// --- SFX (also usable on their own) ---

export function sfxGood() {
  ensure();
  if (!ctx) return;
  void ctx.resume();
  const t = ctx.currentTime;
  tone(880, t, 0.09, "square", 0.4);
  tone(1318.51, t + 0.05, 0.12, "square", 0.35);
}

export function sfxBad() {
  ensure();
  if (!ctx) return;
  void ctx.resume();
  tone(150, ctx.currentTime, 0.16, "sawtooth", 0.4);
}

export function sfxWin() {
  ensure();
  if (!ctx) return;
  void ctx.resume();
  const t = ctx.currentTime;
  [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(f, t + i * 0.09, 0.18, "square", 0.4));
}
