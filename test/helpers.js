// Ferramentas dos testes: sobe um servidor de verdade (porta aleatória, banco temporário)
// e simula pessoas usando o site pelo HTTP e pelo WebSocket, como o navegador faz.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ACCESS = 'codigo-de-teste';

export async function startServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muvuca-test-'));
  const port = 41000 + Math.floor(Math.random() * 9000);
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH,
      PORT: String(port),
      DB_FILE: path.join(dir, 'teste.db'),
      ACCESS_PASSWORD: ACCESS,
      LIVEKIT_API_KEY: 'chave-teste',
      LIVEKIT_API_SECRET: 'segredo-de-teste-com-tamanho-suficiente',
      LIVEKIT_HTTP_URL: 'http://127.0.0.1:1', // não há LiveKit nos testes: as consultas de voz só falham
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  proc.stdout.on('data', (d) => { output += d; });
  proc.stderr.on('data', (d) => { output += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { await fetch(`${base}/`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
    if (proc.exitCode !== null) throw new Error(`O servidor não subiu:\n${output}`);
  }
  return {
    base,
    dir,
    output: () => output,
    async stop() {
      proc.kill();
      await new Promise((r) => proc.once('exit', r));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

// Sobe o painel de verdade apontando para o servidor de teste (mesmo banco), com login próprio.
// O HOME vai para uma pasta temporária (backups e certificados do Caddy ficam vazios).
export const PAINEL_USER = 'admin';
export const PAINEL_PASS = 'senha-do-painel-de-teste';
export async function startPainel(server) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muvuca-painel-'));
  const salt = crypto.randomBytes(16);
  const params = { N: 2 ** 10, r: 8, p: 1 };
  const hash = crypto.scryptSync(PAINEL_PASS, salt, 64, params);
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ user: PAINEL_USER, salt: salt.toString('hex'), hash: hash.toString('hex'), ...params }));
  const port = 41000 + Math.floor(Math.random() * 9000);
  const proc = spawn(process.execPath, ['painel/server.js'], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH, HOME: dir,
      PAINEL_PORT: String(port), DB_FILE: path.join(server.dir, 'teste.db'), PAINEL_AUTH: path.join(dir, 'auth.json'), MAIN_URL: server.base,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  proc.stdout.on('data', (d) => { output += d; });
  proc.stderr.on('data', (d) => { output += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { await fetch(`${base}/`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
    if (proc.exitCode !== null) throw new Error(`O painel não subiu:\n${output}`);
  }
  let cookie = '';
  const call = async (pathname, body) => {
    const res = await fetch(`${base}${pathname}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'x-painel': '1', cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
  };
  const login = await call('/api/login', { user: PAINEL_USER, password: PAINEL_PASS });
  if (login.status !== 200) throw new Error(`Login no painel falhou: ${JSON.stringify(login.body)}`);
  cookie = login.headers.get('set-cookie').split(';')[0];
  return {
    base, dir, call, cookie: () => cookie,
    get: (pathname) => call(pathname),
    post: (pathname, body = {}) => call(pathname, body),
    output: () => output,
    async stop() {
      proc.kill();
      await new Promise((r) => proc.once('exit', r));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

// Uma pessoa usando o site
export class Person {
  constructor(server, username) {
    this.server = server;
    this.username = username;
    this.events = [];
    this.seq = 0;
    this.waiting = new Map();
  }

  async register(invite = ACCESS) {
    const res = await this.post('/api/register', { username: this.username, password: 'senha-123', invite });
    if (res.status !== 200) throw new Error(`cadastro falhou: ${res.status} ${JSON.stringify(res.body)}`);
    this.token = res.body.token;
    return this.connect();
  }

  async post(pathname, body) {
    const res = await fetch(this.server.base + pathname, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  // Envio de arquivo cru (anexos, emojis, fotos), como o site faz
  async upload(pathname, params, bytes) {
    const res = await fetch(`${this.server.base}${pathname}?${new URLSearchParams(params)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}` },
      body: bytes,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`${this.server.base.replace('http', 'ws')}/ws`);
      this.ws.on('open', () => this.ws.send(JSON.stringify({ t: 'hello', token: this.token })));
      this.ws.on('error', reject);
      this.ws.on('message', (raw) => {
        const m = JSON.parse(raw);
        if (m.t === 'welcome') {
          this.welcome = m;
          this.me = m.you;
          this.servers = m.servers;
          resolve(this);
        }
        if (m.t === 'server') this.servers = [...(this.servers ?? []).filter((s) => s.id !== m.server.id), m.server];
        if (m.t === 'me') this.me = { ...this.me, ...m.you };
        if (m.req && this.waiting.has(m.req)) {
          this.waiting.get(m.req)(m);
          this.waiting.delete(m.req);
        } else this.events.push(m);
      });
    });
  }

  // Pede algo e espera a resposta daquele pedido (ok, erro ou dados).
  // Se bater no limite de ações por segundo, espera e tenta de novo, como uma pessoa faria.
  async request(msg) {
    for (let tries = 0; ; tries++) {
      const res = await this.requestOnce(msg);
      if (res.t === 'error' && /seguidas|rápido demais/.test(res.message) && tries < 15) { await sleep(1000); continue; }
      return res;
    }
  }

  requestOnce(msg) {
    const req = ++this.seq;
    return new Promise((resolve, reject) => {
      this.waiting.set(req, resolve);
      this.ws.send(JSON.stringify({ ...msg, req }));
      setTimeout(() => reject(new Error(`sem resposta para ${msg.t}`)), 5000);
    });
  }

  // Envia sem esperar resposta (como o site faz com as mensagens)
  send(msg) { this.ws.send(JSON.stringify(msg)); }

  // Manda uma mensagem e espera ela voltar (respeitando o limite de 5 mensagens a cada 5 s)
  async say(channel, text, extra = {}) {
    for (let tries = 0; tries < 10; tries++) {
      const res = await this.request({ t: 'msg', channel, text, ...extra });
      if (res.t === 'error') throw new Error(res.message);
      const ev = await this.waitFor('msg', (e) => e.msg.userId === this.me.id && e.msg.text === text).catch(() => null);
      if (ev) return ev.msg;
    }
    throw new Error(`mensagem não enviada: ${text}`);
  }

  // Espera um evento que chegou (ou vai chegar) do servidor
  async waitFor(t, pred = () => true, timeout = 3000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const i = this.events.findIndex((e) => e.t === t && pred(e));
      if (i >= 0) return this.events.splice(i, 1)[0];
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`não chegou o evento ${t}`);
  }

  server_(id) { return this.servers.find((s) => s.id === id); }
  close() { this.ws?.close(); }
}

export const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
  '1f15c4890000000d49444154789c6360000002000154a24f5f0000000049454e44ae426082', 'hex');
export const GIF = Buffer.from('474946383961010001008000000000ffffff21f90401000000002c00000000010001000002024401003b', 'hex');
export const WEBM = Buffer.concat([Buffer.from('1a45dfa3', 'hex'), Buffer.alloc(200)]);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
