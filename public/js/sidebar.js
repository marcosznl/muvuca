// Coluna de servidores, lista de canais, painel "Voz conectada" e painel do usuário
import { $, h, makeAvatar, paintServerIcon, toast, showBanner, store } from './util.js';
import { openProfileEditor } from './profile.js';
import { icon } from './icons.js';
import { state, currentServer, canIn, PERMS, serverUnread, serverMentions, statusOf, STATUS_LABEL, isMuted } from './state.js';
import { soundsOn, setSounds } from './sounds.js';
import { enablePush, disablePush, pushEnabled } from './push.js';
import { request } from './net.js';
import { contextMenu, promptText, confirmDialog, openModal, button } from './dialogs.js';
import { selectServer, selectChannel, selectGames } from './app.js';
import { joinVoice, leaveVoice, watchStream, voiceChannelId, speakingNow, openUserVolumeMenu } from './voice.js';
import { musicChannelId } from './music.js';
import { openServerSettings, openInviteDialog } from './settings.js';
import { dmRailItem, renderDmSidebar, dmTitle } from './dms.js';
import { THEMES, currentTheme, setTheme } from './theme.js';
import { openQuickSwitch } from './quick-switch.js';

// ---------- Coluna de servidores ----------

export function renderRail() {
  const rail = $('server-rail');
  rail.replaceChildren();
  // Área de jogos: fixa no topo, igual para todo mundo
  const gamesItem = h('div', 'rail-item');
  gamesItem.classList.toggle('active', !!state.view.games);
  const gamesBtn = h('button', 'server-icon games-icon');
  gamesBtn.title = 'Jogos';
  gamesBtn.append(icon('gamepad', 28));
  gamesBtn.onclick = selectGames;
  gamesItem.append(h('span', 'rail-pill'), gamesBtn);
  rail.append(dmRailItem(), gamesItem, h('div', 'rail-sep'));
  for (const s of state.servers.filter((x) => x.kind !== 'dm')) {
    const item = h('div', 'rail-item');
    item.classList.toggle('active', s.id === state.view.serverId);
    item.classList.toggle('unread', s.id !== state.view.serverId && serverUnread(s) > 0);
    const pill = h('span', 'rail-pill');
    const btn = h('button', 'server-icon');
    paintServerIcon(btn, s);
    btn.title = s.name;
    btn.onclick = () => selectServer(s.id);
    btn.oncontextmenu = (e) => { e.preventDefault(); serverMenu(s, e.clientX, e.clientY); };
    item.append(pill, btn);
    const mentions = serverMentions(s);
    if (mentions) item.append(h('span', 'rail-badge', mentions > 99 ? '99+' : String(mentions))); // te mencionaram lá
    rail.append(item);
  }
  rail.append(h('div', 'rail-sep'));
  const add = h('button', 'server-icon add');
  add.title = 'Adicionar um servidor';
  add.append(icon('plus', 24));
  add.onclick = openAddServer;
  const addItem = h('div', 'rail-item');
  addItem.append(h('span', 'rail-pill'), add);
  rail.append(addItem);
}

function openAddServer() {
  const content = h('div', 'add-server');
  const create = h('button', 'choice');
  create.append(icon('compass', 28), h('strong', '', 'Criar meu servidor'), h('span', 'muted small', 'Para você e seus amigos'));
  const join = h('button', 'choice');
  join.append(icon('link', 28), h('strong', '', 'Entrar com um convite'), h('span', 'muted small', 'Cole o link que te mandaram'));
  content.append(create, join);
  const modal = openModal({ title: 'Adicionar um servidor', subtitle: 'Seu servidor é onde você e seus amigos se reúnem.', content });

  create.onclick = async () => {
    modal.close();
    const name = await promptText({
      title: 'Personalize seu servidor', subtitle: 'Dê um nome ao seu novo servidor. Dá para mudar depois.',
      label: 'Nome do servidor', value: `Servidor de ${state.me.name}`, confirm: 'Criar', maxLength: 40,
    });
    if (!name) return;
    try { await request({ t: 'server:create', name }); } catch (err) { showBanner(err.message, { timeout: 4000 }); }
  };
  join.onclick = async () => {
    modal.close();
    const raw = await promptText({
      title: 'Entrar em um servidor', subtitle: 'Cole o link ou o código do convite.',
      label: 'Link do convite', placeholder: `${location.origin}/?convite=abc123`, confirm: 'Entrar', maxLength: 300,
    });
    if (!raw) return;
    const code = (() => { try { return new URL(raw).searchParams.get('convite') || raw; } catch { return raw; } })().trim();
    try { await request({ t: 'invite:accept', code }); } catch (err) { showBanner(err.message, { timeout: 4000 }); }
  };
}

