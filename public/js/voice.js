// Canais de voz: conexão LiveKit, quadros de vídeo, volumes, indicador de fala, ping e painel de qualidade
import { $, h, store, makeAvatar, showBanner } from './util.js';
import { icon } from './icons.js';
import { openModal, button } from './dialogs.js';
import { avatarOf } from './state.js';
import { state, findChannel, canIn, PERMS, rememberedTextChannel } from './state.js';
import { api, send, request } from './net.js';
import { selectChannel } from './app.js';
import { renderChannels, renderUserPanel, renderVoicePanel } from './sidebar.js';
import { applyVolume as applyMusicVolume } from './music.js';
import { BUILTIN_SOUNDS, soundboardVolume, setSoundboardVolume, playBoardSound } from './sounds.js';

const { Room, RoomEvent, Track, VideoPresets, VideoPreset, ScreenSharePresets, AudioPresets, DisconnectReason } = LivekitClient;

// Áudio em alta fidelidade (Opus). O padrão do LiveKit é 48 kbps com DTX, que corta o início das falas.
// A taxa de bits da voz vem da configuração do canal (padrão 128 kbps)
const VOICE_AUDIO = {
  dtx: false,                            // não "desliga" o microfone nas pausas (evita cortar sílabas)
  red: true,                             // envia redundância: perda de pacote não vira falha na voz
};
// Modo música: desliga os filtros do navegador (redução de ruído, isolamento de voz, cancelamento de eco e ganho automático),
// que "limpam" a voz mas estragam instrumentos e música, e envia em estéreo. Precisa de fone (sem filtro, a caixa de som vira eco).
let musicMode = store.get('musicMode') === '1';
const captureOptions = () => ({
  echoCancellation: !musicMode, noiseSuppression: !musicMode, autoGainControl: !musicMode, voiceIsolation: !musicMode,
  sampleRate: 48_000, channelCount: musicMode ? 2 : 1,
  ...(store.get('micDevice') ? { deviceId: store.get('micDevice') } : {}), // microfone escolhido (se sumir, usa o padrão)
});

// ---------- Dispositivos e volumes (menus ao lado do microfone e do fone) ----------

export const micDevice = () => store.get('micDevice') || 'default';
export const speakerDevice = () => store.get('speakerDevice') || 'default';
const pct = (key, fallback) => { const v = Number(store.get(key)); return store.get(key) === null || Number.isNaN(v) ? fallback : v; };
export const inputVolume = () => Math.min(Math.max(pct('inputVolume', 100), 0), 200);   // % (100 = sem mudança)
export const outputVolume = () => Math.min(Math.max(pct('outputVolume', 100), 0), 100); // % (vale para todo o som da call)

// Lista de microfones ou saídas; sem permissão do microfone o navegador esconde os nomes
export async function listDevices(kind) {
  const all = await navigator.mediaDevices?.enumerateDevices?.().catch(() => []) ?? [];
  return all.filter((d) => d.kind === kind && d.deviceId); // sem permissão vem um item vazio: não serve para escolher
}
export async function unlockDeviceNames() {
  const s = await navigator.mediaDevices.getUserMedia({ audio: true });
  for (const t of s.getTracks()) t.stop();
}
export const canPickSpeaker = () => 'setSinkId' in HTMLMediaElement.prototype; // Safari antigo não deixa escolher

export async function setMicDevice(id) {
  store.set('micDevice', id === 'default' ? null : id);
  if (room) await room.switchActiveDevice('audioinput', id).catch((err) => showBanner(`Não consegui trocar o microfone: ${err.message}`, { timeout: 5000 }));
}
export async function setSpeakerDevice(id) {
  store.set('speakerDevice', id === 'default' ? null : id);
  for (const el of audioSink.children) el.setSinkId?.(id === 'default' ? '' : id).catch(() => {});
  if (room) await room.switchActiveDevice('audiooutput', id).catch(() => {});
}
export function setInputVolume(v) {
  store.set('inputVolume', Number(v) === 100 ? null : String(v));
  if (liveGain) liveGain.gain.value = inputVolume() / 100;
  else applyNoiseFilter(); // ainda sem processador: liga um só de volume
}
export function setOutputVolume(v) {
  store.set('outputVolume', Number(v) === 100 ? null : String(v));
  for (const p of room?.remoteParticipants.values() ?? []) {
    for (const kind of Object.keys(VOLUME_KINDS)) p.setVolume(savedVolume(p, kind) * outputVolume() / 100, VOLUME_KINDS[kind].source);
  }
}
export function setNoiseAi(on) {
  store.set('noiseAi', on ? null : '0');
  applyNoiseFilter();
}

// Câmera: 720p30 com até 2,5 Mbps; quem vê em quadro pequeno recebe as camadas menores (180p/360p)
const CAMERA_VIDEO = {
  videoEncoding: { maxBitrate: 2_500_000, maxFramerate: 30 },
  videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360],
};
const STREAM_AUDIO = {
  audioPreset: AudioPresets.musicHighQualityStereo, // som da live em estéreo a 128 kbps (jogos, música, vídeos)
  forceStereo: true,
  dtx: false,
};

// Qualidades de transmissão de tela (resolução + bitrate máximo)
// Opções da janela "Transmitir tela": resolução (bitrate base a 30 FPS) e quadros por segundo
const SCREEN_RES = {
  '720': { label: '720p', width: 1280, height: 720, bitrate: 3_000_000 },
  '1080': { label: '1080p', width: 1920, height: 1080, bitrate: 5_000_000 },
  '1440': { label: '1440p', width: 2560, height: 1440, bitrate: 8_000_000 },
  source: { label: 'Nativa', width: 3840, height: 2160, bitrate: 10_000_000, hint: 'resolução da sua tela' },
};
const SCREEN_FPS = { 15: 0.6, 30: 1, 60: 1.6 }; // multiplicador do bitrate
const screenBitrate = (res, fps) => Math.min(14_000_000, Math.round(SCREEN_RES[res].bitrate * SCREEN_FPS[fps]));

