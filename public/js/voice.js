// Canais de voz: conexão LiveKit, quadros de vídeo, volumes, indicador de fala, ping e painel de qualidade
import { $, h, store, makeAvatar, showBanner, toast } from './util.js';
import { icon } from './icons.js';
import { openModal, contextMenu, confirmDialog } from './dialogs.js';
import { avatarOf } from './state.js';
import { state, findChannel, canIn, PERMS, rememberedTextChannel } from './state.js';
import { api, send, request } from './net.js';
import { selectChannel } from './app.js';
import { renderChannels, renderUserPanel, renderVoicePanel } from './sidebar.js';
// Qualidades da câmera e da tela e a janela "Transmitir tela": as mesmas da sala de tela do bot do Discord
import { CAN_BOOST, MAX_PERSON_VOLUME, CAMERA_VIDEO, screenShareOptions, lockScreenQuality, openScreenDialog } from './transmissao.js';
import { somDoApp } from './desktop-audio.js';

const { Room, RoomEvent, Track, VideoPresets, VideoQuality, ConnectionQuality, DisconnectReason } = LivekitClient;

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
  callCtx?.setSinkId?.(id === 'default' ? '' : id).catch(() => {});
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

let callCtx = null; // um só para a página; "ensurdecer" pausa ele
function callAudioContext() {
  if (!CAN_BOOST) return null;
  callCtx ??= new AudioContext({ latencyHint: 'interactive' });
  const out = store.get('speakerDevice');
  if (out) callCtx.setSinkId(out).catch(() => {});
  return callCtx;
}
function applyDeafenToContext() {
  if (!callCtx) return;
  if (state.deafened) callCtx.suspend().catch(() => {});
  else callCtx.resume().catch(() => {});
}

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

// Mostra você no canal de voz na hora (sem esperar o servidor). Se já está na lista, atualiza no mesmo lugar:
// tirar e pôr no fim fazia as pessoas "trocarem de lugar" a cada mutar/desmutar (o servidor devolvia a ordem certa)
function showSelfInChannel() {
  const me = state.me ? state.me.id : null;
  for (const [id, list] of Object.entries(state.voice)) if (id !== roomChannel) state.voice[id] = list.filter((p) => p.id !== me);
  if (roomChannel) {
    const list = (state.voice[roomChannel] ??= []);
    const i = list.findIndex((p) => p.id === me);
    if (i >= 0) list[i] = selfEntry();
    else list.push(selfEntry());
  }
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

// A conta já está numa call por outro aparelho (e não por esta aba)?
function inCallElsewhere() {
  if (room || !state.me) return null;
  for (const [channelId, list] of Object.entries(state.voice)) if (list.some((p) => p.id === state.me.id)) return channelId;
  return null;
}

// Já está em call em outro aparelho: troca para este (o outro sai da call)?
function askMoveHere(otherChannel, channelId) {
  return confirmDialog({
    title: 'Você já está em call',
    message: otherChannel === channelId ? 'Você já está nesta call em outro aparelho. Trocando, o outro aparelho sai da call.' : 'Você já está em outra call num outro aparelho. Trocando, o outro sai daquela call e você entra nesta por aqui.',
    confirm: 'Trocar para este aparelho', danger: false,
  });
}

// ---------- Call que continua depois de recarregar a página (como no Discord) ----------
// Em call, a aba guarda o canal (sessionStorage: some ao fechar a aba). Recarregou (F5, atualização do
// Muvuca, "recarregar para todos" do painel): ao abrir de novo, entra sozinho na mesma call. Caiu sem
// ninguém pedir (internet, voz reiniciada): tenta voltar por cerca de 1 minuto. Sair de propósito esquece.
const RESUME_KEY = 'muvuca:call';
const RESUME_MS = 2 * 60_000;
let pageLeaving = false;
let retryTimer = null;
const readCall = () => { try { return JSON.parse(sessionStorage.getItem(RESUME_KEY) ?? 'null'); } catch { return null; } };
function rememberCall() {
  if (!room || !roomChannel) return;
  try { sessionStorage.setItem(RESUME_KEY, JSON.stringify({ channelId: roomChannel, at: Date.now() })); } catch {}
}
function forgetCall() {
  clearTimeout(retryTimer);
  retryTimer = null;
  try { sessionStorage.removeItem(RESUME_KEY); } catch {}
}
// O LiveKit desliga a call já no beforeunload (antes do pagehide): os dois marcam que a página está saindo
// (se a página não fechar de verdade — ex.: clicou num link de download —, a marca some sozinha)
for (const ev of ['beforeunload', 'pagehide']) {
  window.addEventListener(ev, () => { pageLeaving = true; rememberCall(); setTimeout(() => { pageLeaving = false; }, 3000); }, { capture: true });
}
window.addEventListener('pageshow', () => { pageLeaving = false; });

// Chamado quando o site abre e conecta (welcome): volta para a call em que a aba estava
export function resumeCall() {
  if (room || joining || retryTimer) return;
  const c = readCall();
  if (!c || Date.now() - c.at > RESUME_MS || !findChannel(c.channelId).channel) return forgetCall();
  joinVoice(c.channelId, { resume: true });
}

// Queda: tenta de novo em 1,5 s, 3 s, 6 s… (até ~1 min); para se a pessoa entrar em outra call ou sair
function retryCall(channelId) {
  const delays = [1500, 3000, 6000, 10_000, 15_000, 20_000];
  let i = 0;
  showBanner('A voz caiu. Reconectando…', { kind: 'info', timeout: 4000 });
  const attempt = async () => {
    retryTimer = null;
    if (room || !readCall() || !findChannel(channelId).channel) return;
    await joinVoice(channelId, { resume: true, quiet: i < delays.length - 1 });
    if (room) { showBanner('Voz reconectada.', { kind: 'info', timeout: 2500 }); return; }
    if (i < delays.length) retryTimer = setTimeout(attempt, delays[i++]);
    else forgetCall();
  };
  retryTimer = setTimeout(attempt, delays[i++]);
}

// Depois de recarregar, o navegador pode segurar o som até o primeiro clique ou tecla: libera nessa hora
function unlockAudioOnGesture() {
  const unlock = () => {
    meterCtx?.resume().catch(() => {});
    callCtx?.resume().catch(() => {});
    applyDeafenToContext();
    room?.startAudio().catch(() => {});
  };
  unlock();
  window.addEventListener('pointerdown', unlock, { once: true, capture: true });
  window.addEventListener('keydown', unlock, { once: true, capture: true });
}

// resume: voltando para a call depois de recarregar a página ou de uma queda (sem perguntas; quiet: sem aviso de erro)
export async function joinVoice(channelId, { moved = false, resume = false, quiet = false } = {}) {
  if (joining) return;
  const { server } = findChannel(channelId);
  if (!moved && !canIn(server, PERMS.CONNECT)) return showBanner('Você não tem permissão para entrar neste canal.', { timeout: 4000 });
  // Voltando de um recarregar: o "outro aparelho" que a lista ainda mostra é esta mesma aba
  const other = moved || resume ? null : inCallElsewhere();
  if (other && !(await askMoveHere(other, channelId))) return;
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
      webAudioMix: CAN_BOOST ? { audioContext: callAudioContext() } : false,
      ...(store.get('speakerDevice') ? { audioOutput: { deviceId: store.get('speakerDevice') } } : {}),
      publishDefaults: { ...VOICE_AUDIO, audioPreset: { maxBitrate: channelBitrate(channelId) }, forceStereo: musicMode, ...CAMERA_VIDEO },
    });
    r
      .on(RoomEvent.ParticipantConnected, renderStage)
      .on(RoomEvent.ParticipantDisconnected, renderStage)
      .on(RoomEvent.TrackSubscribed, onTrackSubscribed)
      .on(RoomEvent.TrackUnsubscribed, onTrackUnsubscribed)
      .on(RoomEvent.ConnectionQualityChanged, renderStage) // aviso de conexão instável nos quadros
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
        const deliberate = [DisconnectReason.DUPLICATE_IDENTITY, DisconnectReason.PARTICIPANT_REMOVED, DisconnectReason.ROOM_DELETED, DisconnectReason.CLIENT_INITIATED].includes(reason);
        if (deliberate || pageLeaving) {
          if (!pageLeaving) forgetCall();
          onVoiceClosed();
        } else {
          // Caiu sem ninguém pedir (internet, voz reiniciada pelo painel): continua na tela e tenta voltar sozinho
          onVoiceClosed({ keepView: true });
          retryCall(channelId);
        }
        if (reason === DisconnectReason.DUPLICATE_IDENTITY) showBanner('Você entrou na voz em outra aba ou aparelho.', { kind: 'info', timeout: 5000 });
        else if (reason === DisconnectReason.PARTICIPANT_REMOVED) showBanner('Você foi desconectado da voz.', { timeout: 5000 });
        else if (reason === DisconnectReason.ROOM_DELETED) showBanner('O canal de voz foi excluído.', { timeout: 5000 });
      });

    meterCtx ??= new AudioContext();
    meterCtx.resume().catch(() => {}); // precisa do clique do usuário, que é o caso aqui
    applyDeafenToContext(); // o amplificador de volume também só toca depois de um clique
    await r.connect(data.url, data.token);
    room = r;
    roomChannel = channelId;
    joinedAt = Date.now();
    rememberCall();
    if (resume) unlockAudioOnGesture();
    showSelfInChannel();
    await applyAudioState();
    updateMediaButtons();
    updatePing();
    syncDesktopPtt();
    // Continua no canal de texto aberto (o chat não some); a tela da chamada abre clicando no canal de voz
    renderChannels();
    renderVoicePanel();
  } catch (err) {
    console.error(err);
    if (quiet) return;
    showBanner(/cheio/.test(err.message) ? err.message
      : /full|max/i.test(err.message) ? 'Esse canal está cheio (máximo de 25 pessoas).'
        : `Não foi possível entrar no canal: ${err.message}`, { timeout: 5000 });
  } finally {
    joining = false;
  }
}

