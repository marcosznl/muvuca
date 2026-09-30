// Trava de velocidade dos arquivos: segura o download quando está ligada; "esperta" solta sem ninguém na voz
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, Person, WEBM } from './helpers.js';

let server;
let dono;
let geral;
let key;
before(async () => {
  server = await startServer();
  dono = await new Person(server, 'dono').register();
  geral = dono.servers[0].channels.find((c) => c.type === 'text').id;
  key = fs.readFileSync(path.join(server.dir, 'painel-key'), 'utf8').trim();
});
after(async () => {
  dono?.close();
  await server?.stop();
});
const internal = (pathname, body) => fetch(`${server.base}${pathname}`, { method: 'POST', headers: { 'x-painel-key': key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, body: await r.json() }));
const timeDownload = async (url) => {
  const t = Date.now();
  const r = await fetch(url);
  const size = (await r.arrayBuffer()).byteLength;
  return { ms: Date.now() - t, size };
};

test('trava de velocidade: 5 Mbps segura o download; esperta sem ninguém na voz vai no máximo', async () => {
  // Anexo de ~1,25 MB (vídeo "webm" de mentira, só para ter tamanho)
  const video = Buffer.concat([WEBM, Buffer.alloc(1_250_000)]);
  const up = await dono.upload('/api/attach', { channel: geral, name: 'grande.webm' }, video);
  assert.equal(up.status, 200);
  const msg = await dono.say(geral, 'arquivo grande', { attachments: [up.body.id] });
  const url = server.base + msg.attachments[0].url;

  // Sempre travada (não esperta), 5 Mbps = 625 KB/s: 1,25 MB leva mais de 1,5 s
  const set = await internal('/internal/bandwidth', { perMbps: 5, totalMbps: 10, smart: false });
  assert.deepEqual(set.body, { perMbps: 5, totalMbps: 10, smart: false });
  const slow = await timeDownload(url);
  assert.equal(slow.size, video.length, 'o arquivo chega inteiro');
  assert.ok(slow.ms > 1500, `travado: levou ${slow.ms} ms`);

  // Esperta e ninguém na voz: sai na velocidade máxima
  await internal('/internal/bandwidth', { smart: true });
  const fast = await timeDownload(url);
  assert.equal(fast.size, video.length);
  assert.ok(fast.ms < 800, `solto: levou ${fast.ms} ms`);

  // Valores fora da faixa são ajustados (e o painel vê os números)
  const odd = await internal('/internal/bandwidth', { perMbps: 5000, totalMbps: 1 });
  assert.equal(odd.body.totalMbps, 10);
  assert.equal(odd.body.perMbps, 10, 'por arquivo nunca passa do total');
  const stats = await fetch(`${server.base}/internal/stats`, { headers: { 'x-painel-key': key } }).then((r) => r.json());
  assert.equal(stats.bandwidth.limiting, false, 'esperta e ninguém na voz: solta');
  assert.ok(stats.bandwidth.totalBytes >= video.length * 2);
});
