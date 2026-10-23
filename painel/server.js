// Painel administrativo do Muvuca: um site separado (painel.<domínio>) só para o dono do servidor.
// Roda num processo à parte (serviço próprio): continua no ar mesmo quando o Muvuca cai, e mostra isso.
//
//   Login único: usuário e senha criados com ./painel.sh senha (só o hash fica salvo, em data/painel-auth.json)
//   Mostra: saúde dos serviços, CPU/RAM/rede (com histórico de 24 h), quem está online, em voz, em live
//   e jogando, contas, auditoria, acessos ao site, logs e backups. Ações: backup agora e reiniciar.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { AUDIT_LABELS, AUDIT_GROUPS } from '../src/audit-labels.js';
import { deployRoutes, deploying, pendingUpdate } from './deploy.js';
import { startAlerts, alertRoutes, markPlanned, setPlannedUntil, sendAlert, downNow, quedasSince } from './alerts.js';
import { startUpkeep, upkeepState, restoreTest } from './upkeep.js';
import { SANDBOX, realOnly } from './sandbox.js';
import { PERM_INFO, PERMS, can } from '../public/js/permissions.js';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PORT = Number(process.env.PAINEL_PORT || 3002);
const HOST = process.env.PAINEL_HOST || '127.0.0.1';
const DATA = path.join(ROOT, 'data');
const DB_FILE = process.env.DB_FILE || path.join(DATA, 'muvuca.db');
// Até o servidor subir com o nome novo (ele renomeia o malegna.db antigo), o banco pode ter o nome de antes
const dbPath = () => (!process.env.DB_FILE && !fs.existsSync(DB_FILE) && fs.existsSync(path.join(DATA, 'malegna.db'))
  ? path.join(DATA, 'malegna.db') : DB_FILE);
const AUTH_FILE = process.env.PAINEL_AUTH || path.join(DATA, 'painel-auth.json');
const KEY_FILE = path.join(path.dirname(DB_FILE), 'painel-key');
const HISTORY_FILE = path.join(path.dirname(DB_FILE), 'painel-historico.json');
const MAIN_URL = process.env.MAIN_URL || 'http://127.0.0.1:3000';
const PUBLIC = path.join(HERE, 'public');
const LOGS = process.env.PAINEL_LOGS || path.join(ROOT, 'logs'); // teste: pasta própria
const BACKUP_DIR = path.join(os.homedir(), 'Backups/Muvuca'); // onde o backup.sh guarda (fora do projeto)
const CADDY_CERTS = path.join(os.homedir(), 'Library/Application Support/Caddy/certificates');
const env = readEnvPublic();
const DOMAIN = (env.DUCKDNS_SUBDOMAIN ? `${env.DUCKDNS_SUBDOMAIN.split(',')[0].trim()}.duckdns.org` : env.DOMAIN) || 'localhost';

// Só as chaves que não são segredo (o painel nunca lê senhas, tokens nem chaves do .env)
function readEnvPublic() {
  const out = {};
  try {
    for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
      const m = line.match(/^(DOMAIN|DUCKDNS_SUBDOMAIN|PUBLIC_PORT|OWNER_USERNAME)=(.*)$/);
      if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  } catch { /* sem .env: fica com os padrões */ }
  return out;
}

// ---------- Banco (o mesmo do Muvuca; o painel só lê, e grava apenas na auditoria) ----------

let db = null;
function database() {
  if (!db) {
    db = new DatabaseSync(dbPath());
    db.exec('PRAGMA busy_timeout = 3000');
  }
  return db;
}
const all = (sql, ...args) => database().prepare(sql).all(...args);
const one = (sql, ...args) => database().prepare(sql).get(...args);

function audit(action, { ip = null, detail = null, ok = true } = {}) {
  try {
    database().prepare('INSERT INTO audit_log (at, user_id, user_name, action, server_id, detail, ip, ok) VALUES (?, NULL, ?, ?, NULL, ?, ?, ?)')
      .run(Date.now(), 'painel', action, detail ? JSON.stringify(detail) : null, ip, ok ? 1 : 0);
  } catch (err) {
    console.error('auditoria:', err.message);
  }
}

// ---------- Login (usuário e senha únicos) ----------

const SESSION_IDLE_MS = 2 * 3_600_000;   // 2 h sem usar: sai
const SESSION_MAX_MS = 12 * 3_600_000;   // no máximo 12 h, mesmo usando
const sessions = new Map();              // hash do token -> { created, last, ip, ua, stamp }
const ipFails = new Map();               // ip -> { count, until }
let globalFails = [];                    // horários dos erros (qualquer IP)
let globalLockUntil = 0;

// Login temporário (expiresAt): depois do prazo deixa de valer e é preciso criar outro (./painel.sh senha)
function loadAuth() {
  try {
    const a = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
    return a.expiresAt && Date.parse(a.expiresAt) < Date.now() ? null : a;
  } catch { return null; }
}
const authStamp = (a) => (a ? crypto.createHash('sha256').update(a.hash).digest('hex').slice(0, 16) : '');
const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

function scrypt(password, salt, params) {
  return new Promise((resolve, reject) => crypto.scrypt(password, Buffer.from(salt, 'hex'), 64,
    { N: params.N, r: params.r, p: params.p, maxmem: 256 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key))));
}
const sameText = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};

async function checkCredentials(user, password) {
  const a = loadAuth();
  if (!a) return false;
  const key = await scrypt(String(password), a.salt, a);
  const okPass = crypto.timingSafeEqual(key, Buffer.from(a.hash, 'hex'));
  const okUser = sameText(String(user).trim().toLowerCase(), a.user.toLowerCase());
  return okPass && okUser;
}

const cookieName = '__Host-painel';
function sessionOf(req) {
  const m = String(req.headers.cookie ?? '').match(/(?:^|;\s*)__Host-painel=([a-f0-9]{64})/);
  if (!m) return null;
  const id = hashToken(m[1]);
  const s = sessions.get(id);
  const now = Date.now();
  if (!s) return null;
  if (now - s.last > SESSION_IDLE_MS || now - s.created > SESSION_MAX_MS || s.stamp !== authStamp(loadAuth())) {
    sessions.delete(id); // expirou ou a senha foi trocada
    return null;
  }
  s.last = now;
  return { id, ...s };
}

const clientIp = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

async function login(req, res) {
  const ip = clientIp(req);
  const now = Date.now();
  if (globalLockUntil > now) return json(res, 429, { error: 'Login travado por excesso de tentativas. Tente de novo mais tarde.' });
  const f = ipFails.get(ip);
  if (f?.until > now) return json(res, 429, { error: 'Muitas tentativas. Espere 15 minutos.' });
  const body = await readBody(req);
  if (!loadAuth()) return json(res, 503, { error: 'O painel está sem senha (ou o login temporário venceu). No Mac, rode: ./painel.sh senha' });
  const ok = await checkCredentials(body.user ?? '', body.password ?? '');
  if (!ok) {
    const rec = ipFails.get(ip) ?? { count: 0, until: 0 };
    rec.count++;
    if (rec.count >= 5) { rec.until = now + 15 * 60_000; rec.count = 0; }
    ipFails.set(ip, rec);
    globalFails = globalFails.filter((t) => now - t < 3_600_000);
    globalFails.push(now);
    // Muitos erros de vários lugares: trava para todo mundo por 30 min (alguém tentando adivinhar)
    if (globalFails.length >= 20) { globalLockUntil = now + 30 * 60_000; globalFails = []; }
    audit('painel:login:fail', { ip, ok: false, detail: { usuario: String(body.user ?? '').slice(0, 40), aparelho: ua(req) } });
    await new Promise((r) => setTimeout(r, 1000));
    return json(res, 401, { error: 'Usuário ou senha incorretos.' });
  }
  ipFails.delete(ip);
  return startSession(req, res);
}

// Sessão nova (depois da senha): cookie só deste site, que o JavaScript da página não lê
function startSession(req, res) {
  if (!loadAuth()) return json(res, 503, { error: 'O painel está sem senha (ou o login temporário venceu). No Mac, rode: ./painel.sh senha' });
  const now = Date.now();
  const ip = clientIp(req);
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(hashToken(token), { created: now, last: now, ip, ua: ua(req), stamp: authStamp(loadAuth()) });
  audit('painel:login', { ip, detail: { aparelho: ua(req) } });
  res.setHeader('Set-Cookie', `${cookieName}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MAX_MS / 1000}`);
  return json(res, 200, { ok: true });
}
const ua = (req) => String(req.headers['user-agent'] ?? '').slice(0, 160);

function logout(req, res, s) {
  sessions.delete(s.id);
  audit('painel:logout', { ip: clientIp(req) });
  res.setHeader('Set-Cookie', `${cookieName}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`);
  return json(res, 200, { ok: true });
}

// ---------- Coleta periódica (a cada 10 s): máquina, processos, rede e o Muvuca ----------

const SAMPLE_MS = 10_000;
const HISTORY_MAX = 24 * 360; // 24 h de amostras de 10 s
let history = [];
try { history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')).filter((h) => Date.now() - h.t < 86_400_000); } catch { /* começa vazio */ }
let latest = { at: 0 };
let prevCpu = os.cpus();
let prevNet = null;
let netIface = null;

function cpuPercent() {
  const now = os.cpus();
  let idle = 0; let total = 0;
  now.forEach((c, i) => {
    const p = prevCpu[i]?.times ?? c.times;
    const d = Object.fromEntries(Object.keys(c.times).map((k) => [k, c.times[k] - p[k]]));
    idle += d.idle;
    total += d.user + d.nice + d.sys + d.idle + d.irq;
  });
  prevCpu = now;
  return total > 0 ? Math.round((1 - idle / total) * 1000) / 10 : 0;
}

async function memory() {
  const { stdout } = await run('vm_stat');
  const size = Number(stdout.match(/page size of (\d+)/)?.[1] ?? 16384);
  const pages = (label) => Number(stdout.match(new RegExp(`${label}:\\s+(\\d+)`))?.[1] ?? 0) * size;
  const used = pages('Pages active') + pages('Pages wired down') + pages('Pages occupied by compressor');
  return { total: os.totalmem(), used, wired: pages('Pages wired down'), compressed: pages('Pages occupied by compressor') };
}

const WATCH = [
  ['muvuca', / server\.js$/, (c) => !c.includes('painel/')],
  ['livekit', /livekit-server/],
  ['caddy', /caddy run/],
  ['ddns', /ddns-update\.sh/],
  ['start', /start\.sh$/],
];
async function processes() {
  const { stdout } = await run('ps', ['-axo', 'pid=,ppid=,rss=,%cpu=,etime=,command=']);
  const out = {};
  for (const line of stdout.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const [, pid, , rss, cpu, etime, command] = m;
    if (Number(pid) === process.pid) { out.painel = { pid: Number(pid), rss: Number(rss) * 1024, cpu: Number(cpu), etime }; continue; }
    for (const [name, re, extra] of WATCH) {
      if (out[name] || !re.test(command) || (extra && !extra(command))) continue;
      if (name === 'muvuca' && !/node/.test(command)) continue;
      out[name] = { pid: Number(pid), rss: Number(rss) * 1024, cpu: Number(cpu), etime };
    }
  }
  return out;
}

async function network() {
  if (!netIface) {
    try { netIface = (await run('route', ['-n', 'get', 'default'])).stdout.match(/interface:\s*(\S+)/)?.[1] ?? 'en0'; } catch { netIface = 'en0'; }
  }
  const { stdout } = await run('netstat', ['-ibn']);
  for (const line of stdout.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols[0] !== netIface || !cols[2]?.startsWith('<Link')) continue;
    // Name Mtu Network Address Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll
    const n = cols.length;
    const rx = Number(cols[n - 5]);
    const tx = Number(cols[n - 2]);
    const now = Date.now();
    let rate = { rx: 0, tx: 0 };
    if (prevNet && rx >= prevNet.rx && tx >= prevNet.tx) {
      const s = (now - prevNet.at) / 1000;
      rate = { rx: Math.round(((rx - prevNet.rx) * 8) / s), tx: Math.round(((tx - prevNet.tx) * 8) / s) }; // bits/s
    }
    prevNet = { rx, tx, at: now };
    return { iface: netIface, ...rate, totalRx: rx, totalTx: tx };
  }
  return { iface: netIface, rx: 0, tx: 0 };
}

