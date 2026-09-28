// Testes das regras do "Última!" (jogo de cartas, sem rede nem tela)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Cartas, buildDeck, HAND, TURN_MS, CATCH_MS } from '../src/games/cartas.js';

const three = () => [{ id: 'u1', name: 'Ana' }, { id: 'u2', name: 'Bia' }, { id: 'u3', name: 'Caio' }];
const two = () => [{ id: 'u1', name: 'Ana' }, { id: 'u2', name: 'Bia' }];
// Mesa controlada: carta de cima, cor, de quem é a vez e as mãos
function table(players = three(), { top = { id: 900, color: 'white', value: '5' }, hands = {}, rules = { acumular: false } } = {}) {
  const g = new Cartas(players, { bots: false, rules });
  g.discard = [top];
  g.color = top.color;
  g.turn = 0;
  g.dir = 1;
  let id = 1000;
  for (const p of g.players) p.hand = (hands[p.id] ?? [['blue', '1'], ['blue', '2'], ['green', '3']]).map(([color, value]) => ({ id: id++, color, value }));
  return g;
}
const card = (g, pid, i = 0) => g.player(pid).hand[i];

test('o baralho tem 108 cartas e cada um começa com 7', () => {
  assert.equal(buildDeck().length, 108);
  for (let i = 0; i < 50; i++) {
    const g = new Cartas(three());
    // 7 para cada (+2 para alguém se a primeira carta da mesa for um +2)
    const extra = g.top.value === 'draw2' ? 2 : 0;
    assert.equal(g.players.reduce((n, p) => n + p.hand.length, 0), 3 * HAND + extra);
    assert.notEqual(g.top.value, 'wild4');
    assert.equal(g.draw.length + g.discard.length + g.players.reduce((n, p) => n + p.hand.length, 0), 108);
  }
});

test('com menos de 3 pessoas entram robôs', () => {
  assert.equal(new Cartas([{ id: 'u1', name: 'Ana' }]).players.length, 3);
  assert.equal(new Cartas(three()).players.filter((p) => p.bot).length, 0);
});

test('só joga carta da mesma cor ou número, e só na sua vez', () => {
  const g = table(three(), { hands: { u1: [['blue', '5'], ['green', '7'], ['white', '1']] } });
  g.input('u2', { card: card(g, 'u2').id }); // não é a vez
  assert.equal(g.player('u2').hand.length, 3);
  g.input('u1', { card: card(g, 'u1', 1).id }); // verde 7 em vermelho 5: não pode
  assert.equal(g.player('u1').hand.length, 3);
  g.input('u1', { card: card(g, 'u1', 0).id }); // azul 5: mesmo número
  assert.equal(g.top.value, '5');
  assert.equal(g.color, 'blue');
  assert.equal(g.current.id, 'u2');
});

test('pular, inverter e +2', () => {
  let g = table(three(), { hands: { u1: [['white', 'skip'], ['white', '1']] } });
  g.input('u1', { card: card(g, 'u1').id });
  assert.equal(g.current.id, 'u3');
  g = table(three(), { hands: { u1: [['white', 'reverse'], ['white', '1']] } });
  g.input('u1', { card: card(g, 'u1').id });
  assert.equal(g.current.id, 'u3');
  assert.equal(g.dir, -1);
  g = table(three(), { hands: { u1: [['white', 'draw2'], ['white', '1']] } });
  g.input('u1', { card: card(g, 'u1').id });
  assert.equal(g.player('u2').hand.length, 5);
  assert.equal(g.current.id, 'u3');
});

test('com 2 pessoas, inverter funciona como pular', () => {
  const g = table(two(), { hands: { u1: [['white', 'reverse'], ['white', '1']] } });
  g.input('u1', { card: card(g, 'u1').id });
  assert.equal(g.current.id, 'u1');
});

test('coringa precisa de cor; +4 faz o próximo comprar 4', () => {
  const g = table(three(), { hands: { u1: [[null, 'wild4'], ['white', '1']] } });
  g.input('u1', { card: card(g, 'u1').id }); // sem cor: não vale
  assert.equal(g.player('u1').hand.length, 2);
  g.input('u1', { card: card(g, 'u1').id, color: 'green' });
  assert.equal(g.color, 'green');
  assert.equal(g.player('u2').hand.length, 7);
  assert.equal(g.current.id, 'u3');
});

test('comprar: se a comprada serve, pode jogar ela ou passar; se não, a vez passa', () => {
  const g = table(three(), { hands: { u1: [['blue', '1']] } });
  g.draw.push({ id: 5000, color: 'white', value: '9' }); // a próxima do monte serve
  g.input('u1', { act: 'pass' }); // não dá para passar sem comprar
  assert.equal(g.current.id, 'u1');
  g.input('u1', { act: 'draw' });
  assert.equal(g.drewThisTurn, 5000);
  g.input('u1', { card: 5000 });
  assert.equal(g.top.id, 5000);
  assert.equal(g.current.id, 'u2');
  g.draw.push({ id: 5001, color: 'green', value: '2' }); // não serve
  g.input('u2', { act: 'draw' });
  assert.equal(g.current.id, 'u3');
});