// ---------- Cabeçalho e menu do servidor ----------

export function renderServerHeader() {
  if (state.view.dms) return; // a lista de conversas desenha o próprio cabeçalho
  const s = currentServer();
  const header = $('server-name');
  header.replaceChildren();
  if (!s) return;
  header.append(h('span', 'server-title', s.name), icon('chevron-down', 18));
  header.onclick = (e) => {
    const r = header.getBoundingClientRect();
    e.stopPropagation();
    serverMenu(s, r.left + 8, r.bottom + 4);
  };
}

export function serverMenu(s, x, y) {
  const isOwner = s.ownerId === state.me.id;
  const manage = [PERMS.MANAGE_SERVER, PERMS.MANAGE_ROLES, PERMS.KICK_MEMBERS, PERMS.MANAGE_CHANNELS, PERMS.MANAGE_EMOJIS].some((p) => canIn(s, p));
  contextMenu(x, y, [
    canIn(s, PERMS.CREATE_INVITE) && { label: 'Convidar pessoas', icon: 'user-plus', onClick: () => openInviteDialog(s) },
    manage && { label: 'Configurações do servidor', icon: 'settings', onClick: () => openServerSettings(s.id) },
    canIn(s, PERMS.MANAGE_CHANNELS) && { label: 'Criar canal', icon: 'plus', onClick: () => createChannel(s, 'text') },
    canIn(s, PERMS.MANAGE_CHANNELS) && { label: 'Criar categoria', icon: 'plus', onClick: () => createCategory(s) },
    state.mutes.has(s.id)
      ? { label: 'Reativar som do servidor', icon: 'bell', onClick: () => setMute(s.id, false) }
      : { label: 'Silenciar servidor', icon: 'volume-off', onClick: () => setMute(s.id, true) },
    'sep',
    isOwner
      ? !s.home && { label: 'Excluir servidor', icon: 'trash', danger: true, onClick: () => deleteServer(s) }
      : { label: 'Sair do servidor', icon: 'door-out', danger: true, onClick: () => leaveServer(s) },
  ]);
}

async function deleteServer(s) {
  const ok = await confirmDialog({
    title: `Excluir "${s.name}"`,
    message: 'Todos os canais, mensagens e cargos serão apagados para sempre. Não dá para desfazer.',
    confirm: 'Excluir servidor',
  });
  if (!ok) return;
  try { await request({ t: 'server:delete', serverId: s.id }); } catch (err) { showBanner(err.message, { timeout: 4000 }); }
}

async function leaveServer(s) {
  const ok = await confirmDialog({ title: `Sair de "${s.name}"`, message: 'Você só volta com um novo convite.', confirm: 'Sair do servidor' });
  if (!ok) return;
  try { await request({ t: 'server:leave', serverId: s.id }); } catch (err) { showBanner(err.message, { timeout: 4000 }); }
}

// ---------- Canais ----------

const TYPES = {
  text: { icon: 'hash', label: 'Texto', desc: 'Mande mensagens, emojis e links', placeholder: 'novo-canal' },
  voice: { icon: 'speaker', label: 'Voz', desc: 'Converse por voz, câmera e transmita a tela', placeholder: 'Nova sala' },
  music: { icon: 'headphones', label: 'Música', desc: 'Ouçam músicas do YouTube juntos, com cabine de DJ', placeholder: 'Pista' },
};

// Janela "Criar canal": escolhe o tipo e o nome; o canal nasce na categoria indicada (ou fora de todas)
export function createChannel(s, type = 'text', categoryId = null) {
  const cat = s.categories?.find((k) => k.id === categoryId);
  const form = h('form', 'form');
  const choices = h('div', 'type-choices');
  const field = h('label', 'field');
  const wrap = h('div', 'input-prefix');
  const input = h('input');
  input.maxLength = 30;
  let prefix = icon(TYPES[type].icon, 18);
  wrap.append(prefix, input);
  field.append(h('span', 'field-label', 'Nome do canal'), wrap);
  form.append(h('span', 'field-label', 'Tipo de canal'), choices, field);

  const setType = (t) => {
    type = t;
    for (const b of choices.children) b.classList.toggle('selected', b.dataset.type === t);
    const next = icon(TYPES[t].icon, 18);
    prefix.replaceWith(next);
    prefix = next;
    input.placeholder = TYPES[t].placeholder;
  };
  for (const [t, info] of Object.entries(TYPES)) {
    const b = h('button', 'type-choice');
    b.type = 'button';
    b.dataset.type = t;
    const text = h('span', 'type-text');
    text.append(h('strong', '', info.label), h('span', 'muted small', info.desc));
    b.append(icon(info.icon, 22), text, h('span', 'radio'));
    b.onclick = () => { setType(t); input.focus(); };
    choices.append(b);
  }
  setType(type);

  const ok = button('Criar canal');
  const cancel = button('Cancelar', { kind: 'link' });
  const modal = openModal({ title: 'Criar canal', subtitle: `em ${cat ? cat.name : s.name}`, content: form, actions: [cancel, ok] });
  const submit = async (e) => {
    e?.preventDefault();
    const name = input.value.trim();
    if (!name) return input.focus();
    modal.close();
    try {
      const res = await request({ t: 'channel:create', serverId: s.id, type, name, categoryId });
      if (res?.type !== 'voice') selectChannel(res.channelId);
    } catch (err) { showBanner(err.message, { timeout: 4000 }); }
  };
  form.onsubmit = submit;
  ok.onclick = submit;
  cancel.onclick = () => modal.close();
  setTimeout(() => input.focus(), 0);
}

