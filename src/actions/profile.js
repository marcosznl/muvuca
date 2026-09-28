// Ações do perfil: nome de exibição, "Sobre mim", cor do banner e status
import { db } from '../store.js';
import { pushUser, sendToUser, broadcastPresence, presencePref, autoIdle, PRESENCES } from '../realtime.js';
import { renameInVoice } from '../voice.js';
import { fail, clean, validColor } from '../util.js';

export default {
  'profile:update'(user, m) {
    const name = clean(m.name, 32);
    if (!name) fail('Seu nome não pode ficar vazio.');
    const bio = String(m.bio ?? '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 190);
    const banner = validColor(m.banner) ?? null;
    const before = db.userById(user.id);
    db.updateProfile(user.id, { name, bio, banner });
    user.name = name; // esta conexão também passa a usar o nome novo
    pushUser(user.id);
    if (before.name !== name) renameInVoice(user.id, name);
  },

  // Online / ausente / não perturbe / invisível (fica salvo)
  'presence:set'(user, m) {
    if (!PRESENCES.includes(m.presence)) fail('Status inválido.');
    db.setPresence(user.id, m.presence);
    presencePref.set(user.id, m.presence);
    sendToUser(user.id, { t: 'me', you: db.userById(user.id) });
    broadcastPresence();
  },

  // Ausente automático: o site avisa quando a pessoa fica parada (e quando volta)
  'presence:idle'(user, m) {
    const had = autoIdle.has(user.id);
    if (m.idle) autoIdle.add(user.id); else autoIdle.delete(user.id);
    if (had !== autoIdle.has(user.id)) broadcastPresence();
  },

  // Texto do status ("jogando", "estudando"…), aparece embaixo do nome
  'status:text'(user, m) {
    db.setStatusText(user.id, clean(m.text, 60));
    pushUser(user.id);
  },
};
