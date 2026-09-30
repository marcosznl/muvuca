// Canais de música: as salas (music.js) ligadas ao banco e aos avisos do site
import { MusicRooms, createYoutube } from '../music.js';
import { YOUTUBE_API_KEY } from './config.js';
import { db } from './store.js';
import { sendToUser, sendToServer } from './realtime.js';
import { requireServer, requireChannelView } from './guards.js';
import { canSeeChannel } from '../public/js/permissions.js';
import { fail } from './util.js';

export const music = new MusicRooms({
  youtube: createYoutube(YOUTUBE_API_KEY),
  hooks: {
    broadcast(channelId, state) {
      for (const id of state.listeners) sendToUser(id, { t: 'music:state', channelId, state });
    },
    sendQueue(userId, channelId, queue) {
      sendToUser(userId, { t: 'music:queue', channelId, queue });
    },
    presence(channelId) {
      const channel = db.channel(channelId);
      if (channel) sendToServer(channel.server_id, { t: 'music:presence', channelId, ...musicPresence(channelId) });
    },
    system(channelId, text) {
      const channel = db.channel(channelId);
      if (channel) sendToServer(channel.server_id, { t: 'msg', msg: db.addSystemMessage(channelId, text) });
    },
    userName: (id) => db.userName(id),
    recordPlay: (play) => db.addPlay(play),
  },
});

const musicPresence = (channelId) => ({ listeners: music.listenersOf(channelId), nowPlaying: music.nowPlaying(channelId) });

export function musicFor(userId) {
  const out = {};
  for (const serverId of db.serverIdsOf({ id: userId })) {
    const snap = db.snapshot(serverId);
    for (const c of snap?.channels ?? []) if (c.type === 'music' && canSeeChannel(snap, userId, c)) out[c.id] = musicPresence(c.id);
  }
  return out;
}

// Saiu (ou foi removido) de um servidor: sai também das salas de música dele
export function leaveMusicOf(serverId, userId) {
  for (const c of db.musicChannels()) if (c.server_id === serverId) music.leave(c.id, userId);
}

export function requireMusicChannel(user, channelId) {
  const channel = db.channel(channelId);
  if (!channel || channel.type !== 'music') fail('Canal de música não encontrado.');
  const ctx = requireServer(user, channel.server_id);
  requireChannelView(ctx, user.id, channel.id, 'Canal de música não encontrado.');
  return { channel, ...ctx };
}
