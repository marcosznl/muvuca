// Mensagens diretas: conversas privadas (com uma pessoa ou em grupo), no bloco "Amigos" da lateral.
// No servidor elas são "servidores" escondidos (kind: 'dm') com um canal só; aqui viram uma lista de conversas.
import { $, h, makeAvatar, showBanner, store } from './util.js';
import { icon } from './icons.js';
import { state, serverById } from './state.js';
import { request } from './net.js';
import { openModal, button, promptText, contextMenu } from './dialogs.js';
import { selectServer } from './app.js';
import { incomingCount } from './friends.js';
import { renderChannels } from './sidebar.js';

export const isDm = (s) => s?.kind === 'dm';
export const dmServers = () => state.servers.filter(isDm);
export const realServers = () => state.servers.filter((s) => !isDm(s));
const others = (s) => s.members.filter((m) => m.id !== state.me?.id);

// Nome da conversa: a outra pessoa (ou os nomes do grupo)
export function dmTitle(s) {
  const o = others(s);
  if (!o.length) return 'Só você';
  if (o.length === 1) return o[0].name;
  if (s.dmName) return s.dmName; // grupo com nome escolhido
  return o.map((m) => m.name.split(' ')[0]).join(', ');
}

// Conversas escondidas (1:1 não dá para sair; dá para tirar da lista até chegar mensagem nova)
const hidden = () => new Set(JSON.parse(store.get('hiddenDms') || '[]'));
function setHidden(set) { store.set('hiddenDms', JSON.stringify([...set])); }
export function unhideDm(serverId) {
  const set = hidden();
  if (set.delete(serverId)) setHidden(set);
}

const dmUnread = (s) => s.channels.reduce((n, c) => n + (state.unread[c.id] || 0), 0);
export const totalDmUnread = () => dmServers().reduce((n, s) => n + dmUnread(s), 0);

// Abre (ou cria) a conversa com essas pessoas
export async function startDm(userIds) {
  try { await request({ t: 'dm:open', userIds }); } catch (err) { showBanner(err.message, { timeout: 4000 }); }
}

// Bloco "Amigos" da lateral: "Todos os amigos" (página de amigos e pedidos) e as conversas privadas
export function dmTree() {
  const friendsBtn = h('button', 'channel tree-item');
  friendsBtn.classList.toggle('active', !!state.view.dms && !state.view.serverId && !state.view.games);
  friendsBtn.append(icon('friends', 18), h('span', 'name', 'Todos os amigos'));
  const pending = incomingCount();
  if (pending) friendsBtn.append(h('span', 'badge', String(pending)));
  friendsBtn.onclick = selectDmHome;
  const list = h('ul', 'channel-list dm-list');
  const hide = hidden();
  const convs = dmServers().filter((s) => !hide.has(s.id) || s.id === state.view.serverId)
    .sort((a, b) => dmUnread(b) - dmUnread(a) || dmTitle(a).localeCompare(dmTitle(b), 'pt-BR'));
  for (const s of convs) {
    const li = h('li');
    const b = h('button', 'channel dm-item');
    b.classList.toggle('active', s.id === state.view.serverId);
    const o = others(s);
    const avatar = o.length === 1 ? makeAvatar(o[0].name, 'sm', o[0].id) : h('div', 'avatar sm dm-group', String(o.length + 1));
    const online = o.length === 1 && state.online.has(o[0].id);
    if (o.length === 1) avatar.classList.add('with-status', `status-${online ? state.status[o[0].id] ?? 'online' : 'offline'}`);
    const unread = dmUnread(s);
    b.classList.toggle('unread', unread > 0);
    // Segunda linha: o que a pessoa está jogando, o status dela ou quantos há no grupo
    const info = h('span', 'dm-info');
    info.append(h('span', 'name', dmTitle(s)));
    const act = online && state.activity[o[0].id];
    const sub = o.length > 1 ? `${o.length + 1} membros` : act ? `Jogando ${act.name}` : online ? o[0].statusText : '';
    if (sub) info.append(h('span', 'dm-sub', sub));
    b.append(avatar, info);
    const callCh = s.channels.find((c) => c.type === 'voice');
    if (callCh && state.voice[callCh.id]?.length) {
      const live = icon('phone', 16);
      live.classList.add('dm-live-call');
      b.append(live);
    }
    if (unread) b.append(h('span', 'badge', unread > 99 ? '99+' : String(unread)));
    const close = h('span', 'dm-close');
    close.title = o.length === 1 ? 'Tirar da lista' : 'Sair do grupo';
    close.append(icon('close', 14));
    close.onclick = (e) => { e.stopPropagation(); closeDm(s); };
    b.append(close);
    b.onclick = () => selectServer(s.id);
    if (o.length > 1) {
      b.oncontextmenu = (e) => {
        e.preventDefault();
        contextMenu(e.clientX, e.clientY, [
          { label: 'Renomear grupo', icon: 'pencil', onClick: () => renameGroup(s) },
          { label: 'Sair do grupo', icon: 'door-out', danger: true, onClick: () => closeDm(s) },
        ]);
      };
    }
    li.append(b);
    list.append(li);
  }
  const newBtn = h('button', 'channel tree-item tree-add');
  newBtn.append(icon('plus', 16), h('span', 'name', 'Nova conversa'));
  newBtn.onclick = openNewDm;
  return [friendsBtn, list, newBtn];
}
export { openNewDm };