const IS_SAFARI = /^((?!chrome|chromium|android|crios|fxios|edg).)*safari/i.test(navigator.userAgent);

let room = null;             // conexão de voz (LiveKit)
let roomChannel = null;
let joining = false;
let pinnedKey = null;        // tile fixado pelo usuário (clique)
const tiles = new Map();     // key -> elemento do tile
const stage = $('stage');
const audioSink = document.createElement('div');
audioSink.hidden = true;
document.body.appendChild(audioSink);

export const voiceChannelId = () => roomChannel;
let joinedAt = 0;

// Avisa o servidor que algo mudou na voz: ele atualiza a lista de todos na hora
const poke = () => send({ t: 'voice:poke' });

function selfEntry() {
  const lp = room?.localParticipant;
  return {
    id: state.me.id,
    name: state.me.name,
    muted: !lp?.isMicrophoneEnabled,
    deafened: state.deafened,
    camera: !!lp?.isCameraEnabled,
    streaming: !!lp?.isScreenShareEnabled,
  };
}

// Mostra você na sala na hora do clique, sem esperar o servidor consultar o LiveKit
function showSelfInChannel() {
  for (const [id, list] of Object.entries(state.voice)) state.voice[id] = list.filter((p) => p.id !== state.me?.id);
  if (roomChannel) (state.voice[roomChannel] ??= []).push(selfEntry());
  renderChannels();
}

// Nos primeiros segundos o LiveKit ainda pode não te listar: mantém você na lista que chegou do servidor
export function mergeSelfIntoVoice(voice) {
  if (!roomChannel || !state.me || Date.now() - joinedAt > 5000) return voice;
  const list = voice[roomChannel] ?? [];
  if (!list.some((p) => p.id === state.me.id)) voice[roomChannel] = [...list, selfEntry()];
  return voice;
}
export const speakingNow = () => speakingSet;

// ---------- Voz ----------

export async function joinVoice(channelId) {
  if (joining) return;
  const { server } = findChannel(channelId);
  if (!canIn(server, PERMS.CONNECT)) return showBanner('Você não tem permissão para entrar neste canal.', { timeout: 4000 });
  joining = true;
  try {
    if (room) await leaveVoice({ keepView: true });
    const data = await api('/token', { channel: channelId });

    const r = new Room({
      // Só recebe a resolução que o quadro realmente mostra. 'screen' conta os pixels reais da tela:
      // sem isso, em telas Retina (Mac) um quadro de 800px reais recebia vídeo de 400px esticado.
      adaptiveStream: { pixelDensity: 'screen' },
      dynacast: true,       // para de enviar camadas de vídeo que ninguém está vendo
      videoCaptureDefaults: { resolution: VideoPresets.h720.resolution },
      // Cancelamento de eco e redução de ruído continuam ligados: sem eles, quem usa caixa de som gera eco para todos
      audioCaptureDefaults: captureOptions(),
      ...(store.get('speakerDevice') ? { audioOutput: { deviceId: store.get('speakerDevice') } } : {}),
      publishDefaults: { ...VOICE_AUDIO, audioPreset: { maxBitrate: channelBitrate(channelId) }, forceStereo: musicMode, ...CAMERA_VIDEO },
    });
    r
      .on(RoomEvent.ParticipantConnected, renderStage)
      .on(RoomEvent.ParticipantDisconnected, renderStage)
      .on(RoomEvent.TrackSubscribed, onTrackSubscribed)
      .on(RoomEvent.TrackUnsubscribed, onTrackUnsubscribed)
      .on(RoomEvent.TrackMuted, onMuteChange)
      .on(RoomEvent.TrackUnmuted, onMuteChange)
      .on(RoomEvent.LocalTrackPublished, (pub) => {
        if (pub.source === Track.Source.Microphone) {
          attachMeter(r.localParticipant.identity, pub.track.mediaStreamTrack);
          applyVoiceBitrate();
        }
        renderStage();
        poke();
      })
      .on(RoomEvent.LocalTrackUnpublished, onLocalUnpublished)
      .on(RoomEvent.AudioPlaybackStatusChanged, () => {
        if (r === room && !r.canPlaybackAudio) {
          showBanner('O navegador bloqueou o som. Clique aqui para ativar.', { kind: 'info', onClick: () => r.startAudio() });
        }
      })
      .on(RoomEvent.Disconnected, (reason) => {
        if (r !== room) return;
        onVoiceClosed();
        if (reason === DisconnectReason.DUPLICATE_IDENTITY) showBanner('Você entrou na voz em outra aba ou aparelho.', { kind: 'info', timeout: 5000 });
        else if (reason === DisconnectReason.PARTICIPANT_REMOVED) showBanner('Você foi desconectado da voz.', { timeout: 5000 });
        else if (reason === DisconnectReason.ROOM_DELETED) showBanner('O canal de voz foi excluído.', { timeout: 5000 });
      });

    meterCtx ??= new AudioContext();
    meterCtx.resume().catch(() => {}); // precisa do clique do usuário, que é o caso aqui
    await r.connect(data.url, data.token);
    room = r;
    roomChannel = channelId;
    joinedAt = Date.now();
    showSelfInChannel();
    await applyAudioState();
    updateMediaButtons();
    updatePing();
    // Continua no canal de texto aberto (o chat não some); a tela da chamada abre clicando no canal de voz
    renderChannels();
    renderVoicePanel();
  } catch (err) {
    console.error(err);
    showBanner(/full|max/i.test(err.message)
      ? 'Esse canal está cheio (máximo de 6 pessoas).'
      : `Não foi possível entrar no canal: ${err.message}`, { timeout: 5000 });
  } finally {
    joining = false;
  }
}

export async function leaveVoice({ keepView = false } = {}) {
  const r = room;
  if (!r) return;
  onVoiceClosed({ keepView });
  await r.disconnect();
}

