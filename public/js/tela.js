// Página da sala de tela (tela.html): entra com o Discord, assiste e compartilha a tela.
// Sem microfone, câmera nem chat: o token do servidor só permite compartilhar a tela (src/tela.js).
const { Room, RoomEvent, Track, DisconnectReason } = window.LivekitClient;

const codigo = location.pathname.split('/')[2] ?? '';
const $ = (id) => document.getElementById(id);

const ERROS = {
  membro: 'Só membros do servidor do Discord onde a sala foi criada podem entrar.',
  cancelado: 'O login com o Discord foi cancelado.',
  discord: 'Não consegui confirmar a sua conta no Discord. Tente de novo.',
  config: 'O login com o Discord ainda não foi configurado neste Muvuca.',
};

// Mesmo teto das transmissões do site: 1080p a 30 FPS, H.264 (ver public/js/voice.js)
const IS_SAFARI = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
const PODE_COMPARTILHAR = !!navigator.mediaDevices?.getDisplayMedia;

let room = null;
let foco = null; // identidade de quem está em tela cheia no palco

// ---------- Avisos (carregando, login, sala encerrada) ----------

function aviso(texto, { erro = false, botao = null } = {}) {
  $('sala').hidden = true;
  $('acoes').hidden = true;
  const caixa = $('aviso');
  caixa.hidden = false;
  caixa.replaceChildren();
  const p = document.createElement('p');
  p.textContent = texto;
  if (erro) p.className = 'erro';
  caixa.append(p);
  if (botao) caixa.append(botao);
}

function link(texto, href) {
  const a = document.createElement('a');
  a.className = 'botao';
  a.href = href;
  a.textContent = texto;
  return a;
}

function botaoEntrarDeNovo() {
  const b = document.createElement('button');
  b.textContent = 'Entrar de novo';
  b.onclick = () => entrar();
  return b;
}

// ---------- Entrar ----------

async function entrar() {
  aviso('Entrando…');
  let res;
  try {
    res = await fetch('/api/tela/entrar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sala: codigo }),
    });
  } catch {
    return aviso('Não consegui falar com o servidor. Confira a internet.', { erro: true, botao: botaoEntrarDeNovo() });
  }
  const dados = await res.json().catch(() => ({}));
  if (res.status === 404) return aviso('Esta sala foi encerrada. Peça um link novo no Discord com /tela.');
  if (res.status === 401) {
    return aviso('Entre com a sua conta do Discord para ver e compartilhar telas nesta sala.', { botao: link('Entrar com Discord', `/tela/entrar?sala=${encodeURIComponent(codigo)}`) });
  }
  if (!res.ok) return aviso(dados.error || 'Não consegui entrar na sala.', { erro: true, botao: botaoEntrarDeNovo() });

  $('nome-sala').textContent = `· ${dados.sala.nome}`;
  room = new Room({ adaptiveStream: true, dynacast: true });
  room
    .on(RoomEvent.ParticipantConnected, desenhar)
    .on(RoomEvent.ParticipantDisconnected, desenhar)
    .on(RoomEvent.ParticipantMetadataChanged, desenhar)
    .on(RoomEvent.TrackSubscribed, aoReceber)
    .on(RoomEvent.TrackUnsubscribed, aoPerder)
    .on(RoomEvent.TrackMuted, desenhar)
    .on(RoomEvent.TrackUnmuted, desenhar)
    .on(RoomEvent.LocalTrackPublished, desenhar)
    .on(RoomEvent.LocalTrackUnpublished, desenhar)
    .on(RoomEvent.Disconnected, aoSair);
  try {
    await room.connect(dados.url, dados.token);
  } catch {
    room = null;
    return aviso('Não consegui conectar na sala. Tente de novo.', { erro: true, botao: botaoEntrarDeNovo() });
  }
  $('aviso').hidden = true;
  $('sala').hidden = false;
  $('acoes').hidden = false;
  $('btn-tela').hidden = !PODE_COMPARTILHAR;
  desenhar();
}

function aoSair(motivo) {
  room = null;
  foco = null;
  for (const el of document.querySelectorAll('audio[data-tela]')) el.remove();
  if (motivo === DisconnectReason.ROOM_DELETED) return aviso('Esta sala foi encerrada. Peça um link novo no Discord com /tela.');
  if (motivo === DisconnectReason.DUPLICATE_IDENTITY) return aviso('Você abriu esta sala em outra aba ou aparelho.', { botao: botaoEntrarDeNovo() });
  if (motivo === DisconnectReason.CLIENT_INITIATED) return aviso('Você saiu da sala.', { botao: botaoEntrarDeNovo() });
  aviso('A conexão com a sala caiu.', { erro: true, botao: botaoEntrarDeNovo() });
}

// Som da tela compartilhada: toca fora do palco (o vídeo pode ser redesenhado sem cortar o som)
function aoReceber(track, pub, participante) {
  if (track.source === Track.Source.ScreenShareAudio) {
    const el = track.attach();
    el.dataset.tela = participante.identity;
    document.body.append(el);
  }
  desenhar();
}

function aoPerder(track) {
  for (const el of track.detach()) if (el.tagName === 'AUDIO') el.remove();
  desenhar();
}

