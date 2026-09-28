// Recebimento de arquivos (emojis, fotos, anexos): grava direto no disco e confere o tipo pelo conteúdo
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HttpError } from './util.js';

// Descobre o tipo pelo conteúdo do arquivo (não confia no nome nem no que o navegador diz)
export function sniffImage(buf) {
  const ascii = (a, b) => buf.subarray(a, b).toString('latin1');
  if (buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47) {
    const actl = buf.indexOf('acTL');
    return { mime: 'image/png', animated: actl > 0 && actl < buf.indexOf('IDAT') }; // PNG animado (APNG)
  }
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return { mime: 'image/gif', animated: true };
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', animated: false };
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return { mime: 'image/webp', animated: buf.indexOf('ANIM') > 0 };
  return null;
}

// Imagens (como acima) ou vídeo MP4/MOV/WebM
export function sniffMedia(head) {
  const img = sniffImage(head);
  if (img) return { kind: 'image', mime: img.mime };
  if (head.length >= 12 && head.toString('latin1', 4, 8) === 'ftyp') {
    return { kind: 'video', mime: head.toString('latin1', 8, 10) === 'qt' ? 'video/quicktime' : 'video/mp4' };
  }
  if (head.length >= 4 && head.readUInt32BE(0) === 0x1a45dfa3) return { kind: 'video', mime: 'video/webm' };
  return null;
}

// Recebe o corpo do pedido num arquivo temporário em `dir`. Passou de `max` bytes: descarta o resto
// e avisa no fim (cortar a conexão esconderia a mensagem de erro do site).
// Devolve { head, size, save(id), discard() }: `head` são os primeiros 64 KB, para descobrir o tipo.
export async function receiveUpload(req, { dir, max, tooBig }) {
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.envio-${crypto.randomBytes(6).toString('hex')}`);
  let size = 0;
  let head = Buffer.alloc(0);
  const discard = () => fs.unlink(tmp).catch(() => {});
  await new Promise((resolve, reject) => {
    const out = createWriteStream(tmp);
    out.on('error', reject);
    req.on('data', (chunk) => {
      size += chunk.length;
      if (head.length < 65536) head = Buffer.concat([head, chunk]).subarray(0, 65536);
      if (size > max) return;
      if (!out.write(chunk)) { req.pause(); out.once('drain', () => req.resume()); }
    });
    req.on('end', () => out.end(resolve));
    req.on('error', reject);
  }).catch(async (err) => { await discard(); throw err; }); // conexão caiu no meio
  if (size > max) {
    await discard();
    throw new HttpError(413, tooBig);
  }
  return {
    head,
    size,
    save: (id) => fs.rename(tmp, path.join(dir, id)),
    discard,
  };
}

export const removeStored = (dir, id) => (id ? fs.unlink(path.join(dir, id)).catch(() => {}) : Promise.resolve());
