// Todas as ações que o site pode pedir pelo WebSocket ({ t: 'nome', ... })
import messages from './messages.js';
import servers from './servers.js';
import channels from './channels.js';
import roles from './roles.js';
import media from './media.js';
import profile from './profile.js';
import games from './games.js';
import friends from './friends.js';
import calls from './calls.js';
import { emojiActions } from '../emojis.js';
import { imageActions } from '../images.js';
import client from './client.js';
import { pushActions } from '../push.js';
import { voiceStatsActions } from '../voice-stats.js';

export const actions = {
  ...messages, ...servers, ...channels, ...roles, ...media, ...profile, ...games, ...friends, ...calls, ...emojiActions, ...imageActions, ...pushActions, ...voiceStatsActions, ...client,
};

// Ações frequentes e baratas que não contam no limite de ações por minuto
export const RATE_FREE = new Set([
  'gif:search', 'gif:home', 'msg', 'history', 'pins', 'voice:poke', 'time',
  'music:ended', 'music:error', 'music:duration', 'music:react',
  'game:input', 'games:list', // o jogo tem limite próprio
  'typing', 'read', 'visibility', 'client:info', 'client:error', 'voice:stats', 'presence:idle', 'games:leaderboard', 'link:preview', 'game:sync', 'games:stats', // leves e com limite próprio
]);