// Ordens para o Muvuca (desconectar, bloquear, manutenção): só de dentro do Mac, com a chave do painel
async function mainPost(pathname, body) {
  const key = fs.readFileSync(KEY_FILE, 'utf8').trim();
  let r;
  try {
    r = await fetch(`${MAIN_URL}${pathname}`, { method: 'POST', headers: { 'x-painel-key': key, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
  } catch {
    throw new Error('O Muvuca não respondeu (está fora do ar?).');
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `O Muvuca respondeu ${r.status} (reinicie o Muvuca para ativar esta função).`);
  return data;
}

function maintenanceState() {
  try { return JSON.parse(one("SELECT value FROM meta WHERE key = 'maintenance'")?.value ?? 'null') ?? { on: false }; } catch { return { on: false }; }
}

async function mainStats() {
  let key = '';
  try { key = fs.readFileSync(KEY_FILE, 'utf8').trim(); } catch { return { up: false, error: 'sem chave do painel (o Muvuca ainda não criou data/painel-key)' }; }
  try {
    const r = await fetch(`${MAIN_URL}/internal/stats`, { headers: { 'x-painel-key': key }, signal: AbortSignal.timeout(3000) });
    if (!r.ok) return { up: true, error: `o Muvuca respondeu ${r.status} (reinicie o Muvuca para ativar o painel)` };
    const data = await r.json();
    // Nome dos canais de voz direto do banco (o Muvuca manda só o id em algumas versões)
    for (const v of data.voice ?? []) {
      if (!v.private && (!v.name || v.name === '?')) { try { v.name = one('SELECT name FROM channels WHERE id = ?', v.id)?.name ?? v.id; } catch { v.name = v.id; } }
    }
    return { up: true, ...data };
  } catch (err) {
    return { up: false, error: err.name === 'TimeoutError' ? 'não respondeu em 3 s' : 'fora do ar' };
  }
}

async function sample() {
  try {
    const [mem, procs, net, main] = await Promise.all([memory(), processes(), network(), mainStats()]);
    const disk = await fsp.statfs(ROOT);
    latest = {
      at: Date.now(),
      cpu: cpuPercent(),
      cores: os.cpus().length,
      load: os.loadavg().map((v) => Math.round(v * 100) / 100),
      mem, procs, net, main,
      disk: { total: disk.blocks * disk.bsize, free: disk.bavail * disk.bsize },
      uptime: os.uptime(),
    };
    const lives = (main.voice ?? []).reduce((n, v) => n + (v.people ?? []).filter((p) => p.streaming).length, 0);
    history.push({
      t: latest.at, cpu: latest.cpu, mem: mem.used, rx: net.rx, tx: net.tx,
      mcpu: Math.round(((procs.muvuca?.cpu ?? 0) + (procs.livekit?.cpu ?? 0) + (procs.caddy?.cpu ?? 0)) * 10) / 10,
      mrss: (procs.muvuca?.rss ?? 0) + (procs.livekit?.rss ?? 0) + (procs.caddy?.rss ?? 0),
      online: main.users?.length ?? 0,
      voice: (main.voice ?? []).reduce((n, v) => n + v.count, 0),
      lives, up: main.up && !main.error ? 1 : 0,
    });
    if (history.length > HISTORY_MAX) history.splice(0, history.length - HISTORY_MAX);
  } catch (err) {
    console.error('coleta:', err.message);
  }
}
setInterval(sample, SAMPLE_MS);
setInterval(() => fsp.writeFile(HISTORY_FILE, JSON.stringify(history), { mode: 0o600 }).catch(() => {}), 5 * 60_000);
sample();

// Tamanho das pastas de dados (du é lento com muitos arquivos: a cada 10 min)
let sizes = { at: 0 };
async function measureSizes() {
  const out = { at: Date.now() };
  const dirs = [['anexos', path.join(DATA, 'files')], ['fotos', path.join(DATA, 'images')], ['emojis', path.join(DATA, 'emojis')], ['backups', BACKUP_DIR]];
  for (const [name, dir] of dirs) {
    try { out[name] = Number((await run('du', ['-sk', dir])).stdout.split('\t')[0]) * 1024; } catch { out[name] = 0; }
  }
  for (const [key, file] of [['banco', dbPath()], ['banco-wal', `${dbPath()}-wal`]]) {
    try { out[key] = (await fsp.stat(file)).size; } catch { out[key] = 0; }
  }
  sizes = out;
}
measureSizes();
setInterval(measureSizes, 10 * 60_000);

// ---------- Certificado HTTPS (validade, lido dos arquivos do Caddy) ----------

async function certificates() {
  const out = [];
  let dirs = [];
  try { dirs = await fsp.readdir(CADDY_CERTS); } catch { return out; }
  for (const ca of dirs) {
    let names = [];
    try { names = await fsp.readdir(path.join(CADDY_CERTS, ca)); } catch { continue; }
    for (const name of names) {
      try {
        const pem = await fsp.readFile(path.join(CADDY_CERTS, ca, name, `${name}.crt`), 'utf8');
        const cert = new crypto.X509Certificate(pem);
        out.push({ name, validTo: Date.parse(cert.validTo), issuer: cert.issuer.split('\n').find((l) => l.startsWith('O='))?.slice(2) ?? '' });
      } catch { /* pasta sem certificado */ }
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------- Leituras do banco ----------

const DAY = 86_400_000;
function overview() {
  const now = Date.now();
  const count = (sql, ...a) => one(sql, ...a)?.n ?? 0;
  const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };
  return {
    users: count('SELECT COUNT(*) n FROM users'),
    usersNew7: count('SELECT COUNT(*) n FROM users WHERE created_at > ?', now - 7 * DAY),
    active24: safe(() => count('SELECT COUNT(*) n FROM users WHERE last_seen > ?', now - DAY), null),
    active7: safe(() => count('SELECT COUNT(*) n FROM users WHERE last_seen > ?', now - 7 * DAY), null),
    servers: count("SELECT COUNT(*) n FROM servers WHERE kind = 'server'"),
    dms: count("SELECT COUNT(*) n FROM servers WHERE kind = 'dm'"),
    channels: count('SELECT COUNT(*) n FROM channels'),
    messages: count('SELECT COUNT(*) n FROM messages'),
    messages24: count('SELECT COUNT(*) n FROM messages WHERE created_at > ?', now - DAY),
    files: count('SELECT COUNT(*) n FROM files'),
    filesBytes: one('SELECT COALESCE(SUM(size), 0) n FROM files')?.n ?? 0,
    sessions: count('SELECT COUNT(*) n FROM sessions WHERE expires_at > ?', now),
    games7: all('SELECT game, COUNT(*) n FROM game_results WHERE created_at > ? GROUP BY game ORDER BY n DESC', now - 7 * DAY),
    perDay: all(`SELECT CAST((created_at - ?) / ${DAY} AS INTEGER) d, COUNT(*) n FROM messages WHERE created_at > ? GROUP BY d`, now - 14 * DAY, now - 14 * DAY),
    failed24: safe(() => count("SELECT COUNT(*) n FROM audit_log WHERE ok = 0 AND at > ?", now - DAY), null),
    auditReady: safe(() => { one('SELECT 1 FROM audit_log LIMIT 1'); return true; }, false),
  };
}

function usersList() {
  const now = Date.now();
  const online = new Set((latest.main?.users ?? []).map((u) => u.id));
  const rows = all(`SELECT u.id, u.username, u.display_name name, u.created_at, u.last_seen, u.blocked_at, u.blocked_reason, u.must_change,
      (u.id = (SELECT owner_id FROM servers WHERE id = (SELECT value FROM meta WHERE key = 'home_server'))) home_owner,
      (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?) sessions,
      (SELECT COUNT(*) FROM messages m WHERE m.user_id = u.id) messages,
      (SELECT COALESCE(SUM(size), 0) FROM files f WHERE f.owner_id = u.id) bytes,
      (SELECT COUNT(*) FROM members mb JOIN servers sv ON sv.id = mb.server_id WHERE mb.user_id = u.id AND sv.kind = 'server') servers
    FROM users u ORDER BY COALESCE(u.last_seen, u.created_at) DESC`, now);
  const lastLogin = new Map();
  const fails = new Map();
  try {
    for (const r of all("SELECT user_id, MAX(at) at, ip FROM audit_log WHERE action = 'auth:login' GROUP BY user_id")) lastLogin.set(r.user_id, r);
    for (const r of all("SELECT LOWER(user_name) name, COUNT(*) n FROM audit_log WHERE action = 'auth:login:fail' AND at > ? GROUP BY LOWER(user_name)", now - 7 * DAY)) fails.set(r.name, r.n);
  } catch { /* auditoria ainda não existe */ }
  return rows.map((r) => ({
    ...r, online: online.has(`u${r.id}`),
    lastLogin: lastLogin.get(r.id)?.at ?? null, lastIp: lastLogin.get(r.id)?.ip ?? null,
    fails7: fails.get(r.username.toLowerCase()) ?? 0,
  }));
}

// Arquivos pesados: os maiores anexos, quem mandou e onde. Em conversa privada, sem nome do arquivo nem canal.
function heavyFiles(url) {
  const kind = url.searchParams.get('kind');
  const kinds = ['image', 'video', 'audio', 'file'];
  const where = kinds.includes(kind) ? 'WHERE f.kind = ?' : '';
  const rows = all(`SELECT f.id, f.kind, f.mime, f.size, f.name, f.created_at, f.message_id, u.username, u.display_name,
      c.name channel, s.name server, s.kind skind, m.text msg_text
    FROM files f LEFT JOIN users u ON u.id = f.owner_id LEFT JOIN channels c ON c.id = f.channel_id LEFT JOIN servers s ON s.id = c.server_id
    LEFT JOIN messages m ON m.id = f.message_id
    ${where} ORDER BY f.size DESC LIMIT 200`, ...(where ? [kind] : []));
  const byUser = all(`SELECT u.username, u.display_name name, COUNT(*) n, SUM(f.size) bytes FROM files f LEFT JOIN users u ON u.id = f.owner_id
    GROUP BY f.owner_id ORDER BY bytes DESC LIMIT 20`);
  const byKind = all('SELECT kind, COUNT(*) n, SUM(size) bytes FROM files GROUP BY kind ORDER BY bytes DESC');
  const byPlace = all(`SELECT CASE WHEN s.kind = 'dm' THEN 'Conversas privadas' ELSE s.name END place, COUNT(*) n, SUM(f.size) bytes
    FROM files f LEFT JOIN channels c ON c.id = f.channel_id LEFT JOIN servers s ON s.id = c.server_id GROUP BY place ORDER BY bytes DESC LIMIT 20`);
  return {
    total: one('SELECT COUNT(*) n, COALESCE(SUM(size), 0) bytes FROM files'),
    byKind, byUser, byPlace,
    files: rows.map((r) => {
      const dm = r.skind === 'dm';
      return {
        id: dm ? null : r.id, kind: r.kind, mime: r.mime, size: r.size, at: r.created_at, user: r.username ?? '(conta apagada)', userName: r.display_name,
        name: dm ? null : r.name, where: dm ? 'Conversa privada' : `${r.server ?? '?'} · #${r.channel ?? '?'}`, dm, orphan: r.message_id === null,
        messageId: dm ? null : r.message_id, text: dm ? null : (r.msg_text ?? '').slice(0, 300),
      };
    }),
  };
}

// Prévia de um anexo (aba Arquivos). Conversa privada nunca abre aqui. Documento só baixa, nunca vira página.
const FILE_DIR = path.join(path.dirname(DB_FILE), 'files');
async function previewFile(req, res, s, url) {
  const id = url.searchParams.get('id') ?? '';
  const f = /^f-[0-9a-f]{16}$/.test(id) ? one(`SELECT f.id, f.kind, f.mime, f.name, s.kind skind FROM files f
    LEFT JOIN channels c ON c.id = f.channel_id LEFT JOIN servers s ON s.id = c.server_id WHERE f.id = ?`, id) : null;
  if (!f || f.skind === 'dm') return json(res, 404, { error: 'Arquivo não encontrado.' });
  const file = path.join(FILE_DIR, f.id);
  let size;
  try { size = (await fsp.stat(file)).size; } catch { return json(res, 404, { error: 'O arquivo não está mais no disco.' }); }
  const media = ['image', 'video', 'audio'].includes(f.kind) && /^(image|video|audio)\/[\w.+-]+$/.test(f.mime) && f.mime !== 'image/svg+xml';
  const download = !media || url.searchParams.get('download') === '1';
  const headers = {
    'Content-Type': media ? f.mime : 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=3600',
    'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
    'Content-Security-Policy': 'sandbox',
  };
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
  if (range && (range[1] || range[2])) {
    const start = Math.max(0, range[1] ? Number(range[1]) : size - Number(range[2]));
    const end = Math.min(range[1] && range[2] ? Number(range[2]) : size - 1, size - 1);
    if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': size });
  fs.createReadStream(file).pipe(res);
}

// ---------- Mensagens (moderação) ----------
// Busca nas mensagens dos servidores (nunca em conversa privada), as mais novas primeiro
// Cartão da pessoa: tudo de uma conta num lugar só. ref: id ("12" ou "u12") ou @usuário
function findUserId(ref) {
  ref = String(ref ?? '').trim().replace(/^@/, '');
  if (/^u?\d+$/.test(ref)) return Number(ref.replace(/^u/, ''));
  return ref ? one('SELECT id FROM users WHERE username = ? COLLATE NOCASE', ref)?.id ?? null : null;
}
function personDetail(url) {
  const id = findUserId(url.searchParams.get('id') ?? url.searchParams.get('user'));
  const user = id ? usersList().find((u) => u.id === id) : null;
  if (!user) return null;
  const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };
  const now = Date.now();
  return {
    user,
    servers: safe(() => all(`SELECT s.name, mb.nick, s.owner_id = ? owner FROM members mb JOIN servers s ON s.id = mb.server_id
      WHERE mb.user_id = ? AND s.kind = 'server' ORDER BY mb.joined_at`, id, id).map((r) => ({ name: r.name, nick: r.nick ?? null, owner: !!r.owner })), []),
    ips: safe(() => all(`SELECT ip, COUNT(*) n, MAX(at) last FROM audit_log WHERE user_id = ? AND ip IS NOT NULL AND ip != ''
      GROUP BY ip ORDER BY last DESC LIMIT 10`, id), []),
    blockedIps: safe(() => all('SELECT ip FROM blocked_ips').map((r) => r.ip), []),
    devices: safe(() => all('SELECT created_at, last_seen, ip, ua, client FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY COALESCE(last_seen, created_at) DESC', id, now)
      .map((r) => ({ createdAt: r.created_at, lastSeen: r.last_seen ?? r.created_at, ip: r.ip ?? null, ua: r.ua ?? null, client: (() => { try { return JSON.parse(r.client ?? 'null'); } catch { return null; } })() })), []),
    desktopLatest: desktopLatest(),
    messages: searchMessages(new URL(`http://x/?user=${encodeURIComponent(user.username)}`)).slice(0, 8),
    audit: safe(() => all(`SELECT at, action, detail, ip, ok FROM audit_log WHERE user_id = ? ORDER BY id DESC LIMIT 12`, id)
      .map((r) => ({ ...r, label: AUDIT_LABELS[r.action] ?? r.action, detail: r.detail ? JSON.parse(r.detail) : null })), []),
    // Uso nos últimos 7 dias: minutos em call (com mais alguém na call) e jogos
    usage7: {
      callMinutes: safe(() => one('SELECT COUNT(*) n FROM call_minutes WHERE user_id = ? AND at > ?', id, now - 7 * DAY).n, 0),
      messages: safe(() => one('SELECT COUNT(*) n FROM messages WHERE user_id = ? AND created_at > ? AND system = 0', id, now - 7 * DAY).n, 0),
      games: safe(() => all(`SELECT r.game, COUNT(*) n, SUM(r.winner_id = ?) wins FROM game_players p JOIN game_results r ON r.id = p.result_id
        WHERE p.user_id = ? AND r.created_at > ? GROUP BY r.game ORDER BY n DESC`, id, id, now - 7 * DAY), []),
    },
  };
}

// ---------- App do computador e erros do site ----------
const newerVersion = (a, b) => {
  const pa = String(a).split('.').map(Number); const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};
// Versão mais nova do app (a que o publicar.sh deixou em downloads/latest.json)
function desktopLatest() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'downloads', 'latest.json'), 'utf8')).version ?? null; } catch { return null; }
}