function channelMenu(s, c, x, y) {
  const manage = canIn(s, PERMS.MANAGE_CHANNELS);
  const muted = state.mutes.has(c.id);
  contextMenu(x, y, [
    c.type !== 'voice' && { label: muted ? 'Reativar som do canal' : 'Silenciar canal', icon: muted ? 'bell' : 'volume-off', onClick: () => setMute(c.id, !muted) },
    manage && 'sep',
    manage && (c.type === 'voice'
      ? { label: 'Configurações do canal', icon: 'settings', onClick: () => voiceSettings(c) }
      : { label: 'Renomear canal', icon: 'pencil', onClick: () => renameChannel(c) }),
    manage && c.type !== 'voice' && { label: c.topic ? 'Editar tópico' : 'Definir tópico', icon: 'pencil', onClick: () => editTopic(c) },
    manage && { label: 'Mover para categoria', icon: 'chevron-down', onClick: () => pickCategory(s, c) },
    manage && { label: 'Excluir canal', icon: 'trash', danger: true, onClick: () => deleteChannel(c) },
  ]);
}

// Silenciar: sem destaque de não lida, sem som e sem notificação (menções ainda aparecem no número vermelho)
function setMute(target, muted) {
  request({ t: 'mute:set', target, muted }).then(() => toast(muted ? 'Silenciado. Menções ainda aparecem no número vermelho.' : 'Som reativado.'))
    .catch((err) => showBanner(err.message, { timeout: 4000 }));
}

async function editTopic(c) {
  const topic = await promptText({
    title: `Tópico de #${c.name}`, subtitle: 'Uma frase que aparece no topo do canal, dizendo para que ele serve.',
    label: 'Tópico', value: c.topic ?? '', maxLength: 160, allowEmpty: true, confirm: 'Salvar',
  });
  if (topic === null || topic === undefined) return;
  request({ t: 'channel:topic', channelId: c.id, topic }).catch((err) => showBanner(err.message, { timeout: 4000 }));
}

async function renameChannel(c) {
  const name = await promptText({ title: 'Renomear canal', label: 'Nome do canal', value: c.name, maxLength: 30 });
  if (!name || name === c.name) return;
  try { await request({ t: 'channel:rename', channelId: c.id, name }); } catch (err) { showBanner(err.message, { timeout: 4000 }); }
}

// Canal de voz: nome, qualidade do áudio (taxa de bits do Opus, igual ao "Taxa de bits" do Discord) e limite de pessoas
const LIMIT_MAX = 25;
const BITRATE = { min: 16, max: 320, step: 8, default: 128 };
const bitrateHint = (k) =>
  k < 48 ? 'Econômica: parece ligação de telefone. Boa para internet ruim.'
  : k < 96 ? 'Boa: voz clara, usa pouca internet.'
  : k < 160 ? 'Alta: voz com fidelidade total (padrão).'
  : 'Máxima: para música ao vivo e instrumentos. Na voz comum não faz diferença perceptível.';

