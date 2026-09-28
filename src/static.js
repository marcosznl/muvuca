// Arquivos do site (pasta public/) e a biblioteca de voz, com cache que confere antes de usar
import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT, PUBLIC_DIR } from './config.js';
import { json } from './util.js';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json',
};

// Envia o arquivo, ou "não mudou" (304) se o navegador já tem esta versão.
// "no-cache" = o navegador sempre pergunta antes de usar o que guardou: atualizações chegam na hora.
async function sendFile(req, res, file, type) {
  const st = await fs.stat(file);
  const etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`; // muda quando o arquivo muda
  const headers = { 'Content-Type': type, 'Cache-Control': 'no-cache', ETag: etag };
  // O Caddy comprime e marca a etiqueta com "-gzip"; aceita as duas formas
  const asked = String(req.headers['if-none-match'] ?? '').replace(/^W\//, '').replace(/-gzip"$/, '"');
  if (asked === etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  res.writeHead(200, headers);
  res.end(await fs.readFile(file));
}

export async function serveStatic(req, res, pathname) {
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