function onVoiceClosed({ keepView = false } = {}) {
  for (const id of [...meters.keys()]) detachMeter(id);
  speakingSet = new Set();
  room = null;
  roomChannel = null;
  pinnedKey = null;
  for (const el of tiles.values()) el.remove();
  tiles.clear();
  audioSink.replaceChildren();
  renderVoicePanel();
  showSelfInChannel(); // some da lista na hora
  poke();
  // Estava olhando o canal de voz: volta para o último canal de texto do servidor
  const { server, channel } = findChannel(state.view.channelId);
  if (!keepView && channel?.type === 'voice' && state.me) selectChannel(rememberedTextChannel(server)?.id ?? null);
  else renderChannels();
}

// Microfone + ensurdecer (igual ao Discord: ensurdecer também silencia o microfone)
export async function applyAudioState() {
  for (const el of audioSink.children) el.muted = state.deafened;
  if (!room) return;
  const lp = room.localParticipant;
  try {
    const canSpeak = canIn(findChannel(roomChannel).server, PERMS.SPEAK);
    await lp.setMicrophoneEnabled(canSpeak && state.micOn && !state.deafened);
    await applyNoiseFilter();
    await applyPtt();
  } catch (err) {
    console.warn(err);
    state.micOn = false;
    renderUserPanel();
    showBanner(`Não foi possível acessar o microfone: ${err.message}`, { timeout: 5000 });
  }
  await lp.setAttributes({ deafened: state.deafened ? '1' : '0' }).catch(() => {});
  showSelfInChannel();
  poke();
  applyVoiceBitrate();
}

// ---------- Apertar para falar e supressão de ruído (IA) ----------

const pttOn = () => store.get('pttOn') === '1';
const pttKey = () => store.get('pttKey') || 'KeyV';
const keyLabel = (code) => code.replace(/^Key/, '').replace(/^Digit/, '').replace('Backquote', '`').replace('ControlLeft', 'Ctrl esq.')
  .replace('AltLeft', 'Alt esq.').replace('ShiftLeft', 'Shift esq.').replace('CapsLock', 'Caps Lock');
let pttHeld = false;
export const noiseAiOn = () => store.get('noiseAi') !== '0'; // ligado por padrão

// No modo "apertar para falar", o microfone fica ligado mas mudo, e só abre com a tecla segurada
async function applyPtt() {
  const pub = room?.localParticipant.getTrackPublication(Track.Source.Microphone);
  if (!pub?.track) return;
  if (pttOn() && !pttHeld) { if (!pub.isMuted) await pub.mute(); }
  else if (pub.isMuted && state.micOn && !state.deafened) await pub.unmute();
  $('btn-mic').classList.toggle('ptt-open', pttOn() && pttHeld);
}

const typingTarget = (e) => ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target?.tagName) || e.target?.isContentEditable;
window.addEventListener('keydown', (e) => {
  if (!room || !pttOn() || e.code !== pttKey() || e.repeat || typingTarget(e) || pttHeld) return;
  pttHeld = true;
  applyPtt();
});
window.addEventListener('keyup', (e) => {
  if (!pttHeld || e.code !== pttKey()) return;
  pttHeld = false;
  applyPtt();
});
window.addEventListener('blur', () => { if (pttHeld) { pttHeld = false; applyPtt(); } });

// O microfone passa por um processador (Web Audio) quando precisa: supressão de ruído por IA e/ou volume de entrada
let noiseContext = null;
let liveGain = null; // ganho do processador atual (o volume de entrada muda na hora, sem reiniciar)
async function applyNoiseFilter() {
  const track = room?.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
  if (!track) return;
  const wantNoise = noiseAiOn() && !musicMode;
  const want = wantNoise ? 'rnnoise' : inputVolume() !== 100 ? 'gain' : null;
  const has = track.getProcessor?.()?.name ?? null;
  try {
    if (want && want !== has) {
      noiseContext ??= new AudioContext({ sampleRate: 48_000 });
      if (noiseContext.state === 'suspended') await noiseContext.resume();
      track.setAudioContext(noiseContext);
      const { voiceProcessor } = await import('./noise.js');
      await track.setProcessor(voiceProcessor({ noise: wantNoise, onGain: (g) => { liveGain = g; g.gain.value = inputVolume() / 100; } }));
    } else if (!want && has) {
      await track.stopProcessor();
      liveGain = null;
    }
  } catch (err) {
    console.warn('supressão de ruído', err);
    showBanner('A supressão de ruído por IA não funcionou neste navegador (a normal continua ligada).', { timeout: 5000 });
  }
}

// Configurações de voz: modo de entrada (detecção de voz ou apertar para falar), supressão de ruído e soundboard
export function openVoiceSettings() {
  const content = h('div', 'form voice-settings');
  const mode = h('div', 'field');
  mode.append(h('span', 'field-label', 'Modo de entrada'));
  const opts = h('div', 'segmented');
  const vad = h('button', 'seg', 'Detecção de voz');
  const ptt = h('button', 'seg', 'Apertar para falar');
  for (const b of [vad, ptt]) b.type = 'button';
  const keyRow = h('div', 'ptt-key-row');
  const keyBtn = h('button', 'btn secondary', `Tecla: ${keyLabel(pttKey())}`);
  keyBtn.type = 'button';
  const hint = h('p', 'muted small', 'Segure a tecla para falar. Não funciona enquanto você digita, nem com o navegador em segundo plano.');
  keyRow.append(keyBtn);
  const paint = () => {
    vad.classList.toggle('on', !pttOn());
    ptt.classList.toggle('on', pttOn());
    keyRow.hidden = !pttOn();
    hint.hidden = !pttOn();
  };
  vad.onclick = () => { store.set('pttOn', null); paint(); applyPtt(); };
  ptt.onclick = () => { store.set('pttOn', '1'); paint(); applyPtt(); };
  keyBtn.onclick = () => {
    keyBtn.textContent = 'Aperte a tecla…';
    const grab = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code !== 'Escape') store.set('pttKey', e.code);
      keyBtn.textContent = `Tecla: ${keyLabel(pttKey())}`;
      window.removeEventListener('keydown', grab, true);
    };
    window.addEventListener('keydown', grab, true);
  };
  opts.append(vad, ptt);
  mode.append(opts, keyRow, hint);

  const noiseRow = h('label', 'toggle-row');
  const noiseBox = h('input');
  noiseBox.type = 'checkbox';
  noiseBox.checked = noiseAiOn();
  const nt = h('div', '');
  nt.append(h('div', 'toggle-label', 'Supressão de ruído por IA'),
    h('div', 'muted small', 'Tira ventilador, teclado, cachorro latindo… Roda no seu computador. Desliga sozinha no modo música.'));
  noiseRow.append(nt, noiseBox);
  noiseBox.onchange = () => { store.set('noiseAi', noiseBox.checked ? null : '0'); applyNoiseFilter(); };

  const vol = h('label', 'field');
  const range = h('input');
  Object.assign(range, { type: 'range', min: 0, max: 100, value: Math.round(soundboardVolume() * 100) });
  range.oninput = () => setSoundboardVolume(range.value);
  vol.append(h('span', 'field-label', 'Volume do soundboard'), range);
  content.append(mode, noiseRow, vol);
  paint();
  openModal({ title: 'Configurações de voz', content });
}
$('vp-settings').onclick = openVoiceSettings;

