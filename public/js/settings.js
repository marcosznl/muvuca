// Configurações do servidor (visão geral, cargos, membros, convites), convites e menu de membro
import { h, makeAvatar, paintServerIcon, showBanner, toast } from './util.js';
import { pickImage } from './profile.js';
import { icon } from './icons.js';
import { state, serverById, permsIn, PERMS } from './state.js';
import { can, topPosition, nameColor, PERM_INFO, ALL_PERMS } from './permissions.js';
import { request, upload } from './net.js';
import { openModal, button, confirmDialog, contextMenu } from './dialogs.js';

const COLORS = ['#5865f2', '#eb459e', '#57f287', '#fee75c', '#ed4245', '#3ba55c', '#faa61a', '#9b59b6', '#1abc9c', '#e67e22', '#95a5a6', '#607d8b'];

const inviteLink = (code) => `${location.origin}/?convite=${code}`;
const fail = (err) => showBanner(err.message, { timeout: 4500 });

// ---------- Convites ----------

const HOUR = 3_600_000;
const EXPIRY = [[HOUR / 2, '30 minutos'], [HOUR, '1 hora'], [24 * HOUR, '1 dia'], [7 * 24 * HOUR, '7 dias'], [null, 'Nunca']];
const USES = [[null, 'Sem limite'], [1, '1 uso'], [5, '5 usos'], [10, '10 usos'], [25, '25 usos'], [100, '100 usos']];

function selectField(label, options, value) {
  const field = h('label', 'field');
  const sel = h('select');
  options.forEach(([v, text], i) => { const o = new Option(text, String(i)); o.selected = v === value; sel.append(o); });
  field.append(h('span', 'field-label', label), sel);
  return { field, value: () => options[Number(sel.value)][0], sel };
}

// Link de convite: vale por um tempo e por um número de pessoas (padrão: 7 dias, sem limite de usos)
export async function openInviteDialog(s, onCreated) {
  const content = h('div', 'form');
  content.append(h('p', 'muted', 'Mande este link para quem você quer chamar. Quem não tem conta cria uma na hora.'));
  const row = h('div', 'copy-row');
  const input = h('input');
  input.readOnly = true;
  input.value = 'Gerando link…';
  const copy = button('Copiar');
  row.append(input, copy);
  const expiry = selectField('Expira em', EXPIRY, 7 * 24 * HOUR);
  const uses = selectField('Quantas pessoas podem usar', USES, null);
  const opts = h('div', 'invite-options');
  opts.append(expiry.field, uses.field);
  const note = h('p', 'muted small', '');
  content.append(row, opts, note);
  openModal({ title: `Convide amigos para ${s.name}`, content });
  copy.onclick = () => {
    navigator.clipboard?.writeText(input.value).catch(() => {});
    input.select();
    copy.textContent = 'Copiado!';
    setTimeout(() => (copy.textContent = 'Copiar'), 1500);
  };
  let current = null; // link gerado nesta janela (trocar a opção cancela ele e gera outro)
  const make = async () => {
    input.value = 'Gerando link…';
    try {
      if (current) await request({ t: 'invite:revoke', code: current }).catch(() => {});
      const res = await request({ t: 'invite:create', serverId: s.id, expiresIn: expiry.value(), maxUses: uses.value() });
      current = res.code;
      input.value = inviteLink(res.code);
      const when = EXPIRY.find(([v]) => v === res.expiresIn)?.[1] ?? '7 dias';
      note.textContent = `Vale por ${res.expiresIn ? when : 'tempo indeterminado'}${res.maxUses ? ` e para ${res.maxUses} ${res.maxUses === 1 ? 'pessoa' : 'pessoas'}` : ''}. Mudou a opção? Um link novo é gerado.`;
      onCreated?.();
    } catch (err) {
      input.value = err.message;
    }
  };
  expiry.sel.onchange = make;
  uses.sel.onchange = make;
  make();
}

const fmtLeft = (ts) => {
  if (!ts) return 'nunca vence';
  const mins = Math.max(1, Math.round((ts - Date.now()) / 60_000));
  if (mins < 60) return `vence em ${mins} min`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `vence em ${hours} h` : `vence em ${Math.round(hours / 24)} dias`;
};

// ---------- Menu do membro (clique na lista de membros) ----------

export const myTop = (s) => topPosition(s, state.me.id);
export const canManageMember = (s, m) => m.id === state.me.id || topPosition(s, m.id) < myTop(s);

