// Perfil: editor (foto, banner com imagem/GIF ou cor, nome, "Sobre mim") e o cartão que aparece ao clicar em alguém
import { h, hue, makeAvatar, showBanner, toast } from './util.js';
import { startDm } from './dms.js';
import { friendStatus, addFriend } from './friends.js';
import { selectGames } from './app.js';
import { enterRoom } from './games.js';
import { state, serverById, permsIn, PERMS, profileOf, statusOf } from './state.js';
import { can, topPosition, nameColor } from './permissions.js';
import { request, upload, api, send } from './net.js';
import { openModal, button, contextMenu, promptText } from './dialogs.js';
import { icon } from './icons.js';
import { colorPicker, kickMember, transferOwnership, canTransfer, openMemberRoles, canManageMember, myTop } from './settings.js';

const BIO_MAX = 190;

// ---------- Imagens (foto de perfil e ícone do servidor) ----------

// Fotos comuns: recorta o centro em quadrado e reduz para 256 px (fica leve e redonda sem distorcer).
// GIF vai como está, para continuar animado.
export async function prepareImage(file) {
  if (file.type === 'image/gif') {
    if (file.size > 2 * 1024 * 1024) throw new Error('O GIF deve ter no máximo 2 MB.');
    return file;
  }
  const bitmap = await createImageBitmap(file).catch(() => { throw new Error('Não consegui abrir essa imagem.'); });
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = Math.min(256, side);
  canvas.getContext('2d').drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.9));
}

// Banner: recorta o centro na proporção do cartão (17:6) e reduz para 1020 px de largura.
// GIF vai como está (até 10 MB), para continuar animado.
const BANNER_RATIO = 17 / 6;
async function prepareBanner(file) {
  if (file.type === 'image/gif') {
    if (file.size > 10 * 1024 * 1024) throw new Error('O GIF do banner deve ter no máximo 10 MB.');
    return file;
  }
  const bitmap = await createImageBitmap(file).catch(() => { throw new Error('Não consegui abrir essa imagem.'); });
  let sw = bitmap.width;
  let sh = Math.round(sw / BANNER_RATIO);
  if (sh > bitmap.height) { sh = bitmap.height; sw = Math.round(sh * BANNER_RATIO); }
  const canvas = document.createElement('canvas');
  canvas.width = Math.min(1020, sw);
  canvas.height = Math.round(canvas.width / BANNER_RATIO);
  canvas.getContext('2d').drawImage(bitmap, (bitmap.width - sw) / 2, (bitmap.height - sh) / 2, sw, sh, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.9));
}

// Abre o seletor de arquivo e entrega a imagem já preparada
export function pickImage(onPicked, prepare = prepareImage) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/png,image/jpeg,image/gif,image/webp';
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    try { await onPicked(await prepare(file)); } catch (err) { showBanner(err.message, { timeout: 4500 }); }
  };
  input.click();
}

// ---------- Cartão de perfil ----------

// Sem cor escolhida, o banner usa a cor da pessoa (a mesma da inicial)
const bannerColor = (p) => p.banner || `hsl(${hue(p.name)} 45% 38%)`;
const fmtDate = (ts) => new Date(ts).toLocaleDateString('pt-BR', { day: 'numeric', month: 'short', year: 'numeric' });