// ---------- Soundboard ----------

export function onBoardSound(m) {
  playBoardSound(m);
  const who = findChannel(roomChannel).server?.members.find((x) => x.id === m.by)?.name ?? 'Alguém';
  const label = BUILTIN_SOUNDS.find(([id]) => `builtin:${id}` === m.sound)?.[2] ?? m.name;
  const chip = h('div', 'board-chip', `🔊 ${who}: ${label}`);
  document.body.append(chip);
  setTimeout(() => chip.remove(), 2600);
}

function openSoundboard() {
  const server = findChannel(roomChannel).server;
  const box = h('div', 'soundboard');
  box.append(h('div', 'soundboard-title', 'Soundboard'));
  const grid = h('div', 'soundboard-grid');
  const add = (sound, emoji, label) => {
    const b = h('button', 'board-btn');
    b.type = 'button';
    b.append(h('span', 'board-emoji', emoji), h('span', 'board-name', label));
    b.onclick = () => request({ t: 'sound:play', sound }).catch((err) => showBanner(err.message, { timeout: 3000 }));
    grid.append(b);
  };
  for (const [id, emoji, label] of BUILTIN_SOUNDS) add(`builtin:${id}`, emoji, label);
  for (const s of server?.sounds ?? []) add(s.id, s.emoji, s.name);
  box.append(grid);
  if (!(server?.sounds ?? []).length) box.append(h('div', 'muted small', 'Quem gerencia emojis pode subir sons do servidor nas configurações (Sons).'));
  const overlay = document.getElementById('overlay-layer');
  overlay.append(box);
  const r = $('vp-soundboard').getBoundingClientRect();
  const br = box.getBoundingClientRect();
  box.style.left = `${Math.max(8, Math.min(r.left, innerWidth - br.width - 8))}px`;
  box.style.top = `${Math.max(8, r.top - br.height - 8)}px`;
  const outside = (e) => { if (!box.contains(e.target) && e.target !== $('vp-soundboard')) { box.remove(); document.removeEventListener('mousedown', outside, true); } };
  setTimeout(() => document.addEventListener('mousedown', outside, true), 0);
}
$('vp-soundboard').onclick = () => {
  const open = document.querySelector('.soundboard');
  if (open) open.remove(); else openSoundboard();
};

// Liga/desliga o modo música; conectado, troca o microfone na hora (os filtros e o estéreo são definidos ao capturar)
async function setMusicMode(on) {
  musicMode = on;
  store.set('musicMode', on ? '1' : null);
  updateMusicModeButton();
  showBanner(on
    ? 'Modo música ligado: som puro e em estéreo. Use fone de ouvido, senão os outros ouvem eco.'
    : 'Modo música desligado: redução de ruído e cancelamento de eco de volta.', { kind: 'info', timeout: 5000 });
  if (!room) return;
  Object.assign(room.options.audioCaptureDefaults, captureOptions());
  room.options.publishDefaults.forceStereo = on;
  const track = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
  if (track) await room.localParticipant.unpublishTrack(track).catch(() => {});
  await applyAudioState();
}

function updateMusicModeButton() {
  const b = $('btn-music-mode');
  b.classList.toggle('on', musicMode);
  b.title = musicMode
    ? 'Modo música ligado (clique para desligar)'
    : 'Modo música: sem redução de ruído e cancelamento de eco, em estéreo. Para tocar instrumento ou mostrar música. Use fone.';
}
updateMusicModeButton();
$('btn-music-mode').onclick = () => setMusicMode(!musicMode);

// Qualidade do áudio do canal (bits por segundo)
const channelBitrate = (channelId) => (findChannel(channelId).channel?.bitrate ?? 128) * 1000;

// Muda a qualidade do microfone na hora, sem reconectar, quando alguém altera o canal
async function applyVoiceBitrate() {
  if (!room) return;
  const bps = channelBitrate(roomChannel);
  room.options.publishDefaults.audioPreset = { maxBitrate: bps }; // vale se o microfone for publicado de novo
  const sender = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track?.sender;
  if (!sender) return;
  const params = sender.getParameters();
  if (!params.encodings?.length || params.encodings[0].maxBitrate === bps) return;
  params.encodings[0].maxBitrate = bps;
  await sender.setParameters(params).catch((err) => console.warn('bitrate', err));
}

$('btn-mic').onclick = () => {
  state.micOn = !state.micOn;
  if (state.micOn && state.deafened) state.deafened = false;
  store.set('micOn', state.micOn ? null : '0');
  store.set('deafened', state.deafened ? '1' : null);
  renderUserPanel();
  applyAudioState();
  applyMusicVolume(); // ligar o microfone também tira o ensurdecer
};

$('btn-deaf').onclick = () => {
  state.deafened = !state.deafened;
  store.set('deafened', state.deafened ? '1' : null);
  renderUserPanel();
  applyAudioState();
  applyMusicVolume(); // ensurdecer também silencia a música, como no Discord
};

