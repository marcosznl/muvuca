// Tela de entrada: login, cadastro e convite recebido por link
import { $, h, paintServerIcon } from './util.js';
import { api, setSessionToken } from './net.js';

let onDone = () => {};
let mode = 'login';

export const pendingInvite = () => new URLSearchParams(location.search).get('convite');

export function clearInviteFromUrl() {
  const url = new URL(location.href);
  url.searchParams.delete('convite');
  history.replaceState(null, '', url.pathname + url.search);
}

export async function showAuth({ error = '', onLoggedIn } = {}) {
  if (onLoggedIn) onDone = onLoggedIn;
  const invite = pendingInvite();
  // Chegou por convite e ainda não tem conta: abre direto no cadastro
  if (invite && mode === 'login' && !error) mode = 'register';
  $('app').hidden = true;
  const root = $('auth');
  root.hidden = false;
  root.replaceChildren();

  const card = h('form', 'card auth-card');
  const brand = h('div', 'auth-brand');
  brand.append(h('span', 'auth-logo', 'M'), 'Muvuca');
  root.append(brand, card);

  // Cartão do convite
  let inviteInfo = null;
  if (invite) {
    try {
      const res = await fetch(`/api/invite/${encodeURIComponent(invite)}`);
      if (res.ok) inviteInfo = await res.json();
    } catch {}
    const box = h('div', 'invite-card');
    if (inviteInfo) {
      const ic = h('div', 'server-icon big');
      paintServerIcon(ic, inviteInfo);
      if (!inviteInfo.icon) ic.style.background = inviteInfo.color;
      const txt = h('div');
      txt.append(h('div', 'muted small', 'Você recebeu um convite para entrar em'), h('strong', '', inviteInfo.name),
        h('div', 'muted small', `${inviteInfo.memberCount} ${inviteInfo.memberCount === 1 ? 'membro' : 'membros'}`));
      box.append(ic, txt);
    } else {
      box.append(h('div', 'error', 'Esse convite é inválido ou expirou.'));
    }
    card.append(box);
  }

  const isRegister = mode === 'register';
  card.append(h('h1', '', isRegister ? 'Criar uma conta' : 'Boas-vindas de volta!'));
  card.append(h('p', 'muted', isRegister ? 'Leva menos de um minuto.' : 'Que bom te ver de novo!'));

  const field = (label, attrs) => {
    const l = h('label', 'field');
    l.append(h('span', 'field-label', label));
    const input = h('input');
    Object.assign(input, attrs);
    l.append(input);
    card.append(l);
    return input;
  };

  const inputs = {};
  if (isRegister) inputs.name = field('Nome de exibição', { maxLength: 32, autocomplete: 'nickname', placeholder: 'Como vão te ver' });
  inputs.username = field('Usuário', { required: true, maxLength: 20, autocomplete: 'username', autocapitalize: 'none', spellcheck: false });
  inputs.password = field('Senha', {
    required: true, type: 'password', maxLength: 200, autocomplete: isRegister ? 'new-password' : 'current-password',
  });
  if (isRegister && !inviteInfo) inputs.invite = field('Código de convite', { required: true, autocomplete: 'off', placeholder: 'Peça para quem te chamou' });
  if (isRegister) card.append(h('p', 'muted small', 'Usuário: 3 a 20 letras, números, ponto ou _. Senha: pelo menos 6 caracteres.'));

  const err = h('p', 'error', error);
  err.hidden = !error;
  const submit = h('button', 'btn primary block', isRegister ? 'Continuar' : 'Entrar');
  submit.type = 'submit';
  card.append(err, submit);

  const switcher = h('p', 'muted small');
  const link = h('button', 'link', isRegister ? 'Já tem uma conta? Entrar' : 'Precisa de uma conta? Registre-se');
  link.type = 'button';
  link.onclick = () => { mode = isRegister ? 'login' : 'register'; showAuth(); };
  switcher.append(link);
  card.append(switcher);

  card.onsubmit = async (e) => {
    e.preventDefault();
    err.hidden = true;
    submit.disabled = true;
    try {
      const data = isRegister
        ? await api('/api/register', {
          username: inputs.username.value.trim(),
          name: inputs.name.value.trim(),
          password: inputs.password.value,
          invite: inputs.invite ? inputs.invite.value.trim() : invite,
        })
        : await api('/api/login', { username: inputs.username.value.trim(), password: inputs.password.value });
      // No cadastro o convite já foi usado; no login ele é aceito depois de conectar
      if (isRegister) clearInviteFromUrl();
      setSessionToken(data.token);
      root.hidden = true;
      onDone(data);
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
      submit.disabled = false;
    }
  };
  (inputs.name ?? inputs.username).focus();
}
