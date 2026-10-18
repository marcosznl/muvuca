// Salas de DJ (como no plug.dj): ficam fora dos servidores, para todo mundo. Qualquer pessoa cria uma,
// com ou sem senha. Quem criou (e o dono do Muvuca) muda o nome, troca ou tira a senha e apaga a sala.
// A cabine, a fila e o chat da sala são os de sempre (ações music:* e msg).
import { db, DJ_SERVER, HOME_SERVER } from '../store.js';
import { pushServer } from '../realtime.js';
import { music } from '../music-rooms.js';
import { audit } from '../audit.js';
import { fail, clean, underLimit } from '../util.js';

export const DJ_LIMITS = { name: 40, password: 64, perPerson: 3, total: 30 };
const unlockTries = new Map(); // userId -> senhas tentadas (para ninguém ficar chutando)

// O dono do Muvuca (servidor principal) administra todas as salas
const isAdmin = (user) => db.snapshot(HOME_SERVER)?.ownerId === user.id;

function requireRoom(channelId) {
  const room = db.djRoom(channelId);
  if (!room) fail('Sala não encontrada.');
  return room;
}

function requireManager(user, room) {
  if (room.ownerId !== user.id && !isAdmin(user)) fail('Só quem criou a sala pode mudar ou apagar.');
}

const roomName = (raw) => {
  const name = clean(raw, DJ_LIMITS.name);
  if (!name) fail('Dê um nome à sala.');
  return name;
};
const roomPassword = (raw) => {
  const password = String(raw ?? '');
  if (password.length > DJ_LIMITS.password) fail(`A senha pode ter no máximo ${DJ_LIMITS.password} letras.`);
  return password;
};

// Quem criou pode pular músicas dos outros e tirar gente da cabine (como o MUSIC_MANAGE de um servidor)
export const managesDjRoom = (user, channelId) => {
  const room = db.djRoom(channelId);
  return !!room && (room.ownerId === user.id || isAdmin(user));
};

export default {
  async 'dj:create'(user, m) {
    const name = roomName(m.name);
    const password = roomPassword(m.password);
    if (!isAdmin(user) && db.djRoomCount(DJ_SERVER, user.id) >= DJ_LIMITS.perPerson) fail(`Você já criou ${DJ_LIMITS.perPerson} salas. Apague uma para criar outra.`);
    if (db.djRoomCount(DJ_SERVER) >= DJ_LIMITS.total) fail('O Muvuca já tem salas demais. Apague alguma antes.');
    const channelId = await db.createDjRoom(DJ_SERVER, { name, owner: user, password });
    pushServer(DJ_SERVER);
    audit('dj:create', { user, detail: { sala: name, senha: !!password } });
    return { t: 'dj:created', channelId };
  },

  // Sala com senha: digitou certo, fica liberada (não pede de novo até a senha mudar)
  async 'dj:unlock'(user, m) {
    const room = requireRoom(m.channelId);
    if (!room.passwordHash) return { t: 'ok' };
    if (!underLimit(unlockTries, user.id, 5, 60_000)) fail('Muitas tentativas. Espere um minuto e tente de novo.');
    if (!(await db.checkDjPassword(room.id, m.password))) fail('Senha errada.');
    db.grantDjAccess(room.id, user.id);
    pushServer(DJ_SERVER);
    return { t: 'ok' };
  },

  // Mudar o nome e/ou a senha. password: não enviado = não muda; '' = sala sem senha
  async 'dj:update'(user, m) {
    const room = requireRoom(m.channelId);
    requireManager(user, room);
    if (m.name !== undefined) db.renameDjRoom(room.id, roomName(m.name));
    if (m.password !== undefined) {
      const password = roomPassword(m.password);
      await db.setDjPassword(room.id, password);
      // Com senha nova, quem estava ouvindo sem ser quem criou sai da sala (entra de novo com a senha)
      if (password) for (const id of music.listenersOf(room.id)) if (id !== room.ownerId) music.leave(room.id, id);
    }
    pushServer(DJ_SERVER);
  },

  'dj:delete'(user, m) {
    const room = requireRoom(m.channelId);
    requireManager(user, room);
    music.dropChannel(room.id);
    db.deleteChannel(room.id);
    pushServer(DJ_SERVER);
    audit('dj:delete', { user, detail: { sala: room.name } });
  },
};