export async function leaveVoice({ keepView = false } = {}) {
  forgetCall(); // saiu de propósito: recarregar a página não traz de volta
  const r = room;
  if (!r) return;
  onVoiceClosed({ keepView });
  await r.disconnect();
}

function onVoiceClosed({ keepView = false } = {}) {
  for (const id of [...meters.keys()]) detachMeter(id);
  resetMicWatch();
  speakingSet = new Set();
  room = null;
  roomChannel = null;
  pinnedKey = null;
  for (const el of tiles.values()) el.remove();
  tiles.clear();
  syncMiniPlayer(); // saiu da call: a janela flutuante some
  audioSink.replaceChildren();
  renderVoicePanel();
  syncDesktopPtt(); // saiu da call: o app para de escutar a tecla
  stopMacAppAudio();
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
  applyDeafenToContext(); // com o amplificador, o som sai pelo Web Audio (os elementos ficam mudos)
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

// App do Mac: a tecla do "apertar para falar" funciona também com o Muvuca em segundo plano (jogando, por exemplo)
const desktop = window.muvucaDesktop;
let desktopPttWarned = false;
export async function syncDesktopPtt() {
  if (!desktop) return;
  const r = await desktop.setPushToTalk(!!room && pttOn(), pttKey()).catch(() => null);
  if (r && !r.ok && r.reason === 'permissao' && !desktopPttWarned) {
    desktopPttWarned = true;
    showBanner('Para o "apertar para falar" funcionar com o Muvuca em segundo plano, libere o Muvuca em Ajustes do Sistema → Privacidade e Segurança → Acessibilidade. Depois saia e entre na call de novo.', { kind: 'info', timeout: 12000 });
  }
}
desktop?.onPushToTalk((down) => {
  if (!room || !pttOn()) return;
  pttHeld = down;
  applyPtt();
});

// O microfone passa por um processador (Web Audio) quando precisa: supressão de ruído por IA e/ou volume de entrada
let noiseContext = null;
let liveGain = null; // ganho do processador atual (o volume de entrada muda na hora, sem reiniciar)
// O navegador deixa rodar WebAssembly? (a supressão de ruído por IA precisa; se não puder, o microfone vai sem ela
// em vez de ficar mudo — foi o que aconteceu quando uma regra de segurança do site bloqueou o WebAssembly)
let wasmOk = null;
async function canRunWasm() {
  if (wasmOk !== null) return wasmOk;
  try { await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])); wasmOk = true; } catch { wasmOk = false; }
  return wasmOk;
}

