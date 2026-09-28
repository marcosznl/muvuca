// Conexão com o servidor: HTTP (conta) e WebSocket (tempo real)
import { store, showBanner, hideBanner } from './util.js';

let ws = null;
let handler = () => {};
let onAuthError = () => {};
let stopped = false;
let reconnectDelay = 1000;
let everConnected = false;
let reqSeq = 0;
const pending = new Map(); // req -> { resolve, reject }

export const sessionToken = () => store.get('session');
export const setSessionToken = (t) => store.set('session', t);

export async function api(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(sessionToken() ? { Authorization: `Bearer ${sessionToken()}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Falha na comunicação com o servidor');
  return data;
}

// Envia um arquivo (corpo cru) para a API; `params` vão na URL
export async function upload(path, params, file) {
  const res = await fetch(`${path}?${new URLSearchParams(params)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', Authorization: `Bearer ${sessionToken()}` },
    body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Falha ao enviar o arquivo');
  return data;
}

export function connect({ onMessage, onAuthFail }) {
  handler = onMessage;
  onAuthError = onAuthFail;
  stopped = false;
  open();
}

function open() {
  // Fecha a conexão anterior para não deixar um "fantasma" online
  if (ws) { ws.onclose = null; ws.close(); }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${proto}://${location.host}/ws`);
  ws = socket;
  socket.onopen = () => socket.send(JSON.stringify({ t: 'hello', token: sessionToken() }));
  socket.onmessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    if (m.t === 'welcome') { everConnected = true; reconnectDelay = 1000; hideBanner(); }
    if (m.t === 'error' && m.code === 'auth') { stopped = true; return onAuthError(m.message); }
    // Resposta a um pedido feito com request()
    if (m.req && pending.has(m.req)) {
      const p = pending.get(m.req);
      pending.delete(m.req);
      if (m.t === 'error') p.reject(new Error(m.message)); else p.resolve(m);
      return;
    }
    try { handler(m); } catch (err) { console.error(err); }
  };
  socket.onclose = () => {
    if (ws !== socket || stopped) return;
    for (const p of pending.values()) p.reject(new Error('Conexão perdida'));
    pending.clear();
    if (everConnected) showBanner('Conexão perdida. Reconectando…');
    setTimeout(open, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 10_000);
  };
}

export function disconnect() {
  stopped = true;
  everConnected = false;
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
}

// Envia sem esperar resposta (erros chegam como { t: 'error' } no handler)
export function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  else showBanner('Sem conexão com o servidor.', { timeout: 3000 });
}

// Envia e espera a resposta ou o erro daquele pedido
export function request(msg) {
  return new Promise((resolve, reject) => {
    if (ws?.readyState !== WebSocket.OPEN) return reject(new Error('Sem conexão com o servidor.'));
    const req = ++reqSeq;
    pending.set(req, { resolve, reject });
    ws.send(JSON.stringify({ ...msg, req }));
    setTimeout(() => {
      if (pending.has(req)) { pending.delete(req); reject(new Error('O servidor não respondeu.')); }
    }, 10_000);
  });
}
