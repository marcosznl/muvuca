// Perfil: editor (foto, banner com imagem/GIF ou cor, nome, "Sobre mim") e o cartão que aparece ao clicar em alguém
import { h, hue, makeAvatar, showBanner, toast } from './util.js';
import { startDm } from './dms.js';
import { friendStatus, addFriend } from './friends.js';
import { selectGames } from './app.js';
import { enterRoom } from './games.js';
import { state, serverById, permsIn, PERMS, profileOf } from './state.js';
import { can, topPosition, nameColor } from './permissions.js';
import { request, upload, api } from './net.js';
import { openModal, button } from './dialogs.js';
import { colorPicker, kickMember, openMemberRoles, canManageMember, myTop } from './settings.js';

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
// GIF vai como está (até 5 MB), para continuar animado.
const BANNER_RATIO = 17 / 6;
async function prepareBanner(file) {
  if (file.type === 'image/gif') {
    if (file.size > 5 * 1024 * 1024) throw new Error('O GIF do banner deve ter no máximo 5 MB.');
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
function profileCard(p, { server = null, preview = false } = {}) {
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
  const body = h('div', 'profile-card-body');
  const name = h('div', 'profile-card-name', p.name || '…');
  const color = server && nameColor(server, p.id);
  if (color) name.style.color = color;
  body.append(name, h('div', 'muted', `@${p.username}`));
  if (p.statusText && !preview) body.append(h('div', 'profile-card-status', p.statusText));

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
    const roles = server.roles.filter((r) => !r.isDefault && p.roles?.includes(r.id)).sort((a, b) => b.position - a.position);
    if (roles.length) {
      const chips = h('div', 'role-chips');
      for (const r of roles) {
        const chip = h('span', 'role-chip');
        const dot = h('span', 'role-dot');
        dot.style.background = r.color || '#99aab5';
        chip.append(dot, r.name);
        chips.append(chip);
      }
      section('Cargos', chips);
    }
  }
  card.append(banner, avatar, body);
  return { card, body };
}

let openCard = null;
export function closeProfileCard() {
  openCard?.remove();
  openCard = null;
  document.removeEventListener('mousedown', outsideCard, true);
}
function outsideCard(e) { if (openCard && !openCard.contains(e.target)) closeProfileCard(); }
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeProfileCard(); });

// Clique em alguém (lista de membros, nome ou foto no chat): mostra o perfil perto do clique
export function openProfileCard(userId, x, y, serverId = state.view.serverId) {
  closeProfileCard();
  const s = serverById(serverId);
  const p = profileOf(userId, s);
  if (!p) return;
  const { card, body } = profileCard(p, { server: s });

  const actions = h('div', 'profile-card-actions');
  if (userId === state.me?.id) {
    const edit = button('Editar perfil', { kind: 'secondary' });
    edit.onclick = () => { closeProfileCard(); openProfileEditor(); };
    actions.append(edit);
  } else {
    // Conversa privada com a pessoa
    const dm = button('Enviar mensagem');
    dm.onclick = () => { closeProfileCard(); startDm([userId]); };
    actions.append(dm);
    // Amizade: adicionar, aceitar ou só mostrar que já são amigos / que o pedido foi enviado
    const fs = friendStatus(userId);
    const friend = button({ friend: 'Amigos ✓', outgoing: 'Pedido enviado', incoming: 'Aceitar amizade' }[fs] ?? 'Adicionar amigo', { kind: fs === 'incoming' ? 'primary' : 'secondary' });
    friend.disabled = fs === 'friend' || fs === 'outgoing';
    friend.onclick = async () => {
      friend.disabled = true;
      if (fs === 'incoming') await request({ t: 'friend:accept', userId }).catch((err) => showBanner(err.message, { timeout: 4000 }));
      else if (await addFriend({ userId })) friend.textContent = 'Pedido enviado';
      else friend.disabled = false;
    };
    actions.append(friend);
  }
  if (userId !== state.me?.id && s && s.kind !== 'dm') {
    const perms = permsIn(s);
    if (can(perms, PERMS.MANAGE_ROLES) && canManageMember(s, p)) {
      const roles = button('Cargos…', { kind: 'secondary' });
      roles.onclick = () => { closeProfileCard(); openMemberRoles(s.id, p.id); };
      actions.append(roles);
    }
    if (can(perms, PERMS.KICK_MEMBERS) && p.id !== s.ownerId && topPosition(s, p.id) < myTop(s)) {
      const kick = button('Expulsar', { kind: 'danger-outline' });
      kick.onclick = () => { closeProfileCard(); kickMember(s, p); };
      actions.append(kick);
    }
  }
  if (actions.children.length) body.append(actions);
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
  new ResizeObserver(place).observe(card);
  openCard = card;
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
    h('p', 'muted small', 'PNG, JPG, WEBP ou GIF animado (até 5 MB). Tamanho ideal: 1020×360.'),
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

