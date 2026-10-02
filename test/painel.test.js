// Painel administrativo: o quadro "Precisa de atenção", a busca única e o cartão da pessoa
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, startPainel, Person } from './helpers.js';

let server;
let painel;
let ana;

before(async () => {
  server = await startServer();
  ana = await new Person(server, 'ana').register();
  painel = await startPainel(server);
});
after(async () => {
  ana?.close();
  await painel?.stop();
  await server?.stop();
});

test('sem login, o painel não responde', async () => {
  const r = await fetch(`${painel.base}/api/atencao`, { headers: { 'x-painel': '1' } });
  assert.equal(r.status, 401);
});

test('"Precisa de atenção": cada item diz o nível, o texto e onde se resolve', async () => {
  const r = await painel.get('/api/atencao');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.items));
  for (const i of r.body.items) {
    assert.ok(['bad', 'warn', 'info'].includes(i.level), i.level);
    assert.ok(i.text && typeof i.text === 'string');
    assert.match(i.tab, /^[a-z]+$/);
  }
  // No ambiente de teste não há backup nenhum: aparece como pendência em Backups
  assert.ok(r.body.items.some((i) => i.tab === 'backups' && /backup/i.test(i.text)), JSON.stringify(r.body.items));
});

test('modo manutenção ligado aparece no quadro', async () => {
  const on = await painel.post('/api/maintenance', { on: true, message: 'Teste', minutes: 0, lock: false });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  const r = await painel.get('/api/atencao');
  assert.ok(r.body.items.some((i) => i.tab === 'manut' && /manutenção/i.test(i.text)));
  await painel.post('/api/maintenance', { on: false });
  const off = await painel.get('/api/atencao');
  assert.ok(!off.body.items.some((i) => i.tab === 'manut' && /Modo manutenção/.test(i.text)));
});
