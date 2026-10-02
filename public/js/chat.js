// Chat dos canais de texto (e de música): histórico, mensagens, editar/excluir/responder e envio.
// Partes em arquivos próprios: chat-content (desenho do conteúdo), chat-attachments (imagens e vídeos),
// chat-mentions (lista do @), chat-pins (fixadas), chat-picker (GIFs e emojis) e richtext (regras de texto).
import { $, h, makeAvatar, fmtTime, fmtDay, hhmm, sameDay, showBanner } from './util.js';
import { icon } from './icons.js';
import { state, findChannel, canIn, PERMS, nameOf, isMuted, chatChannelId } from './state.js';
import { openProfileCard } from './profile.js';
import { nameColor } from './permissions.js';
import { openEvents } from './events.js';
import { send, request } from './net.js';
import { confirmDialog } from './dialogs.js';
import { renderChannels, renderRail } from './sidebar.js';
import { GIF_URL, encodeMessage, decodeMessage, snippet, usableEmojis } from './richtext.js';
import { appendRich, appendGif, attachmentsView, previewSlot } from './chat-content.js';
import { hasPending, takePending, attachmentsFollow } from './chat-attachments.js';
import { mentionables } from './chat-mentions.js';
import { refreshPins, pinsFollow, toastPin } from './chat-pins.js';
import { reactionsView, openReactionPicker } from './chat-reactions.js';
import { pollView } from './chat-polls.js';
import { searchFollow } from './chat-search.js';
import { sounds } from './sounds.js';
import { selectGames } from './app.js';
import { unhideDm } from './dms.js';
import { enterRoom } from './games.js';
import './chat-picker.js';

const GROUP_WINDOW_MS = 5 * 60_000; // mensagens seguidas da mesma pessoa em até 5 min ficam agrupadas
let hiddenUnread = 0;               // mensagens recebidas com a aba em segundo plano

const box = () => $('messages');
const mine = (msg) => msg.userId === state.me?.id;
// Mensagem que menciona você ou responde a você (na conversa privada, toda mensagem conta)
const inDm = (channelId) => findChannel(channelId).server?.kind === 'dm';
// Me mencionaram: direto, por @todos, por um cargo meu, ou responderam uma mensagem minha (e em conversa privada, tudo)
function mentionsMe(msg) {
  if (mine(msg)) return false;
  if (inDm(msg.channel) || msg.reply?.userId === state.me?.id) return true;
  const text = msg.text ?? '';
  if (text.includes(`<@${state.me?.id}>`) || text.includes('<@todos>')) return true;
  const me = findChannel(msg.channel).server?.members.find((m) => m.id === state.me?.id);
  return !!me?.roles.some((r) => text.includes(`<@&${r}>`));
}
const fail = (err) => showBanner(err.message, { timeout: 4000 });

// Texto digitado -> como fica guardado (emojis e menções viram códigos) e o caminho de volta
const encode = (text) => encodeMessage(text, { emojis: usableEmojis(state.servers, state.view.serverId), members: mentionables() });
const toEditable = (text) => decodeMessage(text, nameOf);

function channelData(channelId) {
  if (!state.messages.has(channelId)) state.messages.set(channelId, { list: [], hasMore: false, loaded: false, loading: false });
  return state.messages.get(channelId);
}

// ---------- Histórico e mensagens novas ----------

// Abre um canal de texto: carrega as mensagens na primeira vez
export function openTextChannel(channelId) {
  const data = channelData(channelId);
  // "Novas mensagens": a linha vermelha fica depois da última que você tinha lido
  if (openedChannel !== channelId) {
    data.newAfter = state.unread[channelId] ? (state.readState[channelId] ?? 0) : null;
    openedChannel = channelId;
  }
  if (!data.loaded && !data.loading) {
    data.loading = true;
    send({ t: 'history', channel: channelId });
  }
  renderMessages();
  renderComposer();
  renderTyping();
  markRead(channelId);
}
let openedChannel = null;

// ---------- Lidas / não lidas ----------