// Grupo: nome livre (até 40 caracteres); vazio volta a mostrar os nomes das pessoas
export async function renameGroup(s) {
  const name = await promptText({
    title: 'Renomear grupo', subtitle: 'Todo mundo do grupo vê o novo nome. Deixe vazio para voltar aos nomes das pessoas.',
    label: 'Nome do grupo', value: s.dmName ?? '', placeholder: dmTitle({ ...s, dmName: null }), maxLength: 40, allowEmpty: true,
  });
  if (name === null || name === undefined) return;
  try { await request({ t: 'dm:rename', serverId: s.id, name: name.trim() }); } catch (err) { showBanner(err.message, { timeout: 4000 }); }
}

async function closeDm(s) {
  if (others(s).length > 1) {
    try { await request({ t: 'server:leave', serverId: s.id }); } catch (err) { showBanner(err.message, { timeout: 4000 }); }
    return;
  }
  const set = hidden();
  set.add(s.id);
  setHidden(set);
  if (state.view.serverId === s.id) selectDmHome();
  else renderChannels();
}

// Área de mensagens diretas sem conversa aberta
export function selectDmHome() {
  state.view = { serverId: null, channelId: null, dms: true };
  import('./app.js').then(({ showChannelView }) => showChannelView());
}

// Escolher com quem conversar (gente dos seus servidores); com mais de uma pessoa vira grupo
function openNewDm() {
  const people = new Map();
  for (const f of state.friends) if (f.status === 'friend') people.set(f.user.id, f.user);
  for (const s of realServers()) for (const m of s.members) if (m.id !== state.me.id) people.set(m.id, m);
  const chosen = new Set();
  const content = h('div', 'form');
  const search = h('input');
  search.placeholder = 'Procurar pessoa…';
  const list = h('div', 'dm-pick-list');
  const go = button('Conversar');
  const paint = () => {
    const q = search.value.trim().toLowerCase();
    list.replaceChildren();
    const sorted = [...people.values()].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))
      .filter((m) => !q || m.name.toLowerCase().includes(q) || m.username.toLowerCase().includes(q));
    for (const m of sorted) {
      const row = h('label', 'dm-pick');
      const box = h('input');
      box.type = 'checkbox';
      box.checked = chosen.has(m.id);
      box.onchange = () => { if (box.checked && chosen.size >= 9) { box.checked = false; return; } box.checked ? chosen.add(m.id) : chosen.delete(m.id); updateGo(); };
      row.append(box, makeAvatar(m.name, 'sm', m.id), h('span', 'name', m.name), h('span', 'muted small', `@${m.username}`));
      list.append(row);
    }
    if (!sorted.length) list.append(h('p', 'muted small', 'Ninguém encontrado.'));
  };
  const updateGo = () => {
    go.disabled = !chosen.size;
    go.textContent = chosen.size > 1 ? `Criar grupo (${chosen.size + 1})` : 'Conversar';
  };
  search.oninput = paint;
  content.append(h('p', 'muted small', 'Escolha amigos ou gente dos seus servidores; várias pessoas viram um grupo (até 10 com você).'), search, list);
  const modal = openModal({ title: 'Nova conversa', content, actions: [go] });
  go.onclick = () => { modal.close(); startDm([...chosen]); };
  paint();
  updateGo();
  setTimeout(() => search.focus(), 0);
}