// Monta o cartão (usado no clique em alguém e na prévia do editor)
function profileCard(p, { server = null, preview = false, editRoles = false, selfCard = false } = {}) {
  const card = h('div', 'profile-card');
  const banner = h('div', p.bannerImage ? 'profile-banner with-image' : 'profile-banner');
  banner.style.background = bannerColor(p);
  if (p.bannerImage) banner.style.backgroundImage = `url("/img/${p.bannerImage}")`;
  const avatar = makeAvatar(p.name, 'xl', preview ? null : p.id);
  if (preview && p.avatar) { // na prévia, a foto vem do rascunho
    avatar.classList.add('photo');
    avatar.textContent = '';
    avatar.style.backgroundImage = `url("/img/${p.avatar}")`;
  }
  avatar.classList.add('profile-card-avatar');
  if (!preview) { // bolinha de status na foto (verde, lua, não perturbe; offline sem bolinha)
    const st = statusOf(p.id);
    if (st && st !== 'offline') avatar.classList.add('with-status', `status-${st}`);
  }
  const body = h('div', 'profile-card-body');
  const name = h('div', 'profile-card-name', p.name || '…');
  const color = server && nameColor(server, p.id);
  if (color) name.style.color = color;
  // Com apelido no servidor: embaixo aparecem o nome da conta e o @
  body.append(name, h('div', 'muted', p.nick && p.globalName && p.globalName !== p.nick ? `${p.globalName} · @${p.username}` : `@${p.username}`));
  // Balão de pensamento (o status personalizado) ao lado da foto; no seu cartão dá para escrever nele
  if (!preview && (p.statusText || (selfCard && p.id === state.me?.id))) card.append(thoughtBubble(p, selfCard));

  const section = (title, content) => {
    const box = h('div', 'profile-card-section');
    box.append(h('div', 'profile-card-title', title), content);
    body.append(box);
  };
  if (p.bio) section('Sobre mim', h('div', 'profile-card-bio', p.bio));
  // XP da conta (o mesmo em todos os servidores)
  if (p.xp && !preview) {
    const x = p.xp;
    const fmt = (n) => n.toLocaleString('pt-BR');
    const fill = h('div');
    fill.style.width = `${Math.round((x.into / x.need) * 100)}%`;
    const bar = h('div', 'xp-bar');
    bar.append(fill);
    const head = h('div', 'xp-level');
    head.append(h('b', '', `Nível ${x.level}`), h('span', 'muted small', `${fmt(x.total)} XP${p.id === state.me?.id && state.me.xpRank ? ` · #${state.me.xpRank} no Muvuca` : ''}`));
    const box = h('div');
    box.append(head, bar, h('div', 'muted small', `${fmt(x.into)} / ${fmt(x.need)} XP para o nível ${x.level + 1}`));
    section('Nível', box);
  }
  if (server && p.joinedAt) section(`Membro de ${server.name} desde`, h('div', 'small', fmtDate(p.joinedAt)));
  if (server) {
    const chips = roleChips(server, p, { editable: editRoles });
    if (chips) section('Cargos', chips);
  }
  card.prepend(banner, avatar);
  card.append(body);
  return { card, body };
}

const BUBBLE_MAX = 60;
function thoughtBubble(p, editable) {
  const bubble = h('div', p.statusText ? 'thought-bubble' : 'thought-bubble empty');
  const show = () => {
    bubble.replaceChildren();
    if (p.statusText) bubble.append(h('span', 'thought-text', p.statusText));
    else bubble.append(icon('plus', 14), h('span', 'thought-text', 'No que você está pensando?'));
    bubble.title = editable ? 'Clique para mudar (aparece para todo mundo)' : p.statusText;
  };
  show();
  if (!editable) return bubble;
  bubble.classList.add('editable');
  bubble.tabIndex = 0;
  bubble.setAttribute('role', 'button');
  const edit = () => {
    if (bubble.querySelector('input')) return;
    const input = h('input');
    Object.assign(input, { value: p.statusText ?? '', maxLength: BUBBLE_MAX, placeholder: 'No que você está pensando?' });
    input.setAttribute('aria-label', 'Balão de pensamento');
    bubble.classList.remove('empty');
    bubble.replaceChildren(input);
    input.focus();
    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      const text = input.value.replace(/\s+/g, ' ').trim();
      if (save && text !== (p.statusText ?? '')) {
        try {
          await request({ t: 'status:text', text });
          p.statusText = text || null;
        } catch (err) { showBanner(err.message, { timeout: 4000 }); }
      }
      bubble.classList.toggle('empty', !p.statusText);
      show();
    };
    input.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
    };
    input.onblur = () => finish(true);
  };
  bubble.onclick = edit;
  bubble.onkeydown = (e) => { if (e.key === 'Enter' && e.target === bubble) edit(); };
  return bubble;
}