export function openMemberMenu(s, m, x, y) {
  const perms = permsIn(s);
  contextMenu(x, y, [
    can(perms, PERMS.MANAGE_ROLES) && canManageMember(s, m) && { label: 'Cargos…', icon: 'shield', onClick: () => openMemberRoles(s.id, m.id) },
    { label: 'Copiar nome de usuário', icon: 'link', onClick: () => { navigator.clipboard?.writeText(m.username); toast('Copiado!'); } },
    can(perms, PERMS.KICK_MEMBERS) && m.id !== state.me.id && m.id !== s.ownerId && topPosition(s, m.id) < myTop(s)
      && { label: `Expulsar ${m.name}`, icon: 'door-out', danger: true, onClick: () => kickMember(s, m) },
  ]);
}

export async function kickMember(s, m) {
  const ok = await confirmDialog({
    title: `Expulsar ${m.name}`,
    message: `${m.name} sairá de ${s.name} e da voz, e só volta com um novo convite.`,
    confirm: 'Expulsar',
  });
  if (ok) request({ t: 'member:kick', serverId: s.id, userId: m.id }).catch(fail);
}

// Janela com os cargos de um membro (só os que estão abaixo do seu)
export function openMemberRoles(serverId, userId) {
  const s = serverById(serverId);
  const m = s?.members.find((x) => x.id === userId);
  if (!m) return;
  const top = myTop(s);
  const content = h('div', 'role-checklist');
  const boxes = [];
  for (const r of s.roles.filter((x) => !x.isDefault).sort((a, b) => b.position - a.position)) {
    const row = h('label', 'check-row');
    const cb = h('input');
    cb.type = 'checkbox';
    cb.checked = m.roles.includes(r.id);
    cb.disabled = !(r.position < top);
    cb.dataset.role = r.id;
    const dot = h('span', 'role-dot');
    dot.style.background = r.color || '#99aab5';
    row.append(cb, dot, h('span', '', r.name));
    if (cb.disabled) row.title = 'Esse cargo está acima (ou no nível) do seu';
    content.append(row);
    boxes.push(cb);
  }
  if (!boxes.length) content.append(h('p', 'muted', 'Este servidor ainda não tem cargos. Crie em Configurações do servidor → Cargos.'));
  const save = button('Salvar');
  const modal = openModal({ title: `Cargos de ${m.name}`, content, actions: [save] });
  save.onclick = async () => {
    const roleIds = boxes.filter((b) => b.checked).map((b) => b.dataset.role);
    try {
      await request({ t: 'member:roles', serverId, userId, roleIds });
      modal.close();
    } catch (err) { fail(err); }
  };
}

// ---------- Configurações do servidor ----------

let open = null; // { serverId, section, roleId, root, close }

export function openServerSettings(serverId, section) {
  const s = serverById(serverId);
  if (!s) return;
  closeServerSettings();
  const root = h('div', 'settings');
  root.innerHTML = `
    <nav class="settings-nav"><div class="settings-nav-inner"></div></nav>
    <section class="settings-content"><div class="settings-content-inner"></div>
      <button class="settings-close" title="Fechar (Esc)"></button></section>`;
  root.querySelector('.settings-close').append(icon('close', 20), h('span', '', 'ESC'));
  root.querySelector('.settings-close').onclick = closeServerSettings;
  document.getElementById('overlay-layer').append(root);
  const onKey = (e) => { if (e.key === 'Escape' && !document.querySelector('.modal-backdrop')) closeServerSettings(); };
  document.addEventListener('keydown', onKey);
  open = { serverId, section: section ?? firstSection(s), roleId: null, root, onKey };
  renderSettings();
}

export function closeServerSettings() {
  if (!open) return;
  open.root.remove();
  document.removeEventListener('keydown', open.onKey);
  open = null;
}

// O servidor mudou (outra pessoa editou, ou você mesmo): atualiza a tela aberta
export function refreshSettings(serverId) {
  if (!open || open.serverId !== serverId) return;
  if (!serverById(serverId)) return closeServerSettings();
  renderSettings();
}