function voiceSettings(c) {
  const form = h('form', 'form');
  const nameField = h('label', 'field');
  const name = h('input');
  Object.assign(name, { value: c.name, maxLength: 30 });
  nameField.append(h('span', 'field-label', 'Nome do canal'), name);

  const rateField = h('div', 'field');
  const value = h('strong', 'bitrate-value');
  const range = h('input', 'bitrate-range');
  Object.assign(range, { type: 'range', min: BITRATE.min, max: BITRATE.max, step: BITRATE.step, value: c.bitrate ?? BITRATE.default });
  const scale = h('div', 'bitrate-scale');
  const mark = h('span', 'bitrate-default', `${BITRATE.default} kbps (padrão)`);
  mark.style.left = `${((BITRATE.default - BITRATE.min) / (BITRATE.max - BITRATE.min)) * 100}%`; // alinhado com o ponto 128 da barra
  scale.append(h('span', '', `${BITRATE.min} kbps`), mark, h('span', '', `${BITRATE.max} kbps`));
  const hint = h('p', 'muted small bitrate-hint');
  const head = h('div', 'bitrate-head');
  head.append(h('span', 'field-label', 'Qualidade do áudio (taxa de bits)'), value);
  rateField.append(head, range, scale, hint);
  const update = () => {
    const k = Number(range.value);
    value.textContent = `${k} kbps`;
    hint.textContent = `${bitrateHint(k)} Cada pessoa envia ${k} kbps e recebe ${k} kbps por pessoa falando.`;
  };
  range.oninput = update;
  update();

  // Limite de pessoas (como o "Limite de usuários" do Discord); 0 = sem limite
  const limitField = h('div', 'field');
  const limitValue = h('strong', 'bitrate-value');
  const limitRange = h('input', 'bitrate-range');
  Object.assign(limitRange, { type: 'range', min: 0, max: LIMIT_MAX, step: 1, value: c.userLimit ?? 0 });
  const limitScale = h('div', 'bitrate-scale');
  limitScale.append(h('span', '', 'Sem limite'), h('span', '', `${LIMIT_MAX} pessoas`));
  const limitHint = h('p', 'muted small bitrate-hint');
  const limitHead = h('div', 'bitrate-head');
  limitHead.append(h('span', 'field-label', 'Limite de pessoas'), limitValue);
  limitField.append(limitHead, limitRange, limitScale, limitHint);
  const updateLimit = () => {
    const n = Number(limitRange.value);
    limitValue.textContent = n ? `${n} ${n === 1 ? 'pessoa' : 'pessoas'}` : 'Sem limite';
    limitHint.textContent = n
      ? `Com ${n} dentro, mais ninguém entra (quem gerencia canais entra mesmo assim).`
      : `Qualquer um pode entrar, até o máximo de ${LIMIT_MAX}. Cada pessoa a mais usa mais da internet da casa onde o servidor roda.`;
  };
  limitRange.oninput = updateLimit;
  updateLimit();
  form.append(nameField, rateField, limitField);

  const ok = button('Salvar');
  const cancel = button('Cancelar', { kind: 'link' });
  const modal = openModal({ title: 'Configurações do canal', subtitle: c.name, content: form, actions: [cancel, ok] });
  const submit = async (e) => {
    e?.preventDefault();
    if (!name.value.trim()) return name.focus();
    modal.close();
    try { await request({ t: 'channel:settings', channelId: c.id, name: name.value.trim(), bitrate: Number(range.value), userLimit: Number(limitRange.value) }); } catch (err) { showBanner(err.message, { timeout: 4000 }); }
  };
  form.onsubmit = submit;
  ok.onclick = submit;
  cancel.onclick = () => modal.close();
}

async function deleteChannel(c) {
  const ok = await confirmDialog({
    title: 'Excluir canal',
    message: {
      text: `Tem certeza de que quer excluir #${c.name}? Todas as mensagens dele serão apagadas.`,
      voice: `Tem certeza de que quer excluir "${c.name}"? Quem estiver nele será desconectado.`,
      music: `Tem certeza de que quer excluir "${c.name}"? A música para para todo mundo e o chat dele é apagado.`,
    }[c.type],
    confirm: 'Excluir canal',
  });
  if (!ok) return;
  try { await request({ t: 'channel:delete', channelId: c.id }); } catch (err) { showBanner(err.message, { timeout: 4000 }); }
}

// Alternativa ao arrastar (e para quem usa o celular): escolher a categoria numa lista
function pickCategory(s, c) {
  const list = h('div', 'category-picker');
  const modal = openModal({ title: 'Mover canal', subtitle: c.name, content: list });
  for (const k of [{ id: null, name: 'Sem categoria' }, ...(s.categories ?? [])]) {
    const b = h('button', 'picker-item', k.name);
    b.classList.toggle('current', (c.categoryId ?? null) === k.id);
    b.onclick = () => {
      modal.close();
      if ((c.categoryId ?? null) !== k.id) moveChannel(s, c.id, k.id, groupOf(s, k.id).length);
    };
    list.append(b);
  }
}

// ---------- Categorias ----------

let collapsed = new Set();
try { collapsed = new Set(JSON.parse(store.get('collapsedCategories') || '[]')); } catch {}

function toggleCollapsed(id) {
  if (collapsed.has(id)) collapsed.delete(id);
  else collapsed.add(id);
  store.set('collapsedCategories', JSON.stringify([...collapsed]));
  renderChannels();
}

