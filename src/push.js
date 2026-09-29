// Notificações no celular/computador mesmo com o site fechado (Web Push).
// As chaves do servidor (VAPID) são criadas uma vez e ficam em data/vapid.json.
import fs from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';
import { DATA_DIR } from './config.js';
import { db } from './store.js';
import { isWatching, statusOf } from './realtime.js';
import { fail } from './util.js';

const KEYS_FILE = path.join(DATA_DIR, 'vapid.json');

function loadKeys() {
  try { return JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8')); } catch { /* primeira vez */ }
  const keys = webpush.generateVAPIDKeys();
  fs.writeFileSync(KEYS_FILE, JSON.stringify(keys), { mode: 0o600 });
  return keys;
}

const keys = loadKeys();
webpush.setVapidDetails('mailto:muvuca@localhost', keys.publicKey, keys.privateKey);

export const publicKey = () => keys.publicKey;

export const pushActions = {
  // O navegador aceitou: guarda o endereço de entrega deste aparelho
  'push:subscribe'(user, m) {
    const endpoint = String(m.sub?.endpoint ?? '');
    const k = m.sub?.keys ?? {};
    if (!/^https:\/\/[^\s]{10,500}$/.test(endpoint) || typeof k.p256dh !== 'string' || typeof k.auth !== 'string') fail('Inscrição inválida.');
    if (k.p256dh.length > 200 || k.auth.length > 100) fail('Inscrição inválida.');
    db.addPushSub(user.id, endpoint, { p256dh: k.p256dh, auth: k.auth });
  },
  'push:unsubscribe'(user, m) {
    db.deleteUserPushSub(user.id, String(m.endpoint ?? '')); // só o aparelho da própria pessoa
  },
  // A aba ficou visível/escondida (com ela à vista, não precisa notificar)
  visibility(user, m, ws) {
    if (ws) ws.hidden = !m.visible;
  },
};

// Manda para todos os aparelhos da pessoa, se ela não estiver com o site aberto na frente e não estiver em "não perturbe"
export function notify(userId, payload) {
  if (isWatching(userId) || statusOf(userId) === 'dnd') return;
  const body = JSON.stringify(payload);
  for (const sub of db.pushSubs(userId)) {
    webpush.sendNotification(sub, body, { TTL: 3600 }).catch((err) => {
      // Aparelho desinstalou ou desativou: esquece esse endereço
      if (err.statusCode === 404 || err.statusCode === 410) db.deletePushSub(sub.endpoint);
    });
  }
}