function sections(s) {
  const p = permsIn(s);
  return [
    can(p, PERMS.MANAGE_SERVER) && ['overview', 'Visão geral'],
    can(p, PERMS.MANAGE_SERVER) && ['welcome', 'Boas-vindas'],
    can(p, PERMS.MANAGE_ROLES) && ['roles', 'Cargos'],
    (can(p, PERMS.MANAGE_ROLES) || can(p, PERMS.KICK_MEMBERS)) && ['members', 'Membros'],
    can(p, PERMS.MANAGE_EMOJIS) && ['emojis', 'Emojis'],
    can(p, PERMS.MANAGE_EMOJIS) && ['sounds', 'Sons'],
    can(p, PERMS.CREATE_INVITE) && ['invites', 'Convites'],
  ].filter(Boolean);
}
const firstSection = (s) => sections(s)[0]?.[0] ?? 'invites';

function renderSettings() {
  const s = serverById(open.serverId);
  const nav = open.root.querySelector('.settings-nav-inner');
  nav.replaceChildren(h('div', 'settings-nav-title', s.name));
  const list = sections(s);
  if (!list.some(([id]) => id === open.section)) open.section = list[0]?.[0];
  for (const [id, label] of list) {
    const b = h('button', id === open.section ? 'settings-nav-item active' : 'settings-nav-item', label);
    b.onclick = () => { open.section = id; renderSettings(); };
    nav.append(b);
  }
  if (s.ownerId === state.me.id && !s.home) {
    nav.append(h('div', 'menu-sep'));
    const del = h('button', 'settings-nav-item danger', 'Excluir servidor');
    del.onclick = async () => {
      const ok = await confirmDialog({
        title: `Excluir "${s.name}"`, message: 'Todos os canais, mensagens e cargos serão apagados para sempre.', confirm: 'Excluir servidor',
      });
      if (ok) request({ t: 'server:delete', serverId: s.id }).then(closeServerSettings).catch(fail);
    };
    nav.append(del);
  }

  const content = open.root.querySelector('.settings-content-inner');
  content.replaceChildren();
  ({ overview: renderOverview, welcome: renderWelcome, roles: renderRoles, members: renderMemberTable, emojis: renderEmojis, sounds: renderSounds, invites: renderInvites })[open.section]?.(s, content);
}

export function colorPicker(current, { allowNone = false } = {}) {
  const wrap = h('div', 'color-picker');
  let value = current;
  const swatches = [];
  const select = (v) => {
    value = v;
    for (const sw of swatches) sw.classList.toggle('selected', sw.dataset.color === (v ?? ''));
  };
  const options = allowNone ? ['', ...COLORS] : COLORS;
  for (const c of options) {
    const sw = h('button', c ? 'swatch' : 'swatch none');
    sw.type = 'button';
    sw.dataset.color = c;
    sw.title = c || 'Sem cor';
    if (c) sw.style.background = c;
    sw.onclick = () => select(c || null);
    swatches.push(sw);
    wrap.append(sw);
  }
  const custom = h('input');
  custom.type = 'color';
  custom.title = 'Outra cor';
  custom.value = current || '#99aab5';
  custom.oninput = () => select(custom.value);
  wrap.append(custom);
  select(current);
  return { el: wrap, get value() { return value; } };
}

function renderOverview(s, root) {
  root.append(h('h2', '', 'Visão geral do servidor'));
  const preview = h('div', 'server-icon big');
  paintServerIcon(preview, s);
  if (!s.icon) preview.style.background = s.color;
  // Ícone: enviar imagem ou voltar para as iniciais
  const iconBox = h('div', 'icon-edit');
  const iconBtns = h('div', 'icon-edit-buttons');
  const sendIcon = button('Enviar imagem', { kind: 'secondary' });
  sendIcon.onclick = () => pickImage(async (file) => {
    await upload('/api/image', { for: 'server', server: s.id }, file);
    toast('Ícone atualizado!');
  });
  iconBtns.append(sendIcon);
  if (s.icon) {
    const rm = button('Remover imagem', { kind: 'link' });
    rm.onclick = () => request({ t: 'server:icon:remove', serverId: s.id }).catch(fail);
    iconBtns.append(rm);
  }
  iconBtns.append(h('p', 'muted small', 'Uma imagem quadrada de pelo menos 128×128 fica melhor. GIF fica animado (até 2 MB).'));
  iconBox.append(preview, iconBtns);
  const form = h('div', 'form');
  const nameField = h('label', 'field');
  const name = h('input');
  Object.assign(name, { value: s.name, maxLength: 40 });
  name.oninput = () => { if (!s.icon) paintServerIcon(preview, { ...s, name: name.value || s.name }); };
  nameField.append(h('span', 'field-label', 'Nome do servidor'), name);
  const colorField = h('div', 'field');
  const picker = colorPicker(s.color);
  const tint = () => { if (!s.icon) preview.style.background = picker.value; };
  picker.el.addEventListener('click', tint);
  picker.el.addEventListener('input', tint);
  colorField.append(h('span', 'field-label', 'Cor do ícone'), picker.el);
  const save = button('Salvar alterações');
  save.onclick = () => request({ t: 'server:update', serverId: s.id, name: name.value, color: picker.value })
    .then(() => toast('Servidor atualizado!')).catch(fail);
  form.append(iconBox, nameField, colorField, save);
  root.append(form);
}