// Erros do site agrupados pela mensagem: quantas vezes, quantas pessoas, em que aparelhos, quando
function clientErrors(url) {
  const days = Math.min(30, Math.max(1, Number(url?.searchParams.get('days')) || 7));
  const since = Date.now() - days * DAY;
  let rows = [];
  try {
    rows = all(`SELECT e.message, e.stack, e.source, e.client, e.ua, e.count, e.at, e.last_at, u.username FROM client_errors e
      LEFT JOIN users u ON u.id = e.user_id WHERE e.last_at > ? ORDER BY e.last_at DESC`, since);
  } catch { return { days, groups: [] }; }
  const groups = new Map();
  for (const r of rows) {
    let c = {};
    try { c = JSON.parse(r.client ?? '{}'); } catch { /* sem detalhe */ }
    const g = groups.get(r.message) ?? { message: r.message, count: 0, people: new Set(), devices: new Set(), first: r.at, last: r.last_at, stack: r.stack, source: r.source, pages: new Set() };
    g.count += r.count;
    if (r.username) g.people.add(r.username);
    g.devices.add(c.app === 'desktop' ? `App ${c.version ?? '?'} (${c.platform ?? '?'})` : c.app === 'pwa' ? `App instalado (${c.platform ?? '?'})` : `Navegador (${c.platform ?? '?'})`);
    if (c.page) g.pages.add(c.page);
    g.first = Math.min(g.first, r.at);
    g.last = Math.max(g.last, r.last_at);
    g.stack ??= r.stack;
    groups.set(r.message, g);
  }
  return {
    days,
    groups: [...groups.values()].sort((a, b) => b.last - a.last).map((g) => ({ ...g, people: [...g.people], devices: [...g.devices], pages: [...g.pages] })),
  };
}

// ---------- Servidores do Muvuca (as conversas privadas ficam de fora) ----------
const onlineNums = () => new Set((latest.main?.users ?? []).map((u) => Number(String(u.id).replace(/^u/, ''))));
const inCallByChannel = () => new Map((latest.main?.voice ?? []).filter((v) => !v.private).map((v) => [v.id, v]));
const homeServerId = () => { try { return one("SELECT value FROM meta WHERE key = 'home_server'")?.value ?? null; } catch { return null; } };

function serversList() {
  const now = Date.now();
  const online = onlineNums();
  const calls = inCallByChannel();
  const home = homeServerId();
  const rows = all(`SELECT s.id, s.name, s.color, s.icon, s.created_at, s.owner_id, u.username owner_user, u.display_name owner_name,
      (SELECT COUNT(*) FROM channels c WHERE c.server_id = s.id AND c.type = 'text') texts,
      (SELECT COUNT(*) FROM channels c WHERE c.server_id = s.id AND c.type = 'voice') voices,
      (SELECT COUNT(*) FROM messages m JOIN channels c ON c.id = m.channel_id WHERE c.server_id = s.id AND m.created_at > ? AND m.system = 0) msgs7,
      (SELECT COALESCE(SUM(f.size), 0) FROM files f JOIN channels c ON c.id = f.channel_id WHERE c.server_id = s.id) bytes
    FROM servers s LEFT JOIN users u ON u.id = s.owner_id WHERE s.kind = 'server' ORDER BY s.created_at`, now - 7 * DAY);
  const members = new Map();
  for (const r of all("SELECT m.server_id, m.user_id FROM members m JOIN servers s ON s.id = m.server_id WHERE s.kind = 'server'")) {
    if (!members.has(r.server_id)) members.set(r.server_id, []);
    members.get(r.server_id).push(r.user_id);
  }
  const voiceIds = new Map();
  for (const r of all("SELECT id, server_id FROM channels WHERE type = 'voice'")) voiceIds.set(r.id, r.server_id);
  return rows.map((r) => {
    const mem = members.get(r.id) ?? [];
    const inCall = [...calls.values()].filter((v) => voiceIds.get(v.id) === r.id).reduce((n, v) => n + v.count, 0);
    return {
      id: r.id, name: r.name, color: r.color, icon: r.icon ?? null, createdAt: r.created_at, home: r.id === home,
      owner: r.owner_id ? { id: r.owner_id, username: r.owner_user, name: r.owner_name } : null,
      members: mem.length, online: mem.filter((id) => online.has(id)).length, inCall,
      channels: { text: r.texts, voice: r.voices }, msgs7: r.msgs7, bytes: r.bytes,
    };
  });
}

