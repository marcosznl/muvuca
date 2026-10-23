// Tela de entrada: login, cadastro e convite recebido por link
import { $, h, paintServerIcon } from './util.js';
import { api, setSessionToken } from './net.js';

let onDone = () => {};
let mode = 'login';
let voltarInicio = null; // veio da página inicial: link para voltar a ela

export const pendingInvite = () => new URLSearchParams(location.search).get('convite');

export function clearInviteFromUrl() {
  const url = new URL(location.href);
  url.searchParams.delete('convite');
  history.replaceState(null, '', url.pathname + url.search);
}

export async function showAuth({ error = '', onLoggedIn, modo, voltar } = {}) {
  if (onLoggedIn) onDone = onLoggedIn;
  if (modo) mode = modo;
  if (voltar) voltarInicio = voltar;
  const invite = pendingInvite();
  // Chegou por convite e ainda não tem conta: abre direto no cadastro
  if (invite && mode === 'login' && !error) mode = 'register';
  $('app').hidden = true;
  const root = $('auth');
  root.hidden = false;
  root.classList.remove('inicio');
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
  if (voltarInicio) {
    const voltar = h('button', 'link', '← Conheça o Muvuca');
    voltar.type = 'button';
    voltar.onclick = () => voltarInicio();
    const p = h('p', 'muted small');
    p.append(voltar);
    card.append(p);
  }

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
      // Senha temporária dada pelo administrador: escolhe a nova antes de entrar
      if (data.mustChange) return showForcedPasswordChange({ current: inputs.password.value, onDone: () => onDone(data) });
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

// Troca obrigatória: o administrador trocou a senha por uma temporária; a pessoa escolhe a dela antes de usar o Muvuca.
// `current` vem preenchido quando a pessoa acabou de digitar a temporária no login; senão, ela digita de novo.
export function showForcedPasswordChange({ current = '', onDone: done } = {}) {
  $('app').hidden = true;
  const root = $('auth');
  root.hidden = false;
  root.classList.remove('inicio');
  root.replaceChildren();
  const card = h('form', 'card auth-card');
  const brand = h('div', 'auth-brand');
  brand.append(h('span', 'auth-logo', 'M'), 'Muvuca');
  root.append(brand, card);
  card.append(h('h1', '', 'Escolha uma senha nova'),
    h('p', 'muted', 'Você entrou com uma senha temporária. Escolha a sua para continuar — só você vai saber qual é.'));
  const field = (label, attrs) => {
    const l = h('label', 'field');
    l.append(h('span', 'field-label', label));
    const input = h('input');
    Object.assign(input, { type: 'password', maxLength: 200, required: true, ...attrs });
    l.append(input);
    card.append(l);
    return input;
  };
  const temp = current ? null : field('Senha temporária', { autocomplete: 'current-password' });
  const next = field('Senha nova', { autocomplete: 'new-password' });
  const again = field('Repita a senha nova', { autocomplete: 'new-password' });
  card.append(h('p', 'muted small', 'Pelo menos 6 caracteres, diferente da temporária.'));
  const err = h('p', 'error');
  err.hidden = true;
  const submit = h('button', 'btn primary block', 'Salvar e entrar');
  submit.type = 'submit';
  const out = h('button', 'link', 'Sair');
  out.type = 'button';
  out.onclick = () => { setSessionToken(null); mode = 'login'; showAuth(); };
  const foot = h('p', 'muted small');
  foot.append(out);
  card.append(err, submit, foot);
  const fail = (msg, input) => { err.textContent = msg; err.hidden = false; input?.focus(); };
  card.onsubmit = async (e) => {
    e.preventDefault();
    err.hidden = true;
    const cur = current || temp.value;
    if (next.value.length < 6) return fail('A senha nova precisa ter pelo menos 6 caracteres.', next);
    if (next.value !== again.value) return fail('As duas senhas novas não são iguais.', again);
    if (next.value === cur) return fail('A senha nova precisa ser diferente da temporária.', next);
    submit.disabled = true;
    try {
      await api('/api/password', { current: cur, password: next.value });
      root.hidden = true;
      (done ?? onDone)();
    } catch (ex) {
      submit.disabled = false;
      fail(ex.message, /atual|temporária/i.test(ex.message) ? temp : next);
    }
  };
  (temp ?? next).focus();
}