// ---------- Boas-vindas (avisos automáticos no chat) ----------

function toggleRow(label, hint, checked) {
  const row = h('label', 'toggle-row');
  const box = h('input');
  box.type = 'checkbox';
  box.checked = checked;
  const text = h('div', '');
  text.append(h('div', 'toggle-label', label), h('div', 'muted small', hint));
  row.append(text, box);
  return { row, box };
}

function renderWelcome(s, root) {
  const w = s.welcome ?? { on: true, channelId: null, joinText: '', leaveText: '', gameAnnounce: true };
  root.append(h('h2', '', 'Boas-vindas'),
    h('p', 'muted', 'Mensagens automáticas no chat quando alguém entra ou sai do servidor, e quando alguém abre uma sala de jogo.'));
  const form = h('div', 'form');
  const on = toggleRow('Avisar quando alguém entra ou sai', 'Uma mensagem aparece no canal escolhido abaixo.', w.on);
  const game = toggleRow('Avisar quando abrirem sala de jogo', 'Com um botão "Entrar na sala" para quem quiser jogar junto.', w.gameAnnounce);

  const channelField = h('label', 'field');
  const channel = h('select');
  const texts = s.channels.filter((c) => c.type === 'text');
  for (const c of texts) channel.append(new Option(`#${c.name}`, c.id));
  channel.value = texts.some((c) => c.id === w.channelId) ? w.channelId : texts[0]?.id ?? '';
  channelField.append(h('span', 'field-label', 'Canal dos avisos'), channel);

  const area = (label, value) => {
    const field = h('label', 'field');
    const input = h('textarea', 'welcome-input');
    Object.assign(input, { value, maxLength: 200, rows: 2 });
    field.append(h('span', 'field-label', label), input);
    return { field, input };
  };
  const join = area('Mensagem de entrada', w.joinText);
  const leave = area('Mensagem de saída', w.leaveText);
  const help = h('p', 'muted small', 'Use {user} para o nome da pessoa e {server} para o nome do servidor. Emojis valem!');

  // Prévia de como fica no chat
  const preview = h('div', 'welcome-preview');
  const paint = () => {
    const fill = (t) => t.replaceAll('{user}', `@${state.me.name}`).replaceAll('{server}', s.name);
    preview.replaceChildren(h('div', 'field-label', 'Prévia'),
      h('div', 'welcome-preview-line join', fill(join.input.value || '…')),
      h('div', 'welcome-preview-line leave', fill(leave.input.value || '…').replaceAll(`@${state.me.name}`, state.me.name)));
    for (const el of [channelField, join.field, leave.field, help, preview]) el.classList.toggle('dimmed', !on.box.checked);
  };
  join.input.oninput = paint;
  leave.input.oninput = paint;
  on.box.onchange = paint;
  paint();

  const reset = button('Voltar ao texto padrão', { kind: 'link' });
  reset.onclick = () => {
    join.input.value = '👋 {user} chegou! Boas-vindas ao {server}.';
    leave.input.value = '🚪 {user} saiu do servidor.';
    paint();
  };
  const save = button('Salvar alterações');
  save.onclick = () => request({
    t: 'server:welcome', serverId: s.id, on: on.box.checked, channelId: channel.value || null,
    joinText: join.input.value, leaveText: leave.input.value, gameAnnounce: game.box.checked,
  }).then(() => toast('Boas-vindas salvas!')).catch(fail);
  const actions = h('div', 'form-actions');
  actions.append(save, reset);
  form.append(on.row, channelField, join.field, leave.field, help, preview, game.row, actions);
  root.append(form);
}

// ---------- Sons do soundboard ----------

