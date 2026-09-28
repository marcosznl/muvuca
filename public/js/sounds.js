// Sons curtinhos, gerados na hora (sem arquivos): mensagem, menção, entrar/sair da voz, vitória.
// Dá para desligar no menu do seu status; em "não perturbe" ficam mudos.
import { store } from './util.js';
import { state } from './state.js';

let ctx = null;
export const soundsOn = () => store.get('sounds') !== '0';
export const setSounds = (on) => store.set('sounds', on ? null : '0');

function audio() {
  if (!ctx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    ctx = new Ctx();
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}
// O navegador só libera som depois de um clique: aproveita o primeiro para acordar o áudio
window.addEventListener('pointerdown', () => { if (soundsOn()) audio(); }, { once: true });

// Notas em sequência: [frequência em Hz, início em s, duração em s]
// force: toca mesmo com os sons desligados (o toque da ligação); "não perturbe" silencia tudo
function play(notes, { type = 'sine', volume = 0.12, force = false } = {}) {
  if ((!soundsOn() && !force) || state.me?.presence === 'dnd') return;
  const ac = audio();
  if (!ac || ac.state !== 'running') return;
  const t0 = ac.currentTime + 0.01;
  for (const [freq, start, dur] of notes) {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, t0 + start);
    gain.gain.linearRampToValueAtTime(volume, t0 + start + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + start + dur);
    osc.connect(gain).connect(ac.destination);
    osc.start(t0 + start);
    osc.stop(t0 + start + dur + 0.02);
  }
}

export const sounds = {
  message: () => play([[880, 0, 0.09], [1320, 0.07, 0.12]], { volume: 0.07 }),
  mention: () => play([[988, 0, 0.1], [1319, 0.08, 0.1], [1760, 0.16, 0.18]], { type: 'triangle', volume: 0.1 }),
  voiceJoin: () => play([[523, 0, 0.12], [784, 0.09, 0.18]], { type: 'triangle' }),
  voiceLeave: () => play([[784, 0, 0.12], [523, 0.09, 0.2]], { type: 'triangle' }),
  // Ligação: toque de quem recebe (trim-trim) e o "tuuu" de quem está chamando
  ring: () => play([[880, 0, 0.18], [660, 0.2, 0.18], [880, 0.4, 0.18], [660, 0.6, 0.25]], { type: 'triangle', volume: 0.14, force: true }),
  dialing: () => play([[440, 0, 0.9]], { volume: 0.05, force: true }),
  win: () => play([[523, 0, 0.14], [659, 0.12, 0.14], [784, 0.24, 0.14], [1047, 0.36, 0.35]], { type: 'square', volume: 0.06 }),
};

// ---------- Soundboard ----------
// Sons prontos, gerados na hora (sem arquivos nem direitos autorais); os do servidor vêm como arquivo.
// Volume próprio (Configurações de voz); quem está ensurdecido não ouve.

export const soundboardVolume = () => Number(store.get('soundboardVolume') ?? 60) / 100;
export const setSoundboardVolume = (v) => store.set('soundboardVolume', String(v));

export const BUILTIN_SOUNDS = [
  ['badumtss', '🥁', 'Ba dum tss'], ['tada', '🎉', 'Tadá!'], ['buzina', '📯', 'Buzina'], ['trombone', '🎺', 'Trombone triste'],
  ['sino', '🔔', 'Sino'], ['aplausos', '👏', 'Aplausos'], ['suspense', '😱', 'Suspense'], ['risada', '😂', 'Risada'],
];

function board() {
  const ac = audio();
  if (!ac || ac.state !== 'running') return null;
  const out = ac.createGain();
  out.gain.value = soundboardVolume();
  out.connect(ac.destination);
  return { ac, out, t0: ac.currentTime + 0.02 };
}

function tone(b, { freq, start, dur, type = 'sine', vol = 0.3, slide = null }) {
  const osc = b.ac.createOscillator();
  const g = b.ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, b.t0 + start);
  if (slide) osc.frequency.exponentialRampToValueAtTime(slide, b.t0 + start + dur);
  g.gain.setValueAtTime(0, b.t0 + start);
  g.gain.linearRampToValueAtTime(vol, b.t0 + start + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, b.t0 + start + dur);
  osc.connect(g).connect(b.out);
  osc.start(b.t0 + start);
  osc.stop(b.t0 + start + dur + 0.05);
}

// Ruído (bateria, palmas)
function noise(b, { start, dur, vol = 0.3, filter = 3000 }) {
  const len = Math.floor(b.ac.sampleRate * dur);
  const buf = b.ac.createBuffer(1, len, b.ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
  const src = b.ac.createBufferSource();
  src.buffer = buf;
  const f = b.ac.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.value = filter;
  const g = b.ac.createGain();
  g.gain.value = vol;
  src.connect(f).connect(g).connect(b.out);
  src.start(b.t0 + start);
}

const SYNTH = {
  badumtss(b) {
    tone(b, { freq: 180, start: 0, dur: 0.18, slide: 60, vol: 0.6 });
    tone(b, { freq: 160, start: 0.22, dur: 0.18, slide: 55, vol: 0.6 });
    noise(b, { start: 0.45, dur: 0.9, vol: 0.5, filter: 7000 });
  },
  tada(b) {
    for (const [f, s] of [[523, 0], [659, 0.1], [784, 0.2]]) tone(b, { freq: f, start: s, dur: 0.18, type: 'sawtooth', vol: 0.15 });
    for (const f of [523, 659, 784, 1047]) tone(b, { freq: f, start: 0.34, dur: 1.1, type: 'sawtooth', vol: 0.09 });
  },
  buzina(b) {
    for (const s of [0, 0.35]) { tone(b, { freq: 330, start: s, dur: 0.28, type: 'square', vol: 0.18 }); tone(b, { freq: 415, start: s, dur: 0.28, type: 'square', vol: 0.12 }); }
  },
  trombone(b) {
    [[392, 0], [370, 0.45], [349, 0.9]].forEach(([f, s]) => tone(b, { freq: f, start: s, dur: 0.4, type: 'sawtooth', vol: 0.18 }));
    tone(b, { freq: 330, start: 1.35, dur: 1.2, type: 'sawtooth', vol: 0.18, slide: 300 });
  },
  sino(b) {
    for (const [f, v] of [[880, 0.35], [1760, 0.12], [2640, 0.06]]) tone(b, { freq: f, start: 0, dur: 1.6, vol: v });
  },
  aplausos(b) {
    for (let i = 0; i < 26; i++) noise(b, { start: i * 0.07 + Math.random() * 0.05, dur: 0.12, vol: 0.35, filter: 1500 + Math.random() * 2500 });
  },
  suspense(b) {
    tone(b, { freq: 147, start: 0, dur: 0.35, type: 'sawtooth', vol: 0.25 });
    tone(b, { freq: 139, start: 0.45, dur: 0.35, type: 'sawtooth', vol: 0.25 });
    tone(b, { freq: 131, start: 0.9, dur: 1.4, type: 'sawtooth', vol: 0.28 });
  },
  risada(b) {
    for (let i = 0; i < 5; i++) tone(b, { freq: 420 - i * 20, start: i * 0.16, dur: 0.12, type: 'triangle', vol: 0.3, slide: 300 - i * 15 });
  },
};

// Toca um som do soundboard que alguém da call disparou
export function playBoardSound({ sound, url }) {
  if (state.deafened) return;
  if (url) {
    const el = new Audio(url);
    el.volume = soundboardVolume();
    el.play().catch(() => {});
    return;
  }
  const b = board();
  if (b) SYNTH[sound.replace('builtin:', '')]?.(b);
}