// Leu tudo o que está carregado no canal: avisa o servidor (as outras abas e a próxima visita também sabem)
export function markRead(channelId = chatChannelId()) {
  const data = state.messages.get(channelId);
  if (!data?.loaded || document.hidden || chatChannelId() !== channelId) return;
  const last = data.list[data.list.length - 1]?.id ?? 0;
  const hadBadge = state.unread[channelId] || state.mentions[channelId];
  state.unread[channelId] = 0;
  state.mentions[channelId] = 0;
  if (hadBadge) { renderChannels(); renderRail(); updateTitle(); }
  if (last > (state.readState[channelId] ?? 0)) {
    state.readState[channelId] = last;
    send({ t: 'read', channel: channelId, id: last });
  }
}

// Leu em outra aba (ou aparelho)
export function onRead({ channel, id }) {
  if (id > (state.readState[channel] ?? 0)) state.readState[channel] = id;
  const last = state.messages.get(channel)?.list.at(-1)?.id ?? 0;
  if (last <= id) {
    state.unread[channel] = 0;
    state.mentions[channel] = 0;
    renderChannels();
    renderRail();
    updateTitle();
  }
}

export function onHistory(m) {
  const data = channelData(m.channel);
  data.loading = false;
  data.hasMore = m.hasMore;
  const viewing = chatChannelId() === m.channel;
  if (m.older) {
    // Mantém a posição de leitura ao inserir mensagens antigas no topo
    const b = box();
    const fromBottom = b.scrollHeight - b.scrollTop;
    data.list = [...m.messages, ...data.list];
    if (viewing) {
      renderMessages();
      b.scrollTop = b.scrollHeight - fromBottom;
    }
  } else {
    data.list = m.messages;
    data.loaded = true;
    if (viewing) { renderMessages(); markRead(m.channel); }
  }
}

export function onMessage(msg) {
  const data = channelData(msg.channel);
  const isMine = mine(msg);
  const viewing = chatChannelId() === msg.channel && !document.hidden;
  stopTyping(msg.channel, msg.userId); // mandou: não está mais digitando
  if (data.loaded) {
    const prev = data.list[data.list.length - 1];
    data.list.push(msg);
    if (chatChannelId() === msg.channel) {
      const b = box();
      const nearBottom = b.scrollHeight - b.scrollTop - b.clientHeight < 150;
      const frag = buildMessage(msg, prev);
      frag.querySelector('.msg')?.classList.add('fresh'); // chegou agora: anima (emoji grande pula)
      b.append(frag);
      if (nearBottom || isMine) b.scrollTop = b.scrollHeight;
    }
  }
  if (!isMine && !msg.system && chatChannelId() !== msg.channel) {
    state.unread[msg.channel] = (state.unread[msg.channel] || 0) + 1;
    if (mentionsMe(msg)) state.mentions[msg.channel] = (state.mentions[msg.channel] || 0) + 1;
    renderChannels();
    renderRail();
  }
  const { server: msgServer } = findChannel(msg.channel);
  if (msgServer?.kind === 'dm' && !isMine) unhideDm(msgServer.id); // conversa escondida volta quando chega mensagem
  if (!isMine && !msg.system) {
    if (mentionsMe(msg)) sounds.mention();
    else if (!viewing && !isMuted(msg.channel, msgServer?.id)) sounds.message();
    // No app do Mac, com a janela fora de foco: notificação nativa para conversas diretas e menções
    const desktop = window.muvucaDesktop;
    if (desktop && !document.hasFocus() && (msgServer?.kind === 'dm' || mentionsMe(msg)) && !isMuted(msg.channel, msgServer?.id)) {
      const author = nameOf(msg.userId) ?? 'Alguém';
      const where = msgServer?.kind === 'dm' ? (msgServer.members.length > 2 ? ` em ${msgServer.dmName || 'grupo'}` : '')
        : ` em #${findChannel(msg.channel).channel?.name ?? ''}`;
      desktop.notify(`${author}${where}`, snippet(msg.text, nameOf), msg.channel);
    }
  }
  if (!isMine && !msg.system && !viewing) hiddenUnread++;
  if (viewing) markRead(msg.channel);
  updateTitle();
}

