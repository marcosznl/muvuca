// Lista de membros à direita: agrupada pelo cargo mais alto, online em cima e offline embaixo
import { $, h, makeAvatar } from './util.js';
import { icon } from './icons.js';
import { state, currentServer, statusOf, STATUS_LABEL } from './state.js';
import { nameColor } from './permissions.js';
import { openMemberMenu } from './settings.js';
import { openProfileCard } from './profile.js';
import { renderSide } from './music.js';
import { selectGames } from './app.js';
import { enterRoom } from './games.js';

export function renderMembers() {
  const s = currentServer();
  const list = $('member-list');
  // No canal de música, o painel da direita vira a cabine de DJs / fila / ouvintes
  if (s?.channels.find((c) => c.id === state.view.channelId)?.type === 'music') return renderSide(list);
  list.replaceChildren();
  if (!s) return;

  // Onde cada um está na voz (para mostrar "Em Sala 1" / "Ao vivo em Sala 1")
  const whereIs = new Map();
  for (const c of s.channels.filter((x) => x.type === 'voice')) {
    for (const p of state.voice[c.id] ?? []) whereIs.set(p.id, { channel: c.name, streaming: p.streaming });
  }

  const rolesDesc = s.roles.filter((r) => !r.isDefault).sort((a, b) => b.position - a.position);
  const topRole = (m) => rolesDesc.find((r) => m.roles.includes(r.id)) ?? null;
  const byName = (a, b) => a.name.localeCompare(b.name, 'pt-BR');

  const online = s.members.filter((m) => state.online.has(m.id));
  const offline = s.members.filter((m) => !state.online.has(m.id)).sort(byName);

  const groups = [];
  for (const role of rolesDesc) {
    const inRole = online.filter((m) => topRole(m)?.id === role.id).sort(byName);
    if (inRole.length) groups.push([role.name, inRole]);
  }
  const noRole = online.filter((m) => !topRole(m)).sort(byName);
  if (noRole.length) groups.push(['Online', noRole]);
  if (offline.length) groups.push(['Offline', offline, true]);

  for (const [title, members, isOffline] of groups) {
    list.append(h('div', 'category member-group', `${title} — ${members.length}`));
    for (const m of members) list.append(memberRow(s, m, whereIs.get(m.id), isOffline));
  }
}

function memberRow(s, m, where, isOffline) {
  const li = h('li', isOffline ? 'member offline' : 'member');
  const avatar = makeAvatar(m.name, '', m.id);
  const status = statusOf(m.id);
  if (!isOffline) avatar.classList.add('online', `status-${status}`);
  avatar.title = STATUS_LABEL[status];
  const info = h('div', 'info');
  const name = h('div', 'name', m.name + (m.id === state.me?.id ? ' (você)' : ''));
  const color = nameColor(s, m.id);
  if (color) name.style.color = color;
  if (m.id === s.ownerId) {
    const crown = icon('crown', 14);
    crown.classList.add('owner-crown');
    crown.title = 'Dono do servidor';
    name.append(crown);
  }
  info.append(name);
  if (where && !isOffline) {
    const sub = h('div', where.streaming ? 'sub live' : 'sub');
    sub.append(icon(where.streaming ? 'monitor' : 'speaker', 12), ` ${where.streaming ? 'Ao vivo em' : 'Em'} ${where.channel}`);
    info.append(sub);
  } else if (state.activity[m.id] && !isOffline) {
    // "Jogando Tron": clique entra na sala
    const act = state.activity[m.id];
    const sub = h('div', 'sub playing', 'Jogando ');
    sub.append(h('strong', '', act.name));
    sub.title = 'Entrar na sala';
    sub.onclick = (e) => { e.stopPropagation(); selectGames(); enterRoom(act.roomId); };
    info.append(sub);
  } else if (m.statusText && !isOffline) {
    info.append(h('div', 'sub status-text', m.statusText)); // status personalizado
  }
  li.append(avatar, info);
  // Clique abre o perfil (com as ações); o botão direito continua abrindo o menu rápido
  li.onclick = (e) => openProfileCard(m.id, li.getBoundingClientRect().left - 332, e.clientY, s.id); // abre à esquerda da lista
  li.oncontextmenu = (e) => { e.preventDefault(); openMemberMenu(s, m, e.clientX, e.clientY); };
  return li;
}