function serverDetail(url) {
  const id = String(url.searchParams.get('id') ?? '');
  const base = serversList().find((x) => x.id === id);
  if (!base) return null;
  const now = Date.now();
  const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };
  const online = onlineNums();
  const calls = inCallByChannel();
  const roles = all('SELECT id, name, color, position, permissions, is_default FROM roles WHERE server_id = ? ORDER BY position DESC', id);
  const roleName = new Map(roles.map((r) => [r.id, r.is_default ? '@everyone' : r.name]));
  const privRoles = new Map();
  for (const r of safe(() => all('SELECT cr.channel_id, cr.role_id FROM channel_roles cr JOIN channels c ON c.id = cr.channel_id WHERE c.server_id = ?', id), [])) {
    if (!privRoles.has(r.channel_id)) privRoles.set(r.channel_id, []);
    privRoles.get(r.channel_id).push(roleName.get(r.role_id) ?? '?');
  }
  const channels = all(`SELECT c.id, c.name, c.type, c.private, c.slowmode, c.user_limit, k.name category,
      (SELECT COUNT(*) FROM messages m WHERE m.channel_id = c.id AND m.created_at > ? AND m.system = 0) msgs7,
      (SELECT MAX(m.created_at) FROM messages m WHERE m.channel_id = c.id AND m.system = 0) lastAt
    FROM channels c LEFT JOIN categories k ON k.id = c.category_id WHERE c.server_id = ?
    ORDER BY COALESCE(k.position, -1), c.position, c.created_at`, now - 7 * DAY, id).map((c) => ({
    id: c.id, name: c.name, type: c.type, category: c.category ?? null, msgs7: c.msgs7, lastAt: c.lastAt ?? null,
    private: !!c.private, roles: privRoles.get(c.id) ?? [], slowmode: c.slowmode ?? 0, userLimit: c.user_limit ?? 0,
    inCall: (calls.get(c.id)?.people ?? []).map((p) => p.name),
  }));
  const memberRoles = new Map();
  for (const r of all('SELECT user_id, role_id FROM member_roles WHERE server_id = ?', id)) {
    if (!memberRoles.has(r.user_id)) memberRoles.set(r.user_id, []);
    memberRoles.get(r.user_id).push(roleName.get(r.role_id) ?? '?');
  }
  const members = all(`SELECT u.id, u.username, u.display_name name, m.nick, m.joined_at FROM members m JOIN users u ON u.id = m.user_id
    WHERE m.server_id = ? ORDER BY m.joined_at`, id).map((m) => ({
    id: m.id, username: m.username, name: m.name, nick: m.nick ?? null, joinedAt: m.joined_at,
    roles: memberRoles.get(m.id) ?? [], online: online.has(m.id), owner: base.owner?.id === m.id,
  }));
  const perDay = all(`SELECT CAST((m.created_at - ?) / ${DAY} AS INTEGER) d, COUNT(*) n FROM messages m JOIN channels c ON c.id = m.channel_id
    WHERE c.server_id = ? AND m.created_at > ? AND m.system = 0 GROUP BY d`, now - 14 * DAY, id, now - 14 * DAY);
  const invites = safe(() => all(`SELECT i.code, i.created_at, i.expires_at, i.uses, i.max_uses, u.username FROM invites i LEFT JOIN users u ON u.id = i.created_by
    WHERE i.server_id = ? AND (i.expires_at IS NULL OR i.expires_at > ?) AND (i.max_uses IS NULL OR i.uses < i.max_uses) ORDER BY i.created_at DESC`, id, now), []);
  return {
    ...base,
    channels, members, invites,
    roles: roles.map((r) => ({
      name: r.is_default ? '@everyone' : r.name, color: r.color ?? null, isDefault: !!r.is_default,
      perms: can(r.permissions, PERMS.ADMINISTRATOR) ? ['Administrador (pode tudo)'] : PERM_INFO.filter(([key]) => can(r.permissions, PERMS[key])).map(([, label]) => label),
      count: r.is_default ? members.length : members.filter((m) => m.roles.includes(r.name)).length,
    })),
    perDay: Array.from({ length: 14 }, (_, i) => perDay.find((d) => d.d === i)?.n ?? 0),
    emojis: safe(() => one('SELECT COUNT(*) n FROM emojis WHERE server_id = ?', id).n, 0),
  };
}

// Planilhas (CSV para Excel/Numbers): contas e mensagens de um canal de servidor
const csvLine = (cells) => cells.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(';');
function usersCsv() {
  const lines = [csvLine(['usuario', 'nome', 'conta criada', 'visto por ultimo', 'mensagens', 'anexos (MB)', 'servidores', 'aparelhos', 'bloqueada'])];
  for (const u of usersList()) {
    lines.push(csvLine([u.username, u.name, new Date(u.created_at).toLocaleString('pt-BR'), u.last_seen ? new Date(u.last_seen).toLocaleString('pt-BR') : '',
      u.messages, (u.bytes / 1024 / 1024).toFixed(1), u.servers, u.sessions, u.blocked_at ? 'sim' : 'não']));
  }
  return `﻿${lines.join('\n')}`;
}
function channelCsv(id) {
  const ch = one("SELECT c.name, s.name server FROM channels c JOIN servers s ON s.id = c.server_id WHERE c.id = ? AND s.kind = 'server'", id);
  if (!ch) return null;
  const lines = [csvLine(['quando', 'usuario', 'nome', 'mensagem', 'anexos'])];
  for (const m of all(`SELECT m.created_at, m.text, m.attachments, u.username, COALESCE(u.display_name, m.author_name) name FROM messages m
      LEFT JOIN users u ON u.id = m.user_id WHERE m.channel_id = ? AND m.system = 0 ORDER BY m.id`, id)) {
    let files = '';
    try { files = m.attachments ? JSON.parse(m.attachments).map((a) => a.name).join(', ') : ''; } catch { /* sem anexos legíveis */ }
    lines.push(csvLine([new Date(m.created_at).toLocaleString('pt-BR'), m.username ?? '', m.name ?? '', m.text, files]));
  }
  return { csv: `﻿${lines.join('\n')}`, name: `${ch.server}-${ch.name}` };
}
const fileSafe = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w.-]+/g, '-').slice(0, 60);

// Busca única do painel: contas (nome ou @), IPs (da auditoria) e mensagens dos servidores
function globalSearch(url) {
  const q = String(url.searchParams.get('q') ?? '').trim().slice(0, 100);
  if (q.length < 2) return { users: [], ips: [], messages: [], servers: [], channels: [] };
  const like = `%${q.replace(/^@/, '').replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const safe = (fn) => { try { return fn(); } catch { return []; } };
  const online = new Set((latest.main?.users ?? []).map((u) => u.id));
  const users = all(`SELECT id, username, display_name name FROM users WHERE username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\'
    ORDER BY COALESCE(last_seen, created_at) DESC LIMIT 8`, like, like).map((u) => ({ ...u, online: online.has(`u${u.id}`) }));
  // IP: só quando parece um (números com ponto ou dois-pontos)
  const ips = /^[\d.:a-f]+$/i.test(q) && /[.:]/.test(q)
    ? safe(() => all(`SELECT ip, MAX(at) last, COUNT(*) n, GROUP_CONCAT(DISTINCT user_name) who FROM audit_log
        WHERE ip LIKE ? ESCAPE '\\' GROUP BY ip ORDER BY last DESC LIMIT 8`, `${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
      .map((r) => ({ ip: r.ip, last: r.last, n: r.n, who: r.who ? r.who.split(',').slice(0, 5) : [] })))
    : [];
  const messages = q.length >= 3 ? searchMessages(new URL(`http://x/?q=${encodeURIComponent(q)}`)).slice(0, 8) : [];
  // Servidores pelo nome; canais pelo nome ("#jogos" também vale)
  const chLike = `%${q.replace(/^#/, '').replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const servers = safe(() => all(`SELECT id, name FROM servers WHERE kind = 'server' AND name LIKE ? ESCAPE '\\' ORDER BY created_at LIMIT 6`, like));
  const channels = safe(() => all(`SELECT c.id, c.name, c.type, s.id server_id, s.name server FROM channels c JOIN servers s ON s.id = c.server_id
    WHERE s.kind = 'server' AND c.name LIKE ? ESCAPE '\\' ORDER BY s.created_at, c.position LIMIT 8`, chLike));
  return { users, ips, messages, servers, channels };
}

function searchMessages(url) {
  const q = String(url.searchParams.get('q') ?? '').trim().slice(0, 100);
  const who = String(url.searchParams.get('user') ?? '').trim().replace(/^@/, '').slice(0, 40);
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const rows = all(`SELECT m.id, m.text, m.created_at, m.attachments, m.edited_at, m.pinned_at, u.username, COALESCE(u.display_name, m.author_name) name,
      c.name channel, s.name server
    FROM messages m JOIN channels c ON c.id = m.channel_id JOIN servers s ON s.id = c.server_id LEFT JOIN users u ON u.id = m.user_id
    WHERE s.kind != 'dm' AND m.system = 0 AND (? = '' OR m.text LIKE ? ESCAPE '\\') AND (? = '' OR u.username = ? COLLATE NOCASE)
    ORDER BY m.id DESC LIMIT 100`, q, like, who, who);
  return rows.map((r) => ({
    id: r.id, text: r.text.slice(0, 600), at: r.created_at, edited: !!r.edited_at, pinned: !!r.pinned_at, user: r.username ?? null, name: r.name,
    where: `${r.server} · #${r.channel}`,
    files: r.attachments ? JSON.parse(r.attachments).map((a) => ({ id: a.id, kind: a.kind, name: a.name, size: a.size })) : [],
  }));
}

// ---------- Resumo da semana ----------
// week=0: últimos 7 dias; week=1: os 7 anteriores… (comparando com a semana antes dela)
function weeklySummary(url) {
  const week = Math.max(0, Math.min(12, Math.floor(Number(url.searchParams.get('week')) || 0)));
  const end = Date.now() - week * 7 * DAY;
  const start = end - 7 * DAY;
  const prevStart = start - 7 * DAY;
  const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };
  const msgCount = (a, b, dm) => one(`SELECT COUNT(*) n FROM messages m JOIN channels c ON c.id = m.channel_id JOIN servers s ON s.id = c.server_id
    WHERE m.created_at >= ? AND m.created_at < ? AND m.system = 0 AND s.kind ${dm ? '=' : '!='} 'dm'`, a, b).n;
  // Minutos de call: 1 linha por minuto para cada pessoa numa call com mais alguém
  const voiceMin = (a, b) => safe(() => one('SELECT COUNT(*) n FROM call_minutes WHERE at >= ? AND at < ?', a, b).n, 0);
  const games = (a, b) => safe(() => one('SELECT COUNT(*) n FROM game_results WHERE created_at >= ? AND created_at < ?', a, b).n, 0);
  const active = (a, b) => safe(() => one(`SELECT COUNT(*) n FROM (
      SELECT user_id FROM messages WHERE created_at >= ? AND created_at < ? AND user_id IS NOT NULL AND system = 0
      UNION SELECT user_id FROM call_minutes WHERE at >= ? AND at < ?
      UNION SELECT p.user_id FROM game_players p JOIN game_results r ON r.id = p.result_id WHERE r.created_at >= ? AND r.created_at < ?)`, a, b, a, b, a, b).n, 0);
  const totals = (a, b) => ({ messages: msgCount(a, b, false), dms: msgCount(a, b, true), voiceMin: voiceMin(a, b), games: games(a, b), active: active(a, b) });
  const cur = totals(start, end);
  const prev = totals(prevStart, start);

  // Por pessoa: mensagens (servidores e privadas juntas, só a contagem), minutos de call e partidas
  const people = new Map();
  const person = (id) => { if (!people.has(id)) people.set(id, { id, messages: 0, voiceMin: 0, games: 0, wins: 0 }); return people.get(id); };
  for (const r of all('SELECT user_id, COUNT(*) n FROM messages WHERE created_at >= ? AND created_at < ? AND system = 0 AND user_id IS NOT NULL GROUP BY user_id', start, end)) person(r.user_id).messages = r.n;
  for (const r of safe(() => all('SELECT user_id, COUNT(*) n FROM call_minutes WHERE at >= ? AND at < ? GROUP BY user_id', start, end), [])) person(r.user_id).voiceMin = r.n;
  for (const r of safe(() => all(`SELECT p.user_id, COUNT(*) n, SUM(p.won) wins FROM game_players p JOIN game_results g ON g.id = p.result_id
      WHERE g.created_at >= ? AND g.created_at < ? GROUP BY p.user_id`, start, end), [])) { const p = person(r.user_id); p.games = r.n; p.wins = r.wins ?? 0; }
  const users = new Map(safe(() => all('SELECT id, username, display_name name FROM users'), []).map((u) => [u.id, u]));
  const ranking = [...people.values()].map((p) => {
    const u = users.get(p.id);
    if (!u) return null;
    return { ...p, username: u.username, name: u.name };
  }).filter(Boolean).sort((a, b) => (b.voiceMin + b.messages * 2 + b.games * 5) - (a.voiceMin + a.messages * 2 + a.games * 5));

  const channels = all(`SELECT s.name server, c.name channel, COUNT(*) n FROM messages m JOIN channels c ON c.id = m.channel_id JOIN servers s ON s.id = c.server_id
    WHERE m.created_at >= ? AND m.created_at < ? AND m.system = 0 AND s.kind != 'dm' GROUP BY c.id ORDER BY n DESC LIMIT 8`, start, end);
  const byDay = [];
  for (let d = 0; d < 7; d++) {
    const a = start + d * DAY; const b = a + DAY;
    byDay.push({ at: a, messages: msgCount(a, b, false) + msgCount(a, b, true), voiceMin: voiceMin(a, b) });
  }
  const files = one('SELECT COUNT(*) n, COALESCE(SUM(size), 0) bytes FROM files WHERE created_at >= ? AND created_at < ?', start, end);
  const newUsers = all('SELECT username, display_name name, created_at FROM users WHERE created_at >= ? AND created_at < ? ORDER BY created_at', start, end);
  const auditCount = (actions) => safe(() => one(`SELECT COUNT(*) n FROM audit_log WHERE at >= ? AND at < ? AND action IN (${actions.map(() => '?').join(',')})`, start, end, ...actions).n, 0);
  return {
    start, end, week, cur, prev, ranking, channels, byDay, files, newUsers,
    safety: {
      spam: auditCount(['spam:timeout']),
      failedLogins: auditCount(['auth:login:fail', 'painel:login:fail']),
      moderation: auditCount(['painel:msg:delete', 'painel:file:delete', 'msg:delete:other', 'msg:purge', 'member:kick']),
      blocks: auditCount(['painel:user:block', 'painel:ip:block']),
    },
  };
}