// Alguém votou numa enquete: troca só o cartão dela
export function onPollVotes({ channel, id, votes }) {
  const msg = state.messages.get(channel)?.list.find((m) => m.id === id);
  if (!msg) return;
  msg.votes = votes;
  const row = chatChannelId() === channel && box().querySelector(`.msg[data-id="${id}"] .poll`);
  if (row) row.replaceWith(pollView(msg, canIn(findChannel(channel).server, PERMS.SEND_MESSAGES)));
}

// Alguém reagiu: troca só os botões de reação daquela mensagem
export function onReactions({ channel, id, reactions }) {
  const msg = state.messages.get(channel)?.list.find((m) => m.id === id);
  if (!msg) return;
  msg.reactions = reactions;
  const row = chatChannelId() === channel && box().querySelector(`.msg[data-id="${id}"]`);
  if (!row) return;
  const { server } = findChannel(channel);
  const b = box();
  const atBottom = b.scrollHeight - b.scrollTop - b.clientHeight < 40;
  row.querySelector('.reactions')?.remove();
  if (reactions.length) row.querySelector('.body').append(reactionsView(msg, canIn(server, PERMS.SEND_MESSAGES)));
  if (atBottom) b.scrollTop = b.scrollHeight;
}

export function onMessageEdit(msg) {
  const data = state.messages.get(msg.channel);
  const i = data?.list.findIndex((m) => m.id === msg.id) ?? -1;
  if (i < 0) return;
  data.list[i] = msg;
  // Respostas a ela mostram o texto novo
  for (const m of data.list) if (m.reply?.id === msg.id && !m.reply.deleted) m.reply = { ...m.reply, text: msg.text.slice(0, 200) };
  if (chatChannelId() === msg.channel) renderMessages();
  refreshPins(msg.channel);
}

// Conta excluída pelo administrador: as mensagens dela somem de todos os canais já carregados
export function onUserPurged(userId) {
  for (const [channelId, data] of state.messages) {
    const removed = new Set(data.list.filter((m) => m.userId === userId).map((m) => m.id));
    if (!removed.size) continue;
    data.list = data.list.filter((m) => !removed.has(m.id));
    for (const m of data.list) if (m.reply && removed.has(m.reply.id)) m.reply = { id: m.reply.id, deleted: true };
    if (chatChannelId() === channelId) renderMessages();
  }
}

export function onMessageDelete({ channel, id }) {
  const data = state.messages.get(channel);
  if (!data) return;
  data.list = data.list.filter((m) => m.id !== id);
  for (const m of data.list) if (m.reply?.id === id) m.reply = { id, deleted: true };
  if (editing?.id === id) editing = null;
  if (replying?.id === id) cancelReply();
  if (chatChannelId() === channel) renderMessages();
  refreshPins(channel);
}

export function updateTitle() {
  const total = Object.values(state.unread).reduce((a, b) => a + b, 0) + hiddenUnread;
  document.title = total ? `(${total}) Muvuca` : 'Muvuca';
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  hiddenUnread = 0;
  updateTitle();
  markRead(); // voltou para a aba: o que estava na tela conta como lido
});

// ---------- Desenho da conversa ----------

let renderedChannel = null; // canal desenhado agora (para manter a posição de leitura ao redesenhar)

