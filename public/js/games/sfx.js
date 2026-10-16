// Sons dos jogos, gerados na hora (sem arquivos): o servidor manda o estado ~20x por segundo e aqui
// comparamos com o anterior para descobrir o que aconteceu (bomba, explosão, tiro, carta, acerto…).
// Liga/desliga e volume próprios (botão 🔊 da sala); "não perturbe" silencia.
import { store } from '../util.js';
import { state } from '../state.js';

export const gameSoundsOn = () => store.get('gameSounds') !== '0';
export const setGameSounds = (on) => store.set('gameSounds', on ? null : '0');
export const gameVolume = () => Math.min(1, Math.max(0, Number(store.get('gameVolume') ?? 70) / 100));
export const setGameVolume = (v) => store.set('gameVolume', String(v));

let ctx = null;
let master = null;
function audio() {
  if (!ctx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    ctx = new Ctx();
    master = ctx.createGain();
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  master.gain.value = gameVolume();
  return ctx.state === 'running' ? ctx : null;
}
window.addEventListener('pointerdown', () => { if (gameSoundsOn()) audio(); }, { passive: true });
window.addEventListener('keydown', () => { if (gameSoundsOn()) audio(); });

const allowed = () => gameSoundsOn() && state.me?.presence !== 'dnd';

// Tons: [frequência inicial, início (s), duração (s), frequência final?]
function tones(notes, { type = 'square', volume = 0.1 } = {}) {
  const ac = audio();
  if (!ac) return;
  const t0 = ac.currentTime + 0.005;
  for (const [f, start, dur, f2] of notes) {
    const osc = ac.createOscillator();
    const g = ac.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f, t0 + start);
    if (f2) osc.frequency.exponentialRampToValueAtTime(f2, t0 + start + dur);
    g.gain.setValueAtTime(0, t0 + start);
    g.gain.linearRampToValueAtTime(volume, t0 + start + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + start + dur);
    osc.connect(g).connect(master);
    osc.start(t0 + start);
    osc.stop(t0 + start + dur + 0.02);
  }
}