// Cargos como etiquetas (cor + nome). Quem gerencia cargos tira no × e põe no + (só os abaixo do seu)
function roleChips(server, p, { editable = false } = {}) {
  let current = [...(p.roles ?? [])];
  const top = editable ? myTop(server) : 0;
  const chips = h('div', 'role-chips');
  const save = async (next) => {
    const before = current;
    current = next;
    paint();
    try {
      await request({ t: 'member:roles', serverId: server.id, userId: p.id, roleIds: next });
    } catch (err) {
      current = before;
      paint();
      showBanner(err.message, { timeout: 4000 });
    }
  };
  const paint = () => {
    chips.replaceChildren();
    const mine = server.roles.filter((r) => !r.isDefault && current.includes(r.id)).sort((a, b) => b.position - a.position);
    for (const r of mine) {
      const chip = h('span', 'role-chip');
      const dot = h('span', 'role-dot');
      dot.style.background = r.color || '#99aab5';
      chip.append(dot, r.name);
      if (editable && r.position < top) {
        const x = h('button', 'role-x');
        x.type = 'button';
        x.title = `Tirar o cargo ${r.name}`;
        x.append(icon('close', 12));
        x.onclick = () => save(current.filter((id) => id !== r.id));
        chip.append(x);
      }
      chips.append(chip);
    }
    const addable = editable ? server.roles.filter((r) => !r.isDefault && !current.includes(r.id) && r.position < top).sort((a, b) => b.position - a.position) : [];
    if (addable.length) {
      const add = h('button', 'role-chip role-add');
      add.type = 'button';
      add.title = 'Dar um cargo';
      add.append(icon('plus', 14));
      add.onclick = (e) => {
        const r0 = e.currentTarget.getBoundingClientRect();
        contextMenu(r0.left, r0.bottom + 4, addable.map((r) => ({ label: r.name, onClick: () => save([...current, r.id]) })));
      };
      chips.append(add);
    }
  };
  paint();
  return chips.children.length ? chips : null;
}

// Mensagem direta sem sair do cartão: abre (ou cria) a conversa, manda o texto e vai para ela
async function sendDmTo(userId, text) {
  await request({ t: 'dm:open', userIds: [userId] });
  const findDm = () => state.servers.find((x) => x.kind === 'dm' && x.members.length === 2 && x.members.some((m) => m.id === userId));
  for (let i = 0; i < 40 && !findDm(); i++) await new Promise((r) => setTimeout(r, 50));
  const channel = findDm()?.channels.find((c) => c.type === 'text');
  if (!channel) throw new Error('Não consegui abrir a conversa.');
  send({ t: 'msg', channel: channel.id, text });
}

// Botão redondo do topo do cartão (em cima do banner)
function cardIcon(name, title, onClick, { text = null, on = false } = {}) {
  const b = h('button', on ? 'profile-icon-btn on' : 'profile-icon-btn');
  b.type = 'button';
  b.title = title;
  b.setAttribute('aria-label', title);
  if (text) b.append(h('span', 'profile-icon-text', text));
  else b.append(icon(name, 18));
  b.onclick = (e) => { e.stopPropagation(); onClick(e); };
  return b;
}

