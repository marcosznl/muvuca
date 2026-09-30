// Ponto de entrada: conexão, eventos do servidor e navegação entre servidores/canais
import { $, store, showBanner, toast } from './util.js';
import { openUserSettings } from './user-settings.js';
import { icon, applyStaticIcons } from './icons.js';
import {
  state, serverById, findChannel, upsertServer, removeServer, rememberTextChannel, rememberedTextChannel,
} from './state.js';
import { connect, disconnect, request, send, api, sessionToken, setSessionToken } from './net.js';
import { showAuth, pendingInvite, clearInviteFromUrl } from './auth.js';
import { renderRail, renderServerHeader, renderChannels, renderUserPanel, renderVoicePanel } from './sidebar.js';
import {
  openTextChannel, onHistory, onMessage, onMessageEdit, onMessageDelete, onReactions, onRead, onTyping, renderComposer, updateTitle, onPollVotes,
} from './chat.js';
import { sounds } from './sounds.js';
import './theme.js';
import './quick-switch.js';
import './voice-menus.js';
import { setupPush } from './push.js';
import { closeEmojiPanel } from './chat-picker.js';
import { renderStage, leaveVoice, voiceChannelId, applyAudioState, updateMediaButtons, mergeSelfIntoVoice, onBoardSound, onVoiceMove } from './voice.js';
import { renderMembers } from './members.js';
import {
  joinMusic, musicChannelId, onMusicState, onMusicQueue, rejoinMusic, musicChannelGone, placeMusicView, renderAllMusic,
} from './music.js';
import { refreshSettings, closeServerSettings } from './settings.js';
import { dmTitle, unhideDm, selectDmHome, renameGroup } from './dms.js';
import { renderFriendsView } from './friends.js';
import { onCallEvent, onVoiceChanged, renderCallBar } from './calls.js';
import { renderMaintBar } from './maintenance.js';
import {
  inGames, openGames, renderGamesSidebar, renderGamesView, onGamesRooms, onGameRoom, onGameState, onGameLeft, onLeaderboard,
  onGameChat, onGameChatlog, onGameEvents,
} from './games.js';

applyStaticIcons();

// ---------- Navegação ----------

export function selectServer(serverId) {
  const s = serverById(serverId);
  if (!s) return;
  // Conversa privada: abre direto o canal único dela, na área de mensagens diretas
  if (s.kind === 'dm') {
    unhideDm(s.id);
    state.view = { serverId, channelId: s.channels[0]?.id ?? null, dms: true };
    store.set('lastDm', serverId);
    if (state.view.channelId) state.unread[state.view.channelId] = 0;
    return showChannel();
  }

  // Se estiver na voz deste servidor, abre o canal de voz; senão, o último canal de texto
  const voiceHere = s.channels.find((c) => c.id === voiceChannelId());
  const target = state.view.serverId === serverId ? state.view.channelId : (rememberedTextChannel(s)?.id ?? voiceHere?.id);
  state.view = { serverId, channelId: target ?? null };
  store.set('lastServer', serverId);
  showChannel();
}

// Ícone fixo de jogos: sai do servidor aberto (a voz e a música continuam tocando)
export function selectGames() {
  state.view = { serverId: null, channelId: null, games: true, dms: true }; // os jogos ficam dentro do início (mensagens diretas)
  showChannel();
  openGames();
}

export function selectChannel(channelId) {
  const { server, channel } = findChannel(channelId);
  if (!channel) {
    // Canal sumiu (ex.: excluído): fica só no servidor
    state.view = { serverId: state.view.serverId, channelId: null };
    return showChannel();
  }
  state.view = { serverId: server.id, channelId, ...(server.kind === 'dm' ? { dms: true } : {}) };
  if (channel.type !== 'voice') state.unread[channelId] = 0;
  if (channel.type === 'text') rememberTextChannel(server.id, channelId);
  showChannel();
  // Clicar num canal de música já entra e começa a ouvir (o clique libera o som no navegador)
  if (channel.type === 'music' && musicChannelId() !== channelId) joinMusic(channelId);
}

export const showChannelView = () => showChannel();

