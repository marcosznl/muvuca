// Testes das regras de texto do chat (emojis, menções, GIFs), sem navegador
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GIF_URL, isJumbo, usableEmojis, encodeCustomEmojis, encodeMentions, encodeMessage, decodeMessage, snippet, mentionSuggestions,
  parseMarkdown, plainText,
} from '../public/js/richtext.js';

const emojis = [{ id: 'e-0000000001', name: 'legal', animated: false }, { id: 'e-0000000002', name: 'gato', animated: true }];
const members = [
  { id: 'u1', name: 'Ana', username: 'aninha' },
  { id: 'u2', name: 'Ana Clara', username: 'clara' },
  { id: 'u3', name: 'José', username: 'ze' },
];
const nameOf = (id) => members.find((m) => m.id === id)?.name ?? null;

test('emojis do servidor viram código ao enviar (e animados ganham o "a")', () => {
  assert.equal(encodeCustomEmojis('olha :legal: e :gato:', emojis), 'olha <:legal:e-0000000001> e <a:gato:e-0000000002>');
  assert.equal(encodeCustomEmojis(':LEGAL:', emojis), '<:legal:e-0000000001>');
  assert.equal(encodeCustomEmojis(':naoexiste: 12:30:45', emojis), ':naoexiste: 12:30:45');
  // Não mexe no que já é código
  assert.equal(encodeCustomEmojis('<:legal:e-0000000001>', emojis), '<:legal:e-0000000001>');
});

test('menções: nome mais longo ganha, usuário também vale, e-mail não', () => {
  assert.equal(encodeMentions('oi @Ana Clara e @Ana', members), 'oi <@u2> e <@u1>');
  assert.equal(encodeMentions('@ze chegou', members), '<@u3> chegou');
  assert.equal(encodeMentions('@josé!', members), '<@u3>!');
  assert.equal(encodeMentions('ana@Ana.com', members), 'ana@Ana.com');
  assert.equal(encodeMentions('@Anabela', members), '@Anabela');
});

test('ida e volta: o que a pessoa digita volta igual no campo de edição', () => {
  const typed = 'valeu @Ana Clara :legal:';
  const stored = encodeMessage(typed, { emojis, members });
  assert.equal(stored, 'valeu <@u2> <:legal:e-0000000001>');
  assert.equal(decodeMessage(stored, nameOf), typed);
});

test('mensagem só com emojis fica grande (até 27)', () => {
  assert.ok(isJumbo('😂😂'));
  assert.ok(isJumbo('<:legal:e-0000000001> 👍'));
  assert.ok(!isJumbo('kkk 😂'));
  assert.ok(!isJumbo('😂'.repeat(28)));
  assert.ok(!isJumbo(''));
});

test('resumo do reply: GIF, anexo e texto numa linha', () => {
  assert.equal(snippet('https://media.giphy.com/media/abc/giphy.gif', nameOf), 'GIF');
  assert.equal(snippet('', nameOf), '📎 Anexo');
  assert.equal(snippet('oi\n<@u1>\n:x:', nameOf), 'oi @Ana :x:');
});

test('só links do Giphy viram GIF', () => {
  assert.ok(GIF_URL.test('https://media2.giphy.com/media/UuzwffmvtBNGjYyEUe/giphy-downsized.gif'));
  assert.ok(!GIF_URL.test('https://exemplo.com/media/x.gif'));
  assert.ok(!GIF_URL.test('https://media.giphy.com/media/x.gif mais texto'));
});

test('emojis usáveis: o servidor aberto vem primeiro', () => {
  const servers = [{ id: 's1', emojis: [{ id: 'a', name: 'um' }] }, { id: 's2', emojis: [{ id: 'b', name: 'dois' }] }];
  assert.deepEqual(usableEmojis(servers, 's2').map((e) => e.name), ['dois', 'um']);
});

test('sugestões do @: sem acento, quem começa com o texto primeiro', () => {
  assert.deepEqual(mentionSuggestions(members, 'jo').map((m) => m.name), ['José']);
  assert.deepEqual(mentionSuggestions(members, 'cla').map((m) => m.name), ['Ana Clara']);
  assert.deepEqual(mentionSuggestions(members, 'an').map((m) => m.name), ['Ana', 'Ana Clara']);
  assert.equal(mentionSuggestions(members, '').length, 3);
});

test('formatação: negrito, itálico, riscado, código, spoiler e citação', () => {
  const types = (t) => parseMarkdown(t).map((n) => n.type);
  assert.deepEqual(types('**a** *b* _c_ ~~d~~ `e` ||f||').filter((x) => x !== 'text'), ['bold', 'italic', 'italic', 'strike', 'code', 'spoiler']);
  assert.deepEqual(types('> citado\n> também\nnormal'), ['quote', 'text']);
  const block = parseMarkdown('```js\nconst a = **1**;\n```');
  assert.deepEqual(block, [{ type: 'codeblock', lang: 'js', text: 'const a = **1**;' }]);
});

test('formatação não estraga links, menções, emojis nem snake_case', () => {
  const one = (t) => { const n = parseMarkdown(t); return n.length === 1 && n[0].type === 'text'; };
  assert.ok(one('https://x.com/a_b_c?q=*x*'));
  assert.ok(one('snake_case_nome <:gato_feliz:e-0123456789> <@u12>'));
  assert.equal(plainText('**oi** ||segredo|| _x_'), 'oi ▒▒▒ x');
});