export async function createCategory(s) {
  const name = await promptText({
    title: 'Criar categoria', subtitle: `em ${s.name}`, label: 'Nome da categoria', placeholder: 'Nova categoria', confirm: 'Criar categoria', maxLength: 30,
  });
  if (!name) return;
  try { await request({ t: 'category:create', serverId: s.id, name }); } catch (err) { showBanner(err.message, { timeout: 4000 }); }
}

function categoryMenu(s, k, x, y) {
  const canManage = canIn(s, PERMS.MANAGE_CHANNELS);
  contextMenu(x, y, [
    { label: collapsed.has(k.id) ? 'Expandir categoria' : 'Recolher categoria', icon: collapsed.has(k.id) ? 'chevron-down' : 'chevron-up', onClick: () => toggleCollapsed(k.id) },
    canManage && 'sep',
    canManage && { label: 'Criar canal', icon: 'plus', onClick: () => createChannel(s, 'text', k.id) },
    canManage && { label: 'Renomear categoria', icon: 'pencil', onClick: () => renameCategory(k) },
    canManage && { label: 'Excluir categoria', icon: 'trash', danger: true, onClick: () => deleteCategory(k) },
  ]);
}

async function renameCategory(k) {
  const name = await promptText({ title: 'Renomear categoria', label: 'Nome da categoria', value: k.name, maxLength: 30 });
  if (!name || name === k.name) return;
  try { await request({ t: 'category:rename', categoryId: k.id, name }); } catch (err) { showBanner(err.message, { timeout: 4000 }); }
}

async function deleteCategory(k) {
  const ok = await confirmDialog({
    title: 'Excluir categoria',
    message: `Excluir a categoria "${k.name}"? Os canais dela não são apagados: eles vão para o topo da lista, fora de categoria.`,
    confirm: 'Excluir categoria',
  });
  if (!ok) return;
  try { await request({ t: 'category:delete', categoryId: k.id }); } catch (err) { showBanner(err.message, { timeout: 4000 }); }
}

// ---------- Organizar (arrastar e soltar) ----------

// Canais de uma categoria (null = sem categoria), na ordem da lista
const groupOf = (s, categoryId) => s.channels.filter((c) => (c.categoryId ?? null) === categoryId);

function moveChannel(s, id, categoryId, index) {
  const ch = s.channels.find((c) => c.id === id);
  if (!ch) return;
  const from = groupOf(s, ch.categoryId ?? null);
  if ((ch.categoryId ?? null) === categoryId && from.indexOf(ch) === index) return;
  // Mostra na hora; o servidor confirma mandando a lista nova para todos
  const others = s.channels.filter((c) => c !== ch);
  const target = others.filter((c) => (c.categoryId ?? null) === categoryId);
  ch.categoryId = categoryId;
  target.splice(index, 0, ch);
  s.channels = [...others.filter((c) => (c.categoryId ?? null) !== categoryId), ...target];
  renderChannels();
  request({ t: 'channel:move', channelId: id, categoryId, index }).catch((err) => showBanner(err.message, { timeout: 4000 }));
}

function moveCategory(s, id, index) {
  const k = s.categories.find((x) => x.id === id);
  if (!k || s.categories.indexOf(k) === index) return;
  const others = s.categories.filter((x) => x !== k);
  others.splice(index, 0, k);
  s.categories = others;
  renderChannels();
  request({ t: 'category:move', categoryId: id, index }).catch((err) => showBanner(err.message, { timeout: 4000 }));
}

let drag = null;           // { kind: 'channel' | 'category', id }
let renderPending = false; // redesenhar no meio do arraste cancelaria o arraste; fica para o fim

function startDrag(e, kind, id, el) {
  drag = { kind, id };
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', id);
  requestAnimationFrame(() => el.classList.add('dragging'));
  $('channel-list').classList.add(`dragging-${kind}`);
}

function endDrag() {
  drag = null;
  clearDropMarks();
  $('channel-list').classList.remove('dragging-channel', 'dragging-category');
  if (renderPending) { renderPending = false; renderChannels(); }
}

function clearDropMarks() {
  for (const el of $('channel-list').querySelectorAll('.drop-before, .drop-after, .drop-into, .dragging')) {
    el.classList.remove('drop-before', 'drop-after', 'drop-into', 'dragging');
  }
}