export function renderMessages() {
  const { server, channel } = findChannel(chatChannelId());
  const b = box();
  // Redesenhar o mesmo canal (alguém trocou a foto, editou uma mensagem…) não pode tirar
  // quem está lendo mensagens antigas do lugar; só volta ao fim quem já estava no fim
  const sameChannel = channel && renderedChannel === channel.id;
  const prevTop = b.scrollTop;
  const fromBottom = b.scrollHeight - b.scrollTop - b.clientHeight;
  b.replaceChildren();
  renderedChannel = channel && channel.type !== 'voice' ? channel.id : null;
  if (!channel || channel.type === 'voice') return;
  const data = channelData(channel.id);

  if (data.hasMore || !data.loaded) {
    b.append(h('div', 'history-loader', data.loaded ? 'Carregando mensagens antigas…' : 'Carregando…'));
  } else {
    const welcome = h('div', 'welcome');
    const big = h('div', 'big-hash');
    if (server?.kind === 'dm') {
      const others = server.members.filter((m) => m.id !== state.me?.id);
      big.append(icon('chat', 40));
      const who = others.map((m) => m.name).join(', ') || 'você';
      welcome.append(big, h('h2', '', server.dmName || who), h('div', 'muted', `Este é o começo da sua conversa com ${who}. Só vocês veem o que está aqui.`));
    } else {
      big.append(icon(channel.type === 'music' ? 'headphones' : 'hash', 40));
      const label = channel.type === 'music' ? channel.name : `#${channel.name}`;
      welcome.append(big, h('h2', '', `Boas-vindas a ${label}!`), h('div', 'muted', channel.topic || `Este é o começo do canal ${label}.`));
    }
    b.append(welcome);
  }

  let prev = null;
  let divider = null;
  for (const msg of data.list) {
    if (data.newAfter != null && !divider && msg.id > data.newAfter && !mine(msg) && prev) {
      divider = h('div', 'new-divider');
      divider.append(h('span', '', 'Novas'));
      b.append(divider);
    }
    b.append(buildMessage(msg, prev, server));
    prev = msg;
  }
  b.scrollTop = sameChannel && fromBottom > 150 ? prevTop : b.scrollHeight;
  // Abriu o canal com mensagens novas: começa nelas (se não couberem todas na tela)
  if (!sameChannel && divider && divider.offsetTop < b.scrollTop) b.scrollTop = Math.max(0, divider.offsetTop - 80);
  if (editing && data.list.some((m) => m.id === editing.id)) startEdit(editing.id, editing.draft); // edição em andamento continua aberta
}

// Chegou perto do topo: busca as mensagens anteriores
$('messages').addEventListener('scroll', () => {
  const data = state.messages.get(chatChannelId());
  if (!data?.loaded || !data.hasMore || data.loading || box().scrollTop > 300) return;
  data.loading = true;
  send({ t: 'history', channel: chatChannelId(), before: data.list[0]?.id });
});

function buildMessage(msg, prev, server = findChannel(msg.channel).server) {
  const frag = document.createDocumentFragment();
  const newDay = !prev || !sameDay(prev.ts, msg.ts);
  if (newDay) frag.append(h('div', 'day-divider', fmtDay(msg.ts)));
  // Aviso do sistema: música tocando, alguém chegou/saiu, sala de jogo aberta
  if (msg.system) {
    const kind = msg.kind ?? 'music';
    const row = h('div', `msg system ${kind}`);
    row.dataset.id = msg.id;
    const text = h('span', 'system-text');
    appendRich(text, msg.text);
    text.classList.remove('jumbo');
    row.append(h('div', 'gutter', hhmm(new Date(msg.ts))),
      icon({ music: 'headphones', join: 'arrow-right', leave: 'arrow-left', game: 'gamepad', call: 'phone', rename: 'pencil', event: 'calendar', owner: 'crown' }[kind] ?? 'headphones', 14), text);
    if (kind === 'event' && msg.meta?.eventId) {
      const see = h('button', 'btn small primary', 'Ver evento');
      see.type = 'button';
      see.onclick = () => openEvents(findChannel(msg.channel).server?.id);
      row.append(see);
    }
    if (kind === 'game' && msg.meta?.roomId) {
      const join = h('button', 'btn small primary', 'Entrar na sala');
      join.type = 'button';
      join.onclick = () => { selectGames(); enterRoom(msg.meta.roomId); };
      row.append(join);
    }
    frag.append(row);
    return frag;
  }

  const cont = !msg.reply && !newDay && !prev.system && prev.userId === msg.userId && msg.ts - prev.ts < GROUP_WINDOW_MS;
  const row = h('div', cont ? 'msg cont' : 'msg');
  const body = h('div', 'body');
  if (msg.reply) {
    row.classList.add('has-reply');
    row.append(replyQuote(msg.reply));
    if (msg.reply.userId === state.me?.id && !mine(msg)) row.classList.add('mentioned'); // responderam você
  }
  if (!mine(msg) && msg.text.includes(`<@${state.me?.id}>`)) row.classList.add('mentioned'); // mencionaram você
  if (cont) {
    row.append(h('div', 'gutter', hhmm(new Date(msg.ts))));
  } else {
    body.append(messageHeader(msg, server, row));
  }
  const text = h('div', 'text');
  if (msg.meta?.poll) text.append(pollView(msg, canIn(server, PERMS.SEND_MESSAGES)));
  else if (GIF_URL.test(msg.text)) appendGif(text, msg.text);
  else appendRich(text, msg.text);
  if (msg.editedAt) {
    const tag = h('span', 'edited', '(editado)');
    tag.title = `Editado ${fmtTime(msg.editedAt)}`;
    text.append(tag);
  }
  if (msg.text || msg.editedAt) body.append(text);
  const preview = msg.meta?.poll ? null : previewSlot(msg.text);
  if (preview) body.append(preview);
  if (msg.attachments?.length) body.append(attachmentsView(msg.attachments));
  if (msg.reactions?.length) body.append(reactionsView(msg, canIn(server, PERMS.SEND_MESSAGES)));
  row.dataset.id = msg.id;
  row.append(body, messageActions(msg, server));
  frag.append(row);
  return frag;
}