function showChannel() {
  closeOverlays();
  closeEmojiPanel();
  const games = inGames();
  $('games-view').hidden = !games;
  $('app').classList.toggle('games-mode', games);
  if (games) {
    for (const id of ['text-view', 'voice-view', 'empty-view', 'friends-view']) $(id).hidden = true;
    $('app').classList.remove('music-mode');
    placeMusicView();
    renderAll();
    renderGamesView();
    return;
  }
  const { channel } = findChannel(state.view.channelId);
  const isVoice = channel?.type === 'voice';
  const isMusic = channel?.type === 'music';
  // O chat é o mesmo componente: embaixo do player nos canais de música, sozinho nos de texto
  // Só move quando muda de lugar: mover o elemento zera a rolagem (o chat "pulava" a cada atualização)
  if (isMusic) { if ($('text-view').parentElement !== $('music-chat-slot')) $('music-chat-slot').append($('text-view')); }
  else if ($('text-view').previousElementSibling !== $('empty-view')) $('empty-view').after($('text-view'));
  $('text-view').hidden = isVoice || !channel;
  $('voice-view').hidden = !isVoice;
  const friendsHome = !!state.view.dms && !channel; // mensagens diretas sem conversa: página de amigos
  $('empty-view').hidden = !!channel || friendsHome;
  $('friends-view').hidden = !friendsHome;
  $('app').classList.toggle('friends-home', friendsHome); // a barra de abas dos amigos vira o topo (sem cabeçalho repetido)
  placeMusicView();
  $('app').classList.toggle('music-mode', isMusic); // painel da direita mais largo nos canais de música
  const server = findChannel(state.view.channelId).server;
  if (server?.kind === 'dm') {
    $('view-icon').replaceChildren(icon('chat', 22));
    $('view-title').textContent = dmTitle(server);
    // Grupo: clicar no nome renomeia
    const group = server.members.length > 2;
    $('view-title').classList.toggle('renamable', group);
    $('view-title').title = group ? 'Clique para renomear o grupo' : '';
    $('view-title').onclick = group ? () => renameGroup(server) : null;
  } else {
    $('view-title').classList.remove('renamable');
    $('view-title').title = '';
    $('view-title').onclick = null;
    $('view-icon').replaceChildren(channel ? icon({ voice: 'speaker', music: 'headphones' }[channel.type] ?? 'hash', 22) : '');
    $('view-title').textContent = channel?.name ?? '';
  }
  $('view-topic').textContent = channel?.topic ?? '';
  $('view-topic').title = channel?.topic ?? '';
  if (friendsHome) { $('view-icon').replaceChildren(icon('friends', 22)); $('view-title').textContent = 'Amigos'; }
  $('empty-view').querySelector('p').textContent = state.view.dms
    ? 'Escolha uma conversa ao lado ou comece uma nova com o +.'
    : 'Escolha um canal na lista ao lado.';
  if (channel && channel.type !== 'voice') {
    openTextChannel(channel.id);
    if (matchMedia('(pointer: fine)').matches && channel.type === 'text') $('chat-input').focus();
  }
  if (isVoice) renderStage();
  renderAll();
  renderCallBar();
  if (friendsHome) renderFriendsView();
}

export function renderAll() {
  renderRail();
  renderServerHeader();
  renderChannels();
  if (inGames()) renderGamesSidebar(); // no lugar dos canais
  renderMembers();
  renderUserPanel();
  renderVoicePanel();
  renderComposer();
  updateMediaButtons();
  renderAllMusic();
  updateTitle();
}

// ---------- Eventos do servidor ----------

