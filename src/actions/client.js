// O próprio aparelho: em que app/versão o site está rodando, erros que aconteceram nele e as sessões
// (aparelhos conectados) da conta, com sair de um aparelho ou de todos os outros
import { db } from '../store.js';
import { sockets, send } from '../realtime.js';
import { fail } from '../util.js';

const text = (v, max) => String(v ?? '').replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, max);

// Derruba as abas/apps abertos com as sessões que acabaram de ser apagadas
function closeSessions(userId, hashes) {
  const gone = new Set(hashes);
  for (const ws of sockets.get(userId) ?? []) {
    if (!gone.has(db.sessionHash(ws.sessionToken))) continue;
    send(ws, { t: 'error', code: 'auth', message: 'Você saiu deste aparelho por outro. Entre de novo.' });
    try { ws.close(); } catch { /* já fechada */ }
  }
}

export default {
  // { app: 'desktop' | 'pwa' | 'web', version, platform } — o painel mostra quem está com o app desatualizado
  'client:info'(user, m, ws) {
    const client = {
      app: ['desktop', 'pwa', 'web'].includes(m.app) ? m.app : 'web',
      version: /^\d+\.\d+\.\d+$/.test(String(m.version ?? '')) ? String(m.version) : null,
      platform: text(m.platform, 20) || null,
    };
    ws.client = client;
    db.touchSession(ws.sessionToken, { client });
  },

  // Erro no site da pessoa (o site já filtra e limita; aqui ainda tem limite por hora)
  'client:error'(user, m, ws) {
    const message = text(m.message, 300);
    if (!message) return;
    db.logClientError(user.id, {
      message, stack: String(m.stack ?? '').slice(0, 2000) || null, source: text(m.source, 200) || null,
      client: JSON.stringify({ ...(ws.client ?? {}), page: text(m.page, 80) || null }), ua: ws.ua ?? null,
    });
  },

  'sessions:list'(user, m, ws) {
    return { t: 'sessions', sessions: db.sessionsOf(user.id, ws.sessionToken) };
  },
  'sessions:end'(user, m, ws) {
    const id = String(m.id ?? '');
    if (!/^[0-9a-f]{16}$/.test(id)) fail('Aparelho não encontrado.');
    if (db.sessionHash(ws.sessionToken)?.startsWith(id)) fail('Este é o aparelho que você está usando: use "Sair da conta".');
    const ended = db.endSessions(user.id, { id });
    if (!ended.length) fail('Aparelho não encontrado.');
    closeSessions(user.id, ended);
    return { t: 'sessions', sessions: db.sessionsOf(user.id, ws.sessionToken) };
  },
  'sessions:end-others'(user, m, ws) {
    const ended = db.endSessions(user.id, { exceptToken: ws.sessionToken });
    closeSessions(user.id, ended);
    return { t: 'sessions', sessions: db.sessionsOf(user.id, ws.sessionToken), ended: ended.length };
  },
};
