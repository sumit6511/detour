/**
 * Synthesised sound effects: no audio files to load, so the game stays one small bundle and
 * works offline. Everything runs through one compressor so overlapping sounds never clip.
 * Browsers only allow audio after a user gesture; every sound here is triggered by one (or by
 * the bot replying to one), and a failed AudioContext simply means silence.
 */

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let enabled = true;

export function setSoundEnabled(on: boolean) {
  enabled = on;
}

function audio(): AudioContext | null {
  if (!enabled) return null;
  if (!ctx) {
    try {
      ctx = new AudioContext();
      const compressor = ctx.createDynamicsCompressor();
      compressor.threshold.value = -18;
      compressor.ratio.value = 6;
      master = ctx.createGain();
      master.gain.value = 0.55;
      master.connect(compressor).connect(ctx.destination);
    } catch {
      return null;
    }
  }
  if (ctx.state === "suspended") void ctx.resume().catch(() => {});
  return ctx;
}

interface ToneOptions {
  type?: OscillatorType;
  gain?: number;
  attack?: number;
  delay?: number;
  slideTo?: number;
}

function tone(freq: number, duration: number, options: ToneOptions = {}) {
  const ac = audio();
  if (!ac || !master) return;
  const { type = "sine", gain = 0.3, attack = 0.005, delay = 0, slideTo } = options;
  const start = ac.currentTime + delay;
  const osc = ac.createOscillator();
  const env = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, start + duration);
  env.gain.setValueAtTime(0.0001, start);
  env.gain.exponentialRampToValueAtTime(gain, start + attack);
  env.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  osc.connect(env).connect(master);
  osc.start(start);
  osc.stop(start + duration + 0.02);
}

interface NoiseOptions {
  gain?: number;
  delay?: number;
  freq?: number;
  q?: number;
  slideTo?: number;
}

function noise(duration: number, options: NoiseOptions = {}) {
  const ac = audio();
  if (!ac || !master) return;
  const { gain = 0.2, delay = 0, freq = 1200, q = 0.8, slideTo } = options;
  const start = ac.currentTime + delay;
  const length = Math.max(1, Math.floor(ac.sampleRate * duration));
  const buffer = ac.createBuffer(1, length, ac.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  const src = ac.createBufferSource();
  src.buffer = buffer;
  const filter = ac.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.setValueAtTime(freq, start);
  if (slideTo) filter.frequency.exponentialRampToValueAtTime(slideTo, start + duration);
  filter.Q.value = q;
  const env = ac.createGain();
  env.gain.setValueAtTime(gain, start);
  env.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  src.connect(filter).connect(env).connect(master);
  src.start(start);
}

/** A short tap of the phone, where the platform allows it. */
function buzz(ms: number) {
  if (!enabled) return;
  try {
    navigator.vibrate?.(ms);
  } catch {
    // Not available here: fine.
  }
}

export const sfx = {
  step() {
    tone(620, 0.07, { type: "triangle", gain: 0.22, slideTo: 440 });
    noise(0.03, { gain: 0.06, freq: 3000 });
    buzz(6);
  },
  jump() {
    noise(0.22, { gain: 0.14, freq: 600, slideTo: 2600, q: 1.2 });
    tone(520, 0.12, {
      type: "triangle",
      gain: 0.18,
      slideTo: 880,
      delay: 0.02,
    });
    tone(700, 0.08, { type: "triangle", gain: 0.2, slideTo: 460, delay: 0.24 });
    buzz(10);
  },
  wall() {
    tone(150, 0.18, { type: "sine", gain: 0.5, slideTo: 62 });
    noise(0.09, { gain: 0.28, freq: 700, q: 0.6 });
    tone(1800, 0.04, { type: "square", gain: 0.03, delay: 0.005 });
    buzz(14);
  },
  sign() {
    tone(880, 0.16, { type: "triangle", gain: 0.16, delay: 0.12 });
    tone(660, 0.22, { type: "triangle", gain: 0.16, delay: 0.26 });
  },
  invalid() {
    tone(140, 0.12, { type: "square", gain: 0.06 });
    tone(118, 0.14, { type: "square", gain: 0.06, delay: 0.09 });
    buzz(30);
  },
  undo() {
    tone(500, 0.09, { type: "triangle", gain: 0.16, slideTo: 330 });
  },
  click() {
    tone(900, 0.035, { type: "triangle", gain: 0.08 });
  },
  hint() {
    tone(988, 0.12, { type: "sine", gain: 0.14 });
    tone(1319, 0.18, { type: "sine", gain: 0.12, delay: 0.08 });
  },
  win() {
    [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.32, { type: "triangle", gain: 0.2, delay: i * 0.09 }));
    tone(1568, 0.5, { type: "sine", gain: 0.08, delay: 0.38 });
    buzz(40);
  },
  lose() {
    [392, 330, 262].forEach((f, i) => tone(f, 0.34, { type: "triangle", gain: 0.16, delay: i * 0.14 }));
  },
};