function handle(m) {
  switch (m.t) {
    // Mudou a própria foto (em qualquer aba)
    case 'me': {
      state.me = { ...state.me, ...m.you };
      renderAll();
      if (findChannel(state.view.channelId).channel?.type !== 'voice') openTextChannel(state.view.channelId); // nome/foto nas mensagens
      break;
    }
    case 'maintenance':
      renderMaintBar(m.maintenance);
      break;
    // XP da conta: barrinha atualiza; subiu de nível, comemora
    case 'xp':
      if (!state.me) break;
      state.me.xp = m.xp;
      state.me.xpRank = m.rank ?? state.me.xpRank;
      renderUserPanel();
      if (m.levelUp) {
        showBanner(`🎉 Você subiu para o nível ${m.levelUp}!`, { kind: 'info', timeout: 6000 });
        sounds.win();
      }
      break;
    case 'welcome': {
      renderMaintBar(m.maintenance);
      state.me = { ...m.you, xpRank: m.xpRank ?? null };
      state.servers = m.servers;
      state.online = new Set(m.online);
      state.status = m.status ?? {};
      state.activity = m.activity ?? {};
      state.voice = m.voice;
      state.music = m.music ?? {};
      // Não lidas que ficaram guardadas no servidor (de antes de recarregar, ou de quando estava fora)
      state.readState = m.readState ?? {};
      state.mutes = new Set(m.mutes ?? []);
      state.friends = m.friends ?? [];
      state.unread = Object.fromEntries(Object.entries(m.unread ?? {}).map(([c, u]) => [c, u.n]));
      state.mentions = Object.fromEntries(Object.entries(m.unread ?? {}).map(([c, u]) => [c, u.mentions]));
      state.messages.clear(); // reconectou: recarrega as conversas (pode ter chegado coisa enquanto estava fora)
      send({ t: 'visibility', visible: !document.hidden });
      $('auth').hidden = true;
      $('app').hidden = false;
      // Reconectou: mantém onde estava; primeira vez: último servidor usado
      const keep = serverById(state.view.serverId);
      const fromLink = findChannel(new URLSearchParams(location.search).get('canal')).channel; // tocou numa notificação
      if (fromLink) { history.replaceState(null, '', location.pathname); selectChannel(fromLink.id); }
      else if (state.view.games) selectGames();
      else if (state.view.dms && !keep) selectDmHome();
      else if (keep) selectServer(keep.id);
      else selectServer(serverById(store.get('lastServer'))?.id ?? state.servers[0]?.id);
      if (!state.servers.length) showChannel();
      rejoinMusic(); // reconectou: volta para a sala de música em que estava
      // Chegou por um link de convite já tendo conta
      const invite = pendingInvite();
      if (invite) {
        clearInviteFromUrl();
        request({ t: 'invite:accept', code: invite }).catch((err) => showBanner(err.message, { timeout: 5000 }));
      }
      break;
    }
    case 'server': {
      const isNew = !serverById(m.server.id);
      upsertServer(m.server);
      refreshSettings(m.server.id);
      musicChannelGone();
      if (m.select) return selectServer(m.server.id);
      if (isNew) { renderRail(); if (state.view.dms) renderChannels(); return; } // conversa nova aparece na lista
      // Meu canal atual ainda existe? Minhas permissões mudaram?
      if (state.view.serverId === m.server.id) {
        if (state.view.channelId && !findChannel(state.view.channelId).channel) selectChannel(rememberedTextChannel(m.server)?.id);
        else showChannel();
      } else { renderRail(); if (state.view.dms) renderChannels(); }
      if (voiceChannelId() && findChannel(voiceChannelId()).server?.id === m.server.id) applyAudioState();
      break;
    }
    case 'server:removed': {
      const wasCurrent = state.view.serverId === m.serverId;
      const inVoiceThere = serverById(m.serverId)?.channels.some((c) => c.id === voiceChannelId());
      if (inVoiceThere) leaveVoice({ keepView: true });
      removeServer(m.serverId);
      refreshSettings(m.serverId);
      musicChannelGone();
      if (m.reason) showBanner(m.reason, { timeout: 6000 });
      if (wasCurrent) selectServer(state.servers[0]?.id);
      renderAll();
      if (!state.servers.length) { state.view = { serverId: null, channelId: null }; showChannel(); }
      break;
    }
    case 'friends':
      state.friends = m.friends;
      renderRail();
      if (state.view.dms) renderChannels();
      renderFriendsView();
      break;
    case 'friend:request':
      toast(`${m.from.name} quer ser seu amigo! Veja em Mensagens diretas → Amigos.`);
      break;
    case 'presence':
      state.online = new Set(m.online);
      state.status = m.status ?? {};
      state.activity = m.activity ?? {};
      if (state.view.dms) renderChannels();
      renderFriendsView(true);
      renderMembers();
      renderUserPanel();
      renderVoicePanel();
      break;
    case 'voice':
      voiceSounds(m.voice);
      state.voice = mergeSelfIntoVoice(m.voice);
      renderChannels();
      renderMembers();
      onVoiceChanged();
      break;
    case 'call:ring':
    case 'call:stop':
      onCallEvent(m);
      break;
    case 'history':
      onHistory(m);
      break;
    case 'music:state':
      onMusicState(m);
      break;
    case 'music:queue':
      onMusicQueue(m);
      break;
    case 'music:presence':
      state.music[m.channelId] = { listeners: m.listeners, nowPlaying: m.nowPlaying };
      renderChannels();
      break;
    case 'msg':
      onMessage(m.msg);
      break;
    case 'msg:edit':
      onMessageEdit(m.msg);
      break;
    case 'voice:move':
      onVoiceMove(m);
      break;
    case 'msg:delete':
      onMessageDelete(m);
      break;
    case 'msg:reactions':
      onReactions(m);
      break;
    case 'sound':
      onBoardSound(m);
      break;
    case 'msg:poll':
      onPollVotes(m);
      break;
    case 'read':
      onRead(m);
      break;
    case 'mutes':
      state.mutes = new Set(m.mutes);
      renderAll();
      break;
    case 'typing':
      onTyping(m);
      break;
    case 'game:chat':
      onGameChat(m);
      break;
    case 'game:chatlog':
      onGameChatlog(m);
      break;
    case 'game:events':
      onGameEvents(m);
      break;
    case 'games:leaderboard':
      onLeaderboard(m);
      break;
    case 'games:rooms':
      onGamesRooms(m);
      break;
    case 'game:room':
      onGameRoom(m);
      break;
    case 'game:state':
      onGameState(m);
      break;
    case 'game:left':
      onGameLeft(m);
      break;
    case 'error':
      showBanner(m.message, { timeout: 4500 });
      break;
  }
}