export async function watchStream(channelId, identity) {
  if (roomChannel !== channelId) await joinVoice(channelId);
  if (roomChannel !== channelId) return;
  pinnedKey = `${identity}|screen`;
  selectChannel(channelId);
}

function onTrackSubscribed(track, pub, participant) {
  if (pub.source === Track.Source.Microphone) attachMeter(participant.identity, track.mediaStreamTrack);
  // Áudio remoto (voz e som da transmissão) toca num elemento escondido
  if (track.kind === Track.Kind.Audio) {
    const el = track.attach();
    el.muted = state.deafened;
    if (store.get('speakerDevice')) el.setSinkId?.(store.get('speakerDevice')).catch(() => {});
    audioSink.appendChild(el);
    // Reaplica o volume escolhido para essa pessoa (inclusive 0%)
    const kind = Object.keys(VOLUME_KINDS).find((k) => VOLUME_KINDS[k].source === pub.source);
    if (kind) participant.setVolume(savedVolume(participant, kind) * outputVolume() / 100, pub.source);
  }
  renderStage();
}

// Volume por pessoa (voz e live separados): fica salvo pelo nome e vale só para quem ajustou
const VOLUME_KINDS = {
  voice: { source: Track.Source.Microphone, key: 'voiceVolume', label: 'Volume da voz', empty: 'Microfone desligado' },
  stream: { source: Track.Source.ScreenShareAudio, key: 'streamVolume', label: 'Volume da live', empty: 'Esta transmissão está sem som' },
};

function savedVolume(p, kind) {
  const raw = store.get(`${VOLUME_KINDS[kind].key}:${p.name}`);
  const v = Number(raw);
  return raw === null || Number.isNaN(v) ? 1 : Math.min(Math.max(v, 0), 1);
}

function saveVolume(p, kind, volume) {
  store.set(`${VOLUME_KINDS[kind].key}:${p.name}`, String(volume));
  p.setVolume(volume * outputVolume() / 100, VOLUME_KINDS[kind].source);
}

const volumeIcon = (v) => icon(v === 0 ? 'volume-off' : v < 0.5 ? 'volume-low' : 'speaker', 18);

function buildVolumeControl(el) {
  const box = h('div', 'vol');
  const btn = h('button', 'vol-btn');
  const slider = h('input');
  Object.assign(slider, { type: 'range', min: 0, max: 100, step: 1 });
  box.append(btn, slider);

  // Não deixa o clique no controle fixar/soltar o quadro
  for (const ev of ['click', 'pointerdown', 'dblclick']) box.addEventListener(ev, (e) => e.stopPropagation());

  slider.oninput = () => {
    const v = Number(slider.value) / 100;
    saveVolume(el._participant, el._volKind, v);
    if (v > 0) box.dataset.last = String(v);
    btn.replaceChildren(volumeIcon(v));
    box.title = `${VOLUME_KINDS[el._volKind].label}: ${slider.value}%`;
  };
  btn.onclick = () => {
    const current = savedVolume(el._participant, el._volKind);
    const v = current > 0 ? 0 : Number(box.dataset.last) || 1; // clique = mudo / volta ao anterior
    if (current > 0) box.dataset.last = String(current);
    saveVolume(el._participant, el._volKind, v);
    syncVolumeControl(el);
  };
  return box;
}

function syncVolumeControl(el) {
  const box = el.querySelector('.vol');
  const kind = VOLUME_KINDS[el._volKind];
  const v = savedVolume(el._participant, el._volKind);
  box.querySelector('input').value = String(Math.round(v * 100));
  box.querySelector('.vol-btn').replaceChildren(volumeIcon(v));
  const hasAudio = !!el._participant.getTrackPublication(kind.source);
  box.classList.toggle('no-audio', !hasAudio);
  box.title = hasAudio ? `${kind.label}: ${Math.round(v * 100)}%` : kind.empty;
}

function onTrackUnsubscribed(track, pub, participant) {
  if (pub.source === Track.Source.Microphone) detachMeter(participant.identity);
  track.detach().forEach((el) => el.remove());
  renderStage();
}

function onMuteChange(pub, participant) {
  renderStage();
  if (participant?.isLocal) { showSelfInChannel(); poke(); } // câmera/microfone ligados ou desligados
}

function onLocalUnpublished(pub) {
  poke();
  // Usuário clicou em "parar compartilhamento" na barra do navegador
  if (pub.source === Track.Source.ScreenShare) updateMediaButtons();
  renderStage();
}

function warnDevice(what) {
  return (err) => {
    console.warn(err);
    showBanner(`Não foi possível acessar a ${what}: ${err.message}`, { timeout: 5000 });
  };
}

$('btn-cam').onclick = async () => {
  if (!room) return;
  const lp = room.localParticipant;
  await lp.setCameraEnabled(!lp.isCameraEnabled).catch(warnDevice('câmera'));
  updateMediaButtons();
  renderStage();
};

$('btn-screen').onclick = async () => {
  if (!room) return;
  const lp = room.localParticipant;
  if (lp.isScreenShareEnabled) {
    await lp.setScreenShareEnabled(false);
    updateMediaButtons();
    renderStage();
  } else openScreenDialog();
};