let openCard = null;
let cardObserver = null;
let openCardCleanup = null;
export function closeProfileCard() {
  openCardCleanup?.();
  openCardCleanup = null;
  cardObserver?.disconnect(); // para de acompanhar o tamanho do cartão fechado
  cardObserver = null;
  openCard?.remove();
  openCard = null;
  document.removeEventListener('mousedown', outsideCard, true);
}
// Clique fora fecha; o menu que o próprio cartão abriu ("…", + dos cargos) não conta como fora
function outsideCard(e) {
  if (!openCard || openCard.contains(e.target) || e.target.closest?.('.context-menu, .status-submenu')) return;
  if (openCard.classList.contains('me-popout') && e.target.closest?.('#me-avatar, #me-name')) return; // o clique na foto fecha (sem reabrir)
  closeProfileCard();
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeProfileCard(); });

// Clique em alguém (lista de membros, nome ou foto no chat): mostra o perfil perto do clique
export function openProfileCard(userId, x, y, serverId = state.view.serverId) {
  closeProfileCard();
  const s = serverById(serverId);
  const p = profileOf(userId, s);
  if (!p) return;
  const me = userId === state.me?.id;
  const inServer = s && s.kind !== 'dm';
  const perms = inServer ? permsIn(s) : 0;
  const manageRoles = !me && inServer && can(perms, PERMS.MANAGE_ROLES) && canManageMember(s, p);
  const canKick = !me && inServer && can(perms, PERMS.KICK_MEMBERS) && p.id !== s.ownerId && topPosition(s, p.id) < myTop(s);
  const { card, body } = profileCard(p, { server: s, editRoles: manageRoles, selfCard: me });

  // Ícones no topo (como no Discord): amizade, editar o próprio perfil e o menu "…"
  const top = h('div', 'profile-card-top');
  if (me) {
    top.append(cardIcon('pencil', 'Editar perfil', () => { closeProfileCard(); openProfileEditor(); }));
  } else {
    const fs = friendStatus(userId);
    const label = { friend: 'Vocês são amigos', outgoing: 'Pedido de amizade enviado', incoming: 'Aceitar pedido de amizade' }[fs] ?? 'Adicionar amigo';
    const friend = cardIcon(fs === 'friend' || fs === 'outgoing' ? 'check' : 'user-plus', label, async () => {
      if (fs === 'friend' || fs === 'outgoing') return;
      friend.disabled = true;
      if (fs === 'incoming') await request({ t: 'friend:accept', userId }).catch((err) => showBanner(err.message, { timeout: 4000 }));
      else if (await addFriend({ userId })) { friend.replaceChildren(icon('check', 18)); friend.title = 'Pedido de amizade enviado'; return; }
      friend.disabled = false;
    }, { on: fs === 'incoming' });
    if (fs === 'friend' || fs === 'outgoing') friend.classList.add('done');
    top.append(friend);
  }
  const canNick = inServer && can(perms, PERMS.MANAGE_NICKNAMES)
    && (me || (p.id !== s.ownerId && topPosition(s, p.id) < myTop(s)));
  const more = [
    canNick && { label: p.nick ? 'Mudar apelido' : 'Dar apelido', icon: 'pencil', onClick: () => { closeProfileCard(); editNick(s, p); } },
    manageRoles && { label: 'Gerenciar cargos', icon: 'shield', onClick: () => { closeProfileCard(); openMemberRoles(s.id, p.id); } },
    { label: 'Copiar nome de usuário', icon: 'link', onClick: () => navigator.clipboard?.writeText(`@${p.username}`).then(() => toast('Copiado!')).catch(() => {}) },
    canKick && 'sep',
    canKick && { label: `Expulsar ${p.name}`, icon: 'door-out', danger: true, onClick: () => { closeProfileCard(); kickMember(s, p); } },
    inServer && canTransfer(s, p) && !canKick && 'sep',
    inServer && canTransfer(s, p) && { label: 'Transferir posse', icon: 'crown', danger: true, onClick: () => { closeProfileCard(); transferOwnership(s, p); } },
  ].filter(Boolean);
  top.append(cardIcon(null, 'Mais opções', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    contextMenu(r.left, r.bottom + 4, more);
  }, { text: '⋯' }));
  card.append(top);

  // Jogando agora + números e conquistas nos jogos (chega um instante depois)
  const act = state.activity[userId];
  if (act) {
    const play = h('div', 'profile-playing');
    const join = button('Entrar na sala', { kind: 'secondary' });
    join.onclick = () => { closeProfileCard(); selectGames(); enterRoom(act.roomId); };
    const what = h('span', '', 'Jogando ');
    what.append(h('strong', '', act.name));
    play.append(what, join);
    body.append(play);
  }
  const games = h('div', 'profile-games');
  body.append(games);
  request({ t: 'games:stats', userId }).then((st) => {
    const wins = st.byGame.reduce((n, g) => n + g.wins, 0);
    const played = st.byGame.reduce((n, g) => n + g.played, 0);
    if (!played) return;
    games.append(h('div', 'profile-card-title', 'Jogos'), h('div', 'small', `${wins} ${wins === 1 ? 'vitória' : 'vitórias'} em ${played} ${played === 1 ? 'partida' : 'partidas'}`));
    const got = st.achievements.filter((a) => a.got);
    if (got.length) {
      const badges = h('div', 'achievements');
      for (const a of got) { const b = h('span', 'achievement', `${a.emoji} ${a.title}`); b.title = a.desc; badges.append(b); }
      games.append(badges);
    }
  }).catch(() => {});

  // Conversar direto: escreve aqui e a mensagem vai para a conversa privada (e abre ela)
  if (!me) {
    const form = h('form', 'profile-dm');
    const input = h('input');
    Object.assign(input, { type: 'text', placeholder: `Conversar com @${p.username}`, maxLength: 2000, autocomplete: 'off' });
    input.setAttribute('aria-label', `Mensagem para ${p.name}`);
    form.append(input);
    form.onsubmit = async (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) { closeProfileCard(); return startDm([userId]); }
      input.disabled = true;
      try {
        await sendDmTo(userId, text);
        closeProfileCard();
      } catch (err) {
        input.disabled = false;
        showBanner(err.message, { timeout: 4000 });
      }
    };
    body.append(form);
  }

  card.classList.add('floating');
  document.getElementById('overlay-layer').append(card);
  // Fica dentro da tela, ao lado do clique. Mede de novo depois da animação de abrir e quando os jogos
  // chegam (o cartão cresce): sem isso, aberto perto do rodapé ele ficava cortado
  const place = () => {
    if (!card.isConnected) return;
    const w = card.offsetWidth;
    const hgt = card.offsetHeight;
    const left = x + w + 16 > innerWidth ? x - w - 16 : x + 16;
    card.style.left = `${Math.max(8, Math.min(left, innerWidth - w - 8))}px`;
    card.style.top = `${Math.max(8, Math.min(y - 60, innerHeight - hgt - 8))}px`;
  };
  place();
  setTimeout(place, 250);
  cardObserver?.disconnect();
  cardObserver = new ResizeObserver(place);
  cardObserver.observe(card);
  openCard = card;
  setTimeout(() => document.addEventListener('mousedown', outsideCard, true), 0);
}

