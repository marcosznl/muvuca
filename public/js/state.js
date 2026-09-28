// Estado do site (o que veio do servidor + escolhas da pessoa)
import { store, setAvatarLookup } from './util.js';
import { computePerms, can, PERMS } from './permissions.js';

export const state = {
  me: null,             // { id, username, name }
  servers: [],          // snapshots: { id, name, color, ownerId, channels, roles, members }
  online: new Set(),    // ids de quem está com o site aberto
  voice: {},            // canal de voz -> [{ id, name, muted, deafened, camera, streaming }]
  music: {},            // canal de música -> { listeners, nowPlaying }
  view: { serverId: null, channelId: null },
  messages: new Map(),  // canal de texto -> { list, hasMore, loaded, loading }
  unread: {},           // canal de texto -> quantidade
  mentions: {},         // canal -> quantas mensagens não lidas mencionam você
  readState: {},        // canal -> id da última mensagem lida
  status: {},           // pessoa online -> 'idle' (ausente) ou 'dnd' (não perturbe); sem nada = online
  typing: new Map(),    // canal -> Map(pessoa -> até quando mostrar "digitando")
  mutes: new Set(),     // canais e servidores que você silenciou
  activity: {},         // pessoa -> { game, name, roomId } ("Jogando Tron")
  friends: [],          // [{ user, status: 'friend' | 'incoming' | 'outgoing' }]
  micOn: store.get('micOn') !== '0',
  deafened: store.get('deafened') === '1',
};

// Foto de perfil de qualquer pessoa que aparece nos seus servidores
// Perfil mais recente de alguém (você ou um membro); `server` dá prioridade ao membro daquele servidor
export function profileOf(userId, server = null) {
  const member = server?.members.find((x) => x.id === userId)
    ?? state.servers.flatMap((s) => s.members).find((x) => x.id === userId);
  if (userId === state.me?.id) return { ...member, ...state.me };
  return member ?? state.friends.find((f) => f.user.id === userId)?.user ?? null; // amigo sem servidor em comum
}
export const nameOf = (userId) => profileOf(userId)?.name ?? null;

export function avatarOf(userId) {
  if (userId === state.me?.id) return state.me.avatar ?? null;
  for (const s of state.servers) {
    const m = s.members.find((x) => x.id === userId);
    if (m) return m.avatar ?? null;
  }
  return state.friends.find((f) => f.user.id === userId)?.user.avatar ?? null;
}
setAvatarLookup(avatarOf);

export const serverById = (id) => state.servers.find((s) => s.id === id) ?? null;
export const currentServer = () => serverById(state.view.serverId);

export function findChannel(channelId) {
  for (const s of state.servers) {
    const c = s.channels.find((x) => x.id === channelId);
    if (c) return { server: s, channel: c };
  }
  return { server: null, channel: null };
}

export const currentChannel = () => findChannel(state.view.channelId).channel;

export const permsIn = (serverOrId) => {
  const s = typeof serverOrId === 'string' ? serverById(serverOrId) : serverOrId;
  return computePerms(s, state.me?.id);
};
export const canIn = (serverOrId, flag) => can(permsIn(serverOrId), flag);
export { PERMS };

export function upsertServer(snapshot) {
  const i = state.servers.findIndex((s) => s.id === snapshot.id);
  if (i >= 0) state.servers[i] = snapshot;
  else state.servers.push(snapshot);
}

export function removeServer(id) {
  const s = serverById(id);
  state.servers = state.servers.filter((x) => x.id !== id);
  for (const c of s?.channels ?? []) {
    state.messages.delete(c.id);
    delete state.unread[c.id];
  }
}

export const firstTextChannel = (server) => server?.channels.find((c) => c.type === 'text') ?? null;

// Último canal de texto aberto em cada servidor (para voltar nele ao trocar de servidor)
export function rememberTextChannel(serverId, channelId) {
  const map = JSON.parse(store.get('lastChannels') || '{}');
  map[serverId] = channelId;
  store.set('lastChannels', JSON.stringify(map));
}
export function rememberedTextChannel(server) {
  const id = JSON.parse(store.get('lastChannels') || '{}')[server.id];
  return server.channels.find((c) => c.id === id && c.type === 'text') ?? firstTextChannel(server);
}

// Silenciado: o próprio canal ou o servidor inteiro
export const isMuted = (channelId, serverId) => state.mutes.has(channelId) || state.mutes.has(serverId);
export const serverUnread = (server) => (state.mutes.has(server.id) ? 0
  : server.channels.reduce((n, c) => n + (state.mutes.has(c.id) ? 0 : state.unread[c.id] || 0), 0));
export const serverMentions = (server) => server.channels.reduce((n, c) => n + (state.mentions[c.id] || 0), 0);

// 'online' | 'idle' | 'dnd' | 'invisible' (só você) | 'offline'
export function statusOf(userId) {
  if (userId === state.me?.id && state.me.presence === 'invisible') return 'invisible';
  if (!state.online.has(userId)) return 'offline';
  return state.status[userId] ?? 'online';
}
export const STATUS_LABEL = { online: 'Online', idle: 'Ausente', dnd: 'Não perturbe', invisible: 'Invisível', offline: 'Offline' };