async function applyNoiseFilter() {
  const track = room?.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
  if (!track) return;
  const wantNoise = noiseAiOn() && !musicMode && await canRunWasm();
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
    // Nunca deixa o microfone mudo por causa do filtro: tira o processador e manda o som direto
    await track.stopProcessor?.().catch(() => {});
    liveGain = null;
    showBanner('A supressão de ruído por IA não funcionou neste navegador (a normal continua ligada).', { timeout: 5000 });
  }
}

// Configurações de voz: modo de entrada (detecção de voz ou apertar para falar) e supressão de ruído
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
  vad.onclick = () => { store.set('pttOn', null); paint(); applyPtt(); syncDesktopPtt(); };
  ptt.onclick = () => { store.set('pttOn', '1'); paint(); applyPtt(); syncDesktopPtt(); };
  keyBtn.onclick = () => {
    keyBtn.textContent = 'Aperte a tecla…';
    const grab = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code !== 'Escape') { store.set('pttKey', e.code); syncDesktopPtt(); }
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

  content.append(mode, noiseRow);
  paint();
  openModal({ title: 'Configurações de voz', content });
}
$('vp-settings').onclick = openVoiceSettings;

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
};

$('btn-deaf').onclick = () => {
  state.deafened = !state.deafened;
  store.set('deafened', state.deafened ? '1' : null);
  renderUserPanel();
  applyAudioState();
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
  return raw === null || Number.isNaN(v) ? 1 : Math.min(Math.max(v, 0), MAX_PERSON_VOLUME);
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
  Object.assign(slider, { type: 'range', min: 0, max: MAX_PERSON_VOLUME * 100, step: 1 });
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

// Botão direito na pessoa (lista do canal ou quadro da chamada): volume dela só para você, como no Discord
let userMenu = null;
function closeUserMenu() {
  userMenu?.remove();
  userMenu = null;
  document.removeEventListener('mousedown', outsideUserMenu, true);
  document.removeEventListener('keydown', escUserMenu, true);
}
function outsideUserMenu(e) { if (userMenu && !userMenu.contains(e.target)) closeUserMenu(); }
function escUserMenu(e) { if (e.key === 'Escape') { e.stopPropagation(); closeUserMenu(); } }

// Alguém com "Mover membros" te levou para outro canal de voz: troca sozinho (só o aparelho principal)
export async function onVoiceMove({ channelId, by }) {
  if (!room || roomChannel === channelId) return;
  const { channel } = findChannel(channelId);
  const wasViewing = state.view.channelId === roomChannel;
  await joinVoice(channelId, { moved: true });
  if (wasViewing) import('./app.js').then(({ selectChannel }) => selectChannel(channelId));
  showBanner(`${by} te moveu para ${channel?.name ?? 'outro canal'}.`, { kind: 'info', timeout: 5000 });
}

export function openUserVolumeMenu(identity, x, y) {
  const p = room?.remoteParticipants.get(identity);
  if (!p) return false; // só dentro da mesma chamada (e nunca em você mesmo)
  closeUserMenu();
  const menu = h('div', 'audio-menu user-volume-menu');
  menu.append(h('div', 'uv-name', p.name || p.identity));
  const slider = (kind) => {
    const box = h('div', 'am-slider');
    const head = h('div', 'am-slider-head');
    const num = h('span', 'am-slider-num');
    head.append(h('span', 'am-title', VOLUME_KINDS[kind].label), num);
    const range = h('input');
    Object.assign(range, { type: 'range', min: 0, max: MAX_PERSON_VOLUME * 100, step: 1, value: Math.round(savedVolume(p, kind) * 100) });
    const paint = () => {
      range.style.setProperty('--fill', `${(range.value / range.max) * 100}%`);
      num.textContent = `${range.value}%`;
      num.classList.toggle('boost', Number(range.value) > 100); // acima de 100%: amplificado
    };
    range.oninput = () => { saveVolume(p, kind, Number(range.value) / 100); paint(); paintMute(); renderStage(); };
    paint();
    box.append(head, range);
    box._range = range;
    return box;
  };
  const voice = slider('voice');
  menu.append(voice);
  // Volume da live aparece só se a pessoa estiver transmitindo com som
  if (p.getTrackPublication(Track.Source.ScreenShareAudio)) menu.append(slider('stream'));
  menu.append(h('div', 'am-sep'));
  // Silenciar para mim: volume da voz em 0 (desfazer volta ao volume de antes)
  const mute = h('button', 'am-row uv-toggle');
  mute.type = 'button';
  const box = h('span', 'uv-check');
  mute.append(h('span', 'am-title', 'Silenciar para mim'), box);
  const paintMute = () => mute.classList.toggle('on', savedVolume(p, 'voice') === 0);
  mute.onclick = () => {
    const now = savedVolume(p, 'voice');
    const next = now > 0 ? 0 : Number(store.get(`voiceVolumeBefore:${p.name}`)) || 1;
    if (now > 0) store.set(`voiceVolumeBefore:${p.name}`, String(now));
    saveVolume(p, 'voice', next);
    voice._range.value = String(Math.round(next * 100));
    voice._range.dispatchEvent(new Event('input'));
  };
  paintMute();
  const profile = h('button', 'am-row');
  profile.type = 'button';
  profile.append(h('span', 'am-title', 'Ver perfil'));
  profile.onclick = () => { closeUserMenu(); import('./profile.js').then(({ openProfileCard }) => openProfileCard(identity, x, y)); };
  menu.append(mute, profile);
  document.body.append(menu);
  const w = menu.offsetWidth;
  const hgt = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(x, innerWidth - w - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, innerHeight - hgt - 8))}px`;
  userMenu = menu;
  setTimeout(() => {
    document.addEventListener('mousedown', outsideUserMenu, true);
    document.addEventListener('keydown', escUserMenu, true);
  }, 0);
  return true;
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
  if (pub.source === Track.Source.ScreenShare) { updateMediaButtons(); stopMacAppAudio(); }
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
  const turningOn = !lp.isCameraEnabled;
  // No celular, liga na câmera que a pessoa usou por último (frontal ou traseira)
  await lp.setCameraEnabled(turningOn, turningOn && isTouch ? { facingMode: cameraFacing } : undefined).catch(warnDevice('câmera'));
  if (turningOn) await countCameras(); // com a permissão dada, a lista de câmeras vem completa
  updateMediaButtons();
  renderStage();
};

// ---------- Virar câmera (frontal ↔ traseira no celular; próxima câmera no computador) ----------
const isTouch = matchMedia('(pointer: coarse)').matches;
let cameraFacing = store.get('cameraFacing') === 'environment' ? 'environment' : 'user';
let cameraCount = 0;
async function countCameras() {
  const all = await navigator.mediaDevices?.enumerateDevices?.().catch(() => []) ?? [];
  cameraCount = all.filter((d) => d.kind === 'videoinput').length;
}
export const mirrorLocalCamera = () => cameraFacing === 'user'; // a traseira não é espelhada (texto legível)

async function flipCamera() {
  const track = room?.localParticipant.getTrackPublication(Track.Source.Camera)?.track;
  if (!track) return;
  const btns = [$('btn-flip'), $('vp-flip')];
  for (const b of btns) b.disabled = true;
  try {
    const caps = track.mediaStreamTrack?.getCapabilities?.() ?? {};
    if (isTouch || caps.facingMode?.length) {
      const next = cameraFacing === 'user' ? 'environment' : 'user';
      await track.restartTrack({ facingMode: next, resolution: VideoPresets.h720.resolution });
      cameraFacing = next;
      store.set('cameraFacing', next === 'environment' ? next : null);
    } else {
      // Computador com várias câmeras: passa para a próxima da lista
      const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput' && d.deviceId);
      const current = track.mediaStreamTrack?.getSettings?.().deviceId;
      const next = cams[(cams.findIndex((d) => d.deviceId === current) + 1) % cams.length];
      if (next) await room.switchActiveDevice('videoinput', next.deviceId);
    }
  } catch (err) {
    warnDevice('outra câmera')(err);
  } finally {
    for (const b of btns) b.disabled = false;
  }
  renderStage();
}
$('btn-flip').onclick = flipCamera;
$('vp-flip').onclick = flipCamera;

$('btn-screen').onclick = async () => {
  if (!room) return;
  const lp = room.localParticipant;
  if (lp.isScreenShareEnabled) {
    await lp.setScreenShareEnabled(false);
    updateMediaButtons();
    renderStage();
  } else openScreenDialog({ onStart: startScreenShare, audioNote: windowsAudioNote });
};

// Janela antes de transmitir (transmissao.js). App do Windows: Windows 10 (2020+) e 11 mandam só o som do
// programa da janela; os mais antigos, o do computador todo
function windowsAudioNote(audioLabel) {
  if (desktop?.platform !== 'win32') return;
  const note = h('span', 'muted small', '');
  audioLabel.append(note);
  desktop.appAudioSupported?.().then((ok) => {
    note.textContent = ok ? ' — só o som do programa da janela (a call não vai junto). Na tela inteira: tudo menos a call.'
      : ' — este Windows manda todo o som do computador. Se a galera ouvir a call de volta, desmarque.';
  }).catch(() => {});
}

// ---------- App do computador: som da live (só o programa da janela transmitida) ----------
// O Electron não captura esse som; o app captura à parte e o site publica como o "som da live" (desktop-audio.js)
const appAudio = somDoApp(desktop, { sala: () => room });
const stopMacAppAudio = () => appAudio.parar();

async function startScreenShare({ res, fps, audio }) {
  if (!room) return;
  // App do Mac: o som vem pelo ScreenCaptureKit (o app começa ao escolher a janela)
  // App do Mac: o som vem pelo ScreenCaptureKit; app do Windows: pelo som do sistema (loopback)
  if (desktop?.wantAppAudio) desktop.wantAppAudio(!!audio && (desktop.platform !== 'darwin' || await desktop.appAudioSupported()));
  try {
    await room.localParticipant.setScreenShareEnabled(true, ...screenShareOptions({ res, fps, audio }));
    await lockScreenQuality(room.localParticipant, fps);
  } catch (err) {
    if (err.name !== 'NotAllowedError') warnDevice('tela')(err); // NotAllowed = usuário cancelou
  }
  appAudio.publicar(); // o som do app pode ter ficado pronto antes da imagem
  updateMediaButtons();
  renderStage();
}

$('btn-leave').onclick = () => leaveVoice();

export function updateMediaButtons() {
  if (!room) {
    $('btn-flip').hidden = $('vp-flip').hidden = true;
    return $('btn-cam').replaceChildren(icon('video-off'));
  }
  const canVideo = canIn(findChannel(roomChannel).server, PERMS.VIDEO);
  for (const id of ['btn-cam', 'btn-screen']) $(id).hidden = !canVideo;
  const lp = room.localParticipant;
  $('btn-cam').replaceChildren(icon(lp.isCameraEnabled ? 'video' : 'video-off'));
  $('btn-cam').title = lp.isCameraEnabled ? 'Desligar câmera' : 'Ligar câmera';
  $('btn-cam').classList.toggle('on', lp.isCameraEnabled);
  // Virar câmera: só com a câmera ligada e mais de uma câmera no aparelho
  $('btn-flip').hidden = $('vp-flip').hidden = !canVideo || !lp.isCameraEnabled || cameraCount < 2;
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
    const rms = Math.sqrt(sum / m.data.length);
    m.peak = Math.max(m.peak ?? 0, rms); // maior volume desde o último relatório (painel: o microfone capta algo?)
    if (rms > SPEAK_THRESHOLD) m.lastLoud = now;
    if (now - m.lastLoud < SPEAK_HOLD_MS) next.add(identity);
  }
  const changed = next.size !== speakingSet.size || [...next].some((id) => !speakingSet.has(id));
  speakingSet = next;
  if (changed) updateSpeaking();
}, 50);

// Vigia do microfone: avisa a própria pessoa quando ninguém está ouvindo ela.
// Compara o que o microfone capta (raw) com o que de fato sai para a call (sent, depois dos filtros):
// - microfone com som, mas saindo silêncio → o filtro travou (foi o caso do WebAssembly bloqueado): desliga o filtro
// - microfone em silêncio absoluto (zero, nem ruído de fundo) → sem permissão do sistema ou microfone errado
const MIC_WATCH_MS = 500;
const micWatch = { raw: null, sent: null, silentSent: 0, zeroRaw: 0, warned: false, fixed: false };
const rmsOf = (w) => {
  w.analyser.getFloatTimeDomainData(w.data);
  let sum = 0;
  for (const v of w.data) sum += v * v;
  return Math.sqrt(sum / w.data.length);
};
function watchTrack(slot, mediaStreamTrack) {
  const cur = micWatch[slot];
  if (cur?.track === mediaStreamTrack) return cur;
  cur?.src.disconnect();
  micWatch[slot] = null;
  if (!mediaStreamTrack || !meterCtx) return null;
  const src = meterCtx.createMediaStreamSource(new MediaStream([mediaStreamTrack]));
  const analyser = meterCtx.createAnalyser();
  analyser.fftSize = 1024;
  src.connect(analyser);
  micWatch[slot] = { track: mediaStreamTrack, src, analyser, data: new Float32Array(analyser.fftSize) };
  return micWatch[slot];
}
export function resetMicWatch() {
  for (const slot of ['raw', 'sent']) { micWatch[slot]?.src.disconnect(); micWatch[slot] = null; }
  Object.assign(micWatch, { silentSent: 0, zeroRaw: 0, warned: false, fixed: false });
}
function micWarn(text) {
  if (micWatch.warned) return;
  micWatch.warned = true;
  showBanner(text, { timeout: 15000, onClick: () => openVoiceSettings() });
}
setInterval(() => {
  const pub = room?.localParticipant.getTrackPublication(Track.Source.Microphone);
  const track = pub?.track;
  if (!room || !track || pub.isMuted || !state.micOn || state.deafened || meterCtx?.state !== 'running') {
    micWatch.silentSent = 0; micWatch.zeroRaw = 0;
    return;
  }
  if (track.mediaStreamTrack?.readyState === 'ended') return micWarn('Seu microfone foi desconectado: ninguém está te ouvindo. Clique aqui para escolher outro.');
  const raw = watchTrack('raw', track.mediaStreamTrack);
  const sent = watchTrack('sent', track.sender?.track ?? null);
  if (!raw) return;
  const rawRms = rmsOf(raw);
  const sentRms = sent && sent.track !== raw.track ? rmsOf(sent) : rawRms;
  micWatch.zeroRaw = rawRms === 0 ? micWatch.zeroRaw + MIC_WATCH_MS : 0;
  micWatch.silentSent = rawRms > 0.003 && sentRms < 1e-5 ? micWatch.silentSent + MIC_WATCH_MS : Math.max(0, micWatch.silentSent - MIC_WATCH_MS);
  if (sentRms > 0.003) micWatch.warned = false; // voltou a sair som: pode avisar de novo se parar
  // O filtro engoliu a voz por uns segundos: tira o filtro nesta call (o som passa direto)
  if (micWatch.silentSent >= 4000 && !micWatch.fixed && track.getProcessor?.()) {
    micWatch.fixed = true;
    micWatch.silentSent = 0;
    track.stopProcessor().catch(() => {});
    liveGain = null;
    showBanner('A supressão de ruído travou e estava deixando seu microfone mudo. Desliguei ela nesta call para você voltar a ser ouvido.', { timeout: 10000 });
  } else if (micWatch.silentSent >= 8000) {
    micWarn('Seu microfone está captando som, mas nada está saindo para a call. Clique aqui para trocar o microfone ou sair e entrar de novo.');
  }
  if (micWatch.zeroRaw >= 12000) {
    const where = /Mac/.test(navigator.userAgent) ? 'Ajustes do Sistema → Privacidade e Segurança → Microfone'
      : /Windows/.test(navigator.userAgent) ? 'Configurações → Privacidade → Microfone' : 'as permissões do navegador';
    micWarn(`Seu microfone está mandando silêncio total: ninguém está te ouvindo. Veja se o Muvuca tem permissão em ${where}, ou clique aqui para escolher outro microfone.`);
  }
}, MIC_WATCH_MS);

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

  // Com alguém em destaque (live): quadro grande e os participantes embaixo, por cima da live (só as câmeras,
  // em miniatura no canto) ou ocultos — a pessoa escolhe nos botões entre os dois
  const focus = !!mainKey && list.length > 1;
  stage.classList.toggle('focus', focus);
  stage.classList.toggle('strip-over', focus && stripMode === 'over');
  if (focus) {
    const others = list.filter((t) => t.key !== mainKey);
    stage.append(tiles.get(mainKey), stripToggle, strip); // append move sem recriar (o vídeo continua tocando)
    for (const t of others) strip.append(tiles.get(t.key));
    strip.hidden = stripMode === 'hidden'; // quadros ocultos deixam de receber vídeo (economiza banda)
    paintStripModes(others.length);
  } else {
    for (const t of list) stage.append(tiles.get(t.key));
    stripToggle.remove();
    strip.remove();
  }
  layoutGrid();
  updateSpeaking();
  syncMiniPlayer();
}

// ---------- Janela flutuante (câmera e live fora da tela da call) ----------
// Em call e olhando outra coisa (chat, outro servidor, jogos, amigos): a live ou a câmera de quem está na call
// aparece numa janelinha no canto, que dá para arrastar. Tem vídeo próprio (o quadro da call fica onde está).
// Fechar esconde até alguém começar outra transmissão; "janela do sistema" solta o vídeo por cima de outros apps.
const mini = h('div', 'mini-player');
mini.hidden = true;
mini.innerHTML = `
  <video autoplay playsinline muted></video>
  <div class="mini-bar">
    <span class="mini-label"></span>
    <button class="mini-btn mini-prev" title="Anterior"></button>
    <button class="mini-btn mini-next" title="Próximo"></button>
    <button class="mini-btn mini-pip" title="Janela do sistema (fica por cima de outros programas)"></button>
    <button class="mini-btn mini-open" title="Abrir a call"></button>
    <button class="mini-btn mini-close" title="Fechar (volta quando alguém começar outra transmissão)"></button>
  </div>`;
document.body.append(mini);
const miniVideo = mini.querySelector('video');
mini.querySelector('.mini-prev').append(icon('arrow-left', 14));
mini.querySelector('.mini-next').append(icon('arrow-right', 14));
mini.querySelector('.mini-pip').append(icon('monitor-up', 14));
mini.querySelector('.mini-open').append(icon('maximize', 14));
mini.querySelector('.mini-close').append(icon('close', 14));
let miniKey = null;          // o que a janelinha está mostrando
let miniChosen = null;       // escolhido pelas setas
let miniDismissed = null;    // fechou: Set das transmissões que existiam (volta se surgir outra)
let miniTrack = null;

// O que dá para ver: lives primeiro, depois câmeras (de quem está na call, não as suas)
function miniCandidates() {
  return desiredTiles().filter((t) => !t.p.isLocal && t.pub?.track && !t.pub.isMuted)
    .sort((a, b) => Number(b.screen) - Number(a.screen));
}
const callOnScreen = () => !$('voice-view').hidden && state.view.channelId === roomChannel && !$('app').hidden;

export function syncMiniPlayer() {
  const list = room ? miniCandidates() : [];
  const keys = list.map((t) => t.key);
  // Começou outra transmissão depois de fechar: a janelinha volta mostrando a nova
  const fresh = miniDismissed && keys.find((k) => !miniDismissed.has(k));
  if (fresh) { miniDismissed = null; miniChosen = fresh; }
  const pip = document.pictureInPictureElement === miniVideo;
  const show = !!list.length && !callOnScreen() && (!miniDismissed || pip);
  const pick = list.find((t) => t.key === miniChosen) ?? list.find((t) => t.key === pinnedKey) ?? list[0];
  if (!show && !pip) {
    mini.hidden = true;
    if (miniTrack) { miniTrack.detach(miniVideo); miniTrack = null; miniKey = null; }
    return;
  }
  if (!pick) { mini.hidden = true; return; }
  const track = pick.pub.track;
  if (track !== miniTrack) {
    miniTrack?.detach(miniVideo);
    track.attach(miniVideo);
    miniTrack = track;
  }
  miniKey = pick.key;
  const name = pick.p.name || pick.p.identity;
  mini.querySelector('.mini-label').textContent = pick.screen ? `Tela de ${name}` : name;
  mini.classList.toggle('screen', pick.screen);
  mini.querySelector('.mini-prev').hidden = mini.querySelector('.mini-next').hidden = list.length < 2;
  mini.querySelector('.mini-pip').hidden = !document.pictureInPictureEnabled || !miniVideo.requestPictureInPicture;
  mini.hidden = !show || pip; // na janela do sistema, a do site some (não mostra o mesmo vídeo duas vezes)
  placeMini();
}

function miniStep(dir) {
  const keys = miniCandidates().map((t) => t.key);
  if (keys.length < 2) return;
  miniChosen = keys[(keys.indexOf(miniKey) + dir + keys.length) % keys.length];
  syncMiniPlayer();
}
function openMiniInCall() {
  if (!roomChannel) return;
  pinnedKey = miniKey; // abre a call com esse quadro em destaque
  selectChannel(roomChannel);
}
mini.querySelector('.mini-prev').onclick = (e) => { e.stopPropagation(); miniStep(-1); };
mini.querySelector('.mini-next').onclick = (e) => { e.stopPropagation(); miniStep(1); };
mini.querySelector('.mini-open').onclick = (e) => { e.stopPropagation(); openMiniInCall(); };
mini.querySelector('.mini-close').onclick = (e) => {
  e.stopPropagation();
  miniDismissed = new Set(miniCandidates().map((t) => t.key));
  syncMiniPlayer();
};
mini.querySelector('.mini-pip').onclick = async (e) => {
  e.stopPropagation();
  try { await miniVideo.requestPictureInPicture(); } catch { toast('Este navegador não deixou abrir a janela do sistema.'); }
  syncMiniPlayer();
};
miniVideo.addEventListener('leavepictureinpicture', () => syncMiniPlayer());
miniVideo.addEventListener('enterpictureinpicture', () => syncMiniPlayer());

// Arrastar (mouse ou dedo); a posição fica salva no aparelho. Toque sem arrastar abre a call.
let miniPos = null;
try { miniPos = JSON.parse(store.get('miniPos') ?? 'null'); } catch {}
function placeMini() {
  if (mini.hidden) return;
  const w = mini.offsetWidth; const hgt = mini.offsetHeight;
  const maxX = window.innerWidth - w - 8; const maxY = window.innerHeight - hgt - 8;
  const x = Math.min(Math.max(8, miniPos?.x ?? maxX - 8), maxX); // padrão: canto de baixo à direita
  const y = Math.min(Math.max(8, miniPos?.y ?? maxY - 72), maxY);
  mini.style.left = `${x}px`;
  mini.style.top = `${y}px`;
}
window.addEventListener('resize', placeMini);
// Qualquer troca de tela (jogos, amigos, outro canal) mostra ou esconde a janelinha
new MutationObserver(() => syncMiniPlayer()).observe($('voice-view'), { attributes: true, attributeFilter: ['hidden'] });
mini.addEventListener('pointerdown', (e) => {
  if (e.target.closest('.mini-btn') || e.button > 0) return;
  const start = { x: e.clientX, y: e.clientY, left: mini.offsetLeft, top: mini.offsetTop };
  let moved = false;
  mini.setPointerCapture(e.pointerId);
  const move = (ev) => {
    const dx = ev.clientX - start.x; const dy = ev.clientY - start.y;
    if (!moved && Math.hypot(dx, dy) < 5) return;
    moved = true;
    mini.classList.add('dragging');
    miniPos = { x: start.left + dx, y: start.top + dy };
    placeMini();
  };
  const up = () => {
    mini.removeEventListener('pointermove', move);
    mini.removeEventListener('pointerup', up);
    mini.removeEventListener('pointercancel', up);
    mini.classList.remove('dragging');
    if (moved) store.set('miniPos', JSON.stringify(miniPos));
    else openMiniInCall();
  };
  mini.addEventListener('pointermove', move);
  mini.addEventListener('pointerup', up);
  mini.addEventListener('pointercancel', up);
});

// Grade como a do Discord: todos os quadros em 16:9, com o número de colunas que deixa cada um o maior possível
// (antes as colunas esticavam até a altura toda e os quadros ficavam compridos em pé)
const TILE_RATIO = 16 / 9;
const GRID_GAP = 10;
function layoutGrid() {
  if (stage.classList.contains('focus')) return;
  const n = stage.querySelectorAll(':scope > .tile').length;
  if (!n) return;
  const cs = getComputedStyle(stage);
  const W = stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const H = stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  if (W <= 0 || H <= 0) return;
  let best = { w: 0, cols: 1 };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const w = Math.min((W - GRID_GAP * (cols - 1)) / cols, ((H - GRID_GAP * (rows - 1)) / rows) * TILE_RATIO);
    if (w > best.w) best = { w, cols };
  }
  stage.style.setProperty('--tile-w', `${Math.floor(best.w)}px`);
}
new ResizeObserver(() => layoutGrid()).observe(stage);

// Participantes durante a live: embaixo (faixa), sobre a tela (câmeras em miniatura no canto) ou ocultos
const strip = h('div', 'strip');
const stripToggle = h('div', 'strip-toggle');
const STRIP_MODES = [['below', 'Embaixo'], ['over', 'Sobre a tela'], ['hidden', 'Ocultar']];
let stripMode = store.get('stripMode') ?? (store.get('hideStrip') === '1' ? 'hidden' : 'below');
if (!STRIP_MODES.some(([m]) => m === stripMode)) stripMode = 'below';
function paintStripModes(count) {
  stripToggle.replaceChildren(h('span', 'strip-label', `Participantes (${count}):`), ...STRIP_MODES.map(([mode, label]) => {
    const b = h('button', mode === stripMode ? 'strip-mode on' : 'strip-mode', label);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(mode === stripMode));
    b.onclick = (e) => {
      e.stopPropagation();
      stripMode = mode;
      store.set('stripMode', mode === 'below' ? null : mode);
      store.set('hideStrip', null);
      renderStage();
    };
    return b;
  }));
}

function createTile(key) {
  const el = document.createElement('div');
  el.className = 'tile';
  el.innerHTML = `
    <video autoplay playsinline muted hidden></video>
    <span class="label"></span>
    <pre class="stats" hidden></pre>
    <span class="conn-warn" hidden></span>
    <button class="qual" title="Qualidade da live" hidden></button>
    <button class="fs" title="Tela cheia" hidden></button>`;
  el.querySelector('.qual').onclick = (e) => { e.stopPropagation(); openQualityMenu(el, e.currentTarget); };
  el.querySelector('.fs').append(icon('maximize', 16));
  el.append(Object.assign(buildVolumeControl(el), { hidden: true }));
  el.onclick = () => { pinnedKey = pinnedKey === key ? null : key; renderStage(); };
  el.oncontextmenu = (e) => { if (openUserVolumeMenu(el.dataset.identity, e.clientX, e.clientY)) e.preventDefault(); };
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
  el.classList.toggle('has-video', showVideo);
  video.style.transform = p.isLocal && !screen && mirrorLocalCamera() ? 'scaleX(-1)' : ''; // espelha só a própria câmera frontal

  // Avatar com a cor da pessoa quando não há vídeo
  let avatar = el.querySelector('.avatar');
  const avatarKey = `${name}|${avatarOf(String(p.identity).split(':')[0]) ?? ''}`; // troca se a pessoa mudar de nome ou foto
  if (!avatar || avatar.dataset.key !== avatarKey) {
    avatar?.remove();
    avatar = makeAvatar(name, '', p.identity);
    avatar.dataset.key = avatarKey;
    el.prepend(avatar);
  }
  avatar.hidden = showVideo;

  el.querySelector('.fs').hidden = !screen;
  // Live de outra pessoa: mostra a qualidade que está chegando (fixa, escolhida por quem transmite)
  const qual = el.querySelector('.qual');
  qual.hidden = !screen || p.isLocal || !showVideo;
  el._pub = pub;
  if (!qual.hidden) { applyStreamQuality(pub); paintQualityButton(el); }
  // Conexão instável de quem está no quadro (é dela que vem a imagem e a voz)
  const cq = p.connectionQuality;
  const warn = el.querySelector('.conn-warn');
  warn.hidden = cq !== ConnectionQuality.Poor && cq !== ConnectionQuality.Lost;
  if (!warn.hidden) warn.replaceChildren(icon('signal', 12), p.isLocal ? ' Sua conexão está instável' : ' Conexão instável');
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
    label.append(name);
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

// ---------- Qualidade da live para quem assiste ----------
// Fixa: chega exatamente a qualidade que quem transmite escolheu (não há versão menor para trocar).
// O botão só mostra o que está chegando (resolução e quadros por segundo) e a conexão de cada um.
function applyStreamQuality(pub) {
  if (pub && !pub.track?.isLocal && pub.setVideoQuality) pub.setVideoQuality(VideoQuality.HIGH);
}

function paintQualityButton(el) {
  const video = el.querySelector('video');
  const vh = video?.videoHeight;
  const res = vh ? `${vh >= 1000 ? 1080 : vh >= 700 ? 720 : vh >= 520 ? 540 : vh >= 340 ? 360 : vh}p` : '';
  const fps = el._pub?.track?.mediaStreamTrack?.getSettings?.().frameRate;
  el.querySelector('.qual').textContent = res ? `${res}${fps ? ` · ${Math.round(fps)} fps` : ''}` : 'Live';
}
// Mostra o que está chegando: atualiza o botão a cada 2 s
setInterval(() => { for (const el of tiles.values()) if (!el.querySelector('.qual').hidden) paintQualityButton(el); }, 2000);

const CONN_LABEL = { excellent: 'excelente', good: 'boa', poor: 'instável', lost: 'caindo', unknown: 'medindo…' };
function openQualityMenu(el, btn) {
  const r = btn.getBoundingClientRect();
  const who = room?.getParticipantByIdentity?.(el.dataset.identity) ?? room?.remoteParticipants.get(el.dataset.identity);
  const mine = room?.localParticipant.connectionQuality;
  contextMenu(r.left, r.bottom + 4, [
    { label: 'Qualidade fixa: a que quem transmite escolheu', icon: 'monitor', onClick: () => {} },
    'sep',
    { label: `Conexão de ${who?.name ?? 'quem transmite'}: ${CONN_LABEL[who?.connectionQuality] ?? '?'}`, icon: 'signal', onClick: () => {} },
    { label: `Sua conexão: ${CONN_LABEL[mine] ?? '?'}`, icon: 'signal', onClick: () => {} },
  ]);
}

// ---------- Painel de qualidade ----------

const QUALITY_LABEL = { excellent: 'excelente', good: 'boa', poor: 'ruim', lost: 'perdida', unknown: '?' };
const LIMIT_LABEL = { bandwidth: 'banda', cpu: 'CPU', other: 'outro' };
let showStats = false;
const prevBytes = new WeakMap(); // track -> { bytes, time }

// Painel do dono: a cada 10 s, quem está em call manda um resumo da própria conexão
// (qualidade, o que envia — câmera/live — e como está recebendo). Só números, nada de conteúdo.
const reportPrev = new Map(); // chave -> { v, time }
function reportDelta(key, value, perSecond = false) {
  const now = performance.now();
  const prev = reportPrev.get(key);
  reportPrev.set(key, { v: value, time: now });
  if (!prev || value < prev.v) return null;
  return perSecond ? ((value - prev.v) * 1000) / (now - prev.time) : value - prev.v;
}
async function reportStats() {
  if (!room) return;
  const lp = room.localParticipant;
  const pub = [];
  for (const p of lp.videoTrackPublications.values()) {
    const track = p.track;
    if (!track) continue;
    const layers = (await track.getSenderStats?.().catch(() => null)) ?? [];
    const top = layers[0];
    const bps = reportDelta(`tx:${p.trackSid}`, layers.reduce((n, l) => n + (l.bytesSent ?? 0), 0), true);
    pub.push({
      src: p.source === Track.Source.ScreenShare ? 'screen' : 'camera',
      w: top?.frameWidth ?? null, h: top?.frameHeight ?? null, fps: Math.round(top?.framesPerSecond ?? 0),
      kbps: bps === null ? null : Math.round((bps * 8) / 1000),
      limit: layers.find((l) => l.qualityLimitationReason && l.qualityLimitationReason !== 'none')?.qualityLimitationReason ?? null,
      rtt: top?.roundTripTime ? Math.round(top.roundTripTime * 1000) : null,
    });
  }
  let rx = 0; let lost = 0; let got = 0; let jitter = 0; let n = 0;
  for (const rp of room.remoteParticipants.values()) {
    for (const p of rp.trackPublications.values()) {
      if (!p.track || !p.isSubscribed) continue;
      const st = await p.track.getReceiverStats?.().catch(() => null);
      if (!st) continue;
      const bps = reportDelta(`rx:${p.trackSid}`, st.bytesReceived ?? 0, true);
      if (bps) rx += bps;
      lost += reportDelta(`lost:${p.trackSid}`, st.packetsLost ?? 0) ?? 0;
      got += reportDelta(`got:${p.trackSid}`, st.packetsReceived ?? 0) ?? 0;
      if (st.jitter) { jitter += st.jitter; n++; }
    }
  }
  // Microfone: quanto está enviando e o maior volume captado nos últimos 10 s (0 = mudo/sem permissão do sistema)
  const micTrack = lp.getTrackPublication(Track.Source.Microphone)?.track;
  const micStats = micTrack ? await micTrack.getSenderStats?.().catch(() => null) : null;
  const micBps = micStats ? reportDelta('mic', micStats.bytesSent ?? 0, true) : null;
  const mine = meters.get(lp.identity);
  const mic = { on: !!micTrack && !micTrack.isMuted, kbps: micBps === null ? null : Math.round((micBps * 8) / 1000), peak: mine ? Math.round((mine.peak ?? 0) * 1000) / 1000 : null };
  if (mine) mine.peak = 0;
  // Volume do que chega dos outros (o que toca aqui)
  let heard = null;
  for (const [identity, m] of meters) {
    if (identity === lp.identity) continue;
    heard = Math.max(heard ?? 0, m.peak ?? 0);
    m.peak = 0;
  }
  send({
    t: 'voice:stats', q: lp.connectionQuality ?? 'unknown', pub, mic, heard: heard === null ? null : Math.round(heard * 1000) / 1000,
    rx: { kbps: Math.round((rx * 8) / 1000), loss: lost + got > 0 ? Math.round((lost * 1000) / (lost + got)) / 10 : 0, jitter: n ? Math.round((jitter * 1000) / n) : null },
  });
}
setInterval(() => { if (room) reportStats().catch(() => {}); }, 10_000);

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