// Alguém entrou ou saiu da sala de voz em que você está: toca o somzinho
function voiceSounds(next) {
  const channel = voiceChannelId();
  if (!channel) return;
  const before = new Set((state.voice[channel] ?? []).map((p) => p.id));
  const after = new Set((next[channel] ?? []).map((p) => p.id));
  const others = (set) => [...set].filter((id) => id !== state.me?.id);
  if (others(after).some((id) => !before.has(id))) sounds.voiceJoin();
  else if (others(before).some((id) => !after.has(id))) sounds.voiceLeave();
}

// ---------- Ausente automático e aba à vista ----------

const IDLE_MS = 10 * 60_000;
let lastActivity = Date.now();
let idleSent = false;
function activity() {
  lastActivity = Date.now();
  if (idleSent) { idleSent = false; send({ t: 'presence:idle', idle: false }); }
}
for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart']) window.addEventListener(type, activity, { passive: true });
setInterval(() => {
  if (!idleSent && state.me && Date.now() - lastActivity > IDLE_MS) { idleSent = true; send({ t: 'presence:idle', idle: true }); }
}, 30_000);
// Com a aba à vista não precisa notificação no celular; escondida, precisa
document.addEventListener('visibilitychange', () => {
  if (state.me) send({ t: 'visibility', visible: !document.hidden });
  if (!document.hidden) activity();
});

// ---------- Sessão ----------

function start() {
  connect({
    onMessage: handle,
    onAuthFail: (message) => {
      setSessionToken(null);
      leaveVoice();
      showAuth({ error: message, onLoggedIn: start });
    },
  });
}

// Sair da conta (pelas Configurações, na engrenagem lá embaixo)
export async function logout() {
  closeServerSettings();
  await leaveVoice();
  try { await api('/api/logout'); } catch {}
  disconnect();
  setSessionToken(null);
  Object.assign(state, { me: null, servers: [], voice: {}, view: { serverId: null, channelId: null } });
  state.messages.clear();
  showAuth({ onLoggedIn: start });
}
$('btn-settings').onclick = () => openUserSettings();

// ---------- Menus laterais em telas pequenas ----------

function closeOverlays() {
  $('app').classList.remove('show-sidebar', 'show-members');
  $('scrim').hidden = true;
}
$('scrim').onclick = closeOverlays;
$('btn-menu').onclick = () => { $('app').classList.add('show-sidebar'); $('scrim').hidden = false; };
$('btn-members').onclick = () => {
  if (matchMedia('(max-width: 1000px)').matches) {
    $('app').classList.add('show-members');
    $('scrim').hidden = false;
  } else {
    const hidden = $('app').classList.toggle('hide-members');
    store.set('hideMembers', hidden ? '1' : null);
  }
};
if (store.get('hideMembers') === '1') $('app').classList.add('hide-members');

// ---------- Início ----------

store.set('password', null); // a versão antiga guardava a senha comum; agora usamos sessão
setupPush(); // service worker: notificações e "instalar na tela inicial"
if (sessionToken()) start();
else showAuth({ onLoggedIn: start });

export { toast };

// ---------- App do Mac (Electron): clique na notificação abre o canal; o menu da barra de menus silencia ----------
if (window.muvucaDesktop) {
  document.documentElement.classList.add('is-desktop');
  window.muvucaDesktop.onOpenChannel((channelId) => { if (findChannel(channelId).channel) selectChannel(channelId); });
  window.muvucaDesktop.onToggleMute(() => $('btn-mic').click());
}
