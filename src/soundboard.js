// Soundboard: sons curtos que todo mundo da call ouve (cada um toca no próprio navegador).
// Os sons prontos ("builtin:…") são gerados no site; os do servidor são arquivos enviados por quem gerencia emojis.
import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { db } from './store.js';
import { pushServer, sendToUser } from './realtime.js';
import { requireServer, requirePerm, requireUser } from './guards.js';
import { receiveUpload, removeStored } from './uploads.js';
import { voiceChannelOf, voicePeople } from './voice.js';
import { HttpError, asHttp, json, fail, clean, underLimit } from './util.js';
import { PERMS } from '../public/js/permissions.js';

const SOUND_DIR = path.join(DATA_DIR, 'sounds');
const MAX_BYTES = 1024 * 1024;
const LIMIT = 30;
export const BUILTIN = ['badumtss', 'tada', 'buzina', 'trombone', 'sino', 'aplausos', 'suspense', 'risada'];
const playTimes = new Map(); // userId -> quando tocou (no máximo 1 som a cada 2 s)

export const removeSoundFile = (id) => removeStored(SOUND_DIR, id);

// MP3, OGG, WAV, WebM ou M4A
function sniffSound(h) {
  const ascii = (a, b) => h.subarray(a, b).toString('latin1');
  if (ascii(0, 3) === 'ID3' || (h[0] === 0xff && (h[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (ascii(0, 4) === 'OggS') return 'audio/ogg';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'audio/wav';
  if (h.length >= 4 && h.readUInt32BE(0) === 0x1a45dfa3) return 'audio/webm';
  if (ascii(4, 8) === 'ftyp') return 'audio/mp4';
  return null;
}

// POST /api/sound?server=…&name=…&emoji=…
export async function uploadSound(req, url) {
  const user = requireUser(req);
  const ctx = asHttp(() => {
    const c = requireServer(user, url.searchParams.get('server'));
    if (c.snap.kind === 'dm') fail('Conversa privada não tem soundboard.');
    requirePerm(c, PERMS.MANAGE_EMOJIS, 'Você não tem permissão para gerenciar os sons.');
    return c;
  });
  const name = clean(url.searchParams.get('name'), 24);
  const emoji = clean(url.searchParams.get('emoji'), 8);
  if (!name) throw new HttpError(400, 'Dê um nome ao som.');
  if ((ctx.snap.sounds ?? []).length >= LIMIT) throw new HttpError(400, `Este servidor já tem ${LIMIT} sons.`);
  const upload = await receiveUpload(req, { dir: SOUND_DIR, max: MAX_BYTES, tooBig: 'O som deve ter no máximo 1 MB.' });
  const mime = sniffSound(upload.head);
  if (!mime) {
    await upload.discard();
    throw new HttpError(400, 'Use um áudio MP3, OGG, WAV, WEBM ou M4A.');
  }
  const id = db.createSound({ serverId: ctx.snap.id, name, emoji, mime, user });
  await upload.save(id);
  pushServer(ctx.snap.id);
  return { id, name };
}

// GET /sound/<id>
export async function serveSound(req, res, id) {
  const s = /^snd-[0-9a-f]{10}$/.test(id) ? db.sound(id) : null;
  if (!s) return json(res, 404, { error: 'Som não encontrado' });
  try {
    const data = await fs.readFile(path.join(SOUND_DIR, s.id));
    res.writeHead(200, { 'Content-Type': s.mime, 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
    res.end(data);
  } catch {
    json(res, 404, { error: 'Som não encontrado' });
  }
}

export const soundActions = {
  // Toca para todo mundo da call em que a pessoa está
  'sound:play'(user, m) {
    const channelId = voiceChannelOf(user.id);
    if (!channelId) fail('Entre numa sala de voz para usar o soundboard.');
    const channel = db.channel(channelId);
    const ctx = requireServer(user, channel.server_id);
    requirePerm(ctx, PERMS.SPEAK, 'Você não tem permissão para falar nesta sala.');
    const sound = String(m.sound ?? '');
    const builtin = sound.startsWith('builtin:') && BUILTIN.includes(sound.slice(8));
    const own = !builtin && db.sound(sound);
    if (!builtin && (!own || own.server_id !== channel.server_id)) fail('Som não encontrado.');
    if (!underLimit(playTimes, user.id, 1, 2000)) fail('Calma! Um som de cada vez.');
    const msg = { t: 'sound', sound, url: own ? `/sound/${own.id}` : null, by: user.id, name: own?.name ?? sound.slice(8) };
    for (const p of voicePeople(channelId)) sendToUser(p.id, msg);
  },

  'sound:delete'(user, m) {
    const s = db.sound(m.soundId);
    if (!s) fail('Som não encontrado.');
    const ctx = requireServer(user, s.server_id);
    requirePerm(ctx, PERMS.MANAGE_EMOJIS, 'Você não tem permissão para gerenciar os sons.');
    db.deleteSound(s.id);
    removeSoundFile(s.id);
    pushServer(ctx.snap.id);
  },
};