// Onde o item cairia se fosse solto agora: { el, mark, apply }
function dropTarget(e) {
  const s = currentServer();
  if (!s || !drag) return null;
  const box = $('channel-list');
  const group = e.target.closest?.('.cat-group');
  if (!group || !box.contains(group)) return null;
  const categoryId = group.dataset.category || null;
  const id = drag.id; // o arraste já terminou quando `apply` roda
  const below = (el) => { const r = el.getBoundingClientRect(); return e.clientY > r.top + r.height / 2; };

  if (drag.kind === 'category') {
    if (!categoryId) {
      const first = box.querySelector('.cat-group[data-category]:not([data-category=""])');
      return first && { el: first, mark: 'drop-before', apply: () => moveCategory(s, id, 0) };
    }
    if (categoryId === id) return null;
    const after = below(group);
    const rest = s.categories.filter((k) => k.id !== id);
    const index = rest.findIndex((k) => k.id === categoryId) + (after ? 1 : 0);
    return { el: group, mark: after ? 'drop-after' : 'drop-before', apply: () => moveCategory(s, id, index) };
  }

  // Arrastando um canal
  const rest = groupOf(s, categoryId).filter((c) => c.id !== id);
  const li = e.target.closest('li[data-channel]');
  if (li && group.contains(li)) {
    if (li.dataset.channel === id) return null;
    const after = below(li);
    const index = rest.findIndex((c) => c.id === li.dataset.channel) + (after ? 1 : 0);
    return { el: li, mark: after ? 'drop-after' : 'drop-before', apply: () => moveChannel(s, id, categoryId, index) };
  }
  const header = e.target.closest('.category');
  if (header) return { el: header, mark: 'drop-into', apply: () => moveChannel(s, id, categoryId, 0) };
  return { el: group, mark: 'drop-into', apply: () => moveChannel(s, id, categoryId, rest.length) };
}

{
  const box = $('channel-list');
  box.addEventListener('dragover', (e) => {
    if (!drag) return;
    const t = dropTarget(e);
    for (const el of box.querySelectorAll('.drop-before, .drop-after, .drop-into')) {
      if (el !== t?.el) el.classList.remove('drop-before', 'drop-after', 'drop-into');
    }
    if (!t) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    t.el.classList.remove('drop-before', 'drop-after', 'drop-into');
    t.el.classList.add(t.mark);
  });
  box.addEventListener('dragleave', (e) => {
    if (drag && !box.contains(e.relatedTarget)) {
      for (const el of box.querySelectorAll('.drop-before, .drop-after, .drop-into')) el.classList.remove('drop-before', 'drop-after', 'drop-into');
    }
  });
  box.addEventListener('drop', (e) => {
    if (!drag) return;
    e.preventDefault();
    const t = dropTarget(e);
    endDrag();
    t?.apply();
  });
  box.addEventListener('dragend', endDrag);
}

// ---------- Lista de canais ----------

function categoryHeader(s, k, canManage) {
  const row = h('div', 'category');
  row.classList.toggle('collapsed', collapsed.has(k.id));
  const toggle = h('button', 'category-toggle');
  toggle.title = collapsed.has(k.id) ? 'Expandir' : 'Recolher';
  toggle.append(icon('chevron-down', 12), h('span', 'category-name', k.name));
  toggle.onclick = () => toggleCollapsed(k.id);
  row.append(toggle);
  row.oncontextmenu = (e) => { e.preventDefault(); categoryMenu(s, k, e.clientX, e.clientY); };
  if (canManage) {
    const add = h('button', 'category-add');
    add.title = 'Criar canal';
    add.append(icon('plus', 16));
    add.onclick = () => createChannel(s, 'text', k.id);
    row.append(add);
    row.draggable = true;
    row.ondragstart = (e) => startDrag(e, 'category', k.id, row.parentElement);
  }
  return row;
}

