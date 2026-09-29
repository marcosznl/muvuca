// Arquivos do site (pasta public/) e a biblioteca de voz, com cache que confere antes de usar
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { ROOT, PUBLIC_DIR } from './config.js';
import { json } from './util.js';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm',
};

// CSP das páginas: só roda script do próprio Muvuca (e os embutidos no HTML, pela impressão digital exata),
// do YouTube (player da música) e worklets de áudio (blob:). Imagens https de fora (GIFs, prévias de link).
// O LiveKit no modo local fica em ws://…:7880 (fora da porta do site).
const cspCache = new Map(); // etag -> cabeçalho
function cspFor(html) {
  const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((m) => `'sha256-${crypto.createHash('sha256').update(m[1]).digest('base64')}'`);
  return [
    "default-src 'self'",
    `script-src 'self' blob: ${hashes.join(' ')} https://www.youtube.com https://s.ytimg.com`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob: https:",
    "font-src 'self'",
    "connect-src 'self' ws://localhost:7880 ws://127.0.0.1:7880 wss:",
    "frame-src https://www.youtube.com https://www.youtube-nocookie.com",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

// Envia o arquivo, ou "não mudou" (304) se o navegador já tem esta versão.
// "no-cache" = o navegador sempre pergunta antes de usar o que guardou: atualizações chegam na hora.
async function sendFile(req, res, file, type) {
  const st = await fs.stat(file);
  const etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`; // muda quando o arquivo muda
  const headers = { 'Content-Type': type, 'Cache-Control': 'no-cache', ETag: etag };
  if (type.startsWith('text/html')) {
    if (!cspCache.has(etag)) cspCache.set(etag, cspFor(await fs.readFile(file, 'utf8')));
    headers['Content-Security-Policy'] = cspCache.get(etag);
  }
  // O Caddy comprime e marca a etiqueta com "-gzip"; aceita as duas formas
  const asked = String(req.headers['if-none-match'] ?? '').replace(/^W\//, '').replace(/-gzip"$/, '"');
  if (asked === etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  res.writeHead(200, headers);
  res.end(await fs.readFile(file));
}

// App do Mac: instaladores em downloads/ (fora do git e do backup; o desktop/publicar.sh coloca lá)
const DOWNLOAD_DIR = path.join(ROOT, 'downloads');
const DOWNLOAD_TYPES = { '.dmg': 'application/x-apple-diskimage', '.zip': 'application/zip', '.exe': 'application/vnd.microsoft.portable-executable', '.json': 'application/json; charset=utf-8' };
async function serveDownload(req, res, name) {
  const type = DOWNLOAD_TYPES[path.extname(name)];
  if (!/^[\w.-]+$/.test(name) || !type) return json(res, 404, { error: 'Não encontrado' });
  const file = path.join(DOWNLOAD_DIR, name);
  let st;
  try { st = await fs.stat(file); } catch { return json(res, 404, { error: 'Não encontrado' }); }
  const isList = name.endsWith('.json');
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': st.size,
    'Cache-Control': isList ? 'no-cache' : 'public, max-age=3600',
    ...(isList ? {} : { 'Content-Disposition': `attachment; filename="${name}"` }),
    'X-Content-Type-Options': 'nosniff',
  });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
}

export async function serveStatic(req, res, pathname) {
  if (pathname === '/baixar') return sendFile(req, res, path.join(PUBLIC_DIR, 'baixar.html'), TYPES['.html']).catch(() => json(res, 404, { error: 'Não encontrado' }));
  if (pathname.startsWith('/downloads/')) return serveDownload(req, res, pathname.slice('/downloads/'.length));
  // Supressão de ruído (RNNoise): só estes arquivos da biblioteca
  const NOISE = { '/vendor/noise/index.js': 'index.js', '/vendor/noise/rnnoise/workletProcessor.js': 'rnnoise/workletProcessor.js',
    '/vendor/noise/rnnoise.wasm': 'rnnoise.wasm', '/vendor/noise/rnnoise_simd.wasm': 'rnnoise_simd.wasm' };
  if (NOISE[pathname]) {
    return sendFile(req, res, path.join(ROOT, 'node_modules/@sapphi-red/web-noise-suppressor/dist', NOISE[pathname]), TYPES[path.extname(pathname)]);
  }
  if (pathname === '/livekit-client.js') {
    return sendFile(req, res, path.join(ROOT, 'node_modules/livekit-client/dist/livekit-client.umd.js'), TYPES['.js']);
  }
  const file = path.normalize(path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname));
  const type = TYPES[path.extname(file)];
  // Só arquivos de dentro de public/ e dos tipos conhecidos
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !type) return json(res, 404, { error: 'Não encontrado' });
  try {
    await sendFile(req, res, file, type);
  } catch {
    json(res, 404, { error: 'Não encontrado' });
  }
}
