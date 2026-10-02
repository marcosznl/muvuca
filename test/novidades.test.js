// Lista de novidades (patch notes) do site: bem formada e da mais nova para a mais antiga
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NOVIDADES } from '../public/js/novidades-lista.js';

test('cada versão tem identificação única, data válida e itens', () => {
  assert.ok(NOVIDADES.length > 0);
  const vistas = new Set();
  for (const v of NOVIDADES) {
    assert.ok(v.versao && !vistas.has(v.versao), `versão repetida ou vazia: ${v.versao}`);
    vistas.add(v.versao);
    assert.match(v.data, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(!Number.isNaN(Date.parse(v.data)), `data inválida: ${v.data}`);
    assert.ok(Array.isArray(v.itens) && v.itens.length > 0, `versão sem itens: ${v.versao}`);
    for (const item of v.itens) assert.ok(typeof item === 'string' && item.trim(), `item vazio em ${v.versao}`);
  }
});

test('da mais nova para a mais antiga', () => {
  for (let i = 1; i < NOVIDADES.length; i++) assert.ok(NOVIDADES[i - 1].data >= NOVIDADES[i].data, `${NOVIDADES[i - 1].versao} antes de ${NOVIDADES[i].versao}`);
});
