// Qualidade das calls em tempo real (para o painel administrativo): cada pessoa em call manda, a cada 10 s,
// um resumo da própria conexão. Fica só em memória e some 30 s depois do último relatório.
const stats = new Map(); // userId -> { at, q, pub, rx }
const QUALITY = new Set(['excellent', 'good', 'poor', 'lost', 'unknown']);
const num = (v, max) => (Number.isFinite(Number(v)) ? Math.max(0, Math.min(max, Math.round(Number(v)))) : null);

export function statsOf(userId) {
  const s = stats.get(userId);
  if (!s || Date.now() - s.at > 30_000) return null;
  return s;
}

export const voiceStatsActions = {
  'voice:stats'(user, m) {
    const pub = (Array.isArray(m.pub) ? m.pub : []).slice(0, 4).map((p) => ({
      src: p?.src === 'screen' ? 'screen' : 'camera',
      w: num(p?.w, 8000), h: num(p?.h, 8000), fps: num(p?.fps, 240), kbps: num(p?.kbps, 1_000_000),
      limit: ['bandwidth', 'cpu', 'other'].includes(p?.limit) ? p.limit : null, rtt: num(p?.rtt, 60_000),
    }));
    stats.set(user.id, {
      at: Date.now(), q: QUALITY.has(m.q) ? m.q : 'unknown', pub,
      rx: { kbps: num(m.rx?.kbps, 1_000_000), loss: Number.isFinite(Number(m.rx?.loss)) ? Math.max(0, Math.min(100, Number(m.rx.loss))) : null, jitter: num(m.rx?.jitter, 60_000) },
    });
    if (stats.size > 500) for (const [id, s] of stats) if (Date.now() - s.at > 30_000) stats.delete(id);
  },
};
