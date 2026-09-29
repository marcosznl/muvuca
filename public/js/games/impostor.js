// Quem é o impostor no site: seu papel (a palavra, ou "você é o impostor"), as dicas na ordem,
// o campo para dar a sua na sua vez, a votação e o chute final do impostor.
import { h } from '../util.js';
import { isMe } from './common.js';

let key = null;

const nameOf = (s, id) => s.players.find((p) => p.id === id)?.name ?? '?';

function roleCard(s) {
  const card = h('div', `imp-role ${s.role}`);
  if (s.role === 'impostor') card.append(h('div', 'imp-role-title', '🕵️ Você é o IMPOSTOR'), h('div', 'imp-role-sub', `O tema é ${s.theme}. Descubra a palavra pelas dicas e disfarce!`));
  else if (s.role === 'inocente') card.append(h('div', 'imp-role-title', `A palavra é: ${s.word}`), h('div', 'imp-role-sub', `Tema: ${s.theme}. Dê dicas sem entregar; o impostor não sabe a palavra.`));
  else card.append(h('div', 'imp-role-title', `Tema: ${s.theme}`), h('div', 'imp-role-sub', 'Você está assistindo.'));
  return card;
}

function inputRow(placeholder, button, onSend) {
  const form = h('form', 'imp-input');
  const input = h('input');
  Object.assign(input, { placeholder, maxLength: 30, autocomplete: 'off' });
  const b = h('button', 'btn primary', button);
  form.append(input, b);
  form.onsubmit = (e) => { e.preventDefault(); if (input.value.trim()) onSend(input.value.trim()); };
  setTimeout(() => input.focus(), 0);
  return form;
}

function cluesList(s) {
  const list = h('div', 'imp-clues');
  if (!s.clues.length) list.append(h('div', 'muted small', 'Nenhuma dica ainda.'));
  for (const c of s.clues) {
    const row = h('div', 'imp-clue');
    row.append(h('strong', '', nameOf(s, c.id)), h('span', '', c.text));
    list.append(row);
  }
  return list;
}

export default {
  emoji: '🕵️',
  title: 'Impostor',
  desc: 'De 3 a 10 pessoas. Todos recebem a mesma palavra, menos o impostor. Deem dicas, votem e descubram quem está blefando!',
  help: () => ['Dê uma dica por vez e vote em quem é o impostor'],
  touchHelp: 'Dê sua dica na sua vez e vote no impostor',
  dom: true,
  reset() { key = null; },
  mount() { key = null; },
  render(el, s, ctx) {
    // Redesenha quando muda algo que aparece (o relógio vai pelo status); o campo de texto só é recriado na troca de vez
    const k = JSON.stringify([s.phase, s.current, s.clues.length, s.myVote, s.votedCount, s.over]);
    const secs = Math.ceil(s.timeLeft / 1000);
    if (k !== key) {
      key = k;
      el.replaceChildren();
      const box = h('div', 'imp');
      box.append(roleCard(s));
      if (s.over) {
        const res = h('div', 'imp-result');
        res.append(h('div', 'imp-result-title', s.outcome === 'caught' ? '✅ Os inocentes venceram!' : '😈 O impostor venceu!'),
          h('div', '', `O impostor era ${nameOf(s, s.impostor)} · a palavra era "${s.word}"${s.guess ? ` · chute dele: "${s.guess}"` : ''}`));
        box.append(res);
      }
      if (s.phase === 'clues' && !s.over) {
        const turn = h('div', 'imp-turn');
        turn.append(isMe(s.current) ? 'Sua vez de dar uma dica!' : `Vez de ${nameOf(s, s.current)} dar a dica…`,
          h('span', 'muted small', ` (${Math.min(s.clueTurn + 1, s.clueTotal)}/${s.clueTotal})`));
        box.append(turn);
        if (isMe(s.current)) box.append(inputRow('Uma palavra ou dica curta…', 'Dar dica', (text) => ctx.send({ text })));
      }
      box.append(h('div', 'imp-section', 'Dicas'), cluesList(s));
      if (s.phase === 'vote' && !s.over) {
        box.append(h('div', 'imp-section', `Quem é o impostor? (${s.votedCount} votaram)`));
        const grid = h('div', 'imp-vote');
        for (const p of s.players.filter((x) => x.alive)) {
          const b = h('button', s.myVote === p.id ? 'imp-vote-btn on' : 'imp-vote-btn', p.name);
          b.type = 'button';
          b.disabled = isMe(p.id) || !ctx.isPlayer;
          b.onclick = () => ctx.send({ target: p.id });
          grid.append(b);
        }
        box.append(grid);
      }
      if (s.phase === 'guess' && !s.over) {
        box.append(h('div', 'imp-turn', s.role === 'impostor' ? 'Pegaram você! Qual é a palavra? Última chance:' : `${nameOf(s, s.voted)} foi pego e vai chutar a palavra…`));
        if (s.role === 'impostor') box.append(inputRow('A palavra é…', 'Chutar', (text) => ctx.send({ text })));
      }
      el.append(box);
    }
    const label = { clues: 'dicas', vote: 'votação', guess: 'chute final' }[s.phase];
    return { status: s.over ? '' : `${label} · ⏱ ${secs}s`, overlay: '', end: s.outcome === 'caught' ? 'Os inocentes venceram! 🎉' : undefined };
  },
};
