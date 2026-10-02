// Mensagem de voz: o microfone do lado dos emojis grava (até 5 min); Enviar manda, a lixeira descarta.
// Na conversa, vira um tocador com play, barra de progresso e duração.
import { $, h, showBanner } from './util.js';
import { icon } from './icons.js';
import { state, chatChannelId } from './state.js';
import { send, upload } from './net.js';

const MAX_SECONDS = 300;
let rec = null; // { recorder, stream, chunks, started, timer, bar, cancelled }

const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
function pickMime() {
  for (const t of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']) {
    if (window.MediaRecorder?.isTypeSupported?.(t)) return t;
  }
  return '';
}

async function start() {
  if (rec) return;
  if (!window.MediaRecorder || !navigator.mediaDevices?.getUserMedia) return showBanner('Este navegador não grava áudio.', { timeout: 4000 });
  const channel = chatChannelId();
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); } catch {
    return showBanner('Não deu para usar o microfone. Libere o acesso no navegador.', { timeout: 5000 });
  }
  const mime = pickMime();
  const recorder = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 48_000 } : undefined);
  rec = { recorder, stream, chunks: [], started: Date.now(), channel, cancelled: false };
  recorder.ondataavailable = (e) => { if (e.data.size) rec?.chunks.push(e.data); };
  recorder.onstop = finish;
  recorder.start(1000);
  showBar();
}

function showBar() {
  const bar = h('div', 'voice-rec');
  const time = h('span', 'voice-rec-time', '0:00');
  const cancel = h('button', 'icon-btn danger-hover');
  cancel.type = 'button';
  cancel.title = 'Descartar';
  cancel.append(icon('trash', 18));
  cancel.onclick = () => stop(true);
  const sendBtn = h('button', 'btn primary voice-rec-send', 'Enviar');
  sendBtn.type = 'button';
  sendBtn.onclick = () => stop(false);
  bar.append(h('span', 'voice-rec-dot'), h('span', 'voice-rec-label', 'Gravando'), time, cancel, sendBtn);
  $('chat-form').append(bar);
  rec.bar = bar;
  rec.timer = setInterval(() => {
    const secs = (Date.now() - rec.started) / 1000;
    time.textContent = fmt(secs);
    if (secs >= MAX_SECONDS) stop(false); // passou do limite: envia o que tem
  }, 250);
}

function stop(cancelled) {
  if (!rec || rec.recorder.state === 'inactive') return;
  rec.cancelled = cancelled;
  rec.recorder.stop();
}

async function finish() {
  const r = rec;
  rec = null;
  clearInterval(r.timer);
  r.bar?.remove();
  for (const t of r.stream.getTracks()) t.stop();
  if (r.cancelled) return;
  const secs = Math.max(1, Math.round((Date.now() - r.started) / 1000));
  const blob = new Blob(r.chunks, { type: r.recorder.mimeType || 'audio/webm' });
  if (blob.size < 500) return showBanner('A gravação ficou vazia.', { timeout: 3000 });
  try {
    const file = await upload('/api/attach', { channel: r.channel, voice: 1, dur: secs }, blob);
    send({ t: 'msg', channel: r.channel, text: '', attachments: [file.id] });
  } catch (err) {
    showBanner(err.message, { timeout: 4500 });
  }
}

$('btn-voice').onclick = () => (rec ? stop(false) : start());
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && rec) stop(true); });

// ---------- Tocador na conversa ----------

let playing = null; // só um áudio tocando por vez
export function voiceNote(a) {
  const box = h('div', 'voice-note');
  const audio = new Audio();
  audio.preload = 'metadata';
  audio.src = a.url;
  const play = h('button', 'voice-play');
  play.type = 'button';
  play.title = 'Ouvir';
  play.append(icon('player-play', 18));
  const track = h('div', 'voice-track');
  const fill = h('div', 'voice-fill');
  track.append(fill);
  const total = a.width || 0; // a duração vem guardada no lugar da largura
  const time = h('span', 'voice-time', fmt(total));
  box.append(play, icon('mic', 16), track, time);
  const paint = () => {
    const dur = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : total;
    fill.style.width = `${dur ? Math.min(100, (audio.currentTime / dur) * 100) : 0}%`;
    time.textContent = audio.paused && audio.currentTime === 0 ? fmt(dur) : fmt(audio.currentTime);
  };
  const setIcon = () => play.replaceChildren(icon(audio.paused ? 'player-play' : 'pause', 18));
  play.onclick = (e) => {
    e.stopPropagation();
    if (audio.paused) {
      if (playing && playing !== audio) playing.pause();
      playing = audio;
      audio.play().catch(() => {});
    } else audio.pause();
  };
  track.onclick = (e) => {
    e.stopPropagation();
    const dur = Number.isFinite(audio.duration) ? audio.duration : total;
    const r = track.getBoundingClientRect();
    audio.currentTime = Math.max(0, Math.min(dur, ((e.clientX - r.left) / r.width) * dur));
    paint();
  };
  audio.ontimeupdate = paint;
  audio.onplay = setIcon;
  audio.onpause = setIcon;
  audio.onended = () => { audio.currentTime = 0; setIcon(); paint(); };
  return box;
}
