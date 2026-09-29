// Testes dos jogos de festa: Desenha aí, Stop e Impostor (sem rede nem tela)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Desenho, CHOOSE_MS, DRAW_MS, REVEAL_MS, GALLERY_MS, BEST_BONUS } from '../src/games/desenho.js';
import { THEMES } from '../src/games/desenho-palavras.js';
import { Stop, WRITE_MS, VOTE_MS, SCORE_MS, ROUNDS, FIXED_CATEGORIES } from '../src/games/stop.js';
import { Impostor } from '../src/games/impostor.js';

const people = (n) => Array.from({ length: n }, (_, i) => ({ id: `u${i + 1}`, name: ['Ana', 'Bia', 'Caio', 'Duda', 'Edu'][i] }));
const run = (g, ms, step = 50) => { for (let t = 0; t < ms; t += step) g.tick(step); };
const lines = (g) => g.drainEvents().filter((e) => e.type === 'line').map((e) => e.text);

// ---------- Desenha aí ----------

test('desenho: quem desenha escolhe a palavra e só ele vê; os outros veem a máscara', () => {
  const g = new Desenho(people(3), { random: () => 0 });
  const drawer = g.drawer.id;
  assert.equal(g.stateFor(drawer).choices.length, 3);
  assert.equal(g.stateFor('u2').choices, null);
  g.input(drawer, { cell: 1 });
  assert.equal(g.phase, 'draw');
  assert.equal(g.stateFor(drawer).word, g.word);
  assert.match(g.stateFor('u2').word, /^[_ -]+$/);
});

test('desenho: palpite certo pontua e some do chat; "quase" avisa só quem chutou', () => {
  const g = new Desenho(people(3), { random: () => 0 });
  g.input(g.drawer.id, { cell: 0 });
  g.word = 'Maçã';
  const other = g.players.find((p) => p !== g.drawer);
  assert.deepEqual(g.chat(other.id, 'maca').hide, true);
  assert.ok(other.score >= 50);
  assert.ok(g.drawer.score > 0);
  const third = g.players.find((p) => p !== g.drawer && p !== other);
  assert.deepEqual(g.chat(third.id, 'MAÇÃ!'), { hide: true }); // acento, maiúscula e pontuação não importam
  assert.equal(g.phase, 'reveal'); // todo mundo acertou: revela antes do tempo
  const g2 = new Desenho(people(3), { random: () => 0 });
  g2.input(g2.drawer.id, { cell: 0 });
  g2.word = 'girafa';
  const guesser = g2.players.find((p) => p !== g2.drawer);
  const almost = g2.chat(guesser.id, 'girafs');
  assert.equal(almost.hide, false);
  assert.match(almost.private, /quase/);
  assert.deepEqual(g2.chat(g2.drawer.id, 'é uma girafa').hide, true); // quem desenha não entrega
  assert.deepEqual(g2.chat(guesser.id, 'acho que é uma GIRAFA?'), { hide: true }); // a palavra dentro da frase vale
});

test('desenho: traços viram eventos; desfazer e limpar; quem chega recebe o desenho inteiro', () => {
  const g = new Desenho(people(2), { random: () => 0 });
  g.input(g.drawer.id, { cell: 0 });
  g.drainEvents();
  g.input(g.drawer.id, { stroke: { c: 3, w: 1, p: [[10, 10], [20, 20]] } });
  g.input(g.drawer.id, { stroke: { c: 99, w: 99, p: [[1, 1]] } }); // cor/tamanho fora da lista: fica no limite
  g.input('u2', { stroke: { c: 0, w: 0, p: [[5, 5]] } });           // quem não desenha: ignorado
  assert.equal(g.fullState().strokes.length, 2);
  assert.deepEqual(g.drainEvents().map((e) => e.type), ['stroke', 'stroke']);
  g.input(g.drawer.id, { act: 'undo' });
  assert.equal(g.strokes.length, 1);
  g.input(g.drawer.id, { act: 'clear' });
  assert.equal(g.strokes.length, 0);
});

test('desenho: tema, dificuldade, palavras da galera e tempo vêm das opções da sala', () => {
  const g = new Desenho(people(2), { random: () => 0.3, options: { tema: 'animais', dificuldade: 'dificil', tempo: 120, galera: false } });
  const choices = g.stateFor(g.drawer.id).choices;
  assert.equal(choices.length, 3);
  for (const c of choices) { assert.ok(THEMES.animais.dificil.includes(c.word), c.word); assert.equal(c.level, 'dificil'); }
  g.input(g.drawer.id, { cell: 0 });
  assert.equal(g.timeLeft, 120_000);
  // Misturada: uma de cada nível
  const mix = new Desenho(people(2), { random: () => 0.9, options: { tema: 'comida', galera: false } });
  assert.deepEqual(mix.stateFor(mix.drawer.id).choices.map((c) => c.level).sort(), ['dificil', 'facil', 'medio']);
  // Só palavras da galera
  const gal = new Desenho(people(2), { random: () => 0.1, options: { tema: 'galera' }, customWords: ['Tio Zé', 'Bar do Juca', 'Rolê na praia', 'Fusca azul'] });
  for (const c of gal.stateFor(gal.drawer.id).choices) { assert.ok(['Tio Zé', 'Bar do Juca', 'Rolê na praia', 'Fusca azul'].includes(c.word)); assert.equal(c.galera, true); }
});