test('"Última!": quem esquece de gritar e é pego compra 2; quem gritou está salvo', () => {
  let g = table(three(), { hands: { u1: [['white', '1'], ['blue', '2']] } });
  g.input('u1', { card: card(g, 'u1').id }); // ficou com 1 sem gritar
  assert.equal(g.pendingCatch.id, 'u1');
  g.input('u2', { act: 'catch' });
  assert.equal(g.player('u1').hand.length, 3);
  g = table(three(), { hands: { u1: [['white', '1'], ['blue', '2']] } });
  g.input('u1', { act: 'call' });
  g.input('u1', { card: card(g, 'u1').id });
  assert.equal(g.pendingCatch, null);
  g.input('u2', { act: 'catch' });
  assert.equal(g.player('u1').hand.length, 1);
  // Gritar logo depois de jogar (antes de alguém pegar) também salva; a janela fecha sozinha
  g = table(three(), { hands: { u1: [['white', '1'], ['blue', '2']] } });
  g.input('u1', { card: card(g, 'u1').id });
  g.input('u1', { act: 'call' });
  assert.equal(g.pendingCatch, null);
  g = table(three(), { hands: { u1: [['white', '1'], ['blue', '2']] } });
  g.input('u1', { card: card(g, 'u1').id });
  g.tick(CATCH_MS + 50);
  assert.equal(g.pendingCatch, null);
});

test('quem acaba as cartas vence; tempo esgotado compra e passa', () => {
  let g = table(three(), { hands: { u1: [['white', '1']] } });
  g.input('u1', { card: card(g, 'u1').id });
  assert.equal(g.over, true);
  assert.equal(g.winner, 'u1');
  g = table(three());
  g.tick(TURN_MS);
  assert.equal(g.player('u1').hand.length, 4);
  assert.equal(g.current.id, 'u2');
});

test('cada um vê só a própria mão', () => {
  const g = new Cartas(three());
  const s = g.stateFor('u2');
  assert.equal(s.hand.length, HAND);
  assert.deepEqual(s.hand, g.player('u2').hand);
  assert.ok(s.players.every((p) => typeof p.cards === 'number' && !p.hand));
  assert.deepEqual(g.stateFor('alguem-de-fora').hand, []);
});

test('robôs jogam sozinhos até alguém vencer', () => {
  const g = new Cartas([{ id: 'u1', name: 'Ana' }]);
  g.eliminate('u1'); // sem gente: acaba
  assert.equal(g.over, true);
  const bots = new Cartas([{ id: 'u1', name: 'Ana' }, { id: 'bot9', name: 'X', bot: true }], { bots: false });
  bots.players.forEach((p) => { p.bot = true; });
  for (let t = 0; t < 20_000 && !bots.over; t++) bots.tick(100);
  assert.equal(bots.over, true);
  assert.ok(bots.winner);
});

// ---------- Regras da casa ----------

test('acumular: Fiado em cima de Fiado soma; quem não cobre compra tudo', () => {
  const g = table(three(), { rules: { acumular: true }, hands: {
    u1: [['white', 'draw2'], ['blue', '1']], u2: [['green', 'draw2'], ['blue', '3']], u3: [['blue', '4'], ['green', '8']],
  } });
  g.input('u1', { card: card(g, 'u1').id });
  assert.equal(g.pendingDraw, 2);
  assert.equal(g.current.id, 'u2');
  g.input('u2', { card: card(g, 'u2', 1).id }); // carta comum não vale com acumulado
  assert.equal(g.player('u2').hand.length, 2);
  g.input('u2', { card: card(g, 'u2').id }); // cobre com outro Fiado
  assert.equal(g.pendingDraw, 4);
  g.input('u3', { act: 'draw' });           // não tem: compra 4
  assert.equal(g.player('u3').hand.length, 6);
  assert.equal(g.pendingDraw, 0);
  assert.equal(g.current.id, 'u1');
});

test('corte: carta igualzinha fora da vez joga na hora e a vez segue de quem cortou', () => {
  const g = table(three(), { rules: { corte: true }, hands: { u3: [['white', '5'], ['blue', '9']] } });
  const cut = card(g, 'u3').id;
  g.input('u3', { card: cut });
  assert.equal(g.top.id, cut);
  assert.equal(g.player('u3').hand.length, 1);
  assert.equal(g.current.id, 'u1'); // depois do u3 vem o u1
  const sem = table(three(), { hands: { u3: [['white', '5'], ['blue', '9']] } });
  sem.input('u3', { card: card(sem, 'u3').id }); // sem a regra: nada acontece
  assert.equal(sem.player('u3').hand.length, 2);
});

test('zero troca: todo mundo passa a mão para o lado', () => {
  const g = table(three(), { rules: { zero: true }, hands: {
    u1: [['white', '0'], ['blue', '1']], u2: [['green', '2']], u3: [['yellow', '3'], ['yellow', '4']],
  } });
  g.input('u1', { card: card(g, 'u1').id });
  assert.deepEqual(g.player('u2').hand.map((c) => c.value), ['1']);         // a do u1 foi para o u2
  assert.deepEqual(g.player('u3').hand.map((c) => c.value), ['2']);         // a do u2 foi para o u3
  assert.deepEqual(g.player('u1').hand.map((c) => c.value), ['3', '4']);    // a do u3 veio para o u1
});

test('sete troca: precisa escolher com quem, e troca as mãos', () => {
  const g = table(three(), { rules: { sete: true }, hands: {
    u1: [['white', '7'], ['blue', '1'], ['blue', '2']], u3: [['green', '9']],
  } });
  g.input('u1', { card: card(g, 'u1').id }); // sem alvo: não vale
  assert.equal(g.player('u1').hand.length, 3);
  g.input('u1', { card: card(g, 'u1').id, target: 'u3' });
  assert.deepEqual(g.player('u1').hand.map((c) => c.value), ['9']);
  assert.equal(g.player('u3').hand.length, 2);
  assert.equal(g.player('u1').called, true); // ficou com 1 por causa da troca: está salvo
});

test('as cores são as da bandeira', async () => {
  const { COLORS } = await import('../src/games/cartas.js');
  assert.deepEqual(COLORS, ['green', 'yellow', 'blue', 'white']);
});