// Foto, nome (na cor do cargo), hora e pininho; foto e nome abrem o perfil
function messageHeader(msg, server, row) {
  // Nome e foto atuais da pessoa (se ela trocou depois, as mensagens antigas acompanham)
  const who = nameOf(msg.userId) ?? msg.name;
  const avatar = makeAvatar(who, 'lg', msg.userId);
  row.append(avatar);
  const meta = h('div', 'meta');
  const author = h('span', 'author', who);
  if (!String(msg.userId).startsWith('imp:')) {
    for (const el of [avatar, author]) {
      el.classList.add('clickable');
      el.onclick = (e) => { e.stopPropagation(); openProfileCard(msg.userId, e.clientX, e.clientY); };
    }
  }
  const color = nameColor(server, msg.userId);
  if (color) author.style.color = color;
  meta.append(author, h('time', '', fmtTime(msg.ts)));
  if (msg.pinnedAt) {
    const pin = icon('pin', 12);
    pin.classList.add('pinned-mark');
    pin.title = 'Mensagem fixada';
    meta.append(pin);
  }
  return meta;
}

// Rola até uma mensagem e pisca ela (reply e fixadas)
export function jumpTo(id) {
  const row = box().querySelector(`.msg[data-id="${id}"]`);
  if (!row) return showBanner('Essa mensagem é antiga: role para cima para carregá-la.', { kind: 'info', timeout: 3500 });
  row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  row.classList.remove('flash');
  void row.offsetWidth; // reinicia a animação
  row.classList.add('flash');
}

// Vai até uma mensagem que pode ainda não estar carregada (resultado da busca): carrega as antigas até achar
export async function jumpToMessage(channelId, id) {
  const data = channelData(channelId);
  for (let i = 0; i < 100 && !data.loaded; i++) await new Promise((r) => setTimeout(r, 50));
  for (let page = 0; page < 40 && !data.list.some((m) => m.id === id) && data.hasMore; page++) {
    data.loading = true;
    try {
      onHistory(await request({ t: 'history', channel: channelId, before: data.list[0]?.id }));
    } catch (err) { data.loading = false; return fail(err); }
  }
  jumpTo(id);
}

// ---------- Botões da mensagem (aparecem ao passar o mouse, como no Discord) ----------

// Celular (sem mouse): tocar na mensagem mostra os botões dela (responder, fixar, editar, excluir)
$('messages').addEventListener('click', (e) => {
  if (matchMedia('(hover: hover)').matches) return;
  if (e.target.closest('a, button, img, video, input, textarea, .clickable')) return;
  const msg = e.target.closest('.msg');
  for (const m of $('messages').querySelectorAll('.msg.show-actions')) if (m !== msg) m.classList.remove('show-actions');
  msg?.classList.toggle('show-actions');
});