test('desenho: palavra difícil vale mais que fácil', () => {
  const score = (level) => {
    const g = new Desenho(people(2), { random: () => 0, options: { tema: 'animais', dificuldade: level, galera: false } });
    g.input(g.drawer.id, { cell: 0 });
    const guesser = g.players.find((p) => p !== g.drawer);
    g.chat(guesser.id, g.word);
    return guesser.score;
  };
  assert.ok(score('dificil') > score('facil'));
});

test('desenho: linha, círculo e balde de tinta viram traços; balde precisa de 1 ponto e linha de 2', () => {
  const g = new Desenho(people(2), { random: () => 0 });
  const d = g.drawer.id;
  g.input(d, { cell: 0 });
  g.input(d, { stroke: { c: 3, w: 1, k: 'l', p: [[10, 10], [500, 500]] } });
  g.input(d, { stroke: { c: 4, w: 2, k: 'o', p: [[300, 300], [400, 300]] } });
  g.input(d, { stroke: { c: 5, w: 0, k: 'f', p: [[50, 50]] } });
  g.input(d, { stroke: { c: 5, w: 0, k: 'l', p: [[1, 1]] } }); // linha com 1 ponto: ignora
  assert.deepEqual(g.strokes.map((s) => s.k), ['l', 'o', 'f']);
});

test('desenho: galeria no fim — vota no melhor (não no próprio) e o mais votado ganha bônus', () => {
  const g = new Desenho(people(2), { random: () => 0 });
  // Duas rodadas por pessoa com 2 jogadores: desenha, passa o tempo, revela
  let guard = 0;
  while (g.phase !== 'gallery' && !g.over && guard++ < 20) {
    if (g.phase === 'choose') g.input(g.drawer.id, { cell: 0 });
    if (g.phase === 'draw') { g.input(g.drawer.id, { stroke: { c: 0, w: 1, p: [[1, 1], [9, 9]] } }); g.tick(g.drawMs); }
    if (g.phase === 'reveal') g.tick(REVEAL_MS);
  }
  assert.equal(g.phase, 'gallery');
  assert.equal(g.gallery.length, 4);
  const [a, b] = g.players;
  const mine = g.gallery.findIndex((x) => x.drawer === a.id);
  const theirs = g.gallery.findIndex((x) => x.drawer === b.id);
  g.input(a.id, { act: 'vote', target: String(mine) }); // o próprio: não vale
  assert.equal(g.votes.has(a.id), false);
  const before = b.score;
  g.input(a.id, { act: 'vote', target: String(theirs) });
  g.input(b.id, { act: 'vote', target: String(mine) });
  assert.equal(g.over, true); // todos votaram: acaba na hora
  assert.equal(b.score, before + BEST_BONUS);
  assert.ok(a.score >= BEST_BONUS);
  // Ninguém vota: acaba sozinho quando o tempo passa
  const h = new Desenho(people(2), { random: () => 0 });
  guard = 0;
  while (h.phase !== 'gallery' && guard++ < 20) {
    if (h.phase === 'choose') h.input(h.drawer.id, { cell: 0 });
    if (h.phase === 'draw') { h.input(h.drawer.id, { stroke: { c: 0, w: 1, p: [[1, 1]] } }); h.tick(h.drawMs); }
    if (h.phase === 'reveal') h.tick(REVEAL_MS);
  }
  h.tick(GALLERY_MS);
  assert.equal(h.over, true);
});

test('desenho: tempo esgotado revela, passa a vez e no fim ganha quem fez mais pontos', () => {
  const g = new Desenho(people(2), { random: () => 0.5 });
  const rounds = g.order.length * g.rounds;
  for (let t = 0; t < rounds && !g.over; t++) run(g, CHOOSE_MS + DRAW_MS + 6000, 500);
  assert.equal(g.over, true);
  assert.ok(lines(g).some((l) => l.startsWith('A palavra era')));
});

// ---------- Stop ----------

