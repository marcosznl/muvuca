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
