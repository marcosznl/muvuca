// Stop / Adedonha no site: escrever (campos por categoria, botão STOP), conferir (recusar respostas dos outros)
// e a tabela de pontos da rodada. Os campos não são recriados enquanto você escreve (não perde o foco).
import { h } from '../util.js';
import { isMe } from './common.js';

const fold = (t) => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
let key = null;       // rodada+fase desenhada (muda: redesenha tudo)
let inputs = [];
let sendTimer = null;

function writePhase(el, s, ctx) {
  const box = h('div', 'stop-write');
  const head = h('div', 'stop-head');
  head.append(h('div', 'stop-letter', s.letter), h('div', 'stop-sub', `Rodada ${s.round} de ${s.rounds}`));
  const form = h('div', 'stop-fields');
  inputs = s.categories.map((cat, i) => {
    const field = h('label', 'stop-field');
    const input = h('input');
    Object.assign(input, { value: s.mine?.[i] ?? '', maxLength: 40, placeholder: `${cat} com ${s.letter}…`, autocomplete: 'off', spellcheck: false });
    input.disabled = !ctx.isPlayer;
    const ok = h('span', 'stop-ok');
    field.append(h('span', 'stop-cat', cat), input, ok);
    input.oninput = () => {
      clearTimeout(sendTimer);
      sendTimer = setTimeout(() => ctx.send({ data: Object.fromEntries(inputs.map((x, k) => [`a${k}`, x.value])) }), 250);
      refresh(s);
    };
    input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); inputs[i + 1]?.focus(); } };
    form.append(field);
    return input;
  });
  const stopBtn = h('button', 'btn stop-btn', 'STOP! ✋');
  stopBtn.type = 'button';
  stopBtn.onclick = () => {
    ctx.send({ data: Object.fromEntries(inputs.map((x, k) => [`a${k}`, x.value])) });
    ctx.send({ act: 'stop' });
  };
  const progress = h('div', 'stop-progress muted small');
  box.append(head, form, stopBtn, progress);
  el.append(box);
  const refresh = (st) => {
    const valid = inputs.map((x) => fold(x.value).startsWith(st.letter.toLowerCase()));
    inputs.forEach((x, k) => { x.parentElement.querySelector('.stop-ok').textContent = x.value.trim() ? (valid[k] ? '✓' : '✗') : ''; });
    stopBtn.disabled = !ctx.isPlayer || !valid.every(Boolean) || !!st.stoppedBy;
  };
  el._refresh = (st) => {
    refresh(st);
    const others = st.players.filter((p) => !isMe(p.id) && p.alive).map((p) => `${p.name.split(' ')[0]} ${st.filled[p.id]}/${st.categories.length}`);
    progress.textContent = st.stoppedBy
      ? `✋ ${st.players.find((p) => p.id === st.stoppedBy)?.name} gritou STOP!`
      : others.length ? `Preenchendo: ${others.join(' · ')}` : '';
  };
  setTimeout(() => inputs[0]?.focus(), 0);
}

function table(s, cell) {
  const tb = h('table', 'stop-table');
  const head = h('tr');
  head.append(h('th', '', ''));
  for (const p of s.players) head.append(h('th', isMe(p.id) ? 'me' : '', p.name.split(' ')[0]));
  tb.append(head);
  s.categories.forEach((cat, c) => {
    const tr = h('tr');
    tr.append(h('th', 'stop-cat-col', cat));
    for (const p of s.players) tr.append(cell(p, c));
    tb.append(tr);
  });
  return tb;
}

function votePhase(el, s, ctx) {
  const box = h('div', 'stop-vote');
  box.append(h('div', 'stop-head-row', `Letra ${s.letter} · recuse o que não vale (clique na resposta)`));
  box.append(table(s, (p, c) => {
    const answer = s.answers?.[p.id]?.[c] ?? '';
    const td = h('td', 'stop-answer');
    const valid = answer.trim() && fold(answer).startsWith(s.letter.toLowerCase());
    const rejects = s.rejects[`${p.id}|${c}`] ?? [];
    td.classList.toggle('invalid', !valid);
    td.classList.toggle('rejected', rejects.length > 0);
    td.append(h('span', '', answer || '—'));
    if (rejects.length) td.append(h('span', 'stop-rej', ` 👎${rejects.length}`));
    if (valid && !isMe(p.id) && ctx.isPlayer) {
      const mine = rejects.includes(ctx.me);
      td.classList.add('clickable');
      td.title = mine ? 'Tirar a recusa' : 'Não vale!';
      td.onclick = () => ctx.send({ data: { reject: `${p.id}|${c}`, on: !mine } });
    }
    return td;
  }));
  const ready = h('button', 'btn primary', s.ready.includes(ctx.me) ? 'Esperando os outros…' : 'Pronto, conferi');
  ready.type = 'button';
  ready.disabled = !ctx.isPlayer || s.ready.includes(ctx.me);
  ready.onclick = () => ctx.send({ act: 'ready' });
  box.append(ready);
  el.append(box);
}

function scorePhase(el, s) {
  const box = h('div', 'stop-vote');
  box.append(h('div', 'stop-head-row', `Pontos da rodada ${s.round} (letra ${s.letter})`));
  box.append(table(s, (p, c) => {
    const pts = s.results?.[p.id]?.[c] ?? 0;
    const td = h('td', `stop-answer pts-${pts}`);
    td.append(h('span', '', s.answers?.[p.id]?.[c] || '—'), h('span', 'stop-pts', ` ${pts}`));
    return td;
  }));
  const totals = h('div', 'stop-totals');
  for (const p of [...s.players].sort((a, b) => b.score - a.score)) totals.append(h('span', 'stop-total', `${p.name.split(' ')[0]}: ${p.score}`));
  box.append(totals);
  el.append(box);
}

export default {
  emoji: '✋',
  title: 'Stop',
  desc: 'De 1 a 10 pessoas. Sorteia a letra e todo mundo preenche nome, animal, cor, fruta… Terminou? Grita STOP! 4 rodadas.',
  help: () => ['Preencha as categorias com a letra sorteada e clique em ', h('span', 'kbd', 'STOP!')],
  touchHelp: 'Preencha as categorias e toque em STOP!',
  dom: true,
  reset() { key = null; },
  mount() { key = null; },
  render(el, s, ctx) {
    const k = `${s.round}-${s.phase}-${s.over}`;
    if (k !== key || !el.firstChild) {
      key = k;
      el.replaceChildren();
      el._refresh = null;
      if (s.phase === 'write' && !s.over) writePhase(el, s, ctx);
      else if (s.phase === 'vote' && !s.over) votePhase(el, s, ctx);
      else scorePhase(el, s);
    } else if (s.phase === 'vote') {
      el.replaceChildren();
      votePhase(el, s, ctx); // conferir: redesenha (as recusas mudam)
    }
    el._refresh?.(s);
    const secs = Math.ceil(s.timeLeft / 1000);
    const label = { write: 'escrevendo', vote: 'conferindo', score: 'pontos' }[s.phase];
    return { status: `Rodada ${s.round}/${s.rounds} · ${label} · ⏱ ${secs}s`, overlay: '' };
  },
};