// Ruído filtrado (explosão, batida, papel da carta)
let noiseBuf = null;
function noise({ dur = 0.3, freq = 800, q = 0.8, volume = 0.3, type = 'lowpass', sweepTo = null, start = 0 } = {}) {
  const ac = audio();
  if (!ac) return;
  if (!noiseBuf) {
    noiseBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const t0 = ac.currentTime + 0.005 + start;
  const src = ac.createBufferSource();
  src.buffer = noiseBuf;
  const filter = ac.createBiquadFilter();
  filter.type = type;
  filter.Q.value = q;
  filter.frequency.setValueAtTime(freq, t0);
  if (sweepTo) filter.frequency.exponentialRampToValueAtTime(sweepTo, t0 + dur);
  const g = ac.createGain();
  g.gain.setValueAtTime(volume, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(filter).connect(g).connect(master);
  src.start(t0, Math.random() * 0.5);
  src.stop(t0 + dur + 0.02);
}

// Evita metralhadora de sons iguais no mesmo instante (várias explosões juntas soam como uma)
const lastAt = new Map();
function limit(name, ms) {
  const now = performance.now();
  if (now - (lastAt.get(name) ?? 0) < ms) return false;
  lastAt.set(name, now);
  return true;
}

export const sfx = {
  tick: () => tones([[880, 0, 0.08]], { type: 'square', volume: 0.06 }),
  go: () => tones([[660, 0, 0.1], [990, 0.08, 0.22]], { type: 'square', volume: 0.08 }),
  yourTurn: () => tones([[784, 0, 0.09], [1175, 0.08, 0.16]], { type: 'triangle', volume: 0.1 }),
  click: (high = false) => tones([[high ? 700 : 520, 0, 0.06, high ? 900 : 380]], { type: 'triangle', volume: 0.12 }),
  bomb: () => tones([[180, 0, 0.12, 90]], { type: 'sine', volume: 0.25 }),
  explosion: () => { noise({ dur: 0.55, freq: 1400, sweepTo: 120, volume: 0.45 }); tones([[90, 0, 0.35, 40]], { type: 'sine', volume: 0.3 }); },
  pickup: () => tones([[988, 0, 0.07], [1319, 0.06, 0.07], [1976, 0.12, 0.12]], { type: 'square', volume: 0.07 }),
  death: () => tones([[440, 0, 0.5, 70]], { type: 'sawtooth', volume: 0.1 }),
  crash: () => { noise({ dur: 0.35, freq: 2500, sweepTo: 300, volume: 0.35 }); tones([[220, 0, 0.3, 60]], { type: 'square', volume: 0.08 }); },
  shoot: () => { tones([[1400, 0, 0.12, 300]], { type: 'square', volume: 0.06 }); noise({ dur: 0.08, freq: 3000, type: 'highpass', volume: 0.12 }); },
  hit: () => { noise({ dur: 0.15, freq: 600, volume: 0.35 }); tones([[160, 0, 0.12, 80]], { type: 'sine', volume: 0.2 }); },
  eat: (pitch = 1) => tones([[500 * pitch, 0, 0.06, 900 * pitch]], { type: 'sine', volume: 0.1 }),
  gulp: () => tones([[300, 0, 0.12, 120], [600, 0.1, 0.18, 1200]], { type: 'triangle', volume: 0.14 }),
  card: () => noise({ dur: 0.12, freq: 2500, sweepTo: 6000, type: 'bandpass', q: 1.2, volume: 0.35 }),
  draw: () => noise({ dur: 0.18, freq: 1500, sweepTo: 900, type: 'bandpass', q: 1, volume: 0.25 }),
  alert: () => tones([[1047, 0, 0.1], [1047, 0.14, 0.1], [1568, 0.28, 0.25]], { type: 'square', volume: 0.08 }),
  ominous: () => tones([[220, 0, 0.25, 180], [165, 0.2, 0.35, 130]], { type: 'sawtooth', volume: 0.07 }),
  correct: (mine = false) => tones(mine
    ? [[784, 0, 0.1], [988, 0.08, 0.1], [1319, 0.16, 0.3]]
    : [[1175, 0, 0.08], [1568, 0.07, 0.14]], { type: 'triangle', volume: mine ? 0.14 : 0.08 }),
  whistle: () => tones([[1800, 0, 0.18, 2400], [2400, 0.2, 0.35, 1900]], { type: 'sine', volume: 0.12 }),
  drum: () => { noise({ dur: 0.2, freq: 200, volume: 0.5 }); tones([[110, 0, 0.2, 55]], { type: 'sine', volume: 0.3 }); },
  pop: () => tones([[600, 0, 0.05, 1200]], { type: 'sine', volume: 0.12 }),
  whoosh: () => noise({ dur: 0.35, freq: 400, sweepTo: 4000, type: 'bandpass', q: 0.9, volume: 0.3 }),
  win: () => tones([[523, 0, 0.12], [659, 0.1, 0.12], [784, 0.2, 0.12], [1047, 0.3, 0.4]], { type: 'square', volume: 0.08 }),
  lose: () => tones([[392, 0, 0.25, 370], [370, 0.25, 0.25, 349], [349, 0.5, 0.6, 262]], { type: 'triangle', volume: 0.12 }),
};

function play(name, ...args) {
  if (!allowed() || !sfx[name]) return;
  sfx[name](...args);
}

// ---------- O que cada jogo toca ----------

const byId = (s) => new Map((s?.players ?? []).map((p) => [p.id, p]));
const secs = (ms) => Math.ceil((ms ?? 0) / 1000);

// Contagem regressiva de largada (3, 2, 1, vai!)
function countdown(prev, s) {
  if (prev.countdown == null || s.countdown == null) return;
  const a = secs(prev.countdown);
  const b = secs(s.countdown);
  if (b !== a && b > 0 && b <= 3) play('tick');
  if (a > 0 && b === 0) play('go');
}

function deaths(prev, s, me, sound = 'death') {
  const before = byId(prev);
  for (const p of s.players) {
    if (before.get(p.id)?.alive && !p.alive) {
      if (p.id === me) play('death');
      else if (limit(sound, 120)) play(sound);
    }
  }
}

const RULES = {
  bomberman(prev, s, me) {
    if (s.bombs.length > prev.bombs.length && limit('bomb', 60)) play('bomb');
    const had = new Set(prev.flames.map(([x, y]) => `${x},${y}`));
    if (s.flames.some(([x, y]) => !had.has(`${x},${y}`)) && limit('explosion', 150)) play('explosion');
    const a = byId(prev).get(me);
    const b = byId(s).get(me);
    if (a && b && (b.bombs > a.bombs || b.range > a.range || b.speed > a.speed)) play('pickup');
    deaths(prev, s, me);
  },





  desenho(prev, s, me) {
    if (s.phase !== prev.phase) {
      if (s.phase === 'draw') play('whoosh');
      if (s.phase === 'reveal') play('drum');
      if (s.phase === 'choose' && s.drawer === me) play('yourTurn');
    }
    const had = new Set(prev.guessed);
    for (const id of s.guessed) if (!had.has(id)) play('correct', id === me);
    if (s.phase === 'draw' && secs(s.timeLeft) !== secs(prev.timeLeft) && secs(s.timeLeft) <= 5 && secs(s.timeLeft) > 0) play('tick');
  },
  stop(prev, s) {
    if (s.stoppedBy && !prev.stoppedBy) play('whistle');
    if (s.phase !== prev.phase || s.round !== prev.round) {
      if (s.phase === 'write') play('drum');
      else if (s.phase === 'vote') play('whoosh');
      else if (s.phase === 'score') play('pop');
    }
    if (s.phase === 'write' && secs(s.timeLeft) !== secs(prev.timeLeft) && secs(s.timeLeft) <= 5 && secs(s.timeLeft) > 0) play('tick');
  },

};

// Chamado a cada estado novo da partida
export function gameSounds(game, prev, s, me) {
  if (!prev || !s || !allowed()) return;
  try {
    if (!s.over) RULES[game]?.(prev, s, me);
    // Fim de partida: vitória (festa) ou derrota (trombone triste), só para quem jogou
    if (s.over && !prev.over && s.players.some((p) => p.id === me) && s.players.length > 1) {
      const won = s.winner === me || (s.winners ?? []).includes(me);
      play(won ? 'win' : 'lose');
    }
  } catch (err) {
    console.warn('som do jogo', err);
  }
}
