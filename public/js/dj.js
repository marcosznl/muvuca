// Assistir Junto (salas de música como no plug.dj): página própria (como a dos jogos) e item na lateral, abaixo de
// "Jogos", para todo mundo.
// Qualquer pessoa cria uma sala, com ou sem senha; quem criou (e o dono do Muvuca) muda e apaga.
// Dentro da sala é tudo o que já existia nos canais de música: player, cabine de DJ, fila e chat.
import { $, h, showBanner, makeAvatar } from './util.js';
import { icon } from './icons.js';
import { state } from './state.js';
import { request } from './net.js';
import { openModal, button, promptText, confirmDialog, contextMenu } from './dialogs.js';
import { selectChannel, selectDjHome } from './app.js';
import { musicChannelId } from './music.js';

export const djLobby = () => state.servers.find((s) => s.kind === 'dj');
export const djRooms = () => djLobby()?.channels.filter((c) => c.type === 'music') ?? [];
export const inDjHome = () => !!state.view.djHome;
export const inDjRoom = () => !!state.view.channelId && djRooms().some((c) => c.id === state.view.channelId);
export const djUnread = () => djRooms().reduce((n, c) => n + (state.unread[c.id] ?? 0), 0);
const fail = (err) => showBanner(err.message, { timeout: 4500 });
const isAdmin = () => state.servers.some((s) => s.home && s.ownerId === state.me?.id);
const manages = (c) => c.ownerId === state.me?.id || isAdmin();
const canEnter = (c) => !c.locked || c.open;

// Entrar: sala com senha pede a senha uma vez (depois fica liberada)
async function enter(c) {
  if (!canEnter(c)) {
    const password = await promptText({
      title: `Entrar em ${c.name}`, subtitle: 'Essa sala tem senha. Peça a quem criou.', label: 'Senha', type: 'password', confirm: 'Entrar', maxLength: 64,
    });
    if (password == null) return;
    try { await request({ t: 'dj:unlock', channelId: c.id, password }); } catch (err) { return fail(err); }
  }
  selectChannel(c.id);
}

// Formulário de criar sala: nome e o tipo, aberta (qualquer um entra) ou com senha.
// Usado na própria página do Assistir Junto e na janela do "+" da lateral.
function createRoomForm(onCreated) {
  const form = h('form', 'form dj-create');
  const nameField = h('label', 'field');
  const name = h('input');
  Object.assign(name, { maxLength: 40, placeholder: 'Nome da sala (ex.: Pista)' });
  nameField.append(h('span', 'field-label', 'Nome da sala'), name);
  let locked = false;
  const kinds = h('div', 'dj-kinds');
  const kind = (value, ic, label, desc) => {
    const b = h('button', 'dj-kind');
    b.type = 'button';
    b.append(icon(ic, 18), h('span', 'dj-kind-text'));
    b.lastChild.append(h('strong', '', label), h('span', 'muted small', desc));
    b.onclick = () => { locked = value; paint(); if (locked) pass.focus(); };
    return b;
  };
  const open = kind(false, 'headphones', 'Aberta', 'Qualquer um entra');
  const closed = kind(true, 'lock', 'Com senha', 'Só quem sabe a senha');
  kinds.append(open, closed);
  const passField = h('label', 'field');
  const pass = h('input');
  Object.assign(pass, { type: 'password', maxLength: 64, autocomplete: 'off', placeholder: 'Senha da sala' });
  passField.append(h('span', 'field-label', 'Senha'), pass);
  const paint = () => {
    open.classList.toggle('selected', !locked);
    closed.classList.toggle('selected', locked);
    passField.hidden = !locked;
  };
  const ok = h('button', 'btn primary', 'Criar sala');
  ok.type = 'submit';
  form.append(nameField, h('span', 'field-label', 'Tipo de sala'), kinds, passField, ok);
  paint();
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (!name.value.trim()) return name.focus();
    if (locked && !pass.value) return pass.focus();
    ok.disabled = true;
    try {
      const r = await request({ t: 'dj:create', name: name.value.trim(), password: locked ? pass.value : '' });
      onCreated?.();
      setTimeout(() => selectChannel(r.channelId), 150); // espera a sala chegar na lista
    } catch (err) { ok.disabled = false; fail(err); }
  };
  return { form, name };
}

// "+" da lateral: o mesmo formulário numa janela
export function openCreateDjRoom() {
  let modal;
  const { form, name } = createRoomForm(() => modal.close());
  modal = openModal({ title: 'Nova sala', subtitle: 'Ouçam músicas do YouTube juntos, revezando na cabine de DJ.', content: form });
  setTimeout(() => name.focus(), 0);
}

function roomMenu(c, x, y) {
  contextMenu(x, y, [
    canEnter(c) && { label: 'Entrar na sala', icon: 'headphones', onClick: () => enter(c) },
    manages(c) && { label: 'Mudar o nome', icon: 'pencil', onClick: () => rename(c) },
    manages(c) && { label: c.locked ? 'Trocar a senha' : 'Colocar senha', icon: 'lock', onClick: () => setPassword(c) },
    manages(c) && c.locked && { label: 'Tirar a senha', icon: 'lock', onClick: () => update(c, { password: '' }) },
    manages(c) && 'sep',
    manages(c) && { label: 'Apagar a sala', icon: 'trash', danger: true, onClick: () => remove(c) },
  ]);
}