function renderSounds(s, root) {
  const sounds = s.sounds ?? [];
  root.append(h('h2', '', 'Sons'), h('p', 'muted', `Sons curtos que qualquer um na call toca pelo soundboard (botão 🔊 no painel da voz). Até 30 sons, com no máximo 8 segundos e 1 MB (MP3, OGG, WAV, M4A). ${sounds.length}/30 usados.`));
  const form = h('div', 'sound-upload');
  const name = h('input');
  Object.assign(name, { placeholder: 'Nome (ex.: Ihhh)', maxLength: 24 });
  const emoji = h('input');
  Object.assign(emoji, { placeholder: '🔊', maxLength: 4, className: 'sound-emoji-input' });
  const pick = button('Escolher arquivo e enviar');
  pick.onclick = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'audio/*';
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return;
      // Confere a duração antes de enviar
      const dur = await new Promise((resolve) => {
        const a = new Audio(URL.createObjectURL(file));
        a.onloadedmetadata = () => resolve(a.duration);
        a.onerror = () => resolve(null);
      });
      if (dur === null) return fail(new Error('Não deu para ler esse áudio.'));
      if (dur > 8.5) return fail(new Error(`O som tem ${Math.round(dur)} s; o máximo é 8 s.`));
      try {
        await upload('/api/sound', { server: s.id, name: name.value.trim() || file.name.replace(/\.[^.]+$/, '').slice(0, 24), emoji: emoji.value.trim() }, file);
        toast('Som adicionado!');
      } catch (err) { fail(err); }
    };
    input.click();
  };
  form.append(emoji, name, pick);
  root.append(form);
  const list = h('div', 'sound-list');
  for (const snd of sounds) {
    const row = h('div', 'sound-row');
    const play = button('▶', { kind: 'secondary' });
    play.title = 'Ouvir';
    play.onclick = () => new Audio(`/sound/${snd.id}`).play().catch(() => {});
    const del = button('Excluir', { kind: 'danger-outline' });
    del.onclick = () => request({ t: 'sound:delete', soundId: snd.id }).catch(fail);
    row.append(h('span', 'board-emoji', snd.emoji), h('span', 'sound-name', snd.name), play, del);
    list.append(row);
  }
  if (!sounds.length) list.append(h('p', 'muted small', 'Nenhum som ainda. Os sons prontos (tambor, tadá, buzina…) já estão no soundboard.'));
  root.append(list);
}

// ---------- Emojis ----------

const EMOJI_LIMIT = 50;
const EMOJI_MAX_KB = 256;

