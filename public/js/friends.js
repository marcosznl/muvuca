// Amigos (como no Discord): página com abas Online / Todos / Pendentes / Adicionar amigo,
// aberta pelo item "Amigos" no topo das mensagens diretas. A lista chega pronta do servidor (evento 'friends').
import { $, h, makeAvatar, showBanner, toast } from './util.js';
import { icon } from './icons.js';
import { state, STATUS_LABEL } from './state.js';
import { request } from './net.js';
import { confirmDialog, contextMenu } from './dialogs.js';
import { startDm, realServers } from './dms.js';
import { openProfileCard } from './profile.js';

let tab = 'online';
let draft = ''; // o que está digitado em "Adicionar amigo" (sobrevive aos redesenhos)
let query = ''; // busca na lista de amigos

export const friendStatus = (userId) => state.friends.find((f) => f.user.id === userId)?.status ?? null;
export const incomingCount = () => state.friends.filter((f) => f.status === 'incoming').length;
const isOnline = (id) => state.online.has(id);

export async function addFriend(target) {
  try {
    const r = await request({ t: 'friend:add', ...target });
    toast(r.status === 'friend' ? `Agora você e ${r.name} são amigos!` : `Pedido de amizade enviado para ${r.name}.`);
    return true;
  } catch (err) {
    showBanner(err.message, { timeout: 4500 });
    return false;
  }
}
const act = (t, userId) => request({ t, userId }).catch((err) => showBanner(err.message, { timeout: 4000 }));

async function unfriend(f) {
  const ok = await confirmDialog({ title: `Remover ${f.user.name}`, message: `Tem certeza que quer desfazer a amizade com ${f.user.name}?`, confirm: 'Remover amigo' });
  if (ok) act('friend:remove', f.user.id);
}

// Segunda linha de cada pessoa: jogo (com o controle), status personalizado ou o status (Ausente, Não perturbe…)
function subline(f) {
  if (f.status === 'incoming') return 'Pedido de amizade recebido';
  if (f.status === 'outgoing') return 'Pedido de amizade enviado';
  const id = f.user.id;
  if (!isOnline(id)) return 'Offline';
  const a = state.activity[id];
  if (a) {
    const game = h('span', 'friend-game');
    game.append(icon('gamepad', 14), a.name);
    return game;
  }
  return f.user.statusText || STATUS_LABEL[state.status[id] ?? 'online'];
}

function roundBtn(name, title, onClick, cls = '') {
  const b = h('button', `friend-act ${cls}`);
  b.type = 'button';
  b.title = title;
  b.append(icon(name, 18));
  b.onclick = (e) => { e.stopPropagation(); onClick(); };
  return b;
}

function row(f) {
  const r = h('div', 'friend-row');
  const avatar = makeAvatar(f.user.name, '', f.user.id);
  avatar.classList.add('with-status', `status-${isOnline(f.user.id) ? state.status[f.user.id] ?? 'online' : 'offline'}`);
  const info = h('div', 'friend-info');
  const name = h('div', 'friend-name', f.user.name);
  name.append(h('span', 'friend-user', ` @${f.user.username}`)); // aparece ao passar o mouse
  info.append(name, h('div', 'friend-sub', subline(f)));
  const acts = h('div', 'friend-acts');
  if (f.status === 'friend') {
    acts.append(roundBtn('chat', 'Enviar mensagem', () => startDm([f.user.id])),
      roundBtn('dots-vertical', 'Mais', () => {
        const b = acts.lastElementChild.getBoundingClientRect();
        contextMenu(b.left, b.bottom + 4, [
          { label: 'Ver perfil', icon: 'friends', onClick: () => openProfileCard(f.user.id, b.left, b.top) },
          { label: 'Enviar mensagem', icon: 'chat', onClick: () => startDm([f.user.id]) },
          'sep',
          { label: 'Remover amigo', icon: 'close', danger: true, onClick: () => unfriend(f) },
        ]);
      }));
    r.onclick = () => startDm([f.user.id]);
  } else if (f.status === 'incoming') {
    acts.append(roundBtn('check', 'Aceitar', () => act('friend:accept', f.user.id), 'ok'),
      roundBtn('close', 'Recusar', () => act('friend:remove', f.user.id), 'danger'));
  } else {
    acts.append(roundBtn('close', 'Cancelar pedido', () => act('friend:remove', f.user.id), 'danger'));
  }
  r.oncontextmenu = (e) => { e.preventDefault(); openProfileCard(f.user.id, e.clientX, e.clientY); };
  r.append(avatar, info, acts);
  return r;
}