function channelItem(s, c, canManage) {
  const li = h('li');
  li.dataset.channel = c.id;
  const btn = h('button', 'channel');
  btn.classList.toggle('active', state.view.channelId === c.id);
  li.append(btn);

  if (c.type === 'text') {
    // Não lida: nome em destaque; o número vermelho é só para quando te mencionaram (como no Discord)
    const muted = isMuted(c.id, s.id);
    const unread = muted ? 0 : state.unread[c.id] || 0;
    const mentions = state.mentions[c.id] || 0;
    btn.classList.toggle('unread', unread > 0);
    btn.classList.toggle('muted', muted);
    if (c.topic) btn.title = c.topic;
    btn.append(icon('hash'), h('span', 'name', c.name));
    if (mentions) btn.append(h('span', 'badge', mentions > 99 ? '99+' : String(mentions)));
    btn.onclick = () => selectChannel(c.id);
  } else if (c.type === 'voice') {
    const people = state.voice[c.id] ?? [];
    btn.classList.toggle('connected', voiceChannelId() === c.id);
    btn.append(icon('speaker'), h('span', 'name', c.name));
    // Com limite: "2/5" sempre à vista (como no Discord); sem limite: só quantos estão dentro
    if (c.userLimit) btn.append(h('span', `count${people.length >= c.userLimit ? ' full' : ''}`, `${people.length}/${c.userLimit}`));
    else if (people.length) btn.append(h('span', 'count', String(people.length)));
    btn.onclick = () => (voiceChannelId() === c.id ? selectChannel(c.id) : joinVoice(c.id));
    const members = h('ul', 'voice-members');
    for (const p of people) {
      const row = h('li', 'voice-member');
      row.dataset.id = p.id;
      row.classList.toggle('speaking', voiceChannelId() === c.id && speakingNow().has(p.id));
      const icons = h('span', 'icons');
      if (p.camera) icons.append(icon('video', 14));
      if (p.muted || p.deafened) icons.append(icon('mic-off', 14));
      if (p.deafened) icons.append(icon('headphones-off', 14));
      row.append(makeAvatar(p.name, 'sm', p.id), h('span', 'name', p.name));
      if (p.streaming) {
        const live = h('button', 'live-badge', 'AO VIVO');
        live.title = `Assistir a tela de ${p.name}`;
        live.onclick = () => watchStream(c.id, p.id);
        row.append(live);
      }
      row.append(icons);
      // Botão direito: volume dessa pessoa só para você (quando vocês estão na mesma chamada)
      row.oncontextmenu = (e) => { if (openUserVolumeMenu(p.id, e.clientX, e.clientY)) e.preventDefault(); };
      members.append(row);
    }
    li.append(members);
  } else {
    const listeners = state.music[c.id]?.listeners?.length ?? 0;
    btn.classList.toggle('connected', musicChannelId() === c.id);
    btn.append(icon('headphones'), h('span', 'name', c.name));
    if (listeners) btn.append(h('span', 'count', String(listeners)));
    const playing = state.music[c.id]?.nowPlaying;
    btn.title = playing ? `Tocando: ${playing}` : c.name;
    btn.onclick = () => selectChannel(c.id);
  }

  if (canManage) {
    const gear = h('span', 'channel-gear');
    gear.title = 'Editar canal';
    gear.append(icon('settings', 14));
    gear.onclick = (e) => {
      e.stopPropagation();
      const r = gear.getBoundingClientRect();
      channelMenu(s, c, r.right, r.bottom);
    };
    btn.append(gear);
    li.draggable = true;
    li.ondragstart = (e) => { e.stopPropagation(); startDrag(e, 'channel', c.id, li); };
  }
  // Botão direito: silenciar (todo mundo) e editar (quem gerencia)
  btn.oncontextmenu = (e) => { e.preventDefault(); channelMenu(s, c, e.clientX, e.clientY); };
  return li;
}

export function renderChannels() {
  if (drag) { renderPending = true; return; }
  if (state.view.games) return; // na área de jogos a coluna mostra as salas (não pode ser apagada)
  if (state.view.dms) return renderDmSidebar();
  const s = currentServer();
  const box = $('channel-list');
  box.replaceChildren();
  if (!s) return;
  const canManage = canIn(s, PERMS.MANAGE_CHANNELS);
  // Canais sem categoria ficam no topo; os de uma categoria que não existe mais também
  const known = new Set((s.categories ?? []).map((k) => k.id));
  const loose = s.channels.filter((c) => !c.categoryId || !known.has(c.categoryId));

  for (const k of [null, ...(s.categories ?? [])]) {
    const list = k ? groupOf(s, k.id) : loose;
    if (!k && !list.length && !canManage) continue;
    const group = h('section', 'cat-group');
    group.dataset.category = k?.id ?? '';
    if (k) group.append(categoryHeader(s, k, canManage));
    const ul = h('ul', 'channel-list');
    const hide = k && collapsed.has(k.id);
    for (const c of list) {
      // Recolhida, a categoria ainda mostra o canal aberto e as salas em que você está
      if (hide && state.view.channelId !== c.id && voiceChannelId() !== c.id && musicChannelId() !== c.id) continue;
      ul.append(channelItem(s, c, canManage));
    }
    group.append(ul);
    box.append(group);
  }
}

// ---------- Painéis de baixo ----------

export function renderUserPanel() {
  if (!state.me) return;
  $('me-name').textContent = state.me.name;
  $('me-name').title = `@${state.me.username}`;
  const status = statusOf(state.me.id);
  const avatar = Object.assign(makeAvatar(state.me.name, 'sm', state.me.id), { id: 'me-avatar', title: 'Status e perfil' });
  avatar.classList.add('with-status', `status-${status === 'offline' ? 'online' : status}`);
  $('me-avatar').replaceWith(avatar);
  const openMenu = (e) => { e.stopPropagation(); const r = $('me-avatar').getBoundingClientRect(); statusMenu(r.left, r.top - 8); };
  $('me-avatar').onclick = openMenu;
  $('me-name').onclick = openMenu;
  const micOff = !state.micOn || state.deafened;
  $('btn-mic').replaceChildren(icon(micOff ? 'mic-off' : 'mic'));
  $('btn-mic').classList.toggle('off', micOff);
  $('btn-mic').title = state.micOn ? 'Silenciar microfone' : 'Ativar microfone';
  $('btn-deaf').replaceChildren(icon(state.deafened ? 'headphones-off' : 'headphones'));
  $('btn-deaf').classList.toggle('off', state.deafened);
  $('btn-deaf').title = state.deafened ? 'Parar de ensurdecer' : 'Ensurdecer';
  syncDesktopVoiceState();
}

