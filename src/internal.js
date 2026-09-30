// Números ao vivo para o painel administrativo (painel/): quem está online, em voz, em live, jogando.
// Só responde para pedidos de dentro do próprio Mac (sem passar pelo Caddy) que tragam a chave do
// painel (data/painel-key, criada aqui na primeira vez e legível só pelo seu usuário).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { DATA_DIR } from './config.js';
import { db } from './store.js';
import { sockets, statusOf } from './realtime.js';
import { voiceAll } from './voice.js';
import { music } from './music-rooms.js';
import { listRooms } from './games/lobby.js';
import { statsOf } from './voice-stats.js';
import { bandwidthStats } from './throttle.js';

const KEY_FILE = path.join(DATA_DIR, 'painel-key');
let key = '';
try {
  key = fs.readFileSync(KEY_FILE, 'utf8').trim();
} catch {
  key = crypto.randomBytes(32).toString('hex');
  try { fs.writeFileSync(KEY_FILE, `${key}\n`, { mode: 0o600 }); } catch (err) { console.error('painel-key:', err.message); }
}

const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
export function isInternal(req) {
  if (req.headers['x-forwarded-for'] || req.headers['x-forwarded-host']) return false; // veio da internet via Caddy
  if (!LOOPBACK.has(req.socket.remoteAddress)) return false;
  const given = Buffer.from(String(req.headers['x-painel-key'] ?? ''));
  const want = Buffer.from(key);
  return key.length > 0 && given.length === want.length && crypto.timingSafeEqual(given, want);
}

export function internalStats(startedAt) {
  const users = [];
  for (const [id, set] of sockets) {
    const u = db.userById(id);
    if (!u) continue;
    users.push({ id, username: u.username, name: u.name, status: statusOf(id), tabs: set.size,
      hidden: [...set].every((ws) => ws.hidden), ip: [...set][0]?.ip ?? null });
  }
  const channels = new Map(db.voiceChannels().map((c) => [c.id, c]));
  const voice = [];
  for (const [channelId, people] of Object.entries(voiceAll())) {
    if (!people.length) continue;
    const c = channels.get(channelId);
    const server = c ? db.server(c.server_id) : null;
    // Ligação de mensagem direta: só a quantidade (conversa privada)
    if (server?.kind === 'dm') { voice.push({ id: channelId, private: true, count: people.length }); continue; }
    voice.push({
      id: channelId, server: server?.name ?? '?', name: c?.name ?? '?', count: people.length,
      people: people.map((p) => ({ name: p.name, muted: !!p.muted, deafened: !!p.deafened, camera: !!p.camera, streaming: !!p.streaming, net: statsOf(p.id) })),
    });
  }
  const musicRooms = [];
  for (const c of db.musicChannels()) {
    const r = music.rooms.get(c.id);
    if (!r || !r.listeners.size) continue;
    const snap = music.snapshot(c.id);
    musicRooms.push({ name: c.name, server: db.server(c.server_id)?.name ?? '?', listeners: snap.listeners.length, booth: snap.booth.length, track: snap.track?.title ?? null });
  }
  const games = listRooms().map((r) => ({ game: r.game, status: r.status, players: r.players.map((p) => p.name), spectators: r.spectators }));
  const mem = process.memoryUsage();
  return {
    at: Date.now(),
    upSince: startedAt,
    pid: process.pid,
    node: process.version,
    memory: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal, external: mem.external },
    // O medidor soma a própria resolução (20 ms) em cada leitura: tira para mostrar só o atraso de verdade
    loopDelayMs: Math.max(0, Math.round((loopDelay.mean / 1e6 - 20) * 10) / 10),
    loopDelayMaxMs: Math.max(0, Math.round(loopDelay.max / 1e6 - 20)),
    connections: [...sockets.values()].reduce((n, s) => n + s.size, 0),
    users, voice, music: musicRooms, games,
    bandwidth: bandwidthStats(),
  };
}
// A média do atraso vale por janela: zera a cada consulta de 10 min
setInterval(() => loopDelay.reset(), 600_000).unref();