function addPanel(box) {
  box.append(h('div', 'friends-add-title', 'Adicionar amigo'),
    h('p', 'muted', 'Você pode adicionar amigos pelo nome de usuário deles (o @, não o nome de exibição).'));
  const form = h('form', 'friends-add-form');
  const input = h('input');
  Object.assign(input, { placeholder: 'Digite o nome de usuário, ex.: @marcos', autocomplete: 'off', spellcheck: false, maxLength: 40 });
  const go = h('button', 'btn primary', 'Enviar pedido de amizade');
  go.disabled = true;
  input.value = draft;
  go.disabled = !draft.trim();
  input.oninput = () => { draft = input.value; go.disabled = !input.value.trim(); };
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (await addFriend({ username: input.value.trim() })) { draft = ''; renderFriendsView(); }
  };
  form.append(input, go);
  box.append(form);
  setTimeout(() => input.focus(), 0);
  // Sugestões: gente dos seus servidores que ainda não é amiga
  const known = new Set(state.friends.map((f) => f.user.id));
  const people = new Map();
  for (const s of realServers()) for (const m of s.members) if (m.id !== state.me.id && !known.has(m.id)) people.set(m.id, m);
  if (!people.size) return;
  box.append(h('div', 'friends-section', `Pessoas dos seus servidores — ${people.size}`));
  for (const m of [...people.values()].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))) {
    const r = h('div', 'friend-row');
    const info = h('div', 'friend-info');
    const name = h('div', 'friend-name', m.name);
    name.append(h('span', 'friend-user', ` @${m.username}`));
    info.append(name);
    const acts = h('div', 'friend-acts always');
    acts.append(roundBtn('user-plus', 'Adicionar amigo', () => addFriend({ userId: m.id }), 'ok'));
    r.append(makeAvatar(m.name, '', m.id), info, acts);
    box.append(r);
  }
}

// presenceOnly: só mudou quem está online; na aba de adicionar não redesenha (não tira o foco do campo)
export function renderFriendsView(presenceOnly = false) {
  const view = $('friends-view');
  if (!view || view.hidden || (presenceOnly && tab === 'add')) return;
  const typing = tab === 'add' && view.contains(document.activeElement);
  const searching = document.activeElement?.closest?.('.friends-search') && view.contains(document.activeElement);
  const caret = searching ? document.activeElement.selectionStart : null;
  const pending = incomingCount();
  // Topo como no Discord: "Amigos" com o ícone, as abas e o "Adicionar amigo" em destaque
  const bar = h('div', 'friends-tabs');
  const title = h('div', 'friends-title');
  title.append(icon('friends', 22), h('span', '', 'Amigos'));
  bar.append(title, h('span', 'friends-dot'));
  const tabs = [['online', 'Disponível'], ['all', 'Todos'], ['pending', 'Pendente'], ['add', 'Adicionar amigo']];
  for (const [id, label] of tabs) {
    const b = h('button', `friends-tab${id === 'add' ? ' add' : ''}${tab === id ? ' on' : ''}`, label);
    if (id === 'pending' && pending) b.append(h('span', 'badge', String(pending)));
    b.onclick = () => { tab = id; renderFriendsView(); };
    bar.append(b);
  }
  const body = h('div', 'friends-body');
  if (tab === 'add') addPanel(body);
  else {
    const byName = (a, b) => a.user.name.localeCompare(b.user.name, 'pt-BR');
    let list = state.friends.filter((f) => (tab === 'pending' ? f.status !== 'friend' : f.status === 'friend'));
    if (tab === 'online') list = list.filter((f) => isOnline(f.user.id));
    // Busca (nome ou @usuário)
    const search = h('label', 'friends-search');
    const input = h('input');
    Object.assign(input, { type: 'search', placeholder: 'Buscar', value: query, autocomplete: 'off', spellcheck: false });
    input.setAttribute('aria-label', 'Buscar amigos');
    input.oninput = () => { query = input.value; renderFriendsView(); };
    search.append(icon('search', 18), input);
    body.append(search);
    const q = query.trim().toLowerCase().replace(/^@/, '');
    if (q) list = list.filter((f) => f.user.name.toLowerCase().includes(q) || f.user.username.toLowerCase().includes(q));
    list.sort((a, b) => (a.status === 'incoming' ? -1 : 0) - (b.status === 'incoming' ? -1 : 0) || byName(a, b));
    const heading = { online: 'Online', all: 'Todos os amigos', pending: 'Pendentes' }[tab];
    body.append(h('div', 'friends-section', `${heading} — ${list.length}`));
    for (const f of list) body.append(row(f));
    if (!list.length) {
      const empty = h('div', 'friends-empty');
      empty.append(h('p', 'muted', q ? 'Ninguém com esse nome.' : tab === 'pending' ? 'Nenhum pedido de amizade por aqui.'
          : tab === 'online' ? 'Nenhum amigo online agora.' : 'Você ainda não tem amigos adicionados.'));
      if (tab !== 'pending' && !q) {
        const b = h('button', 'btn primary', 'Adicionar amigo');
        b.onclick = () => { tab = 'add'; renderFriendsView(); };
        empty.append(b);
      }
      body.append(empty);
    }
  }
  view.replaceChildren(bar, body);
  if (typing) view.querySelector('.friends-add-form input')?.focus();
  if (searching) { const i = view.querySelector('.friends-search input'); i?.focus(); i?.setSelectionRange(caret, caret); } // continua digitando
}