// Janela antes de transmitir (como o "Ao vivo" do Discord): resolução, FPS e som
function openScreenDialog() {
  const saved = (() => { try { return JSON.parse(store.get('screenOptions')) ?? {}; } catch { return {}; } })();
  const opts = {
    res: SCREEN_RES[saved.res] ? saved.res : '1080',
    fps: SCREEN_FPS[saved.fps] ? Number(saved.fps) : 30,
    audio: saved.audio ?? true,
  };
  const body = h('div', 'screen-dialog');
  const group = (title, entries, key) => {
    const box = h('div', 'seg-group');
    const row = h('div', 'seg');
    for (const [value, label, sub] of entries) {
      const b = h('button', 'seg-btn');
      b.type = 'button';
      b.append(h('strong', '', label));
      if (sub) b.append(h('span', '', sub));
      b.onclick = () => { opts[key] = key === 'fps' ? Number(value) : value; refresh(); };
      b.dataset.value = value;
      row.append(b);
    }
    box.append(h('span', 'field-label', title), row);
    body.append(box);
    return row;
  };
  const resRow = group('Resolução', Object.entries(SCREEN_RES).map(([k, r]) => [k, r.label, r.hint ?? `${r.width}×${r.height}`]), 'res');
  const fpsRow = group('Quadros por segundo', Object.keys(SCREEN_FPS).map((f) => [f, `${f} FPS`, { 15: 'mais leve', 30: 'padrão', 60: 'mais fluido' }[f]]), 'fps');
  const audioLabel = h('label', 'check-row');
  const audioBox = h('input');
  audioBox.type = 'checkbox';
  audioLabel.append(audioBox, h('span', '', IS_SAFARI ? 'Transmitir o som (o Safari não envia som de tela; use Chrome ou Edge)' : 'Transmitir o som também'));
  audioBox.onchange = () => { opts.audio = audioBox.checked; };
  const summary = h('p', 'muted small screen-summary');
  body.append(audioLabel, summary);

  const refresh = () => {
    for (const b of resRow.children) b.classList.toggle('selected', b.dataset.value === opts.res);
    for (const b of fpsRow.children) b.classList.toggle('selected', Number(b.dataset.value) === opts.fps);
    audioBox.checked = opts.audio && !IS_SAFARI;
    audioBox.disabled = IS_SAFARI;
    const mbps = (screenBitrate(opts.res, opts.fps) / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 1 });
    summary.textContent = `Usa até ${mbps} Mbps do seu upload.` + (opts.fps === 60 || opts.res === 'source' || opts.res === '1440'
      ? ' Pesa mais no computador: se a live travar, baixe para 1080p 30 FPS.' : '');
  };
  refresh();

  const go = button('Transmitir');
  const cancel = button('Cancelar', { kind: 'link' });
  const modal = openModal({ title: 'Transmitir tela', subtitle: 'Escolha a qualidade; depois o navegador pergunta qual tela ou janela mostrar.', content: body, actions: [cancel, go] });
  cancel.onclick = () => modal.close();
  go.onclick = () => {
    store.set('screenOptions', JSON.stringify(opts));
    modal.close();
    startScreenShare(opts);
  };
  setTimeout(() => go.focus(), 0);
}

async function startScreenShare({ res, fps, audio }) {
  if (!room) return;
  const r = SCREEN_RES[res];
  const bitrate = screenBitrate(res, fps);
  try {
    await room.localParticipant.setScreenShareEnabled(
      true,
      {
        // Som do sistema/aba (Chrome/Edge) sem os filtros de voz, que estragam música e som de jogo
        audio: audio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 } : false,
        // O Safari reduz a captura (ex.: 640x416) quando recebe limites de resolução,
        // então nele capturamos na resolução nativa e o bitrate/FPS controlam a qualidade.
        resolution: IS_SAFARI ? undefined : { width: r.width, height: r.height, frameRate: fps },
        contentHint: 'motion', // prioriza fluidez (jogos, vídeos)
        selfBrowserSurface: 'exclude',
      },
      {
        screenShareEncoding: { maxBitrate: bitrate, maxFramerate: fps, priority: 'medium' },
        // H.264 costuma ser codificado pela placa de vídeo (VP8 usa o processador): muito mais leve durante jogos
        videoCodec: 'h264',
        // O padrão do LiveKit para tela é manter a resolução e derrubar o FPS quando o PC não dá conta
        // (medido: 1080p a ~11 fps). Para live, é melhor baixar a resolução e manter a fluidez.
        degradationPreference: fps >= 60 ? 'maintain-framerate' : 'balanced',
        ...STREAM_AUDIO,
      },
    );
  } catch (err) {
    if (err.name !== 'NotAllowedError') warnDevice('tela')(err); // NotAllowed = usuário cancelou
  }
  updateMediaButtons();
  renderStage();
}

$('btn-leave').onclick = () => leaveVoice();

export function updateMediaButtons() {
  if (!room) return $('btn-cam').replaceChildren(icon('video-off'));
  const canVideo = canIn(findChannel(roomChannel).server, PERMS.VIDEO);
  for (const id of ['btn-cam', 'btn-screen']) $(id).hidden = !canVideo;
  const lp = room.localParticipant;
  $('btn-cam').replaceChildren(icon(lp.isCameraEnabled ? 'video' : 'video-off'));
  $('btn-cam').title = lp.isCameraEnabled ? 'Desligar câmera' : 'Ligar câmera';
  $('btn-cam').classList.toggle('on', lp.isCameraEnabled);
  $('btn-screen').classList.toggle('on', lp.isScreenShareEnabled);
  $('btn-screen').title = lp.isScreenShareEnabled ? 'Parar transmissão' : 'Transmitir tela';
  // Botões do painel "Voz conectada" (mesmas ações, sem sair do chat)
  $('vp-cam').hidden = $('vp-screen').hidden = !canVideo;
  $('vp-cam').classList.toggle('on', lp.isCameraEnabled);
  $('vp-cam').title = $('btn-cam').title;
  $('vp-screen').classList.toggle('on', lp.isScreenShareEnabled);
  $('vp-screen').title = $('btn-screen').title;
}
$('vp-cam').onclick = () => $('btn-cam').onclick();
$('vp-screen').onclick = () => $('btn-screen').onclick();

// ---------- Quem está falando (medido aqui, 20x por segundo) ----------
// O aviso do servidor chega com ~0,5 s de atraso; medir o volume localmente acende a borda junto com a voz.

const SPEAK_THRESHOLD = 0.012; // volume (RMS) a partir do qual conta como fala
const SPEAK_HOLD_MS = 300;     // mantém aceso um pouco depois da última sílaba, sem piscar
let meterCtx = null;
const meters = new Map();      // identity -> { src, analyser, data, lastLoud }
let speakingSet = new Set();

