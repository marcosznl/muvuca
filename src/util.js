// Utilidades usadas em todo o servidor
import crypto from 'node:crypto';
import { LIMITS } from './config.js';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Erro de uma rota HTTP (vira { error } com o status)
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Erro de uma ação do WebSocket (vira { t: 'error', message } para o site)
export class ActionError extends Error {}
export const fail = (message) => { throw new ActionError(message); };

// Nas rotas HTTP, uma recusa de permissão (ActionError) vira 403
export function asHttp(fn, status = 403) {
  try {
    return fn();
  } catch (err) {
    if (err instanceof ActionError) throw new HttpError(status, err.message);
    throw err;
  }
}

export function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

export function readBody(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > limit) reject(new HttpError(413, 'Requisição grande demais'));
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new HttpError(400, 'Requisição inválida')); }
    });
    req.on('error', reject);
  });
}

export function sameSecret(given, expected) {
  const a = crypto.createHash('sha256').update(String(given ?? '')).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

export const clean = (raw, max) => String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);

// Canais de texto no estilo Discord: minúsculas, sem espaços ("Bate Papo" -> "bate-papo")
export function textChannelName(raw) {
  return clean(raw, LIMITS.channelName).toLowerCase().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_-]/gu, '').replace(/-+/g, '-');
}

export const validColor = (c) => (c === null || c === '' ? null : /^#[0-9a-f]{6}$/i.test(String(c)) ? String(c).toLowerCase() : undefined);

// IP de quem acessa (o Caddy repassa no X-Forwarded-For)
export const clientIp = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

export function bearer(req) {
  const h = String(req.headers.authorization || '');
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

// Limite por pessoa: no máximo `count` vezes a cada `windowMs` (guarda os horários em `times`)
export function underLimit(times, key, count, windowMs) {
  const now = Date.now();
  const recent = (times.get(key) ?? []).filter((ts) => now - ts < windowMs);
  if (recent.length >= count) return false;
  times.set(key, [...recent, now]);
  return true;
}