function actionButton(title, iconName, onClick, extra = '') {
  const b = h('button', `icon-btn tiny ${extra}`.trim());
  b.type = 'button';
  b.title = title;
  b.append(icon(iconName, 16));
  b.onclick = onClick;
  return b;
}

function messageActions(msg, server) {
  const bar = h('div', 'msg-actions');
  if (canIn(server, PERMS.SEND_MESSAGES)) {
    bar.append(actionButton('Adicionar reação', 'smile', (e) => { e.stopPropagation(); openReactionPicker(msg, e.currentTarget); }));
    bar.append(actionButton('Responder', 'reply', () => startReply(msg)));
  }
  if (canIn(server, PERMS.PIN_MESSAGES)) {
    bar.append(actionButton(msg.pinnedAt ? 'Desafixar' : 'Fixar', 'pin', () => request({ t: 'msg:pin', id: msg.id, pinned: !msg.pinnedAt })
      .then(() => toastPin(!msg.pinnedAt)).catch(fail), msg.pinnedAt ? 'on' : ''));
  }
  if (mine(msg) && !GIF_URL.test(msg.text) && !msg.meta?.poll) bar.append(actionButton('Editar', 'pencil', () => startEdit(msg.id)));
  if (mine(msg) || canIn(server, PERMS.MANAGE_MESSAGES)) {
    bar.append(actionButton('Excluir (Shift+clique exclui sem perguntar)', 'trash', (e) => deleteMessage(msg, e.shiftKey), 'danger-hover'));
  }
  return bar;
}

async function deleteMessage(msg, skipConfirm = false) {
  if (!skipConfirm) {
    const ok = await confirmDialog({
      title: 'Excluir mensagem',
      message: mine(msg) ? 'Tem certeza de que quer excluir esta mensagem? Não dá para desfazer.' : `Excluir a mensagem de ${nameOf(msg.userId) ?? msg.name}? Não dá para desfazer.`,
      confirm: 'Excluir',
    });
    if (!ok) return;
  }
  request({ t: 'msg:delete', id: msg.id }).catch(fail);
}

// ---------- Editar ----------

let editing = null; // { id, draft }

function startEdit(id, draft = null) {
  const data = channelData(chatChannelId());
  const msg = data.list.find((m) => m.id === id);
  const row = box().querySelector(`.msg[data-id="${id}"]`);
  if (!msg || !row) return;
  if (editing && editing.id !== id) cancelEdit();
  editing = { id, draft: draft ?? toEditable(msg.text) };
  row.classList.add('editing');
  const text = row.querySelector('.text');
  const area = h('textarea', 'edit-input');
  area.value = editing.draft;
  area.maxLength = 2000;
  const fit = () => { area.style.height = 'auto'; area.style.height = `${area.scrollHeight}px`; };
  area.oninput = () => { editing.draft = area.value; fit(); };
  area.onkeydown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelEdit(); }
    else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEdit(); }
  };
  const hint = h('div', 'edit-hint');
  const cancel = h('button', 'link-btn', 'cancelar');
  cancel.type = 'button';
  cancel.onclick = cancelEdit;
  const save = h('button', 'link-btn', 'salvar');
  save.type = 'button';
  save.onclick = saveEdit;
  hint.append('esc para ', cancel, ' • enter para ', save);
  if (text) text.replaceWith(area, hint);
  else row.querySelector('.body').append(area, hint); // mensagem só com anexo
  fit();
  area.focus();
  area.setSelectionRange(area.value.length, area.value.length);
}

function cancelEdit() {
  if (!editing) return;
  editing = null;
  renderMessages();
  $('chat-input').focus();
}

function saveEdit() {
  if (!editing) return;
  const { id, draft } = editing;
  const msg = channelData(chatChannelId()).list.find((m) => m.id === id);
  const text = draft.trim();
  editing = null;
  renderMessages();
  if (!text) { // apagou tudo: pergunta se quer excluir (como no Discord)
    if (msg) deleteMessage(msg);
    return;
  }
  $('chat-input').focus();
  const encoded = encode(text);
  if (msg && encoded !== msg.text) request({ t: 'msg:edit', id, text: encoded }).catch(fail);
}

