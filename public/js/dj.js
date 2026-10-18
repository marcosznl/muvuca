// Salas de DJ (como no plug.dj): ficam na lateral, abaixo de "Todos os jogos", para todo mundo.
// Qualquer pessoa cria uma sala, com ou sem senha; quem criou (e o dono do Muvuca) muda e apaga.
// Dentro da sala é tudo o que já existia nos canais de música: player, cabine de DJ, fila e chat.
import { h, showBanner } from './util.js';
import { icon } from './icons.js';
import { state } from './state.js';
import { request } from './net.js';
import { openModal, button, promptText, confirmDialog, contextMenu } from './dialogs.js';
import { selectChannel } from './app.js';
import { musicChannelId } from './music.js';

export const djLobby = () => state.servers.find((s) => s.kind === 'dj');
export const djRooms = () => djLobby()?.channels.filter((c) => c.type === 'music') ?? [];
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

// Criar sala: nome e, se quiser, uma senha
export function openCreateDjRoom() {
  const form = h('form', 'form');
  const nameField = h('label', 'field');
  const name = h('input');
  Object.assign(name, { maxLength: 40, placeholder: 'Pista' });
  nameField.append(h('span', 'field-label', 'Nome da sala'), name);
  const passField = h('label', 'field');
  const pass = h('input');
  Object.assign(pass, { type: 'password', maxLength: 64, autocomplete: 'off', placeholder: 'Deixe vazio para qualquer um entrar' });
  passField.append(h('span', 'field-label', 'Senha (opcional)'), pass);
  const enterKey = h('button'); // com dois campos, o Enter só envia se o formulário tiver um botão de enviar
  Object.assign(enterKey, { type: 'submit', hidden: true });
  form.append(nameField, passField, enterKey);
  const ok = button('Criar sala');
  const cancel = button('Cancelar', { kind: 'link' });
  const modal = openModal({ title: 'Nova sala de DJ', subtitle: 'Ouçam músicas do YouTube juntos, revezando na cabine de DJ.', content: form, actions: [cancel, ok] });
  const submit = async (e) => {
    e?.preventDefault();
    if (!name.value.trim()) return name.focus();
    ok.disabled = true;
    try {
      const r = await request({ t: 'dj:create', name: name.value.trim(), password: pass.value });
      modal.close();
      setTimeout(() => selectChannel(r.channelId), 150); // espera a sala chegar na lista
    } catch (err) { ok.disabled = false; fail(err); }
  };
  form.onsubmit = submit;
  ok.onclick = submit;
  cancel.onclick = () => modal.close();
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

// O que aparece ao abrir "Salas de DJ" na lateral: as salas (com cadeado, quem está ouvindo e a música) e "Nova sala"
export function djTree() {
  const list = h('ul', 'channel-list dj-rooms');
  for (const c of djRooms()) {
    const li = h('li');
    li.dataset.channel = c.id;
    const b = h('button', 'channel music');
    b.classList.toggle('active', state.view.channelId === c.id);
    b.classList.toggle('connected', musicChannelId() === c.id);
    b.classList.toggle('unread', (state.unread[c.id] ?? 0) > 0);
    b.append(icon(canEnter(c) ? 'headphones' : 'lock', 16), h('span', 'name', c.name));
    if (c.locked && canEnter(c)) {
      const lock = h('span', 'channel-lock');
      lock.title = 'Sala com senha';
      lock.append(icon('lock', 12));
      b.append(lock);
    }
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