function auditQuery(url) {
  const where = [];
  const args = [];
  const q = url.searchParams;
  if (q.get('user')) { where.push('LOWER(user_name) = ?'); args.push(q.get('user').toLowerCase()); }
  if (q.get('action')) { where.push('action = ?'); args.push(q.get('action')); }
  const group = AUDIT_GROUPS[q.get('group')];
  if (group) { where.push(`action IN (${group.map(() => '?').join(',')})`); args.push(...group); }
  if (q.get('ok') === '0') where.push('ok = 0');
  if (q.get('ip')) { where.push('ip = ?'); args.push(q.get('ip')); }
  if (q.get('text')) { where.push('(detail LIKE ? OR user_name LIKE ?)'); args.push(`%${q.get('text')}%`, `%${q.get('text')}%`); }
  if (q.get('from')) { where.push('at >= ?'); args.push(Number(q.get('from'))); }
  if (q.get('to')) { where.push('at <= ?'); args.push(Number(q.get('to'))); }
  if (q.get('before')) { where.push('id < ?'); args.push(Number(q.get('before'))); }
  const limit = Math.min(1000, Math.max(1, Number(q.get('limit')) || 100));
  const sql = `SELECT id, at, user_id, user_name, action, server_id, detail, ip, ok FROM audit_log
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ${limit}`;
  return all(sql, ...args).map((r) => ({ ...r, label: AUDIT_LABELS[r.action] ?? r.action, detail: r.detail ? JSON.parse(r.detail) : null }));
}

function auditCsv(rows) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['quando', 'quem', 'acao', 'descricao', 'detalhes', 'ip', 'resultado'].join(';')];
  for (const r of rows) {
    lines.push([new Date(r.at).toLocaleString('pt-BR'), r.user_name, r.action, r.label,
      r.detail ? Object.entries(r.detail).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join(' | ') : '', r.ip, r.ok ? 'ok' : 'falhou'].map(esc).join(';'));
  }
  return `﻿${lines.join('\n')}`;
}

// ---------- Logs ----------

async function tail(file, maxBytes = 200_000) {
  let fh;
  try {
    fh = await fsp.open(file, 'r');
    const { size } = await fh.stat();
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift(); // primeira linha cortada no meio
    return lines;
  } catch {
    return [];
  } finally {
    await fh?.close();
  }
}