// Apelido no servidor (moderação): vazio volta ao nome da conta
async function editNick(s, p) {
  const nick = await promptText({
    title: `Apelido de ${p.globalName ?? p.name}`, subtitle: `Como ${p.id === state.me?.id ? 'você aparece' : 'essa pessoa aparece'} em ${s.name}. Deixe vazio para voltar ao nome da conta.`,
    label: 'Apelido', value: p.nick ?? '', placeholder: p.globalName ?? p.name, confirm: 'Salvar', maxLength: 32, allowEmpty: true,
  });
  if (nick === null || nick === undefined) return;
  request({ t: 'member:nick', serverId: s.id, userId: p.id, nick })
    .then(() => toast(nick.trim() ? 'Apelido salvo.' : 'Apelido removido.'))
    .catch((err) => showBanner(err.message, { timeout: 4000 }));
}

// ---------- Você (clique na sua foto lá embaixo) ----------
// Seu cartão com o balão de pensamento e, embaixo, os atalhos: editar perfil, status e mais opções
const PRESENCE_INFO = {
  online: { label: 'Disponível' },
  idle: { label: 'Ausente', desc: 'Aparece com a lua para os outros' },
  dnd: { label: 'Não perturbe', desc: 'Sem sons e sem notificações' },
  invisible: { label: 'Invisível', desc: 'Você aparece offline' },
};
export function openMePopout(anchor, { onMore, onSettings }) {
  if (openCard?.classList.contains('me-popout')) return closeProfileCard(); // clicar de novo na foto fecha
  closeProfileCard();
  const me = state.me;
  const p = profileOf(me.id, null) ?? me;
  const { card, body } = profileCard({ ...p, statusText: me.statusText }, { selfCard: true });
  card.classList.add('me-popout');

  const row = (iconName, label, onClick, { chevron = false, dot = null } = {}) => {
    const b = h('button', 'me-row');
    b.type = 'button';
    if (dot) b.append(h('span', `me-dot status-${dot}`));
    else b.append(icon(iconName, 18));
    b.append(h('span', 'me-row-label', label));
    if (chevron) b.append(h('span', 'me-chevron', '›'));
    b.onclick = (e) => { e.stopPropagation(); onClick(b); };
    return b;
  };
  const presence = me.presence ?? 'online';
  let sub = null;
  const closeSub = () => { sub?.remove(); sub = null; };
  const statusRow = row(null, PRESENCE_INFO[presence].label, (b) => {
    if (sub) return closeSub();
    sub = h('div', 'status-submenu');
    for (const key of ['online', 'idle', 'dnd', 'invisible']) {
      const item = h('button', key === presence ? 'status-item on' : 'status-item');
      item.type = 'button';
      const text = h('span', 'status-item-text');
      text.append(h('span', 'status-item-label', PRESENCE_INFO[key].label));
      if (PRESENCE_INFO[key].desc) text.append(h('span', 'status-item-desc', PRESENCE_INFO[key].desc));
      item.append(h('span', `me-dot status-${key}`), text);
      item.onclick = () => {
        request({ t: 'presence:set', presence: key }).catch((err) => showBanner(err.message, { timeout: 4000 }));
        closeProfileCard();
      };
      sub.append(item);
      if (key === 'online') sub.append(h('div', 'menu-sep'));
    }
    document.getElementById('overlay-layer').append(sub);
    const r = b.getBoundingClientRect();
    const w = sub.offsetWidth;
    sub.style.left = `${r.right + 8 + w > innerWidth ? Math.max(8, r.left - w - 8) : r.right + 8}px`;
    sub.style.top = `${Math.max(8, Math.min(r.top - 8, innerHeight - sub.offsetHeight - 8))}px`;
  }, { chevron: true, dot: presence });

  const group1 = h('div', 'me-group');
  group1.append(
    row('pencil', 'Editar perfil', () => { closeProfileCard(); openProfileEditor(); }),
    h('div', 'me-sep'),
    statusRow,
  );
  const group2 = h('div', 'me-group');
  group2.append(
    row('settings', 'Configurações', () => { closeProfileCard(); onSettings(); }),
    h('div', 'me-sep'),
    row('menu', 'Mais opções', (b) => { const r = b.getBoundingClientRect(); closeSub(); onMore(r.right + 8, r.top); }, { chevron: true }),
    h('div', 'me-sep'),
    row('link', 'Copiar nome de usuário', () => navigator.clipboard?.writeText(`@${me.username}`).then(() => toast('Copiado!')).catch(() => {})),
  );
  body.append(group1, group2);

  card.classList.add('floating');
  document.getElementById('overlay-layer').append(card);
  const place = () => {
    if (!card.isConnected) return;
    card.style.left = `${Math.max(8, Math.min(anchor.left - 4, innerWidth - card.offsetWidth - 8))}px`;
    card.style.top = `${Math.max(8, anchor.top - card.offsetHeight - 8)}px`;
  };
  place();
  cardObserver?.disconnect();
  cardObserver = new ResizeObserver(place);
  cardObserver.observe(card);
  openCard = card;
  openCardCleanup = closeSub;
  setTimeout(() => document.addEventListener('mousedown', outsideCard, true), 0);
}