test('stop: só grita STOP com tudo preenchido com a letra; os outros têm 5 s', () => {
  const g = new Stop(people(2), { random: () => 0 });
  const L = g.letter.toLowerCase();
  g.input('u1', { data: { a0: `${L}aaa` } });
  g.input('u1', { act: 'stop' });
  assert.equal(g.stoppedBy, null);
  g.input('u1', { data: Object.fromEntries(g.categories.map((_, i) => [`a${i}`, `${L}xx${i}`])) });
  g.input('u1', { act: 'stop' });
  assert.equal(g.stoppedBy, 'u1');
  assert.ok(g.timeLeft <= 5000);
  assert.equal(g.stateFor('u2').answers, null); // escrevendo: não dá para ver as dos outros
});

test('stop: pontos (única 10, repetida 5) e recusa pela maioria', () => {
  const g = new Stop(people(3), { random: () => 0 });
  const L = g.letter.toLowerCase();
  g.input('u1', { data: { a0: `${L}ana`, a1: `${L}ato` } });
  g.input('u2', { data: { a0: `${L}ana`, a1: 'xis' } });
  g.input('u3', { data: { a0: `${L}ucas`, a1: `${L}ixo` } });
  run(g, WRITE_MS);
  assert.equal(g.phase, 'vote');
  g.input('u2', { data: { reject: 'u3|1', on: true } });
  g.input('u1', { data: { reject: 'u3|1', on: true } });
  run(g, VOTE_MS);
  assert.deepEqual(g.results.u1.slice(0, 2), [5, 10]);
  assert.deepEqual(g.results.u2.slice(0, 2), [5, 0]);   // não começa com a letra
  assert.deepEqual(g.results.u3.slice(0, 2), [10, 0]);  // recusada pela maioria
});

test('stop: Nome, Minha sogra é…, Filme / Série / Anime e CEP em toda partida, mais 2 sorteadas', () => {
  for (const seed of [0, 0.3, 0.7, 0.99]) {
    const g = new Stop(people(2), { random: () => seed });
    assert.equal(g.categories.length, 6);
    assert.deepEqual(g.categories.slice(0, 4), FIXED_CATEGORIES);
    assert.equal(new Set(g.categories).size, 6);
  }
});

test('stop: 4 rodadas com letras diferentes', () => {
  const g = new Stop(people(2));
  const letters = new Set([g.letter]);
  for (let r = 0; r < ROUNDS && !g.over; r++) { run(g, WRITE_MS + VOTE_MS + SCORE_MS + 100, 500); if (!g.over) letters.add(g.letter); }
  assert.equal(g.over, true);
  assert.equal(letters.size, ROUNDS);
});

// ---------- Impostor ----------

test('impostor: só ele não sabe a palavra; dicas na ordem; quem sabe não pode entregar', () => {
  const g = new Impostor(people(4), { random: () => 0.3 });
  const imp = g.impostor;
  const innocent = g.players.find((p) => p.id !== imp).id;
  assert.equal(g.stateFor(imp).word, null);
  assert.equal(g.stateFor(imp).role, 'impostor');
  assert.equal(g.stateFor(innocent).word, g.word);
  const first = g.current;
  g.input(first === imp ? innocent : imp, { text: 'dica fora da vez' });
  assert.equal(g.clues.length, 0);
  if (first !== imp) {
    g.input(first, { text: `é ${g.word}` }); // entregou: não vale
    assert.equal(g.clues.length, 0);
  }
  g.input(first, { text: 'amarelo' });
  assert.equal(g.clues.length, 1);
});

test('impostor: pegaram e ele errou a palavra -> inocentes vencem juntos; acertou -> ele vence', () => {
  const play = (guess) => {
    const g = new Impostor(people(4), { random: () => 0.3 });
    while (g.phase === 'clues') g.input(g.current, { text: 'dica' });
    for (const p of g.players) g.input(p.id, { target: p.id === g.impostor ? g.players.find((x) => x.id !== g.impostor).id : g.impostor });
    assert.equal(g.phase, 'guess');
    g.input(g.impostor, { text: guess(g) });
    return g;
  };
  const caught = play(() => 'nada a ver');
  assert.equal(caught.outcome, 'caught');
  assert.equal(caught.winners.length, 3);
  assert.equal(caught.winner, null);
  const lucky = play((g) => g.word.toUpperCase());
  assert.equal(lucky.outcome, 'guessed');
  assert.equal(lucky.winner, lucky.impostor);
});

test('impostor: empate na votação -> ele escapa', () => {
  const g = new Impostor(people(4), { random: () => 0.3 });
  while (g.phase === 'clues') g.input(g.current, { text: 'dica' });
  const [a, b, c, d] = g.players.map((p) => p.id);
  g.input(a, { target: b }); g.input(b, { target: a }); g.input(c, { target: d }); g.input(d, { target: c });
  assert.equal(g.outcome, 'escaped');
  assert.deepEqual(g.winners, [g.impostor]);
});