// Nunca mostra nada que pareça segredo (token na URL, senha, chave)
const scrub = (s) => String(s)
  .replace(/(access_token|token|key|senha|password|secret)=([^&\s"]+)/gi, '$1=•••')
  .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer •••');

const LOG_FILES = { muvuca: 'server.log', backup: 'backup.log', painel: 'painel.log' };
async function logs(which, lines = 400) {
  if (which === 'caddy') return accessLog(lines);
  const file = LOG_FILES[which];
  if (!file) return [];
  return (await tail(path.join(LOGS, file))).filter(Boolean).slice(-lines).map(scrub);
}

// Acessos ao site (log do Caddy, em JSON): sem a parte "?..." da URL, onde podem ir tokens
async function readAccess(maxBytes = 3_000_000) {
  const out = [];
  // Log de acesso do site (em logs/; o que ficou na raiz antes da mudança é lido junto até sair da janela)
  const files = [path.join(LOGS, 'caddy-antes.log'), path.join(LOGS, 'caddy.log')].filter((f) => fs.existsSync(f));
  const lines = (await Promise.all(files.map((f) => tail(f, maxBytes)))).flat();
  for (const line of lines) {
    if (!line.startsWith('{')) continue;
    try {
      const e = JSON.parse(line);
      if (!e.request) continue;
      out.push({
        at: Math.round(e.ts * 1000), ip: e.request.client_ip || e.request.remote_ip, method: e.request.method,
        host: e.request.host, path: String(e.request.uri ?? '').split('?')[0].slice(0, 120), status: e.status,
        ms: Math.round((e.duration ?? 0) * 1000), bytes: e.size ?? 0,
        ua: String(e.request.headers?.['User-Agent']?.[0] ?? '').slice(0, 120),
      });
    } catch { /* linha incompleta */ }
  }
  return out;
}
async function accessLog(lines) {
  return (await readAccess()).slice(-lines).reverse();
}
// O log do Caddy é lido e interpretado no máximo a cada 30 s
let accessCache = { at: 0, data: null };
async function accessSummary() {
  if (Date.now() - accessCache.at < 30_000 && accessCache.data) return accessCache.data;
  accessCache = { at: Date.now(), data: await accessSummaryNow() };
  return accessCache.data;
}
async function accessSummaryNow() {
  const since = Date.now() - DAY;
  const rows = (await readAccess(8_000_000)).filter((r) => r.at > since);
  const by = (key) => Object.entries(rows.reduce((m, r) => { m[r[key]] = (m[r[key]] ?? 0) + 1; return m; }, {}))
    .sort((a, b) => b[1] - a[1]).slice(0, 10);
  const status = rows.reduce((m, r) => { const k = `${String(r.status)[0]}xx`; m[k] = (m[k] ?? 0) + 1; return m; }, {});
  return { total: rows.length, since, status, ips: by('ip'), paths: by('path'), errors: rows.filter((r) => r.status >= 500).slice(-20).reverse(),
    denied: rows.filter((r) => r.status === 401 || r.status === 403 || r.status === 429).slice(-30).reverse() };
}

// ---------- Backups ----------

async function listDir(dir, re) {
  try {
    const names = (await fsp.readdir(dir)).filter((n) => re.test(n));
    const out = [];
    for (const n of names) { const st = await fsp.stat(path.join(dir, n)); out.push({ name: n, size: st.size, at: st.mtimeMs }); }
    return out.sort((a, b) => b.at - a.at);
  } catch { return null; }
}
async function backups() {
  const log = (await tail(path.join(LOGS, 'backup.log'), 50_000)).filter(Boolean);
  const results = log.filter((l) => l.startsWith('[backup')).slice(-15).reverse();
  // Avisos só do último backup (e as linhas de erro que vieram junto com ele)
  const lastIdx = log.findLastIndex((l) => l.startsWith('[backup'));
  const prevIdx = log.slice(0, Math.max(0, lastIdx)).findLastIndex((l) => l.startsWith('[backup'));
  const lastRun = lastIdx >= 0 ? log.slice(prevIdx + 1, lastIdx + 1) : [];
  const warnings = /AVISO|FALHOU/.test(log[lastIdx] ?? '') ? lastRun.filter((l) => /AVISO|FALHOU|error/i.test(l)).slice(-3) : [];
  return {
    dir: BACKUP_DIR,
    local: await listDir(BACKUP_DIR, /^(muvuca|malegna)-.*\.tar\.gz$/),
    anexos: await run('du', ['-sk', path.join(BACKUP_DIR, 'anexos')]).then((r) => Number(r.stdout.split('\t')[0]) * 1024).catch(() => 0),
    results,
    warnings,
  };
}

// ---------- Precisa de atenção ----------
// O que pede ação agora, cada item com a sub-aba onde se resolve (o painel mostra na Visão geral e
// como bolinha na lateral). level: 'bad' (urgente), 'warn' (olhar logo) ou 'info' (só para saber).
let slowCache = { at: 0, data: null }; // backups (du), certificados e atualização pendente: no máximo 1 vez por minuto
async function slowAttentionData() {
  if (slowCache.data && Date.now() - slowCache.at < 60_000) return slowCache.data;
  const [bk, certs, upd] = await Promise.all([backups().catch(() => null), certificates().catch(() => []), pendingUpdate()]);
  slowCache = { at: Date.now(), data: { bk, certs, upd } };
  return slowCache.data;
}

async function attention() {
  const out = [];
  const add = (level, text, tab) => out.push({ level, text, tab });
  const s = latest;
  const m = s.main ?? {};
  const fmtGb = (b) => `${(b / 1024 ** 3).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} GB`;
  if (s.at) {
    const queda = downNow();
    const stopped = stoppedByPanel();
    if (!m.up && stopped) add('info', `O Muvuca está desligado pelo painel desde ${new Date(stopped.at).toLocaleString('pt-BR')}. Ligue em Manutenção → Manutenção e reiniciar.`, 'manut');
    else if (!m.up) add('bad', `O Muvuca está fora do ar (${m.error ?? 'sem resposta'})${queda ? ` há ${Math.max(1, Math.round((Date.now() - queda.start) / 60_000))} min` : ''}.`, 'quedas');
    else if (m.error) add('warn', `Muvuca: ${m.error}`, 'sistema');
    for (const [name, label] of [['livekit', 'voz (LiveKit)'], ['caddy', 'HTTPS (Caddy)'], ['ddns', 'DuckDNS']]) {
      if (!s.procs?.[name]) add('bad', `O serviço de ${label} não está rodando.`, 'sistema');
    }
    const memPct = s.mem ? (s.mem.used / s.mem.total) * 100 : 0;
    if (memPct > 90) add('warn', `Memória do Mac em ${Math.round(memPct)}%.`, 'sistema');
    if (s.cpu > 85) add('warn', `Processador em ${Math.round(s.cpu)}%.`, 'sistema');
    if (s.disk && s.disk.free < 5 * 1024 ** 3) add('bad', `Disco quase cheio: só ${fmtGb(s.disk.free)} livres.`, 'sistema');
    else if (s.disk && s.disk.free < 15 * 1024 ** 3) add('warn', `Pouco espaço em disco: ${fmtGb(s.disk.free)} livres.`, 'sistema');
    const inCall = (m.voice ?? []).flatMap((v) => v.people ?? []);
    const badNet = inCall.filter((p) => p.net && (p.net.q === 'poor' || p.net.q === 'lost'));
    if (badNet.length) add('warn', `Conexão ruim na call: ${badNet.map((p) => p.name).join(', ')}.`, 'aovivo');
    const limited = inCall.filter((p) => p.net?.pub?.some((x) => x.limit === 'bandwidth' || x.limit === 'cpu'));
    if (limited.length) add('warn', `Live ou câmera com qualidade reduzida: ${limited.map((p) => p.name).join(', ')}.`, 'aovivo');
    if (m.loopDelayMs > 100) add('warn', `O Muvuca está respondendo devagar (atraso médio de ${m.loopDelayMs} ms).`, 'sistema');
  }
  const caidas = quedasSince(Date.now() - DAY);
  if (caidas.length && m.up) add('warn', `O Muvuca caiu ${caidas.length === 1 ? '1 vez' : `${caidas.length} vezes`} nas últimas 24 h.`, 'quedas');
  let ov = null;
  try { ov = overview(); } catch { /* banco indisponível */ }
  if (ov?.failed24 > 10) add('warn', `${ov.failed24} tentativas que falharam (senha errada etc.) nas últimas 24 h.`, 'auditoria');
  if (ov && !ov.auditReady) add('warn', 'A auditoria ainda não está ativa: reinicie o Muvuca uma vez para criar o registro.', 'manut');
  const { bk, certs, upd } = await slowAttentionData();
  for (const c of certs) {
    if (!c.name.endsWith('duckdns.org')) continue;
    const days = Math.floor((c.validTo - Date.now()) / DAY);
    if (days < 14) add(days < 5 ? 'bad' : 'warn', `Certificado HTTPS de ${c.name} vence em ${days} dias (o Caddy renova sozinho; se não renovar, confira os logs).`, 'sistema');
  }
  if (bk) {
    const last = bk.local?.[0]?.at;
    if (!last || Date.now() - last > 26 * 3_600_000) add('warn', `O último backup é de ${last ? `${Math.round((Date.now() - last) / 3_600_000)} h atrás` : 'nunca'}.`, 'backups');
    const lastWarn = (bk.warnings ?? []).find((w) => w.startsWith('[backup'));
    if (lastWarn) add('warn', `Último backup com aviso: ${lastWarn.replace(/^\[backup [^\]]+\]\s*/, '')}`, 'backups');
  }
  const restore = upkeepState()?.restore;
  if (restore && !restore.ok) add('bad', `O teste de restauração do backup falhou: ${restore.error ?? 'veja os detalhes'}.`, 'backups');
  const files = upd ? upd.site.length + upd.server.length : 0;
  if (files && !deploying()) add('info', `Tem atualização esperando para ir ao ar (${files} ${files === 1 ? 'arquivo mudou' : 'arquivos mudaram'}).`, 'atualizar');
  try {
    const mt = maintenanceState();
    if (mt.on) add(mt.lock ? 'warn' : 'info', mt.lock ? 'Modo manutenção ligado com o acesso travado: só você entra.' : 'Modo manutenção ligado (aviso no topo do Muvuca).', 'manut');
  } catch { /* banco indisponível */ }
  try {
    for (const sv of all("SELECT name FROM servers WHERE kind = 'server' AND owner_id IS NULL")) {
      add('warn', `O servidor "${sv.name}" está sem dono (a conta foi excluída): passe a posse para alguém.`, 'servidores');
    }
  } catch { /* banco indisponível */ }
  try {
    const recent = clientErrors(new URL('http://x/?days=1')).groups.filter((g) => g.people.length >= 3 || g.count >= 20);
    for (const g of recent.slice(0, 3)) add('warn', `Erro no site de ${g.people.length} ${g.people.length === 1 ? 'pessoa' : 'pessoas'} (${g.count} vezes em 24 h): ${g.message.slice(0, 90)}`, 'erros');
  } catch { /* sem a tabela ainda */ }
  const outdated = (() => {
    const v = desktopLatest();
    if (!v) return [];
    return (latest.main?.users ?? []).filter((u) => (u.clients ?? []).some((c) => c.app === 'desktop' && c.version && newerVersion(v, c.version)));
  })();
  if (outdated.length) add('info', `${outdated.length} ${outdated.length === 1 ? 'pessoa está' : 'pessoas estão'} com o app do computador desatualizado: ${outdated.map((u) => u.name).join(', ')}.`, 'aovivo');
  const order = { bad: 0, warn: 1, info: 2 };
  return out.sort((a, b) => order[a.level] - order[b.level]);
}

// ---------- Ações ----------

let busy = null;
function runScript(args, timeoutMs) {
  if (SANDBOX) return Promise.resolve({ ok: false, output: 'Painel de teste: não mexe no Muvuca de verdade.' });
  return new Promise((resolve) => {
    execFile('/bin/zsh', args, { cwd: ROOT, timeout: timeoutMs, env: { ...process.env, PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin' } },
      (err, stdout, stderr) => resolve({ ok: !err, output: scrub(`${stdout}${stderr}`).trim().split('\n').slice(-10).join('\n') }));
  });
}

async function doBackup(req) {
  if (busy) return { ok: false, output: `Aguarde: ${busy} em andamento.` };
  busy = 'backup';
  try {
    const r = await runScript(['./backup.sh'], 10 * 60_000);
    await fsp.appendFile(path.join(LOGS, 'backup.log'), `${r.output}\n`).catch(() => {}); // aparece em "Últimos resultados"
    audit('painel:backup', { ip: clientIp(req), ok: r.ok, detail: { resultado: r.output.split('\n').pop()?.slice(0, 200) } });
    return r;
  } finally { busy = null; }
}

async function doRestart(req, body) {
  realOnly();
  if (busy) return { ok: false, output: `Aguarde: ${busy} em andamento.` };
  const inVoice = (latest.main?.voice ?? []).reduce((n, v) => n + v.count, 0);
  if (inVoice > 0 && !body.force) return { ok: false, needsForce: true, output: `Tem ${inVoice} ${inVoice === 1 ? 'pessoa' : 'pessoas'} em call agora: a call cai por alguns segundos.` };
  busy = 'reinício';
  markPlanned(); // a queda de agora é esperada (não vira alerta)
  audit('painel:restart', { ip: clientIp(req), detail: { pessoasEmCall: inVoice } });
  // Fora deste processo (o painel continua no ar enquanto o Muvuca reinicia)
  const child = spawn('/bin/zsh', ['./server.sh', 'reiniciar'], { cwd: ROOT, detached: true, stdio: 'ignore' });
  child.unref();
  setTimeout(() => { busy = null; }, 20_000);
  return { ok: true, output: 'Reiniciando… o Muvuca volta em uns 10 segundos.' };
}

// ---------- Serviços (botões do painel) ----------
// Desligado pelo painel: guardado num arquivo (o painel pode reiniciar enquanto o Muvuca está desligado)
const STOPPED_FILE = path.join(path.dirname(DB_FILE), 'painel-desligado.json');
const stoppedByPanel = () => { try { return JSON.parse(fs.readFileSync(STOPPED_FILE, 'utf8')); } catch { return null; } };
if (stoppedByPanel()) setPlannedUntil(Date.now() + 365 * DAY);

async function serviceAction(req, body) {
  const what = String(body.what ?? '');
  const ip = clientIp(req);
  if (what === 'reload') {
    const r = await mainPost('/internal/reload', {});
    audit('painel:service', { ip, detail: { acao: 'recarregar o site de todos', abas: r.tabs } });
    return { ok: true, message: `Pedido enviado para ${r.tabs} ${r.tabs === 1 ? 'aba/app aberto' : 'abas/apps abertos'}: recarregam em alguns segundos (quem está em call volta sozinho).` };
  }
  if (what === 'voice') {
    // (no painel de teste, o start.sh que roda neste Mac é o de verdade: nunca mexe nele)
    if (SANDBOX || !latest.procs?.start) throw new Error('O supervisor (start.sh) não está rodando: use "Reiniciar o Muvuca".');
    await fsp.mkdir(LOGS, { recursive: true });
    await fsp.writeFile(path.join(LOGS, '.reiniciar-voz'), String(Date.now()));
    const inVoice = (latest.main?.voice ?? []).reduce((n, v) => n + v.count, 0);
    audit('painel:service', { ip, detail: { acao: 'reiniciar só a voz', pessoasEmCall: inVoice } });
    return { ok: true, message: 'A voz reinicia em até 5 segundos. Quem estava em call volta sozinho; o chat e os jogos não caem.' };
  }
  if (what === 'stop') {
    if (String(body.confirm ?? '').trim().toUpperCase() !== 'DESLIGAR') throw new Error('Para desligar, digite DESLIGAR.');
    if (busy) throw new Error(`Aguarde: ${busy} em andamento.`);
    setPlannedUntil(Date.now() + 365 * DAY); // não é queda: não manda alerta enquanto estiver desligado
    fs.writeFileSync(STOPPED_FILE, JSON.stringify({ at: Date.now(), ip }), { mode: 0o600 });
    const r = await runScript(['./server.sh', 'parar'], 30_000);
    audit('painel:service', { ip, ok: r.ok, detail: { acao: 'desligar o Muvuca', resultado: r.output.slice(0, 200) } });
    if (!r.ok) { fs.rmSync(STOPPED_FILE, { force: true }); setPlannedUntil(0); throw new Error(`Não deu para desligar: ${r.output || 'erro desconhecido'}`); }
    return { ok: true, message: 'Muvuca desligado. O painel continua no ar: ligue de novo por aqui quando quiser.' };
  }
  if (what === 'start') {
    const r = await runScript(['./server.sh', 'ligar'], 30_000);
    audit('painel:service', { ip, ok: r.ok, detail: { acao: 'ligar o Muvuca', resultado: r.output.slice(0, 200) } });
    if (!r.ok) throw new Error(`Não deu para ligar: ${r.output || 'erro desconhecido'}`);
    fs.rmSync(STOPPED_FILE, { force: true });
    setPlannedUntil(Date.now() + 90_000); // uns segundos para subir sem virar "queda"
    return { ok: true, message: 'Ligando o Muvuca: volta em uns 10 segundos.' };
  }
  throw new Error('Ação desconhecida.');
}

// ---------- HTTP ----------

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function readBody(req, limit = 10_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('grande demais')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
async function serveStatic(res, pathname) {
  const name = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!/^[a-z0-9-]+\.(html|js|css|svg|png|webmanifest)$/.test(name)) return json(res, 404, { error: 'Não encontrado' });
  try {
    const data = await fsp.readFile(path.join(PUBLIC, name));
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(name)], 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch {
    json(res, 404, { error: 'Não encontrado' });
  }
}

function securityHeaders(req, res) {
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'; object-src 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  if (req.headers['x-forwarded-proto'] === 'https') res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}

// Pedidos que mudam algo: só do próprio painel (mesma origem + cabeçalho que outro site não consegue mandar)
function sameOrigin(req) {
  if (req.headers['x-painel'] !== '1') return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

// Quem está usando agora (a atualização avisa antes de atrapalhar)
const activityNow = () => ({
  voice: (latest.main?.voice ?? []).reduce((n, v) => n + v.count, 0),
  lives: (latest.main?.voice ?? []).reduce((n, v) => n + (v.people ?? []).filter((p) => p.streaming).length, 0),
});

// Convites: os que valem agora (de cada servidor) e quem entrou por qual convite (pela auditoria)
function invitesOverview() {
  const now = Date.now();
  const servers = all("SELECT id, name FROM servers WHERE kind = 'server' ORDER BY created_at");
  const active = all(`SELECT i.code, i.server_id, i.created_at, i.expires_at, i.uses, i.max_uses, u.username, u.display_name
    FROM invites i LEFT JOIN users u ON u.id = i.created_by
    WHERE (i.expires_at IS NULL OR i.expires_at > ?) AND (i.max_uses IS NULL OR i.uses < i.max_uses) ORDER BY i.created_at DESC`, now);
  // Entradas por convite: cadastro ("convite ABC") ou quem já tinha conta e aceitou (código na auditoria)
  const joins = [];
  try {
    for (const r of all("SELECT at, user_name, action, detail, server_id FROM audit_log WHERE action IN ('auth:register', 'invite:accept') ORDER BY id DESC LIMIT 300")) {
      let d = {};
      try { d = JSON.parse(r.detail ?? '{}'); } catch { /* sem detalhe */ }
      const code = r.action === 'auth:register' ? (/convite (\S+)/.exec(d.via ?? '')?.[1] ?? null) : d.code ?? null;
      joins.push({ at: r.at, user: r.user_name, kind: r.action === 'auth:register' ? 'cadastro' : 'entrou', code, via: d.via === 'código de acesso' ? 'código de acesso' : null, server: servers.find((x) => x.id === r.server_id)?.name ?? null });
    }
  } catch { /* auditoria ainda vazia */ }
  const byCode = new Map();
  for (const j of joins) if (j.code) { if (!byCode.has(j.code)) byCode.set(j.code, []); byCode.get(j.code).push(j.user); }
  return {
    domain: DOMAIN,
    servers,
    active: active.map((i) => ({
      code: i.code, server: servers.find((x) => x.id === i.server_id)?.name ?? '?', serverId: i.server_id, by: i.username ?? null, byName: i.display_name ?? null,
      createdAt: i.created_at, expiresAt: i.expires_at, uses: i.uses, maxUses: i.max_uses, joined: byCode.get(i.code) ?? [],
    })),
    joins: joins.slice(0, 60),
  };
}

const api = {
  'GET /api/me': (req, res, s) => json(res, 200, { ok: true, since: s.created, ip: s.ip, domain: DOMAIN }),
  'GET /api/status': async (req, res) => json(res, 200, { ...latest, stoppedByPanel: stoppedByPanel(), desktopLatest: desktopLatest(), sizes, certs: await certificates(), busy, domain: DOMAIN, publicPort: env.PUBLIC_PORT || null }),
  'GET /api/history': (req, res, s, url) => {
    const hours = Math.min(24, Math.max(1, Number(url.searchParams.get('hours')) || 1));
    const since = Date.now() - hours * 3_600_000;
    const rows = history.filter((h) => h.t >= since);
    const step = Math.max(1, Math.floor(rows.length / 360)); // até ~360 pontos por gráfico
    json(res, 200, rows.filter((_, i) => i % step === 0));
  },
  'GET /api/overview': (req, res) => json(res, 200, overview()),
  'GET /api/pessoa': (req, res, s, url) => {
    const d = personDetail(url);
    return d ? json(res, 200, d) : json(res, 404, { error: 'Conta não encontrada.' });
  },
  'GET /api/servers': (req, res) => json(res, 200, serversList()),
  'GET /api/client-errors': (req, res, s, url) => json(res, 200, clientErrors(url)),
  'POST /api/client-errors/clear': async (req, res) => {
    const b = await readBody(req);
    const msg = String(b.message ?? '');
    const n = msg ? database().prepare('DELETE FROM client_errors WHERE message = ?').run(msg).changes : database().prepare('DELETE FROM client_errors').run().changes;
    audit('painel:service', { ip: clientIp(req), detail: { acao: 'limpar erros do site', registros: n } });
    json(res, 200, { ok: true, message: n ? 'Erro marcado como resolvido (some da lista até acontecer de novo).' : 'Nada para limpar.' });
  },
  // Ícone de servidor (e fotos): lidos da pasta de imagens do Muvuca
  'GET /api/img': async (req, res, s, url) => {
    const id = String(url.searchParams.get('id') ?? '');
    const img = /^i-[0-9a-f]{10}$/.test(id) ? one('SELECT id, mime FROM images WHERE id = ?', id) : null;
    if (!img || !/^image\/(png|jpeg|gif|webp)$/.test(img.mime)) return json(res, 404, { error: 'Imagem não encontrada' });
    try {
      const data = await fsp.readFile(path.join(path.dirname(DB_FILE), 'images', img.id));
      res.writeHead(200, { 'Content-Type': img.mime, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
      res.end(data);
    } catch { json(res, 404, { error: 'Imagem não encontrada' }); }
  },
  'GET /api/server': (req, res, s, url) => {
    const d = serverDetail(url);
    return d ? json(res, 200, d) : json(res, 404, { error: 'Servidor não encontrado.' });
  },
  'POST /api/server/rename': async (req, res) => {
    const b = await readBody(req);
    const before = one("SELECT name FROM servers WHERE id = ? AND kind = 'server'", String(b.id ?? ''));
    if (!before) return json(res, 404, { error: 'Servidor não encontrado.' });
    const r = await mainPost('/internal/server/rename', { serverId: b.id, name: String(b.name ?? '') });
    audit('painel:server:rename', { ip: clientIp(req), detail: { de: before.name, para: r.name } });
    json(res, 200, { ok: true, message: `Servidor renomeado para "${r.name}".` });
  },
  'POST /api/server/transfer': async (req, res) => {
    const b = await readBody(req);
    const sv = one("SELECT s.name, u.username dono FROM servers s LEFT JOIN users u ON u.id = s.owner_id WHERE s.id = ? AND s.kind = 'server'", String(b.id ?? ''));
    const to = one('SELECT id, username FROM users WHERE id = ?', Number(String(b.userId ?? '').replace(/^u/, '')));
    if (!sv || !to) return json(res, 404, { error: 'Servidor ou pessoa não encontrados.' });
    await mainPost('/internal/server/transfer', { serverId: b.id, userId: `u${to.id}` });
    audit('painel:server:transfer', { ip: clientIp(req), detail: { servidor: sv.name, de: sv.dono ?? '(sem dono)', para: to.username } });
    json(res, 200, { ok: true, message: `@${to.username} agora é dono de "${sv.name}".` });
  },
  'POST /api/server/delete': async (req, res) => {
    const b = await readBody(req);
    const sv = one("SELECT name FROM servers WHERE id = ? AND kind = 'server'", String(b.id ?? ''));
    if (!sv) return json(res, 404, { error: 'Servidor não encontrado.' });
    if (String(b.confirm ?? '').trim() !== sv.name) return json(res, 400, { error: 'Para excluir, digite o nome do servidor exatamente como ele é.' });
    await mainPost('/internal/server/delete', { serverId: b.id });
    audit('painel:server:delete', { ip: clientIp(req), detail: { servidor: sv.name } });
    json(res, 200, { ok: true, message: `Servidor "${sv.name}" excluído.` });
  },
  'GET /api/users.csv': (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="contas-${new Date().toISOString().slice(0, 10)}.csv"`, 'Cache-Control': 'no-store' });
    res.end(usersCsv());
  },
  'GET /api/channel.csv': (req, res, s, url) => {
    const r = channelCsv(String(url.searchParams.get('id') ?? ''));
    if (!r) return json(res, 404, { error: 'Canal não encontrado.' });
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="mensagens-${fileSafe(r.name)}.csv"`, 'Cache-Control': 'no-store' });
    res.end(r.csv);
  },
  'GET /api/busca': (req, res, s, url) => json(res, 200, globalSearch(url)),
  'GET /api/atencao': async (req, res) => json(res, 200, { items: await attention() }),
  'GET /api/users': (req, res) => json(res, 200, usersList()),
  'GET /api/files': (req, res, s, url) => json(res, 200, heavyFiles(url)),
  'GET /api/file': previewFile,
  'GET /api/summary': (req, res, s, url) => json(res, 200, weeklySummary(url)),
  'GET /api/messages': (req, res, s, url) => json(res, 200, searchMessages(url)),
  'POST /api/messages/delete': async (req, res) => {
    const b = await readBody(req);
    const m = one(`SELECT m.id, m.text, u.username, c.name channel, s.name server, s.kind skind FROM messages m
      JOIN channels c ON c.id = m.channel_id JOIN servers s ON s.id = c.server_id LEFT JOIN users u ON u.id = m.user_id WHERE m.id = ?`, Number(b.id));
    if (!m || m.skind === 'dm') return json(res, 404, { error: 'Mensagem não encontrada.' });
    const r = await mainPost('/internal/message/delete', { id: m.id });
    audit('painel:msg:delete', { ip: clientIp(req), detail: { de: m.username ? `@${m.username}` : '?', onde: `${m.server} · #${m.channel}`, texto: m.text.slice(0, 200), ...(r.files ? { anexos: r.files } : {}) } });
    json(res, 200, { ok: true, message: `Mensagem apagada${r.files ? ` (com ${r.files} ${r.files === 1 ? 'anexo' : 'anexos'})` : ''}.` });
  },
  'POST /api/files/delete': async (req, res) => {
    const b = await readBody(req);
    const f = one(`SELECT f.id, f.name, f.size, u.username, c.name channel, s.name server, s.kind skind FROM files f
      LEFT JOIN users u ON u.id = f.owner_id LEFT JOIN channels c ON c.id = f.channel_id LEFT JOIN servers s ON s.id = c.server_id WHERE f.id = ?`, String(b.id ?? ''));
    if (!f || f.skind === 'dm') return json(res, 404, { error: 'Anexo não encontrado.' });
    const r = await mainPost('/internal/file/delete', { id: f.id });
    audit('painel:file:delete', { ip: clientIp(req), detail: { arquivo: f.name, tamanho: f.size, de: f.username ? `@${f.username}` : '?', onde: `${f.server} · #${f.channel}`, ...(r.message === 'deleted' ? { mensagemApagada: true } : {}) } });
    json(res, 200, { ok: true, message: r.message === 'deleted' ? 'Anexo apagado (a mensagem só tinha ele, então saiu também).' : 'Anexo apagado.' });
  },
  'POST /api/users/disconnect': async (req, res) => {
    const b = await readBody(req);
    const u = one('SELECT id, username FROM users WHERE id = ?', Number(b.id));
    if (!u) return json(res, 404, { error: 'Conta não encontrada.' });
    const r = await mainPost('/internal/user/disconnect', { userId: `u${u.id}` });
    audit('painel:user:disconnect', { ip: clientIp(req), detail: { conta: u.username, sessoes: r.sessions } });
    json(res, 200, { ok: true, message: `@${u.username} saiu de todos os aparelhos (${r.sessions} ${r.sessions === 1 ? 'sessão' : 'sessões'}).` });
  },
  'POST /api/users/block': async (req, res) => {
    const b = await readBody(req);
    const u = one('SELECT id, username FROM users WHERE id = ?', Number(b.id));
    if (!u) return json(res, 404, { error: 'Conta não encontrada.' });
    const block = b.block === true;
    const reason = String(b.reason ?? '').slice(0, 200);
    await mainPost('/internal/user/block', { userId: `u${u.id}`, block, reason });
    audit(block ? 'painel:user:block' : 'painel:user:unblock', { ip: clientIp(req), detail: { conta: u.username, ...(reason ? { motivo: reason } : {}) } });
    json(res, 200, { ok: true, message: block ? `@${u.username} bloqueada e desconectada.` : `@${u.username} desbloqueada.` });
  },
  // Trava de velocidade dos arquivos que saem do Mac (anexos, instaladores do app, fotos)
  'POST /api/bandwidth': async (req, res) => {
    const b = await readBody(req);
    const r = await mainPost('/internal/bandwidth', { perMbps: Number(b.perMbps), totalMbps: Number(b.totalMbps), smart: b.smart === true });
    audit('painel:bandwidth', { ip: clientIp(req), detail: { porArquivo: `${r.perMbps} Mbps`, total: `${r.totalMbps} Mbps`, esperta: r.smart } });
    json(res, 200, { ok: true, message: `Trava salva: ${r.perMbps} Mbps por arquivo, ${r.totalMbps} Mbps no total${r.smart ? ', só com gente na call' : ', sempre ligada'}.` });
  },
  // Senha temporária: a pessoa entra com ela uma vez e escolhe a nova na hora
  'POST /api/users/reset-password': async (req, res) => {
    const b = await readBody(req);
    const u = one('SELECT id, username FROM users WHERE id = ?', Number(b.id));
    if (!u) return json(res, 404, { error: 'Conta não encontrada.' });
    const password = String(b.password ?? '');
    if (password.length < 6) return json(res, 400, { error: 'A senha temporária precisa ter pelo menos 6 caracteres.' });
    const r = await mainPost('/internal/user/reset-password', { userId: `u${u.id}`, password });
    audit('painel:user:reset-password', { ip: clientIp(req), detail: { conta: u.username, sessoesEncerradas: r.sessions } }); // a senha nunca vai para a auditoria
    json(res, 200, { ok: true, message: `Senha de @${u.username} trocada. Passe a senha temporária para a pessoa: no primeiro login ela escolhe a nova.` });
  },
  // Excluir a conta e tudo dela (pede o @ digitado de novo, para não apagar a conta errada)
  'POST /api/users/delete': async (req, res) => {
    const b = await readBody(req);
    const u = one('SELECT id, username, display_name FROM users WHERE id = ?', Number(b.id));
    if (!u) return json(res, 404, { error: 'Conta não encontrada.' });
    if (String(b.confirm ?? '').trim().replace(/^@/, '').toLowerCase() !== u.username.toLowerCase()) return json(res, 400, { error: 'O nome de usuário digitado não confere.' });
    const r = await mainPost('/internal/user/delete', { userId: `u${u.id}` });
    audit('painel:user:delete', { ip: clientIp(req), detail: { conta: u.username, nome: u.display_name, mensagens: r.messages, anexos: r.files, ...(r.transferred.length ? { servidoresPassados: r.transferred.length } : {}), ...(r.deletedServers ? { servidoresApagados: r.deletedServers } : {}) } });
    const extra = [r.transferred.length ? `${r.transferred.length} servidor(es) dela passaram para o membro mais antigo` : null, r.deletedServers ? `${r.deletedServers} servidor(es) vazios apagados` : null].filter(Boolean).join('; ');
    json(res, 200, { ok: true, message: `Conta @${u.username} excluída: ${r.messages} mensagens e ${r.files} anexos apagados${extra ? `; ${extra}` : ''}.` });
  },
  'GET /api/ips': (req, res) => {
    json(res, 200, { blocked: all('SELECT ip, reason, created_at FROM blocked_ips ORDER BY created_at DESC'), you: clientIp(req) });
  },
  'POST /api/ips/block': async (req, res) => {
    const b = await readBody(req);
    const ip = String(b.ip ?? '').trim();
    const block = b.block === true;
    if (block && ip.replace(/^::ffff:/, '') === clientIp(req).replace(/^::ffff:/, '')) return json(res, 400, { error: 'Esse é o IP de onde você está usando o painel: bloquear tiraria você do Muvuca.' });
    const r = await mainPost('/internal/ip/block', { ip, block, reason: String(b.reason ?? '') });
    audit(block ? 'painel:ip:block' : 'painel:ip:unblock', { ip: clientIp(req), detail: { ipAlvo: ip, ...(b.reason ? { motivo: String(b.reason).slice(0, 200) } : {}), ...(r.closed ? { conexoesFechadas: r.closed } : {}) } });
    json(res, 200, { ok: true, message: block ? `IP ${ip} bloqueado${r.closed ? ` (${r.closed} ${r.closed === 1 ? 'conexão fechada' : 'conexões fechadas'})` : ''}.` : `IP ${ip} desbloqueado.` });
  },
  'GET /api/maintenance': (req, res) => json(res, 200, maintenanceState()),
  'POST /api/maintenance': async (req, res) => {
    const b = await readBody(req);
    const r = await mainPost('/internal/maintenance', { on: b.on === true, message: b.message, lock: b.lock === true, minutes: Number(b.minutes) || 0 });
    audit('painel:maintenance', { ip: clientIp(req), detail: r.on ? { ligado: true, mensagem: r.message, acessoTravado: r.lock, ...(b.minutes ? { minutos: Number(b.minutes) } : {}) } : { ligado: false } });
    json(res, 200, { ok: true, state: r, message: r.on ? (r.lock ? `Manutenção ligada com acesso travado (${r.closed} ${r.closed === 1 ? 'pessoa saiu' : 'pessoas saíram'}).` : 'Aviso de manutenção ligado para todo mundo.') : 'Manutenção desligada.' });
  },
  'GET /api/audit': (req, res, s, url) => json(res, 200, { rows: auditQuery(url), labels: AUDIT_LABELS, groups: Object.keys(AUDIT_GROUPS) }),
  'GET /api/audit.csv': (req, res, s, url) => {
    url.searchParams.set('limit', '1000');
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="auditoria-${new Date().toISOString().slice(0, 10)}.csv"`, 'Cache-Control': 'no-store' });
    res.end(auditCsv(auditQuery(url)));
  },
  'GET /api/logs': async (req, res, s, url) => json(res, 200, await logs(url.searchParams.get('which'), Math.min(2000, Number(url.searchParams.get('lines')) || 400))),
  'GET /api/access': async (req, res) => json(res, 200, await accessSummary()),
  'GET /api/backups': async (req, res) => json(res, 200, await backups()),
  'GET /api/sessions': (req, res, s) => json(res, 200, [...sessions.entries()].map(([id, v]) => ({ current: id === s.id, created: v.created, last: v.last, ip: v.ip, ua: v.ua }))),
  'POST /api/logout': (req, res, s) => logout(req, res, s),
  'POST /api/logout-all': (req, res, s) => {
    for (const id of sessions.keys()) if (id !== s.id) sessions.delete(id);
    json(res, 200, { ok: true });
  },
  'POST /api/backup': async (req, res) => json(res, 200, await doBackup(req)),
  'POST /api/restart': async (req, res) => json(res, 200, await doRestart(req, await readBody(req))),
  'POST /api/service': async (req, res) => {
    try { json(res, 200, await serviceAction(req, await readBody(req))); } catch (err) { json(res, 400, { error: err.message }); }
  },
  // ---------- Convites ----------
  'GET /api/invites': (req, res) => json(res, 200, invitesOverview()),
  'POST /api/invites/create': async (req, res) => {
    const b = await readBody(req);
    const srv = one("SELECT id, name FROM servers WHERE id = ? AND kind != 'dm'", String(b.serverId ?? ''));
    if (!srv) return json(res, 404, { error: 'Servidor não encontrado.' });
    const expiresIn = b.expiresIn === null ? null : Number(b.expiresIn);
    const maxUses = b.maxUses ? Number(b.maxUses) : null;
    const r = await mainPost('/internal/invite/create', { serverId: srv.id, expiresIn, maxUses });
    audit('painel:invite:create', { ip: clientIp(req), detail: { servidor: srv.name, codigo: r.code, ...(maxUses ? { usos: maxUses } : {}) } });
    json(res, 200, { ok: true, code: r.code, link: `https://${DOMAIN}/?convite=${r.code}`, message: 'Convite criado.' });
  },
  'POST /api/invites/revoke': async (req, res) => {
    const b = await readBody(req);
    const row = one('SELECT i.code, s.name FROM invites i JOIN servers s ON s.id = i.server_id WHERE i.code = ?', String(b.code ?? ''));
    if (!row) return json(res, 404, { error: 'Convite não encontrado.' });
    await mainPost('/internal/invite/revoke', { code: row.code });
    audit('painel:invite:revoke', { ip: clientIp(req), detail: { servidor: row.name, codigo: row.code } });
    json(res, 200, { ok: true, message: `Convite ${row.code} cancelado.` });
  },
  'GET /api/upkeep': (req, res) => json(res, 200, upkeepState()),
  'POST /api/upkeep/restore-test': async (req, res) => {
    const r = await restoreTest();
    json(res, 200, { ok: r.ok, message: r.ok ? `Backup testado: abriu certinho (${r.counts.contas} contas, ${r.counts.mensagens} mensagens).` : `O teste falhou: ${r.error}` });
  },
  ...alertRoutes({ json, readBody, audit, clientIp }),
  ...deployRoutes({
    json, readBody, clientIp, root: ROOT, mainUrl: MAIN_URL, auditFn: audit, activityFn: activityNow,
    noticeFn: (b) => mainPost('/internal/maintenance', b),
  }),
};

// Manutenção automática: gira os logs, recarrega o certificado do TURN e testa o backup toda semana
startUpkeep({
  dataDir: path.dirname(DB_FILE), logsDir: LOGS, backupDir: BACKUP_DIR, root: ROOT, one,
  activity: () => ({ ...activityNow(), games: (latest.main?.games ?? []).length }),
  deploying, markPlanned, alert: sendAlert,
  audit: (action, opts) => audit(action, opts),
  certFile: () => path.join(CADDY_CERTS, 'acme-v02.api.letsencrypt.org-directory', DOMAIN, `${DOMAIN}.crt`),
});

// O login por Face ID / Touch ID e o teste de velocidade saíram do painel: os arquivos deles não servem mais
for (const f of ['painel-passkeys.json', 'speedtests.json']) fs.rmSync(path.join(path.dirname(DB_FILE), f), { force: true });

// Alertas no celular (+ histórico de quedas)
startAlerts({
  dataDir: path.dirname(DB_FILE), domain: DOMAIN, one,
  latest: () => latest,
  deploying,
  certificates,
  weekly: () => weeklySummary(new URL('http://x/?week=0')),
  // Últimas linhas do log do Muvuca quando ele cai (o motivo costuma estar ali)
  lastLog: async () => (await tail(path.join(LOGS, 'server.log'), 20_000)).filter(Boolean).slice(-15).map(scrub),
  lastBackup: async () => {
    const line = (await tail(path.join(LOGS, 'backup.log'), 20_000)).filter((l) => l.startsWith('[backup')).pop();
    const m = line && /^\[backup (\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\]/.exec(line);
    return m ? { line, at: new Date(m[1].replace(' ', 'T')).getTime() } : null;
  },
});

const server = http.createServer(async (req, res) => {
  securityHeaders(req, res);
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'POST' && url.pathname === '/api/login') {
      if (!sameOrigin(req)) return json(res, 403, { error: 'Origem não permitida.' });
      return await login(req, res);
    }
    if (url.pathname.startsWith('/api/')) {
      const s = sessionOf(req);
      if (!s) return json(res, 401, { error: 'Entre de novo.' });
      if (req.method !== 'GET' && !sameOrigin(req)) return json(res, 403, { error: 'Origem não permitida.' });
      const handler = api[`${req.method} ${url.pathname}`];
      if (!handler) return json(res, 404, { error: 'Não encontrado' });
      return await handler(req, res, s, url);
    }
    if (req.method !== 'GET') return json(res, 405, { error: 'Método não permitido' });
    return await serveStatic(res, url.pathname);
  } catch (err) {
    console.error(err);
    // Painel só do administrador: a mensagem ajuda mais do que um "erro interno"
    if (!res.headersSent) json(res, 500, { error: err.message || 'Erro interno' });
  }
});

// Limpeza: sessões vencidas e bloqueios antigos
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) if (now - s.last > SESSION_IDLE_MS || now - s.created > SESSION_MAX_MS) sessions.delete(id);
  for (const [ip, f] of ipFails) if (f.until < now && f.count === 0) ipFails.delete(ip);
}, 60_000).unref();

process.on('SIGTERM', () => {
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(history), { mode: 0o600 }); } catch { /* sem histórico salvo */ }
  process.exit(0);
});

server.listen(PORT, HOST, () => console.log(`[${new Date().toLocaleString('pt-BR')}] Painel em http://${HOST}:${PORT} (${DOMAIN})`));