// ---------- Trocar senha ----------
// Pede a atual (confere no servidor), a nova duas vezes; os outros aparelhos da conta saem na hora
export function openChangePassword() {
  const form = h('form', 'form');
  const field = (label, autocomplete) => {
    const f = h('label', 'field');
    const input = h('input');
    Object.assign(input, { type: 'password', autocomplete, maxLength: 200, required: true });
    f.append(h('span', 'field-label', label), input);
    form.append(f);
    return input;
  };
  const current = field('Senha atual', 'current-password');
  const next = field('Senha nova', 'new-password');
  const again = field('Repita a senha nova', 'new-password');
  const hint = h('p', 'muted small', 'Pelo menos 6 caracteres. Os outros aparelhos conectados na sua conta vão precisar entrar de novo.');
  const error = h('p', 'error small');
  form.append(hint, error);
  const save = button('Trocar senha');
  const cancel = button('Cancelar', { kind: 'link' });
  const modal = openModal({ title: 'Trocar senha', content: form, actions: [cancel, save] });
  cancel.onclick = () => modal.close();
  const submit = async (e) => {
    e?.preventDefault();
    error.textContent = '';
    if (!current.value) return current.focus();
    if (next.value.length < 6) { error.textContent = 'A senha nova precisa ter pelo menos 6 caracteres.'; return next.focus(); }
    if (next.value !== again.value) { error.textContent = 'As duas senhas novas não são iguais.'; return again.focus(); }
    if (next.value === current.value) { error.textContent = 'A senha nova precisa ser diferente da atual.'; return next.focus(); }
    save.disabled = true;
    try {
      const r = await api('/api/password', { current: current.value, password: next.value });
      modal.close();
      toast(r.others ? `Senha trocada! ${r.others} ${r.others === 1 ? 'outro aparelho saiu' : 'outros aparelhos saíram'} da sua conta.` : 'Senha trocada!');
    } catch (err) {
      error.textContent = err.message;
      if (/atual/.test(err.message)) { current.value = ''; current.focus(); }
    } finally { save.disabled = false; }
  };
  form.onsubmit = submit;
  save.onclick = submit;
  setTimeout(() => current.focus(), 0);
}