// ---------- Responder (reply) ----------

let replying = null; // { id, channel, name }

// Linha em cima da resposta (como no Discord): quem foi respondido e o começo da mensagem
function replyQuote(reply) {
  const quote = h('div', 'reply-quote');
  if (reply.deleted) {
    quote.append(h('span', 'reply-deleted', 'Mensagem original excluída'));
    return quote;
  }
  const who = nameOf(reply.userId) ?? reply.name;
  quote.append(makeAvatar(who, 'xs', reply.userId), h('span', 'reply-name', who), h('span', 'reply-text', snippet(reply.text, nameOf)));
  quote.title = 'Ir para a mensagem';
  quote.onclick = () => jumpTo(reply.id);
  return quote;
}

function startReply(msg) {
  replying = { id: msg.id, channel: msg.channel, name: nameOf(msg.userId) ?? msg.name };
  renderReplyBar();
  $('chat-input').focus();
}

export function cancelReply() {
  replying = null;
  renderReplyBar();
}

function renderReplyBar() {
  const bar = $('reply-bar');
  // Trocou de canal: a resposta pendente fica para trás
  if (replying && replying.channel !== chatChannelId()) replying = null;
  bar.hidden = !replying;
  bar.replaceChildren();
  if (!replying) return;
  const text = h('span', '');
  text.append('Respondendo a ', h('strong', '', replying.name));
  const close = h('button', 'icon-btn tiny');
  close.type = 'button';
  close.title = 'Cancelar resposta (Esc)';
  close.append(icon('close', 14));
  close.onclick = () => { cancelReply(); $('chat-input').focus(); };
  bar.append(text, close);
}

// ---------- "Fulano está digitando…" ----------

const TYPING_SHOW_MS = 6000;
let lastTypingSent = 0;

export function onTyping({ channel, userId }) {
  if (!state.typing.has(channel)) state.typing.set(channel, new Map());
  state.typing.get(channel).set(userId, Date.now() + TYPING_SHOW_MS);
  if (channel === chatChannelId()) renderTyping();
}

function stopTyping(channel, userId) {
  if (state.typing.get(channel)?.delete(userId) && channel === chatChannelId()) renderTyping();
}

export function renderTyping() {
  const bar = $('typing-bar');
  const now = Date.now();
  const map = state.typing.get(chatChannelId());
  const names = [];
  for (const [id, until] of map ?? []) {
    if (until < now) map.delete(id);
    else names.push(nameOf(id) ?? 'Alguém');
  }
  bar.replaceChildren();
  if (!names.length) return;
  const dots = h('span', 'typing-dots');
  dots.append(h('i'), h('i'), h('i'));
  const who = h('span', '');
  if (names.length === 1) who.append(h('strong', '', names[0]), ' está digitando…');
  else if (names.length <= 3) {
    names.slice(0, -1).forEach((n, i) => who.append(...(i ? [', '] : []), h('strong', '', n)));
    who.append(' e ', h('strong', '', names.at(-1)), ' estão digitando…');
  } else who.append('Várias pessoas estão digitando…');
  bar.append(dots, who);
}
setInterval(() => { if (state.typing.get(chatChannelId())?.size) renderTyping(); }, 1000);

