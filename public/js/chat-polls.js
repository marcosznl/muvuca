// Enquetes: criar (pelo + do campo de mensagem), votar ao vivo e encerrar
import { h, showBanner, toast } from './util.js';
import { icon } from './icons.js';
import { state, nameOf } from './state.js';
import { request } from './net.js';
import { openModal, button } from './dialogs.js';

const fail = (err) => showBanner(err.message, { timeout: 4000 });

export function openPollDialog(channelId) {
  const content = h('div', 'form poll-form');
  const q = h('input');
  Object.assign(q, { placeholder: 'Qual é a pergunta?', maxLength: 200 });
  const qField = h('label', 'field');
  qField.append(h('span', 'field-label', 'Pergunta'), q);
  const list = h('div', 'poll-options-edit');
  const addOption = (value = '') => {
    if (list.children.length >= 10) return;
    const row = h('div', 'poll-option-edit');
    const input = h('input');
    Object.assign(input, { value, placeholder: `Opção ${list.children.length + 1}`, maxLength: 80 });
    const rm = h('button', 'icon-btn tiny');
    rm.type = 'button';
    rm.title = 'Tirar opção';
    rm.append(icon('close', 14));
    rm.onclick = () => { if (list.children.length > 2) row.remove(); };
    input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); addOption(); list.lastChild.querySelector('input').focus(); } };
    row.append(input, rm);
    list.append(row);
  };
  addOption();
  addOption();
  const more = button('+ Adicionar opção', { kind: 'link' });
  more.onclick = () => addOption();
  const multiRow = h('label', 'toggle-row');
  const multi = h('input');
  multi.type = 'checkbox';
  const txt = h('div', '');
  txt.append(h('div', 'toggle-label', 'Permitir várias respostas'), h('div', 'muted small', 'Cada pessoa pode marcar mais de uma opção.'));
  multiRow.append(txt, multi);
  const optField = h('div', 'field');
  optField.append(h('span', 'field-label', 'Opções (até 10)'), list, more);
  content.append(qField, optField, multiRow);
  const create = button('Criar enquete');
  const modal = openModal({ title: 'Criar enquete', content, actions: [create] });
  create.onclick = async () => {
    const options = [...list.querySelectorAll('input')].map((i) => i.value.trim()).filter(Boolean);
    try {
      await request({ t: 'poll:create', channel: channelId, question: q.value, options, multi: multi.checked });
      modal.close();
    } catch (err) { fail(err); }
  };
  setTimeout(() => q.focus(), 0);
}

// Cartão da enquete na conversa
export function pollView(msg, canVote) {
  const poll = msg.meta.poll;
  const votes = msg.votes ?? [];
  const usersOf = (i) => votes.find((v) => v.option === i)?.users ?? [];
  const voters = new Set(votes.flatMap((v) => v.users));
  const totalVotes = votes.reduce((n, v) => n + v.users.length, 0);
  const card = h('div', poll.closed ? 'poll closed' : 'poll');
  card.append(h('div', 'poll-question', poll.question));
  if (poll.multi && !poll.closed) card.append(h('div', 'muted small', 'Pode marcar mais de uma'));
  const top = Math.max(0, ...poll.options.map((_, i) => usersOf(i).length));
  poll.options.forEach((label, i) => {
    const users = usersOf(i);
    const mine = users.includes(state.me?.id);
    const pct = totalVotes ? Math.round((users.length / totalVotes) * 100) : 0;
    const opt = h('button', 'poll-option');
    opt.type = 'button';
    opt.classList.toggle('mine', mine);
    opt.classList.toggle('winner', poll.closed && users.length === top && top > 0);
    opt.disabled = !canVote || poll.closed;
    const bar = h('span', 'poll-bar');
    bar.style.width = `${pct}%`;
    const check = h('span', 'poll-check');
    if (mine) check.append(icon('check', 14));
    opt.append(bar, check, h('span', 'poll-label', label), h('span', 'poll-count', `${users.length} · ${pct}%`));
    const names = users.map((id) => (id === state.me?.id ? 'você' : nameOf(id) ?? 'alguém'));
    opt.title = names.length ? `Votaram: ${names.slice(0, 15).join(', ')}${names.length > 15 ? '…' : ''}` : 'Ninguém votou ainda';
    opt.onclick = (e) => { e.stopPropagation(); request({ t: 'poll:vote', id: msg.id, option: i }).catch(fail); };
    card.append(opt);
  });
  const foot = h('div', 'poll-foot');
  foot.append(h('span', 'muted small', `${voters.size} ${voters.size === 1 ? 'pessoa votou' : 'pessoas votaram'}${poll.closed ? ' · encerrada' : ''}`));
  if (!poll.closed && msg.userId === state.me?.id) {
    const close = h('button', 'link-btn', 'Encerrar');
    close.type = 'button';
    close.onclick = (e) => { e.stopPropagation(); request({ t: 'poll:close', id: msg.id }).then(() => toast('Enquete encerrada.')).catch(fail); };
    foot.append(close);
  }
  card.append(foot);
  return card;
}