const update = (c, fields) => request({ t: 'dj:update', channelId: c.id, ...fields }).catch(fail);
async function rename(c) {
  const name = await promptText({ title: 'Nome da sala', label: 'Nome', value: c.name, maxLength: 40 });
  if (name && name !== c.name) update(c, { name });
}
async function setPassword(c) {
  const password = await promptText({
    title: c.locked ? 'Trocar a senha' : 'Colocar senha', subtitle: 'Quem já tinha entrado precisa digitar a senha nova.', label: 'Senha', type: 'password', maxLength: 64,
  });
  if (password) update(c, { password });
}
async function remove(c) {
  const ok = await confirmDialog({ title: `Apagar ${c.name}`, message: 'A música para para todo mundo e o chat da sala é apagado. Não dá para desfazer.', confirm: 'Apagar sala' });
  if (ok) request({ t: 'dj:delete', channelId: c.id }).catch(fail);
}

// O que aparece ao abrir "Assistir Junto" na lateral: as salas (só o nome, quem está ouvindo e a música) e "Nova sala"
export function djTree() {
  const list = h('ul', 'channel-list dj-rooms');
  for (const c of djRooms()) {
    const li = h('li');
    li.dataset.channel = c.id;
    const b = h('button', 'channel music');
    b.classList.toggle('active', state.view.channelId === c.id);
    b.classList.toggle('connected', musicChannelId() === c.id);
    b.classList.toggle('unread', (state.unread[c.id] ?? 0) > 0);
    b.append(h('span', 'name', c.name)); // só o nome: são salas, sem ícone
    const listeners = state.music[c.id]?.listeners?.length ?? 0;
    if (listeners) b.append(h('span', 'count', String(listeners)));
    const playing = state.music[c.id]?.nowPlaying;
    b.title = !canEnter(c) ? 'Sala com senha' : playing ? `Tocando: ${playing}` : c.name;
    b.onclick = () => enter(c);
    b.oncontextmenu = (e) => { e.preventDefault(); roomMenu(c, e.clientX, e.clientY); };
    li.append(b);
    list.append(li);
  }
  const add = h('button', 'channel tree-item tree-add');
  add.append(icon('plus', 16), h('span', 'name', 'Nova sala'));
  add.onclick = openCreateDjRoom;
  return [list, add];
}

// ---------- Página das salas (mesmo molde da página dos jogos) ----------

const ownerName = (c) => djLobby()?.members.find((x) => x.id === c.ownerId)?.name ?? null;

function roomCard(c) {
  const card = h('div', 'game-card dj-card');
  card.classList.toggle('current', musicChannelId() === c.id);
  const body = h('div', 'game-card-body');
  const title = h('h2', '', c.name);
  const playing = state.music[c.id]?.nowPlaying;
  const listeners = state.music[c.id]?.listeners ?? [];
  const owner = ownerName(c);
  const lines = [
    !canEnter(c) ? 'Sala com senha: peça a senha a quem criou.' : playing ? `Tocando: ${playing}` : 'Nenhuma música tocando agora.',
    [c.locked && canEnter(c) ? 'Sala com senha' : null, owner ? `Criada por ${owner}` : null].filter(Boolean).join(' · ') || null,
  ].filter(Boolean);
  body.append(title, ...lines.map((t, i) => h('p', i ? 'muted small' : 'muted', t)));
  if (listeners.length) {
    const who = h('div', 'dj-card-listeners');
    for (const id of listeners.slice(0, 8)) {
      const name = djLobby()?.members.find((x) => x.id === id)?.name ?? '?';
      const a = makeAvatar(name, 'sm', id);
      a.title = name;
      who.append(a);
    }
    who.append(h('span', 'muted small', `${listeners.length} ouvindo`));
    body.append(who);
  }
  const actions = h('div', 'room-actions');
  const enterBtn = h('button', 'btn primary', musicChannelId() === c.id ? 'Voltar para a sala' : canEnter(c) ? 'Entrar' : 'Entrar com senha');
  enterBtn.onclick = () => enter(c);
  actions.append(enterBtn);
  if (manages(c)) {
    const more = h('button', 'btn secondary', 'Opções');
    more.onclick = (e) => { const r = e.currentTarget.getBoundingClientRect(); roomMenu(c, r.left, r.bottom + 4); };
    actions.append(more);
  }
  body.append(actions);
  card.append(body);
  card.oncontextmenu = (e) => { e.preventDefault(); roomMenu(c, e.clientX, e.clientY); };
  return card;
}

let createBox = null; // formulário de criar sala da página (mantido entre atualizações)
export function renderDjHome() {
  const view = $('dj-view');
  if (!view || !inDjHome()) return;
  $('view-icon').replaceChildren(icon('headphones', 22));
  $('view-title').textContent = 'Assistir Junto';
  const wrap = h('div', 'games-lobby');
  const intro = h('div', 'game-card dj-intro');
  const introBody = h('div', 'game-card-body');
  introBody.append(h('h2', '', 'Assistir Junto'), h('p', 'muted', 'Ouçam músicas do YouTube juntos: cada um entra na cabine de DJ e toca a sua vez.'));
  intro.append(h('div', 'game-art', '🎶'), introBody);
  // Criar sala ali mesmo (o mesmo formulário entre atualizações da página: não perde o que foi digitado)
  if (!createBox) createBox = createRoomForm(() => { createBox = null; }).form;
  introBody.append(createBox);
  wrap.append(intro);
  const rooms = djRooms();
  wrap.append(h('h3', 'games-subtitle', rooms.length ? 'Salas' : 'Nenhuma sala ainda'));
  if (!rooms.length) wrap.append(h('p', 'muted', 'Crie a primeira e chame a galera!'));
  const cards = h('div', 'game-cards');
  for (const c of rooms) cards.append(roomCard(c));
  if (rooms.length) wrap.append(cards);
  const scroll = view.scrollTop;
  view.replaceChildren(wrap);
  view.scrollTop = scroll;
}

export { selectDjHome };
