// Transmissão de tela e câmera: as mesmas qualidades e a mesma janela "Transmitir tela" na call do site
// (voice.js) e na sala de tela do bot do Discord (tela.js)
import { h, store } from './util.js';
import { openModal, button } from './dialogs.js';

const { VideoPresets, AudioPresets, Track } = LivekitClient;

export const IS_SAFARI = /^((?!chrome|chromium|android|crios|fxios|edg).)*safari/i.test(navigator.userAgent);

// Volume acima de 100% (até 200%, como no Discord): o som de cada pessoa passa por um amplificador (Web Audio).
// Só onde o navegador também deixa escolher o fone nesse modo (Chrome, Edge, Opera); no Safari/Firefox fica até 100%.
export const CAN_BOOST = !IS_SAFARI && typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype;
export const MAX_PERSON_VOLUME = CAN_BOOST ? 2 : 1;

// Câmera: 720p30 com até 2,5 Mbps; quem vê em quadro pequeno recebe as camadas menores (180p/360p)
export const CAMERA_VIDEO = {
  videoEncoding: { maxBitrate: 2_500_000, maxFramerate: 30 },
  videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360],
};
export const STREAM_AUDIO = {
  audioPreset: AudioPresets.musicHighQualityStereo, // som da live em estéreo a 128 kbps (jogos, música, vídeos)
  forceStereo: true,
  dtx: false,
};

// Qualidades de transmissão de tela (resolução + bitrate máximo)
// Opções da janela "Transmitir tela": resolução (bitrate base a 30 FPS) e quadros por segundo.
// Teto: 1080p a 60 FPS (decisão do dono). Cada pessoa assistindo usa o upload do servidor: 60 FPS pesa mais nele.
// Qualidade fixa: quem transmite escolhe e é essa que todo mundo recebe (uma versão só, sem degraus menores)
export const SCREEN_RES = {
  '720': { label: '720p', width: 1280, height: 720, bitrate: 2_500_000 },
  '1080': { label: '1080p', width: 1920, height: 1080, bitrate: 4_500_000 },
};
// Multiplicador do bitrate por FPS: o dobro de quadros não precisa do dobro de dados (quadros seguidos se parecem).
// 60 FPS: 720p até 4 Mbps e 1080p até 7,2 Mbps
export const SCREEN_FPS = { 15: 0.6, 30: 1, 60: 1.6 };
const FPS_HINT = { 15: 'mais leve', 30: 'padrão', 60: 'mais fluido' };
export const screenBitrate = (res, fps) => Math.round(SCREEN_RES[res].bitrate * SCREEN_FPS[fps]);

// Argumentos de setScreenShareEnabled(true, captura, envio) para a qualidade escolhida
export function screenShareOptions({ res, fps, audio }) {
  const r = SCREEN_RES[res];
  return [
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
      screenShareEncoding: { maxBitrate: screenBitrate(res, fps), maxFramerate: fps, priority: 'high' },
      // Uma versão só, na qualidade escolhida: ninguém recebe uma versão menor sem pedir
      simulcast: false,
      // H.264 costuma ser codificado pela placa de vídeo (VP8 usa o processador): muito mais leve durante jogos
      videoCodec: 'h264',
      // Resolução fixa: se o PC ou a internet apertarem, o navegador segura a nitidez (e não a troca sozinho)
      degradationPreference: 'maintain-resolution',
      ...STREAM_AUDIO,
    },
  ];
}

// Depois de começar: trava também o FPS onde o navegador aceita, e o teto de resolução e FPS no Safari
export async function lockScreenQuality(localParticipant, fps = 30) {
  const pub = localParticipant.getTrackPublication(Track.Source.ScreenShare);
  const sender = pub?.track?.sender;
  if (sender) {
    try {
      const params = sender.getParameters();
      params.degradationPreference = 'maintain-framerate-and-resolution';
      await sender.setParameters(params);
    } catch { /* navegador antigo: fica com a resolução fixa */ }
  }
  if (IS_SAFARI) {
    await pub?.track?.mediaStreamTrack?.applyConstraints({ width: { max: 1920 }, height: { max: 1080 }, frameRate: { max: fps } }).catch(() => {});
  }
}

// Janela antes de transmitir (como o "Ao vivo" do Discord): resolução, FPS e som.
// audioNote(label): acrescenta um aviso sobre o som (o app do Windows usa). onStart(opções) começa a transmissão.
export function openScreenDialog({ onStart, audioNote }) {
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
  const fpsRow = group('Quadros por segundo', Object.keys(SCREEN_FPS).map((f) => [f, `${f} FPS`, FPS_HINT[f]]), 'fps');
  const audioLabel = h('label', 'check-row');
  const audioBox = h('input');
  audioBox.type = 'checkbox';
  audioLabel.append(audioBox, h('span', '', IS_SAFARI ? 'Transmitir o som (o Safari não envia som de tela; use Chrome ou Edge)' : 'Transmitir o som também'));
  audioNote?.(audioLabel);
  audioBox.onchange = () => { opts.audio = audioBox.checked; };
  const summary = h('p', 'muted small screen-summary');
  body.append(audioLabel, summary);

  const refresh = () => {
    for (const b of resRow.children) b.classList.toggle('selected', b.dataset.value === opts.res);
    for (const b of fpsRow.children) b.classList.toggle('selected', Number(b.dataset.value) === opts.fps);
    audioBox.checked = opts.audio && !IS_SAFARI;
    audioBox.disabled = IS_SAFARI;
    const mbps = (screenBitrate(opts.res, opts.fps) / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 1 });
    summary.textContent = `Usa até ${mbps} Mbps do seu upload. Qualidade máxima do servidor: 1080p a 60 FPS.`;
  };
  refresh();

  const go = button('Transmitir');
  const cancel = button('Cancelar', { kind: 'link' });
  const modal = openModal({ title: 'Transmitir tela', subtitle: 'Escolha a qualidade; depois o navegador pergunta qual tela ou janela mostrar.', content: body, actions: [cancel, go] });
  cancel.onclick = () => modal.close();
  go.onclick = () => {
    store.set('screenOptions', JSON.stringify(opts));
    modal.close();
    onStart(opts);
  };
  setTimeout(() => go.focus(), 0);
}
