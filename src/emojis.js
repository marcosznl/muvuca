// Emojis do servidor: envio (HTTP), a imagem, e as ações de renomear/excluir
import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { db } from './store.js';
import { pushServer } from './realtime.js';
import { requireServer, requirePerm, requireUser } from './guards.js';
import { receiveUpload, sniffImage, removeStored } from './uploads.js';
import { HttpError, asHttp, json, fail } from './util.js';
import { PERMS } from '../public/js/permissions.js';

const EMOJI_DIR = path.join(DATA_DIR, 'emojis');
const MAX_BYTES = 256 * 1024; // como no Discord
const LIMIT = 50;             // por servidor: 50 estáticos + 50 animados
const NAME = /^[A-Za-z0-9_]{2,32}$/;
const BAD_NAME = 'O nome do emoji deve ter de 2 a 32 caracteres: letras, números ou _.';

export const removeEmojiFile = (id) => removeStored(EMOJI_DIR, id);

// POST /api/emojis?server=…&name=…
export async function uploadEmoji(req, url) {
  const user = requireUser(req);
  const name = String(url.searchParams.get('name') ?? '');
  const ctx = asHttp(() => {
    const c = requireServer(user, url.searchParams.get('server'));
    requirePerm(c, PERMS.MANAGE_EMOJIS, 'Você não tem permissão para gerenciar emojis.');
    return c;
  });
  if (!NAME.test(name)) throw new HttpError(400, BAD_NAME);
  if (db.emojiNameTaken(ctx.snap.id, name)) throw new HttpError(409, `Já existe um emoji chamado :${name}: neste servidor.`);
  const upload = await receiveUpload(req, { dir: EMOJI_DIR, max: MAX_BYTES, tooBig: 'O emoji deve ter no máximo 256 KB.' });
  const kind = sniffImage(upload.head);
  if (!kind) {
    await upload.discard();
    throw new HttpError(400, 'Use uma imagem PNG, JPG, GIF ou WEBP.');
  }
  if (db.countEmojis(ctx.snap.id, kind.animated) >= LIMIT) {
    await upload.discard();
    throw new HttpError(400, `Este servidor já tem ${LIMIT} emojis ${kind.animated ? 'animados' : 'estáticos'}.`);
  }
  const id = db.createEmoji({ serverId: ctx.snap.id, name, animated: kind.animated, mime: kind.mime, user });
  await upload.save(id);
  pushServer(ctx.snap.id);
  return { id, name, animated: kind.animated };
}

// GET /emoji/<id>
export async function serveEmoji(req, res, id) {
  const e = /^e-[0-9a-f]{10}$/.test(id) ? db.emoji(id) : null;
  if (!e) return json(res, 404, { error: 'Emoji não encontrado' });
  // O navegador guarda por 10 min e depois só confere (304): emoji excluído some para todos
  const headers = { 'Cache-Control': 'public, max-age=600', ETag: `"${e.id}"`, 'X-Content-Type-Options': 'nosniff' };
  if (req.headers['if-none-match'] === headers.ETag) { res.writeHead(304, headers); return res.end(); }
  try {
    const data = await fs.readFile(path.join(EMOJI_DIR, e.id));
    res.writeHead(200, { 'Content-Type': e.mime, ...headers });
    res.end(data);
  } catch {
    json(res, 404, { error: 'Emoji não encontrado' });
  }
}

function requireEmoji(user, emojiId) {
  const e = db.emoji(emojiId);
  if (!e) fail('Emoji não encontrado.');
  const ctx = requireServer(user, e.server_id);
  requirePerm(ctx, PERMS.MANAGE_EMOJIS, 'Você não tem permissão para gerenciar emojis.');
  return { e, ctx };
}

export const emojiActions = {
  'emoji:rename'(user, m) {
    const { e, ctx } = requireEmoji(user, m.emojiId);
    const name = String(m.name ?? '');
    if (!NAME.test(name)) fail(BAD_NAME);
    if (db.emojiNameTaken(e.server_id, name, e.id)) fail(`Já existe um emoji chamado :${name}: neste servidor.`);
    db.renameEmoji(e.id, name);
    pushServer(ctx.snap.id);
  },

  'emoji:delete'(user, m) {
    const { e, ctx } = requireEmoji(user, m.emojiId);
    db.deleteEmoji(e.id);
    removeEmojiFile(e.id);
    pushServer(ctx.snap.id);
  },
};
