// XP da conta (um só para todos os servidores): mensagens, tempo em call e jogos. Regras pensadas para não dar
// para "farmar": XP de mensagem no máximo 1 vez por minuto, só em call com mais gente e sem estar ensurdecido.
import { db } from './store.js';
import { sendToUser, pushUser } from './realtime.js';
import { voiceAll } from './voice.js';
import { xpInfo } from './xp-curve.js';

export const XP_RULES = {
  message: { min: 15, max: 25, cooldownMs: 60_000, minChars: 5 },
  voicePerMinute: 3,  // em call com pelo menos mais 1 pessoa, sem estar ensurdecido
  gamePlayed: 10,     // partida com 2 ou mais pessoas
  gameWon: 40,
};

const lastMessageXp = new Map(); // userId -> quando ganhou XP por mensagem

export function award(userId, amount, reason) {
  amount = Math.floor(amount);
  if (!(amount > 0) || !db.userById(userId)) return;
  const before = xpInfo(db.xpOf(userId));
  const after = xpInfo(db.addXp(userId, amount));
  const levelUp = after.level > before.level ? after.level : null;
  sendToUser(userId, { t: 'xp', xp: after, gained: amount, reason, levelUp, rank: db.xpRank(userId) });
  if (levelUp) pushUser(userId); // o nível novo aparece para os outros (perfil e lista de membros)
}

// Mensagem mandada: 15 a 25 XP, no máximo uma vez por minuto, e só se tiver conteúdo de verdade
export function xpForMessage(user, text, fileCount) {
  const r = XP_RULES.message;
  if (String(text ?? '').replace(/\s+/g, '').length < r.minChars && !fileCount) return;
  const now = Date.now();
  if (now - (lastMessageXp.get(user.id) ?? 0) < r.cooldownMs) return;
  lastMessageXp.set(user.id, now);
  if (lastMessageXp.size > 5000) for (const [id, t] of lastMessageXp) if (now - t > r.cooldownMs) lastMessageXp.delete(id);
  award(user.id, r.min + Math.floor(Math.random() * (r.max - r.min + 1)), 'message');
}

// Partida terminada com 2 ou mais pessoas: todo mundo ganha um pouco; quem venceu, mais
export function xpForGame(peopleIds, winnerIds) {
  if (peopleIds.length < 2) return;
  const winners = new Set(winnerIds);
  for (const id of peopleIds) award(id, XP_RULES.gamePlayed + (winners.has(id) ? XP_RULES.gameWon : 0), winners.has(id) ? 'game-won' : 'game');
}

// Tempo em call: a cada minuto, quem está numa call com mais gente (e ouvindo) ganha XP
function voiceTick() {
  for (const people of Object.values(voiceAll())) {
    if (people.length < 2) continue;
    for (const p of people) if (!p.deafened) award(p.id, XP_RULES.voicePerMinute, 'voice');
  }
}
setInterval(voiceTick, 60_000).unref();