// ---------- Compartilhar ----------

async function alternarTela() {
  if (!room) return;
  const botao = $('btn-tela');
  botao.disabled = true;
  try {
    if (room.localParticipant.isScreenShareEnabled) {
      await room.localParticipant.setScreenShareEnabled(false);
    } else {
      await room.localParticipant.setScreenShareEnabled(
        true,
        {
          // Som da aba/sistema (Chrome/Edge) sem os filtros de voz, que estragam música e som de jogo
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 },
          // O Safari reduz a captura quando recebe limites de resolução: nele vai a nativa
          resolution: IS_SAFARI ? undefined : { width: 1920, height: 1080, frameRate: 30 },
          contentHint: 'motion',
          selfBrowserSurface: 'exclude',
        },
        {
          screenShareEncoding: { maxBitrate: 4_500_000, maxFramerate: 30, priority: 'high' },
          simulcast: false,
          videoCodec: 'h264',
          degradationPreference: 'maintain-resolution',
          forceStereo: true,
          dtx: false,
        },
      );
    }
  } catch (err) {
    if (err.name !== 'NotAllowedError') alert('Não consegui compartilhar a tela neste navegador.'); // NotAllowed = cancelou
  }
  botao.disabled = false;
  desenhar();
}

// ---------- Desenho ----------

const pessoas = () => (room ? [room.localParticipant, ...room.remoteParticipants.values()] : []);

function fotoDe(p) {
  try { return JSON.parse(p.metadata || '{}').avatar || ''; } catch { return ''; }
}

function telaDe(p) {
  const pub = p.getTrackPublication(Track.Source.ScreenShare);
  return pub?.track && !pub.isMuted ? pub.track : null;
}

function desenhar() {
  if (!room) return;
  const local = room.localParticipant;
  $('btn-tela').textContent = local.isScreenShareEnabled ? 'Parar de compartilhar' : 'Compartilhar tela';
  $('btn-tela').className = local.isScreenShareEnabled ? 'perigo' : '';

  // Quem está na sala
  const lista = pessoas().map((p) => {
    const li = document.createElement('li');
    const img = document.createElement('img');
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    const foto = fotoDe(p);
    if (foto) img.src = foto;
    const nome = document.createElement('span');
    nome.className = 'nome';
    nome.textContent = p === local ? `${p.name} (você)` : p.name;
    li.append(img, nome);
    if (telaDe(p)) {
      const vivo = document.createElement('span');
      vivo.className = 'ao-vivo';
      vivo.textContent = 'AO VIVO';
      li.append(vivo);
    }
    return li;
  });
  $('lista').replaceChildren(...lista);

  // Telas compartilhadas (clicar numa deixa só ela no palco; clicar de novo volta para todas)
  const comTela = pessoas().filter(telaDe);
  if (foco && !comTela.some((p) => p.identity === foco)) foco = null;
  const palco = $('palco');
  palco.classList.toggle('foco', !!foco);
  const mostrar = foco ? comTela.filter((p) => p.identity === foco) : comTela;
  if (!mostrar.length) {
    const vazio = document.createElement('p');
    vazio.className = 'vazio';
    vazio.textContent = PODE_COMPARTILHAR
      ? 'Ninguém está compartilhando a tela. Clique em "Compartilhar tela" para mostrar a sua.'
      : 'Ninguém está compartilhando a tela. Este aparelho só consegue assistir.';
    palco.replaceChildren(vazio);
    return;
  }
  // Reaproveita os vídeos que já estão na tela (recriar faz a imagem piscar). A chave é a transmissão:
  // parou e começou de novo, o vídeo é outro
  const atuais = new Map([...palco.querySelectorAll('.tela')].map((el) => [el.dataset.id, el]));
  palco.replaceChildren(...mostrar.map((p) => {
    const chave = `${p.identity}:${telaDe(p).sid}`;
    let caixa = atuais.get(chave);
    if (!caixa) {
      caixa = document.createElement('div');
      caixa.className = 'tela';
      caixa.dataset.id = chave;
      caixa.title = 'Clique para focar · clique duplo para tela cheia';
      const video = telaDe(p).attach();
      video.muted = true; // o som vem pelo elemento de áudio separado
      const rotulo = document.createElement('span');
      rotulo.className = 'rotulo';
      caixa.append(video, rotulo);
      caixa.onclick = () => { foco = foco === p.identity ? null : p.identity; desenhar(); };
      caixa.ondblclick = () => caixa.requestFullscreen?.().catch(() => {});
    }
    caixa.querySelector('.rotulo').textContent = p === room.localParticipant ? 'Sua tela' : p.name;
    return caixa;
  }));
}

$('btn-tela').onclick = alternarTela;
$('btn-sair').onclick = () => room?.disconnect();

// Volta do login do Discord com erro (?erro=...): mostra e limpa o endereço
const erro = new URLSearchParams(location.search).get('erro');
if (erro) history.replaceState(null, '', location.pathname);
if (erro && ERROS[erro]) {
  aviso(ERROS[erro], { erro: true, botao: link('Tentar de novo', `/tela/entrar?sala=${encodeURIComponent(codigo)}`) });
} else {
  entrar();
}