// App do Mac: estado do microfone (menu da barra de menus) e se está em call/música (o Mac não pode "cochilar" o app)
export function syncDesktopVoiceState() {
  window.muvucaDesktop?.setVoiceState({ muted: !state.micOn || state.deafened, inCall: !!voiceChannelId() || !!musicChannelId() });
}

// Menu do seu status (clique na sua foto lá embaixo)
function statusMenu(x, y) {
  const current = state.me.presence ?? 'online';
  const pick = (presence) => ({
    label: `${{ online: '🟢', idle: '🌙', dnd: '⛔', invisible: '⚪' }[presence]} ${STATUS_LABEL[presence]}${current === presence ? '  ✓' : ''}`,
    onClick: () => request({ t: 'presence:set', presence }).catch((err) => showBanner(err.message, { timeout: 4000 })),
  });
  contextMenu(x, y, [
    pick('online'), pick('idle'), pick('dnd'), pick('invisible'),
    'sep',
    { label: state.me.statusText ? 'Mudar status personalizado…' : 'Definir status personalizado…', icon: 'pencil', onClick: setCustomStatus },
    { label: 'Editar perfil', icon: 'user-plus', onClick: openProfileEditor },
    'sep',
    { label: soundsOn() ? 'Sons: ligados' : 'Sons: desligados', icon: soundsOn() ? 'volume-low' : 'volume-off', onClick: () => { setSounds(!soundsOn()); toast(soundsOn() ? 'Sons ligados.' : 'Sons desligados.'); } },
    // No app do Mac as notificações são do próprio sistema (não precisa ativar)
    !window.muvucaDesktop && (pushEnabled()
      ? { label: 'Desativar notificações aqui', icon: 'bell', onClick: disablePush }
      : { label: 'Ativar notificações', icon: 'bell', onClick: enablePush }),
    { label: 'Ir para… (Ctrl+K)', icon: 'search', onClick: openQuickSwitch },
    // No Mac pelo navegador: link para o app (tem apertar para falar em segundo plano)
    !window.muvucaDesktop && /Mac/.test(navigator.userAgent) && !/iPhone|iPad/.test(navigator.userAgent)
      && { label: 'Baixar o app para Mac', icon: 'download', onClick: () => window.open('/baixar', '_blank') },
    'sep',
    ...THEMES.map(([id, label]) => ({ label: `Tema: ${label}${currentTheme() === id ? '  ✓' : ''}`, onClick: () => setTheme(id) })),
  ]);
}

async function setCustomStatus() {
  const text = await promptText({
    title: 'Status personalizado', subtitle: 'Aparece embaixo do seu nome para todo mundo. Deixe vazio para tirar.',
    label: 'O que você está fazendo?', value: state.me.statusText ?? '', placeholder: 'Jogando Tron, estudando, ouvindo música…', confirm: 'Salvar', maxLength: 60, allowEmpty: true,
  });
  if (text === null || text === undefined) return;
  request({ t: 'status:text', text }).catch((err) => showBanner(err.message, { timeout: 4000 }));
}

export function renderVoicePanel() {
  const channelId = voiceChannelId();
  $('voice-panel').hidden = !channelId;
  const status = statusOf(state.me?.id);
  const idle = [state.me?.statusText || STATUS_LABEL[status === 'offline' ? 'online' : status]];
  $('me-status').replaceChildren(...(channelId ? [icon('speaker', 12), ' Em voz'] : idle));
  $('me-status').classList.toggle('in-voice', !!channelId);
  if (!channelId) return;
  const s = state.servers.find((x) => x.channels.some((c) => c.id === channelId));
  const c = s?.channels.find((x) => x.id === channelId);
  $('vp-channel').textContent = s?.kind === 'dm' ? `Chamada com ${dmTitle(s)}` : `${c?.name ?? '?'} / ${s?.name ?? '?'}`;
  syncDesktopVoiceState();
}

$('vp-channel').onclick = () => { const id = voiceChannelId(); if (id) selectChannel(id); };
$('btn-disconnect').onclick = () => leaveVoice();

export function copyText(text) {
  navigator.clipboard?.writeText(text).then(() => toast('Copiado!')).catch(() => {});
}

