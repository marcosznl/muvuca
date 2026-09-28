// Amigos: pedir (pelo @usuário ou pelo perfil), aceitar, recusar/cancelar e desfazer amizade.
// Os dois lados recebem a lista atualizada na hora.
import { db } from '../store.js';
import { sendToUser } from '../realtime.js';
import { fail } from '../util.js';

const FRIENDS_MAX = 500;

export function sendFriends(userId) {
  sendToUser(userId, { t: 'friends', friends: db.friendsOf(userId) });
}

function targetOf(user, m) {
  const username = String(m.username ?? '').trim().replace(/^@/, '').toLowerCase();
  const id = m.userId ? (db.userById(String(m.userId)) ? String(m.userId) : null) : username ? db.userIdByUsername(username) : null;
  if (!id) fail(username ? `Não achei ninguém com o usuário @${username}. Confira como está escrito.` : 'Escolha alguém.');
  if (id === user.id) fail('Você não pode adicionar a si mesmo.');
  return id;
}

export default {
  'friend:add'(user, m) {
    const other = targetOf(user, m);
    const before = db.friendship(user.id, other);
    if (before === 'friend') fail('Vocês já são amigos.');
    if (before === 'outgoing') fail('Você já mandou um pedido para essa pessoa.');
    if (!before && db.friendsOf(user.id).length >= FRIENDS_MAX) fail(`Limite de ${FRIENDS_MAX} amigos e pedidos.`);
    const status = db.requestFriend(user.id, other);
    sendFriends(user.id);
    sendFriends(other);
    if (status === 'outgoing') sendToUser(other, { t: 'friend:request', from: db.userById(user.id) });
    return { t: 'ok', status, name: db.userById(other).name };
  },

  'friend:accept'(user, m) {
    const other = targetOf(user, m);
    if (!db.acceptFriend(user.id, other)) fail('Esse pedido não existe mais.');
    sendFriends(user.id);
    sendFriends(other);
  },

  // Recusar, cancelar o pedido ou desfazer a amizade
  'friend:remove'(user, m) {
    const other = targetOf(user, m);
    db.removeFriend(user.id, other);
    sendFriends(user.id);
    sendFriends(other);
  },
};