// Nome a partir do arquivo: "Gato Feliz!.gif" -> "Gato_Feliz"
const emojiNameFrom = (file) => {
  const base = file.name.replace(/\.[^.]+$/, '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32);
  return base.length >= 2 ? base : `emoji_${Math.random().toString(36).slice(2, 6)}`;
};

function renderEmojis(s, root) {
  const emojis = s.emojis ?? [];
  const animated = emojis.filter((e) => e.animated).length;
  root.append(h('h2', '', 'Emojis'));
  root.append(h('p', 'muted', `Adicione até ${EMOJI_LIMIT} emojis normais e ${EMOJI_LIMIT} animados, que todo mundo do servidor pode usar no chat digitando :nome: ou pelo botão de emoji.`));
  const rules = h('ul', 'emoji-rules muted small');
  for (const t of ['Formatos: PNG, JPG, WEBP ou GIF (GIF e PNG/WEBP animados viram emojis animados).', `Tamanho máximo: ${EMOJI_MAX_KB} KB. Uma imagem quadrada de 128×128 fica melhor.`, 'Nome: de 2 a 32 letras, números ou _ (sem espaço nem acento).']) rules.append(h('li', '', t));
  root.append(rules);

  const input = h('input');
  input.type = 'file';
  input.accept = 'image/png,image/jpeg,image/gif,image/webp';
  input.multiple = true;
  input.hidden = true;
  const add = button('Enviar emoji');
  add.onclick = () => input.click();
  input.onchange = async () => {
    const files = [...input.files];
    input.value = '';
    add.disabled = true;
    let ok = 0;
    for (const file of files) {
      if (file.size > EMOJI_MAX_KB * 1024) { fail(new Error(`"${file.name}" tem mais de ${EMOJI_MAX_KB} KB.`)); continue; }
      try {
        await upload('/api/emojis', { server: s.id, name: emojiNameFrom(file) }, file);
        ok++;
      } catch (err) { fail(new Error(`${file.name}: ${err.message}`)); }
    }
    add.disabled = false;
    if (ok) toast(ok === 1 ? 'Emoji adicionado!' : `${ok} emojis adicionados!`);
  };
  root.append(add, input);

  for (const [title, list] of [
    [`Emojis — ${EMOJI_LIMIT - (emojis.length - animated)} vagas`, emojis.filter((e) => !e.animated)],
    [`Emojis animados — ${EMOJI_LIMIT - animated} vagas`, emojis.filter((e) => e.animated)],
  ]) {
    root.append(h('h3', 'emoji-section-title', title));
    if (!list.length) { root.append(h('p', 'muted small', 'Nenhum ainda.')); continue; }
    const table = h('div', 'emoji-table');
    for (const e of list) {
      const row = h('div', 'emoji-row');
      const img = h('img', 'emoji-preview');
      img.src = `/emoji/${e.id}`;
      img.alt = e.name;
      const name = h('input', 'emoji-name');
      Object.assign(name, { value: e.name, maxLength: 32, title: 'Clique para renomear', size: Math.max(3, e.name.length) });
      name.oninput = () => (name.size = Math.max(3, name.value.length)); // o ":" final acompanha o nome
      const rename = () => {
        const v = name.value.trim();
        if (v === e.name) return;
        request({ t: 'emoji:rename', emojiId: e.id, name: v }).catch((err) => { name.value = e.name; fail(err); });
      };
      name.onblur = rename;
      name.onkeydown = (ev) => { if (ev.key === 'Enter') name.blur(); if (ev.key === 'Escape') { name.value = e.name; name.blur(); } };
      const who = s.members.find((m) => m.id === e.by);
      const del = h('button', 'icon-btn tiny danger-hover');
      del.title = 'Excluir emoji';
      del.append(icon('trash', 16));
      del.onclick = async () => {
        const yes = await confirmDialog({ title: 'Excluir emoji', message: `Excluir :${e.name}:? Nas mensagens antigas ele vira só o texto :${e.name}:.`, confirm: 'Excluir' });
        if (yes) request({ t: 'emoji:delete', emojiId: e.id }).catch(fail);
      };
      row.append(img, h('span', 'emoji-colon', ':'), name, h('span', 'emoji-colon', ':'), h('span', 'muted small emoji-by', who ? `por ${who.name}` : ''), del);
      table.append(row);
    }
    root.append(table);
  }
}

function renderInvites(s, root) {
  root.append(h('h2', '', 'Convites'));
  root.append(h('p', 'muted', 'Gere um link e mande para quem você quer chamar. Dá para escolher por quanto tempo ele vale e quantas pessoas podem usar.'));
  const list = h('div', 'invite-list');
  const load = async () => {
    let res;
    try { res = await request({ t: 'invites:list', serverId: s.id }); } catch (err) { return list.replaceChildren(h('p', 'muted', err.message)); }
    list.replaceChildren();
    if (!res.invites.length) list.append(h('p', 'muted small', 'Nenhum convite ativo.'));
    for (const inv of res.invites) {
      const row = h('div', 'invite-row');
      const info = h('div', 'invite-info');
      info.append(h('code', '', inv.code),
        h('span', 'muted small', `por ${inv.byName} · ${inv.uses}${inv.maxUses ? `/${inv.maxUses}` : ''} ${inv.uses === 1 ? 'uso' : 'usos'} · ${fmtLeft(inv.expiresAt)}`));
      const copyBtn = button('Copiar', { kind: 'secondary' });
      copyBtn.onclick = () => { navigator.clipboard?.writeText(inviteLink(inv.code)).catch(() => {}); toast('Link copiado!'); };
      const revoke = button('Cancelar', { kind: 'danger-outline' });
      revoke.onclick = () => request({ t: 'invite:revoke', code: inv.code }).then(load).catch(fail);
      row.append(info, copyBtn, revoke);
      list.append(row);
    }
  };
  const b = button('Criar link de convite');
  b.onclick = () => openInviteDialog(s, load);
  root.append(b, h('h3', 'settings-subtitle', 'Convites ativos'), list);
  load();
}

// ---------- Cargos ----------

function renderRoles(s, root) {
  root.append(h('h2', '', 'Cargos'));
  root.append(h('p', 'muted', 'Use cargos para organizar os membros e dar permissões. Quem tem cargo mais alto pode gerenciar os de baixo.'));
  const top = myTop(s);
  const perms = permsIn(s);
  const layout = h('div', 'roles-layout');
  const list = h('div', 'roles-list');
  const editor = h('div', 'role-editor');
  layout.append(list, editor);
  root.append(layout);

  const create = button('Criar cargo');
  create.onclick = async () => {
    try {
      const res = await request({ t: 'role:create', serverId: s.id, name: 'novo cargo' });
      open.roleId = res.roleId; // a lista nova chega antes desta resposta: redesenha já com o cargo novo aberto
      renderSettings();
    } catch (err) { fail(err); }
  };
  list.append(create);

  const roles = [...s.roles].sort((a, b) => b.position - a.position);
  if (!roles.some((r) => r.id === open.roleId)) open.roleId = roles[0]?.id;
  if (roles.some((r) => !r.isDefault && r.position < top)) list.append(h('p', 'muted small roles-hint', 'Arraste para reorganizar: quanto mais alto, mais poder.'));
  for (const r of roles) {
    const count = r.isDefault ? s.members.length : s.members.filter((m) => m.roles.includes(r.id)).length;
    const item = h('button', r.id === open.roleId ? 'role-item active' : 'role-item');
    item.dataset.role = r.id;
    const dot = h('span', 'role-dot');
    dot.style.background = r.color || '#99aab5';
    item.append(dot, h('span', 'role-name', r.name), h('span', 'muted small', String(count)));
    item.onclick = () => { open.roleId = r.id; renderSettings(); };
    // Só arrasta cargos abaixo do seu (o @everyone fica sempre embaixo)
    if (!r.isDefault && r.position < top) {
      item.draggable = true;
      item.prepend(h('span', 'role-grip', '⠿'));
      item.ondragstart = (e) => {
        dragRole = r.id;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', r.id);
        requestAnimationFrame(() => item.classList.add('dragging'));
      };
      item.ondragend = () => { dragRole = null; item.classList.remove('dragging'); clearRoleMarks(list); };
    } else item.prepend(h('span', 'role-grip off', '⠿')); // mantém o alinhamento com os que arrastam
    list.append(item);
  }

  // Onde o cargo cairia: { el, mark, position }
  const nonDefault = roles.filter((r) => !r.isDefault);
  const dropAt = (e) => {
    const el = e.target.closest?.('.role-item');
    if (!dragRole || !el || el.dataset.role === dragRole) return null;
    const rest = nonDefault.filter((r) => r.id !== dragRole);
    const target = roles.find((r) => r.id === el.dataset.role);
    if (target.isDefault) return { el, mark: 'drop-before', position: 1 }; // vai para o fim da lista
    const rect = el.getBoundingClientRect();
    const after = e.clientY > rect.top + rect.height / 2;
    const idx = rest.indexOf(target) + (after ? 1 : 0); // posição na lista de cima para baixo
    const position = nonDefault.length - idx;
    if (!(position < top) && top !== Infinity) return null; // acima do seu cargo: não pode
    return { el, mark: after ? 'drop-after' : 'drop-before', position };
  };
  list.ondragover = (e) => {
    const t = dropAt(e);
    clearRoleMarks(list, t?.el);
    if (!t) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    t.el.classList.remove('drop-before', 'drop-after');
    t.el.classList.add(t.mark);
  };
  list.ondrop = (e) => {
    const t = dropAt(e);
    const id = dragRole;
    clearRoleMarks(list);
    if (!t) return;
    e.preventDefault();
    const current = s.roles.find((r) => r.id === id);
    const sameSpot = nonDefault.filter((r) => r.position <= current.position).length === t.position;
    if (!sameSpot) request({ t: 'role:reorder', roleId: id, position: t.position }).catch(fail);
  };

  const role = s.roles.find((r) => r.id === open.roleId);
  if (!role) return;
  const editable = role.isDefault || role.position < top;
  editor.append(h('h3', '', role.isDefault ? 'Cargo padrão (@everyone)' : `Editar cargo — ${role.name}`));
  if (role.isDefault) editor.append(h('p', 'muted small', 'Vale para todos os membros do servidor.'));
  if (!editable) editor.append(h('p', 'warn', 'Esse cargo está acima (ou no nível) do seu: você só pode ver.'));

  let nameInput = null;
  let picker = null;
  if (!role.isDefault) {
    const nf = h('label', 'field');
    nameInput = h('input');
    Object.assign(nameInput, { value: role.name, maxLength: 30, disabled: !editable });
    nf.append(h('span', 'field-label', 'Nome do cargo'), nameInput);
    const cf = h('div', 'field');
    picker = colorPicker(role.color, { allowNone: true });
    if (!editable) picker.el.classList.add('disabled');
    cf.append(h('span', 'field-label', 'Cor (o nome dos membros aparece nessa cor)'), picker.el);
    editor.append(nf, cf);
  }

  editor.append(h('span', 'field-label', 'Permissões'));
  const permBoxes = [];
  const isAdmin = can(perms, PERMS.ADMINISTRATOR);
  for (const [key, label, desc] of PERM_INFO) {
    const flag = PERMS[key];
    const row = h('label', 'perm-row');
    const text = h('div');
    text.append(h('div', 'perm-label', label), h('div', 'muted small', desc));
    const toggle = h('input');
    toggle.type = 'checkbox';
    toggle.className = 'switch';
    toggle.checked = (role.permissions & flag) === flag;
    // Só dá ou tira permissões que você mesmo tem
    toggle.disabled = !editable || (!isAdmin && !can(perms, flag));
    toggle.dataset.flag = String(flag);
    row.append(text, toggle);
    editor.append(row);
    permBoxes.push(toggle);
  }

  if (!editable) return;
  const actions = h('div', 'role-actions');
  if (!role.isDefault) {
    const up = h('button', 'icon-btn');
    up.title = 'Subir cargo';
    up.append(icon('arrow-up', 18));
    up.onclick = () => request({ t: 'role:move', roleId: role.id, dir: 'up' }).catch(fail);
    const down = h('button', 'icon-btn');
    down.title = 'Descer cargo';
    down.append(icon('arrow-down', 18));
    down.onclick = () => request({ t: 'role:move', roleId: role.id, dir: 'down' }).catch(fail);
    const del = button('Excluir cargo', { kind: 'danger-outline' });
    del.onclick = async () => {
      const ok = await confirmDialog({ title: 'Excluir cargo', message: `Excluir "${role.name}"? Quem tem esse cargo perde as permissões dele.`, confirm: 'Excluir' });
      if (ok) request({ t: 'role:delete', roleId: role.id }).catch(fail);
    };
    actions.append(up, down, del);
  }
  const save = button('Salvar alterações');
  save.onclick = () => {
    const permissions = permBoxes.reduce((acc, b) => (b.checked ? acc | Number(b.dataset.flag) : acc), 0) & ALL_PERMS;
    request({
      t: 'role:update', roleId: role.id, name: nameInput?.value, color: picker ? picker.value ?? '' : null, permissions,
    }).then(() => toast('Cargo salvo!')).catch(fail);
  };
  actions.append(save);
  editor.append(actions);
}

let dragRole = null;
function clearRoleMarks(list, keep = null) {
  for (const el of list.querySelectorAll('.drop-before, .drop-after')) if (el !== keep) el.classList.remove('drop-before', 'drop-after');
}

// ---------- Membros ----------

function renderMemberTable(s, root) {
  root.append(h('h2', '', `Membros — ${s.members.length}`));
  const perms = permsIn(s);
  const table = h('div', 'member-table');
  const rolesById = new Map(s.roles.map((r) => [r.id, r]));
  for (const m of [...s.members].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))) {
    const row = h('div', 'member-row');
    const who = h('div', 'member-who');
    const name = h('div', 'name', m.name);
    const color = nameColor(s, m.id);
    if (color) name.style.color = color;
    if (m.id === s.ownerId) name.append(icon('crown', 14));
    const info = h('div');
    info.append(name, h('div', 'muted small', `@${m.username}`));
    who.append(makeAvatar(m.name, '', m.id), info);
    const chips = h('div', 'role-chips');
    for (const id of m.roles) {
      const r = rolesById.get(id);
      if (!r) continue;
      const chip = h('span', 'role-chip');
      const dot = h('span', 'role-dot');
      dot.style.background = r.color || '#99aab5';
      chip.append(dot, r.name);
      chips.append(chip);
    }
    const actions = h('div', 'member-actions');
    if (can(perms, PERMS.MANAGE_ROLES) && canManageMember(s, m)) {
      const b = button('Cargos', { kind: 'secondary' });
      b.onclick = () => openMemberRoles(s.id, m.id);
      actions.append(b);
    }
    if (can(perms, PERMS.KICK_MEMBERS) && m.id !== state.me.id && m.id !== s.ownerId && topPosition(s, m.id) < myTop(s)) {
      const b = button('Expulsar', { kind: 'danger-outline' });
      b.onclick = () => kickMember(s, m);
      actions.append(b);
    }
    row.append(who, chips, actions);
    table.append(row);
  }
  root.append(table);
}