// ---------- Editor de perfil ----------

export function openProfileEditor() {
  if (!state.me) return;
  closeProfileCard();
  const draft = { ...state.me };
  const layout = h('div', 'profile-editor');
  const form = h('div', 'form profile-form');
  const previewBox = h('div', 'profile-preview');
  layout.append(form, previewBox);

  const paintPreview = () => {
    previewBox.replaceChildren(h('div', 'field-label', 'Prévia'), profileCard(draft, { preview: true }).card);
    removePhoto.hidden = !draft.avatar;
    removeBanner.hidden = !draft.bannerImage;
  };

  // Foto (troca na hora, como no Discord)
  const photoField = h('div', 'field');
  const photoBtns = h('div', 'profile-buttons');
  const changePhoto = button('Trocar foto', { kind: 'secondary' });
  const removePhoto = button('Remover foto', { kind: 'link' });
  photoBtns.append(changePhoto, removePhoto);
  photoField.append(h('span', 'field-label', 'Foto de perfil'), photoBtns,
    h('p', 'muted small', 'PNG, JPG, WEBP ou GIF (GIF fica animado, até 2 MB). A foto é recortada em quadrado.'));
  changePhoto.onclick = () => pickImage(async (file) => {
    changePhoto.disabled = true;
    try {
      const res = await upload('/api/image', { for: 'avatar' }, file);
      draft.avatar = state.me.avatar = res.id;
      paintPreview();
    } finally { changePhoto.disabled = false; }
  });
  removePhoto.onclick = async () => {
    try {
      await request({ t: 'avatar:remove' });
      draft.avatar = state.me.avatar = null;
      paintPreview();
    } catch (err) { showBanner(err.message, { timeout: 4000 }); }
  };

  // Nome de exibição
  const nameField = h('label', 'field');
  const name = h('input');
  Object.assign(name, { value: draft.name, maxLength: 32 });
  name.oninput = () => { draft.name = name.value.trim(); paintPreview(); };
  nameField.append(h('span', 'field-label', 'Nome de exibição'), name,
    h('span', 'muted small', `Seu usuário continua @${draft.username} (é com ele que você entra).`));

  // Banner: imagem ou GIF (troca na hora, como a foto); a cor aparece quando não há imagem
  const bannerField = h('div', 'field');
  const bannerBtns = h('div', 'profile-buttons');
  const changeBanner = button('Trocar banner', { kind: 'secondary' });
  const removeBanner = button('Remover banner', { kind: 'link' });
  bannerBtns.append(changeBanner, removeBanner);
  const picker = colorPicker(draft.banner, { allowNone: true });
  const onColor = () => { draft.banner = picker.value; paintPreview(); };
  picker.el.addEventListener('click', onColor);
  picker.el.addEventListener('input', onColor);
  bannerField.append(h('span', 'field-label', 'Banner'), bannerBtns,
    h('p', 'muted small', 'PNG, JPG, WEBP ou GIF animado (até 10 MB). Tamanho ideal: 1020×360.'),
    h('span', 'field-label profile-sub-label', 'Cor do banner (aparece sem imagem)'), picker.el);
  changeBanner.onclick = () => pickImage(async (file) => {
    changeBanner.disabled = true;
    try {
      const res = await upload('/api/image', { for: 'banner' }, file);
      draft.bannerImage = state.me.bannerImage = res.id;
      paintPreview();
    } finally { changeBanner.disabled = false; }
  }, prepareBanner);
  removeBanner.onclick = async () => {
    try {
      await request({ t: 'banner:remove' });
      draft.bannerImage = state.me.bannerImage = null;
      paintPreview();
    } catch (err) { showBanner(err.message, { timeout: 4000 }); }
  };

  // Sobre mim
  const bioField = h('label', 'field');
  const bio = h('textarea', 'profile-bio-input');
  Object.assign(bio, { value: draft.bio ?? '', maxLength: BIO_MAX, rows: 4, placeholder: 'Conte um pouco sobre você' });
  const counter = h('span', 'muted small bio-counter');
  const count = () => { counter.textContent = `${bio.value.length}/${BIO_MAX}`; };
  bio.oninput = () => { draft.bio = bio.value; count(); paintPreview(); };
  count();
  bioField.append(h('span', 'field-label', 'Sobre mim'), bio, counter);

  form.append(photoField, nameField, bannerField, bioField);
  paintPreview();

  const save = button('Salvar');
  const cancel = button('Cancelar', { kind: 'link' });
  const modal = openModal({ title: 'Editar perfil', content: layout, actions: [cancel, save], wide: true });
  cancel.onclick = () => modal.close();
  save.onclick = async () => {
    if (!name.value.trim()) return name.focus();
    save.disabled = true;
    try {
      await request({ t: 'profile:update', name: name.value.trim(), bio: bio.value, banner: picker.value ?? '' });
      modal.close();
      toast('Perfil atualizado!');
    } catch (err) {
      showBanner(err.message, { timeout: 4000 });
    } finally { save.disabled = false; }
  };
}