function attachMeter(identity, mediaStreamTrack) {
  if (!meterCtx || !mediaStreamTrack) return;
  detachMeter(identity);
  const src = meterCtx.createMediaStreamSource(new MediaStream([mediaStreamTrack]));
  const analyser = meterCtx.createAnalyser();
  analyser.fftSize = 512;
  src.connect(analyser); // só mede: não vai para a caixa de som
  meters.set(identity, { src, analyser, data: new Float32Array(analyser.fftSize), lastLoud: 0 });
}

function detachMeter(identity) {
  const m = meters.get(identity);
  if (!m) return;
  m.src.disconnect();
  meters.delete(identity);
}

setInterval(() => {
  if (!room || meters.size === 0) return;
  const now = performance.now();
  const next = new Set();
  for (const [identity, m] of meters) {
    m.analyser.getFloatTimeDomainData(m.data);
    let sum = 0;
    for (const v of m.data) sum += v * v;
    if (Math.sqrt(sum / m.data.length) > SPEAK_THRESHOLD) m.lastLoud = now;
    if (now - m.lastLoud < SPEAK_HOLD_MS) next.add(identity);
  }
  const changed = next.size !== speakingSet.size || [...next].some((id) => !speakingSet.has(id));
  speakingSet = next;
  if (changed) updateSpeaking();
}, 50);

// ---------- Ping da conexão de voz ----------

async function measurePing() {
  if (!room) return null;
  // Qualquer faixa de áudio/vídeo (enviada ou recebida) enxerga o par de conexão ativo com o servidor
  const endpoints = [];
  for (const pub of room.localParticipant.trackPublications.values()) if (pub.track?.sender) endpoints.push(pub.track.sender);
  for (const p of room.remoteParticipants.values()) {
    for (const pub of p.trackPublications.values()) if (pub.track?.receiver) endpoints.push(pub.track.receiver);
  }
  for (const ep of endpoints) {
    try {
      const stats = await ep.getStats();
      for (const st of stats.values()) {
        if (st.type === 'candidate-pair' && st.nominated && st.currentRoundTripTime !== undefined) {
          return Math.round(st.currentRoundTripTime * 1000);
        }
      }
    } catch {}
  }
  const signalRtt = room.engine?.client?.rtt; // plano B: ping do canal de sinalização
  return signalRtt ? Math.round(signalRtt) : null;
}

async function updatePing() {
  const ms = await measurePing();
  const tip = $('ping-tip');
  const quality = ms === null ? '' : ms < 100 ? 'good' : ms < 250 ? 'ok' : 'bad';
  $('vp-signal').className = `vp-signal ${quality}`;
  tip.replaceChildren(
    h('strong', '', ms === null ? 'Medindo…' : `${ms} ms`),
    h('div', 'muted small', { good: 'Conexão excelente', ok: 'Conexão razoável', bad: 'Conexão ruim', '': '' }[quality]),
  );
}
setInterval(() => { if (room) updatePing(); }, 2000);

// ---------- Renderização dos tiles ----------

function participants() {
  return room ? [room.localParticipant, ...room.remoteParticipants.values()] : [];
}

// Lista o que deve aparecer na tela: 1 tile por pessoa + 1 por transmissão ativa
function desiredTiles() {
  const list = [];
  for (const p of participants()) {
    const cam = p.getTrackPublication(Track.Source.Camera);
    list.push({ key: `${p.identity}|cam`, p, pub: cam, screen: false });
    const scr = p.getTrackPublication(Track.Source.ScreenShare);
    if (scr?.track) list.push({ key: `${p.identity}|screen`, p, pub: scr, screen: true });
  }
  return list;
}

export function renderStage() {
  if (!room) return;
  const list = desiredTiles();
  const keys = new Set(list.map((t) => t.key));

  if (pinnedKey && !keys.has(pinnedKey)) pinnedKey = null;
  const mainKey = pinnedKey || list.find((t) => t.screen)?.key || null;

  for (const [key, el] of tiles) {
    if (!keys.has(key)) { el.remove(); tiles.delete(key); }
  }

  for (const t of list) updateTile(tiles.get(t.key) || createTile(t.key), t, t.key === mainKey);

  // Com alguém em destaque (live): quadro grande em cima e os participantes numa faixa embaixo, que pode ser ocultada
  const focus = !!mainKey && list.length > 1;
  stage.classList.toggle('focus', focus);
  if (focus) {
    const others = list.filter((t) => t.key !== mainKey);
    stage.append(tiles.get(mainKey), stripToggle, strip); // append move sem recriar (o vídeo continua tocando)
    for (const t of others) strip.append(tiles.get(t.key));
    strip.hidden = stripHidden; // quadros ocultos deixam de receber vídeo (economiza banda)
    stripToggle.replaceChildren(
      icon(stripHidden ? 'chevron-up' : 'chevron-down', 16),
      stripHidden ? ` Mostrar participantes (${others.length})` : ' Ocultar participantes',
    );
  } else {
    for (const t of list) stage.append(tiles.get(t.key));
    stripToggle.remove();
    strip.remove();
  }
  updateSpeaking();
}

// Faixa de participantes embaixo da live
const strip = h('div', 'strip');
const stripToggle = h('button', 'strip-toggle');
let stripHidden = store.get('hideStrip') === '1';
stripToggle.onclick = () => {
  stripHidden = !stripHidden;
  store.set('hideStrip', stripHidden ? '1' : null);
  renderStage();
};

function createTile(key) {
  const el = document.createElement('div');
  el.className = 'tile';
  el.innerHTML = `
    <video autoplay playsinline muted hidden></video>
    <span class="label"></span>
    <pre class="stats" hidden></pre>
    <button class="fs" title="Tela cheia" hidden></button>`;
  el.querySelector('.fs').append(icon('maximize', 16));
  el.append(Object.assign(buildVolumeControl(el), { hidden: true }));
  el.onclick = () => { pinnedKey = pinnedKey === key ? null : key; renderStage(); };
  el.querySelector('.fs').onclick = (e) => {
    e.stopPropagation();
    el.querySelector('video').requestFullscreen?.();
  };
  tiles.set(key, el);
  return el;
}

