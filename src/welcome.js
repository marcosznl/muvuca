// Avisos automáticos no chat: quem chegou ou saiu do servidor, e salas de jogo abertas.
// Cada servidor liga/desliga e personaliza o texto nas configurações ({user} e {server}).
import { db } from './store.js';
import { SYSTEM } from '../db.js';
import { sendToServer } from './realtime.js';
import { underLimit } from './util.js';

const gameAnnounceTimes = new Map(); // userId -> quando anunciou (no máximo 1 sala a cada 2 min)

// Canal escolhido ou, se ele não existir mais, o primeiro canal de texto
export function announceChannel(snap) {
  const text = snap.channels.filter((c) => c.type === 'text');
  return (text.find((c) => c.id === snap.welcome.channelId) ?? text[0])?.id ?? null;
}

const fill = (template, who, snap) => template.replaceAll('{user}', who).replaceAll('{server}', snap.name);

function post(snap, text, kind, meta = null) {
  const channelId = announceChannel(snap);
  if (!channelId) return;
  sendToServer(snap.id, { t: 'msg', msg: db.addSystemMessage(channelId, text, kind, meta) });
}

export function announceJoin(serverId, user) {
  const snap = db.snapshot(serverId);
  if (snap?.welcome.on) post(snap, fill(snap.welcome.joinText, `<@${user.id}>`, snap), SYSTEM.join);
}

// Depois de sair a pessoa não é mais membro: vai o nome, não a menção
export function announceLeave(serverId, user) {
  const snap = db.snapshot(serverId);
  if (snap?.welcome.on) post(snap, fill(snap.welcome.leaveText, user.name, snap), SYSTEM.leave);
}

// "Fulano abriu uma sala de Tron" nos servidores da pessoa que deixam esse aviso ligado
export function announceGameRoom(user, room, gameName) {
  if (!underLimit(gameAnnounceTimes, user.id, 1, 120_000)) return;
  for (const serverId of db.serverIdsOf(user)) {
    const snap = db.snapshot(serverId);
    if (snap?.welcome.gameAnnounce) {
      post(snap, `<@${user.id}> abriu uma sala de ${gameName} — bora jogar?`, SYSTEM.game, { roomId: room.id, game: room.game });
    }
  }
}
