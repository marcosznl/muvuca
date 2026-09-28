// Foto de perfil, banner do perfil e ícone do servidor: envio (HTTP), a imagem, e as ações de remover
import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { db } from './store.js';
import { pushServer, pushUser } from './realtime.js';
import { requireServer, requirePerm, requireUser } from './guards.js';
import { receiveUpload, sniffImage, removeStored } from './uploads.js';
import { HttpError, asHttp, json } from './util.js';
import { PERMS } from '../public/js/permissions.js';

const IMAGE_DIR = path.join(DATA_DIR, 'images');
const MAX_BYTES = 2 * 1024 * 1024; // GIF animado pode ser maior; as fotos comuns o site já reduz para 256 px
const BANNER_MAX = 5 * 1024 * 1024; // banner é largo: GIF animado de banner costuma pesar mais
const NO_ICON_PERM = 'Você não tem permissão para mudar o ícone do servidor.';

export async function removeImage(id) {
  if (!id) return;
  db.deleteImage(id);
  await removeStored(IMAGE_DIR, id);
}

// POST /api/image?for=avatar   ou   ?for=banner   ou   ?for=server&server=…
export async function uploadImage(req, url) {
  const user = requireUser(req);
  const target = url.searchParams.get('for');
  let serverId = null;
  if (target === 'server') {
    serverId = asHttp(() => {
      const ctx = requireServer(user, url.searchParams.get('server'));
      requirePerm(ctx, PERMS.MANAGE_SERVER, NO_ICON_PERM);
      return ctx.snap.id;
    });
  } else if (target !== 'avatar' && target !== 'banner') throw new HttpError(400, 'Requisição inválida');

  const max = target === 'banner' ? BANNER_MAX : MAX_BYTES;
  const upload = await receiveUpload(req, { dir: IMAGE_DIR, max, tooBig: `A imagem deve ter no máximo ${max / 1024 / 1024} MB.` });
  const kind = sniffImage(upload.head);
  if (!kind) {
    await upload.discard();
    throw new HttpError(400, 'Use uma imagem PNG, JPG, GIF ou WEBP.');
  }
  const id = db.addImage(kind.mime);
  await upload.save(id);
  if (serverId) {
    await removeImage(db.setServerIcon(serverId, id));
    pushServer(serverId);
  } else if (target === 'banner') {
    await removeImage(db.setBannerImage(user.id, id));
    pushUser(user.id);
  } else {
    await removeImage(db.setAvatar(user.id, id));
    pushUser(user.id);
  }
  return { id };
}

// GET /img/<id>
export async function serveImage(res, id) {
  const img = /^i-[0-9a-f]{10}$/.test(id) ? db.image(id) : null;
  if (!img) return json(res, 404, { error: 'Imagem não encontrada' });
  try {
    const data = await fs.readFile(path.join(IMAGE_DIR, img.id));
    // Trocar a foto gera outro id: esta nunca muda, o navegador pode guardar
    res.writeHead(200, { 'Content-Type': img.mime, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
    res.end(data);
  } catch {
    json(res, 404, { error: 'Imagem não encontrada' });
  }
}

export const imageActions = {
  async 'avatar:remove'(user) {
    await removeImage(db.setAvatar(user.id, null));
    pushUser(user.id);
  },

  async 'banner:remove'(user) {
    await removeImage(db.setBannerImage(user.id, null));
    pushUser(user.id);
  },

  async 'server:icon:remove'(user, m) {
    const ctx = requireServer(user, m.serverId);
    requirePerm(ctx, PERMS.MANAGE_SERVER, NO_ICON_PERM);
    await removeImage(db.setServerIcon(ctx.snap.id, null));
    pushServer(ctx.snap.id);
  },
};