function updateTile(el, { p, pub, screen }, isMain) {
  const video = el.querySelector('video');
  const track = pub?.track;
  const showVideo = !!track && !pub.isMuted;

  if (showVideo && el.dataset.trackSid !== track.sid) {
    track.attach(video);
    el.dataset.trackSid = track.sid;
  } else if (!showVideo && el.dataset.trackSid) {
    delete el.dataset.trackSid;
    video.srcObject = null;
  }

  const name = p.name || p.identity;
  video.hidden = !showVideo;
  video.style.transform = p.isLocal && !screen ? 'scaleX(-1)' : ''; // espelha só a própria câmera

  // Avatar com a cor da pessoa quando não há vídeo
  let avatar = el.querySelector('.avatar');
  const avatarKey = `${name}|${avatarOf(p.identity) ?? ''}`; // troca se a pessoa mudar de nome ou foto
  if (!avatar || avatar.dataset.key !== avatarKey) {
    avatar?.remove();
    avatar = makeAvatar(name, '', p.identity);
    avatar.dataset.key = avatarKey;
    el.prepend(avatar);
  }
  avatar.hidden = showVideo;

  el.querySelector('.fs').hidden = !screen;
  el.classList.toggle('screen', screen);
  el.classList.toggle('main', isMain);
  el.dataset.identity = p.identity;
  el._track = showVideo ? track : null; // usado pelo painel de qualidade
  el._participant = p;

  const mic = p.getTrackPublication(Track.Source.Microphone);
  const muted = !mic || mic.isMuted;
  const label = el.querySelector('.label');
  label.replaceChildren();
  if (screen) label.append(icon('monitor', 14), ` Tela de ${name}`);
  else {
    if (muted) label.append(icon('mic-off', 14), ' ');
    label.append(`${name}${p.isLocal ? ' (você)' : ''}`);
  }

  // Volume individual: voz no quadro da pessoa, som da live no quadro da tela (nunca no seu próprio)
  el._volKind = screen ? 'stream' : 'voice';
  const vol = el.querySelector('.vol');
  vol.hidden = p.isLocal;
  if (!vol.hidden) syncVolumeControl(el);
}

function updateSpeaking() {
  if (!room) return;
  const speaking = speakingSet;
  for (const [key, el] of tiles) {
    el.classList.toggle('speaking', key.endsWith('|cam') && speaking.has(el.dataset.identity));
  }
  // Bolinha verde na lista de canais (sem recriar a lista a cada fala)
  for (const row of document.querySelectorAll('.voice-member')) {
    row.classList.toggle('speaking', speaking.has(row.dataset.id));
  }
}

// ---------- Painel de qualidade ----------

const QUALITY_LABEL = { excellent: 'excelente', good: 'boa', poor: 'ruim', lost: 'perdida', unknown: '?' };
const LIMIT_LABEL = { bandwidth: 'banda', cpu: 'CPU', other: 'outro' };
let showStats = false;
const prevBytes = new WeakMap(); // track -> { bytes, time }

$('btn-stats').onclick = () => {
  showStats = !showStats;
  $('btn-stats').classList.toggle('on', showStats);
  for (const el of tiles.values()) el.querySelector('.stats').hidden = !showStats;
  if (showStats) updateStats();
};

setInterval(() => { if (showStats && findChannel(state.view.channelId).channel?.type === 'voice') updateStats(); }, 2000);

function kbps(track, bytes) {
  const now = performance.now();
  const prev = prevBytes.get(track);
  prevBytes.set(track, { bytes, time: now });
  if (!prev || bytes < prev.bytes) return null;
  return Math.round(((bytes - prev.bytes) * 8) / (now - prev.time)); // bytes/ms -> kbps
}

async function updateStats() {
  if (!room) return;
  for (const el of tiles.values()) {
    const out = el.querySelector('.stats');
    out.hidden = false;
    const p = el._participant;
    const track = el._track;
    const lines = [`conexão: ${QUALITY_LABEL[p?.connectionQuality] ?? '?'}`];
    try {
      if (track && p.isLocal) {
        const cap = track.mediaStreamTrack.getSettings();
        lines.push(`captura: ${cap.width}x${cap.height} @ ${Math.round(cap.frameRate ?? 0)}fps`);
        const layers = (await track.getSenderStats?.()) ?? [];
        const top = layers[0];
        if (top) {
          const rate = kbps(track, layers.reduce((sum, l) => sum + (l.bytesSent ?? 0), 0));
          lines.push(`enviando: ${top.frameWidth ?? '?'}x${top.frameHeight ?? '?'} @ ${Math.round(top.framesPerSecond ?? 0)}fps`);
          if (rate !== null) lines.push(`bitrate: ${rate} kbps (${layers.length} camada${layers.length > 1 ? 's' : ''})`);
          const limit = layers.find((l) => l.qualityLimitationReason && l.qualityLimitationReason !== 'none');
          if (limit) lines.push(`atenção: limitado por ${LIMIT_LABEL[limit.qualityLimitationReason] ?? limit.qualityLimitationReason}`);
          if (top.roundTripTime) lines.push(`ping: ${Math.round(top.roundTripTime * 1000)} ms`);
        }
      } else if (track) {
        const st = await track.getReceiverStats?.();
        if (st) {
          const rate = kbps(track, st.bytesReceived ?? 0);
          lines.push(`recebendo: ${st.frameWidth ?? '?'}x${st.frameHeight ?? '?'} @ ${Math.round(st.framesPerSecond ?? 0)}fps`);
          if (rate !== null) lines.push(`bitrate: ${rate} kbps`);
          lines.push(`perdidos: ${st.packetsLost ?? 0} pacotes  descartados: ${st.framesDropped ?? 0} quadros`);
          if (st.jitter) lines.push(`jitter: ${Math.round(st.jitter * 1000)} ms`);
        }
      } else {
        lines.push('sem vídeo');
      }
    } catch (err) {
      lines.push(`erro: ${err.message}`);
    }
    out.textContent = lines.join('\n');
  }
}

