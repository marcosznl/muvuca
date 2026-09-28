// Anexos do chat (imagens e vídeos): envio antes da mensagem, entrega com Range e limpeza
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './config.js';
import { db } from './store.js';
import { unum } from '../db.js';
import { requireServer, requirePerm, requireUser } from './guards.js';
import { receiveUpload, sniffMedia, removeStored } from './uploads.js';
import { HttpError, asHttp, json, fail, clean, underLimit } from './util.js';
import { PERMS } from '../public/js/permissions.js';

const FILE_DIR = path.join(DATA_DIR, 'files');
export const ATTACH = {
  imageMax: 10 * 1024 * 1024,  // fotos grandes o site já reduz antes de enviar
  videoMax: 50 * 1024 * 1024,
  perMessage: 10,
  minFree: 3 * 1024 ** 3,      // para de aceitar se o disco do Mac ficar com menos de 3 GB livres
};
const attachTimes = new Map(); // userId -> horários dos últimos envios

// POST /api/attach?channel=…&name=…&w=…&h=…  (a mensagem vem depois, citando o id)
export async function uploadAttachment(req, url) {
  const user = requireUser(req);
  const channel = db.channel(url.searchParams.get('channel'));
  asHttp(() => {
    if (!channel || channel.type === 'voice') fail('Canal não encontrado.');
    const ctx = requireServer(user, channel.server_id);
    requirePerm(ctx, PERMS.SEND_MESSAGES, 'Você não tem permissão para enviar mensagens aqui.');
  });
  if (!underLimit(attachTimes, user.id, 30, 60_000)) throw new HttpError(429, 'Muitos arquivos seguidos. Espere um minuto.');
  await fs.mkdir(FILE_DIR, { recursive: true });
  const disk = await fs.statfs(FILE_DIR);
  if (disk.bavail * disk.bsize < ATTACH.minFree) throw new HttpError(507, 'O servidor está sem espaço para arquivos agora.');

  const upload = await receiveUpload(req, { dir: FILE_DIR, max: ATTACH.videoMax, tooBig: 'O arquivo deve ter no máximo 50 MB.' });
  const kind = sniffMedia(upload.head);
  const problem = !kind ? [400, 'Envie uma imagem (PNG, JPG, GIF, WEBP) ou um vídeo (MP4, MOV, WEBM).']
    : kind.kind === 'image' && upload.size > ATTACH.imageMax ? [413, 'A imagem deve ter no máximo 10 MB.'] : null;
  if (problem) {
    await upload.discard();
    throw new HttpError(...problem);
  }
  const id = `f-${crypto.randomBytes(8).toString('hex')}`;
  await upload.save(id);
  const dim = (v) => Math.max(1, Math.min(20000, Math.round(Number(v)) || 0)) || null;
  const info = {
    id, user, channelId: channel.id, ...kind, size: upload.size,
    width: dim(url.searchParams.get('w')), height: dim(url.searchParams.get('h')),
    name: clean(url.searchParams.get('name'), 100) || (kind.kind === 'video' ? 'video' : 'imagem'),
  };
  db.addFile(info);
  return { id, kind: info.kind, mime: info.mime, size: info.size, width: info.width, height: info.height, name: info.name };
}

// Anexos que esta pessoa enviou para este canal e ainda não estão em nenhuma mensagem
export function claimAttachments(ids, user, channelId) {
  return [...new Set((Array.isArray(ids) ? ids : []).map(String))]
    .slice(0, ATTACH.perMessage)
    .map((id) => db.file(id))
    .filter((f) => f && !f.message_id && f.owner_id === unum(user.id) && f.channel_id === channelId);
}

// GET /file/<id> — vídeos pedem pedaços (Range) para dar play e avançar sem baixar tudo
export async function serveFile(req, res, id) {
  const f = /^f-[0-9a-f]{16}$/.test(id) ? db.file(id) : null;
  if (!f || !f.message_id) return json(res, 404, { error: 'Arquivo não encontrado' });
  const file = path.join(FILE_DIR, f.id);
  let size;
  try { size = (await fs.stat(file)).size; } catch { return json(res, 404, { error: 'Arquivo não encontrado' }); }
  const headers = {
    'Content-Type': f.mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=31536000, immutable', // o id nunca troca de conteúdo
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(f.name)}`,
  };
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : size - 1;
    start = Math.max(0, start);
    end = Math.min(end, size - 1);
    if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    return createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': size });
  createReadStream(file).pipe(res);
}

export async function removeFiles(ids) {
  for (const id of ids) {
    db.deleteFile(id);
    await removeStored(FILE_DIR, id);
  }
}

// Envios abandonados (anexou e não mandou), anexos de mensagens/canais apagados
// e pedaços de envios que caíram no meio
export async function cleanupFiles() {
  await removeFiles(db.staleFiles(Date.now() - 3_600_000)).catch(() => {});
  const hourAgo = Date.now() - 3_600_000;
  for (const name of await fs.readdir(FILE_DIR).catch(() => [])) {
    if (!name.startsWith('.envio-')) continue;
    const st = await fs.stat(path.join(FILE_DIR, name)).catch(() => null);
    if (st && st.mtimeMs < hourAgo) await fs.unlink(path.join(FILE_DIR, name)).catch(() => {});
  }
}