// Campo de várias linhas: Enter envia, Shift+Enter pula linha; cresce conforme o texto (até um limite)
export function fitComposer() {
  const input = $('chat-input');
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, Math.round(innerHeight * 0.4))}px`;
}
$('chat-input').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.defaultPrevented) return;
  e.preventDefault();
  $('chat-form').requestSubmit();
});
$('chat-input').addEventListener('input', fitComposer);

// Enquanto você digita, avisa os outros (no máximo a cada 3 s)
$('chat-input').addEventListener('input', () => {
  const now = Date.now();
  if (!$('chat-input').value.trim() || now - lastTypingSent < 3000) return;
  lastTypingSent = now;
  send({ t: 'typing', channel: chatChannelId() });
});

// ---------- Campo de mensagem ----------

export function renderComposer() {
  const { server, channel } = findChannel(chatChannelId());
  renderReplyBar();
  pinsFollow(channel);
  searchFollow();
  attachmentsFollow(chatChannelId());
  if (!channel || channel.type === 'voice') return;
  const allowed = canIn(server, PERMS.SEND_MESSAGES);
  const input = $('chat-input');
  input.disabled = !allowed;
  const others = server?.kind === 'dm' ? server.members.filter((m) => m.id !== state.me?.id).map((m) => m.name) : null;
  const label = server?.dmName || (others ? others.join(', ') : channel.type === 'music' ? channel.name : `#${channel.name}`);
  // Modo lento (quem gerencia mensagens ou canais não espera, então não precisa do aviso)
  const slow = channel.slowmode && !canIn(server, PERMS.MANAGE_MESSAGES) && !canIn(server, PERMS.MANAGE_CHANNELS) ? channel.slowmode : 0;
  const slowTime = slow < 60 ? `${slow} s` : slow < 3600 ? `${slow / 60} min` : '1 h';
  const slowText = !slow ? '' : matchMedia('(max-width: 700px)').matches ? ` · ⏱ ${slowTime}` : ` · modo lento: ${slowTime}`; // curto no celular
  input.placeholder = allowed ? `Conversar ${others && !server.dmName ? 'com' : 'em'} ${label}${slowText}` : 'Você não tem permissão para enviar mensagens neste canal.';
  $('btn-emoji').disabled = $('btn-gif').disabled = $('btn-attach').disabled = $('btn-voice').disabled = !allowed;
}

async function purgeChannel(channelId, count) {
  const { server, channel } = findChannel(channelId);
  if (server?.kind === 'dm') return showBanner('Não dá para limpar uma conversa privada.', { timeout: 4000 });
  if (!canIn(server, PERMS.MANAGE_MESSAGES)) return showBanner('Você precisa da permissão "Gerenciar mensagens" para limpar o canal.', { timeout: 4000 });
  const n = Math.max(1, Math.min(100, count));
  const ok = await confirmDialog({
    title: 'Limpar mensagens',
    message: `${n === 1 ? 'Apagar a última mensagem' : `Apagar as ${n} últimas mensagens`} de #${channel?.name ?? 'canal'}? As mensagens fixadas ficam. Não dá para desfazer.`,
    confirm: n === 1 ? 'Apagar' : `Apagar ${n}`,
  });
  if (!ok) return;
  try {
    const r = await request({ t: 'msg:purge', channel: channelId, count: n });
    showBanner(r.deleted ? `${r.deleted} ${r.deleted === 1 ? 'mensagem apagada' : 'mensagens apagadas'}.` : 'Não havia mensagens para apagar.', { kind: 'info', timeout: 3500 });
  } catch (err) {
    showBanner(err.message, { timeout: 4000 });
  }
}

// Esc cancela a resposta; seta para cima com o campo vazio edita a sua última mensagem (como no Discord)
$('chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && replying) { e.preventDefault(); cancelReply(); return; }
  if (e.key !== 'ArrowUp' || $('chat-input').value) return;
  const last = [...(state.messages.get(chatChannelId())?.list ?? [])].reverse().find((m) => mine(m) && !m.system && !GIF_URL.test(m.text));
  if (!last) return;
  e.preventDefault();
  startEdit(last.id);
});

$('chat-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('chat-input');
  const text = input.value.trim();
  if (!text && !hasPending()) return;
  const channel = chatChannelId();
  // /limpar N: apaga as N últimas mensagens do canal (para quem gerencia mensagens)
  const purge = text.match(/^\/limpar(?:\s+(\d+))?$/i);
  if (purge) {
    input.value = '';
    fitComposer();
    purgeChannel(channel, Number(purge[1]) || 10);
    return;
  }
  const replyTo = replying?.id;
  const encoded = encode(text);
  input.value = '';
  fitComposer();
  lastTypingSent = 0;
  cancelReply();
  // Anexos ainda subindo: espera terminar (a mensagem sai junto, como no Discord)
  const attachments = await takePending();
  if (!text && !attachments.length) return;
  send({ t: 'msg', channel, text: encoded, attachments, ...(replyTo ? { replyTo } : {}) });
});
