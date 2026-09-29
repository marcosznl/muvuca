// Relatórios de qualidade das calls (painel administrativo): guarda só números válidos e esquece em 30 s
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { voiceStatsActions, statsOf } from '../src/voice-stats.js';

const report = (user, m) => voiceStatsActions['voice:stats'](user, m);

test('guarda o relatório e limpa valores estranhos', () => {
  report({ id: 'u1' }, {
    q: 'poor',
    pub: [{ src: 'screen', w: 1920, h: 1080, fps: 29.7, kbps: 4200, limit: 'bandwidth', rtt: 35, extra: '<script>' }, { src: 'hack', w: -5, limit: 'x' }],
    rx: { kbps: 800, loss: 2.5, jitter: 12 },
  });
  const s = statsOf('u1');
  assert.equal(s.q, 'poor');
  assert.deepEqual(s.pub[0], { src: 'screen', w: 1920, h: 1080, fps: 30, kbps: 4200, limit: 'bandwidth', rtt: 35 });
  assert.equal(s.pub[1].src, 'camera');
  assert.equal(s.pub[1].w, 0);
  assert.equal(s.pub[1].limit, null);
  assert.deepEqual(s.rx, { kbps: 800, loss: 2.5, jitter: 12 });
});

test('qualidade desconhecida vira "unknown" e no máximo 4 fontes', () => {
  report({ id: 'u2' }, { q: 'ótima', pub: Array.from({ length: 10 }, () => ({ src: 'camera' })), rx: { loss: 'abc' } });
  const s = statsOf('u2');
  assert.equal(s.q, 'unknown');
  assert.equal(s.pub.length, 4);
  assert.equal(s.rx.loss, null);
});

test('relatório velho (mais de 30 s) não aparece', (t) => {
  report({ id: 'u3' }, { q: 'good', pub: [], rx: {} });
  t.mock.method(Date, 'now', () => new Date().getTime() + 31_000);
  assert.equal(statsOf('u3'), null);
});
