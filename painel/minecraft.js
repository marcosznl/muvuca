// Minecraft no painel: liga, desliga e reinicia os servidores da pasta minecraft/ do projeto, mostra quem está
// jogando, consumo e desempenho, console (RCON), logs, configurações, lista de permitidos e backup dos mundos.
//
// Cada servidor roda como um serviço do macOS (launchd) próprio, carregado só quando o painel manda ligar
// (o arquivo do serviço fica em data/launchd/, fora de ~/Library/LaunchAgents: não liga sozinho ao entrar no Mac).
// Desligar é sempre pelo comando "stop" do jogo (salva o mundo); só se ele não responder é que o processo é encerrado.
import net from 'node:net';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const UID = process.getuid();
let MC_ROOT; // minecraft/ dentro do projeto do Muvuca (ou MINECRAFT_DIR)
const BACKUP_ROOT = path.join(os.homedir(), 'Backups/Minecraft');
const SAMPLE_MS = 15_000;
const STOP_WAIT_MS = 90_000;
export const MEMORY_CHOICES = ['2G', '3G', '4G', '5G', '6G', '8G'];
export const AUTOSTOP_CHOICES = [0, 10, 20, 30, 60]; // minutos vazio até desligar (0 = nunca)

let ROOT;          // pasta do projeto do Muvuca (para data/ e logs/)
let audit = () => {};
let CONFIG_FILE;
let PLIST_DIR;
let LOG_DIR;

// ---------- Configurações que o próprio servidor guarda (server.properties) ----------

// O que dá para mudar pelo painel (vale na próxima vez que ligar)
export const EDITABLE = {
  motd: { label: 'Mensagem na lista de servidores', type: 'text', max: 59 },
  'max-players': { label: 'Máximo de jogadores', type: 'int', min: 1, max: 100 },
  difficulty: { label: 'Dificuldade', type: 'enum', choices: [['peaceful', 'Pacífico'], ['easy', 'Fácil'], ['normal', 'Normal'], ['hard', 'Difícil']] },
  gamemode: { label: 'Modo de jogo', type: 'enum', choices: [['survival', 'Sobrevivência'], ['creative', 'Criativo'], ['adventure', 'Aventura'], ['spectator', 'Espectador']] },
  pvp: { label: 'PvP (jogador contra jogador)', type: 'bool' },
  'white-list': { label: 'Só quem está na lista de permitidos entra', type: 'bool' },
  'view-distance': { label: 'Distância de visão (chunks)', type: 'int', min: 3, max: 32 },
  'simulation-distance': { label: 'Distância de simulação (chunks)', type: 'int', min: 3, max: 32 },
  'spawn-protection': { label: 'Proteção do spawn (blocos)', type: 'int', min: 0, max: 64 },
  'allow-flight': { label: 'Permitir voo (alguns mods precisam)', type: 'bool' },
};

function readProps(dir) {
  const out = {};
  try {
    for (const line of fs.readFileSync(path.join(dir, 'server.properties'), 'utf8').split('\n')) {
      const m = line.match(/^([a-zA-Z0-9.-]+)=(.*)$/);
      if (m) out[m[1]] = m[2];
    }
  } catch { /* sem arquivo */ }
  return out;
}

// Troca só as linhas pedidas, mantendo o resto do arquivo como está
async function writeProps(dir, changes) {
  const file = path.join(dir, 'server.properties');
  const lines = (await fsp.readFile(file, 'utf8')).split('\n');
  const done = new Set();
  const out = lines.map((line) => {
    const m = line.match(/^([a-zA-Z0-9.-]+)=/);
    if (m && m[1] in changes) { done.add(m[1]); return `${m[1]}=${changes[m[1]]}`; }
    return line;
  });
  for (const [k, v] of Object.entries(changes)) if (!done.has(k)) out.splice(out.length - (out.at(-1) === '' ? 1 : 0), 0, `${k}=${v}`);
  await fsp.writeFile(`${file}.tmp`, out.join('\n'));
  await fsp.rename(`${file}.tmp`, file);
}

// Caracteres de texto do .properties: o motd aceita acentos escritos como \uXXXX
const propText = (s) => [...s].map((c) => (c.charCodeAt(0) > 126 ? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}` : c)).join('');
const readText = (s) => String(s ?? '').replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

function validate(changes) {
  const out = {};
  for (const [k, raw] of Object.entries(changes ?? {})) {
    const def = EDITABLE[k];
    if (!def) continue;
    if (def.type === 'text') {
      const v = String(raw ?? '').replace(/[\r\n]/g, ' ').trim().slice(0, def.max);
      out[k] = propText(v).replace(/\\(?!u[0-9a-f]{4})/g, '\\\\');
    } else if (def.type === 'int') {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < def.min || n > def.max) throw new Error(`${def.label}: use um número de ${def.min} a ${def.max}.`);
      out[k] = String(n);
    } else if (def.type === 'enum') {
      if (!def.choices.some(([v]) => v === raw)) throw new Error(`${def.label}: opção inválida.`);
      out[k] = raw;
    } else if (def.type === 'bool') {
      out[k] = raw === true || raw === 'true' ? 'true' : 'false';
    }
  }
  return out;
}

// ---------- Configurações do painel para cada servidor (memória, desligar sozinho) ----------

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}
function saveConfig(cfg) {
  fs.writeFileSync(`${CONFIG_FILE}.tmp`, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.renameSync(`${CONFIG_FILE}.tmp`, CONFIG_FILE);
}

// ---------- Descoberta dos servidores ----------

// Cada pasta com server.properties é um servidor. Paper (run.jar) ou NeoForge/Forge (run.sh + user_jvm_args.txt)
function discover() {
  let names = [];
  try { names = fs.readdirSync(MC_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return []; }
  const out = [];
  for (const id of names.sort()) {
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(id)) continue;
    const dir = path.join(MC_ROOT, id);
    if (!fs.existsSync(path.join(dir, 'server.properties'))) continue;
    const modded = fs.existsSync(path.join(dir, 'run.sh')) && fs.existsSync(path.join(dir, 'user_jvm_args.txt'));
    const jar = fs.existsSync(path.join(dir, 'run.jar')) ? 'run.jar' : fs.readdirSync(dir).find((f) => /\.jar$/.test(f) && !/installer/i.test(f));
    if (!modded && !jar) continue;
    out.push({ id, dir, modded, jar, label: `com.marcos.minecraft.${id}`, version: versionOf(dir, modded) });
  }
  return out;
}

// Versão e tipo, pelo começo do último log
function versionOf(dir, modded) {
  try {
    // O log de modpack é enorme: lê só o começo (a versão aparece nas primeiras linhas do servidor)
    const fd = fs.openSync(path.join(dir, 'logs/latest.log'), 'r');
    const buf = Buffer.alloc(3_000_000);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const head = buf.subarray(0, n).toString('utf8');
    const mc = head.match(/Starting minecraft server version (\S+)/)?.[1];
    const paper = head.match(/running (Paper|Purpur|Folia|Spigot) version (\S+)/);
    const loader = modded ? (fs.existsSync(path.join(dir, 'libraries/net/neoforged')) ? 'NeoForge' : 'Forge') : null;
    const mods = modded ? (() => { try { return fs.readdirSync(path.join(dir, 'mods')).filter((f) => f.endsWith('.jar')).length; } catch { return 0; } })() : 0;
    return { minecraft: mc ?? '?', kind: paper ? paper[1] : loader ?? 'Vanilla', mods };
  } catch {
    return { minecraft: '?', kind: modded ? 'Forge/NeoForge' : 'Paper/Vanilla', mods: 0 };
  }
}

let servers = [];
const byId = (id) => servers.find((s) => s.id === id);

// ---------- RCON (comando remoto do Minecraft) ----------

// Protocolo simples: pacote = tamanho, id, tipo, texto, 2 zeros. Tipo 3 = senha, 2 = comando, 0 = resposta
export function rcon(port, password, commands, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    let buf = Buffer.alloc(0);
    const results = [];
    let step = -1; // -1 = autenticando; depois o índice do comando
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('o servidor não respondeu ao console')); }, timeoutMs);
    const send = (id, type, body) => {
      const payload = Buffer.from(body, 'utf8');
      const pkt = Buffer.alloc(14 + payload.length);
      pkt.writeInt32LE(10 + payload.length, 0);
      pkt.writeInt32LE(id, 4);
      pkt.writeInt32LE(type, 8);
      payload.copy(pkt, 12);
      sock.write(pkt);
    };
    const next = () => {
      step++;
      if (step >= commands.length) { clearTimeout(timer); sock.end(); resolve(results); return; }
      send(100 + step, 2, commands[step]);
    };
    sock.on('connect', () => send(1, 3, password));
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 4) {
        const len = buf.readInt32LE(0);
        if (buf.length < 4 + len) break;
        const id = buf.readInt32LE(4);
        const body = buf.subarray(12, 4 + len - 2).toString('utf8');
        buf = buf.subarray(4 + len);
        if (step === -1) {
          if (id === -1) { clearTimeout(timer); sock.destroy(); reject(new Error('senha do RCON recusada')); return; }
          next();
        } else if (id === 100 + step) {
          results.push(body.replace(/§./g, ''));
          next();
        }
      }
    });
    sock.on('error', (err) => { clearTimeout(timer); reject(err.code === 'ECONNREFUSED' ? new Error('desligado') : err); });
  });
}

// Ping da lista de servidores (o mesmo que o Minecraft usa para mostrar "3/10"): não depende de idioma
// nem de plugin, e não aparece no log do jogo. Traz quantos estão online, o máximo e até 12 nomes.
export function statusPing(port, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const varint = (n) => { const out = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n); return Buffer.from(out); };
    const packet = (...parts) => { const body = Buffer.concat(parts); return Buffer.concat([varint(body.length), body]); };
    const host = Buffer.from('127.0.0.1');
    const portBuf = Buffer.alloc(2);
    portBuf.writeUInt16BE(port);
    const sock = net.connect({ host: '127.0.0.1', port });
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('sem resposta')); }, timeoutMs);
    const readVarint = (b, pos) => { let n = 0; let shift = 0; for (;;) { if (pos >= b.length) return null; const x = b[pos++]; n |= (x & 0x7f) << shift; if (!(x & 0x80)) return [n, pos]; shift += 7; if (shift > 35) throw new Error('resposta inválida'); } };
    sock.on('connect', () => {
      sock.write(packet(varint(0), varint(767), varint(host.length), host, portBuf, varint(1))); // handshake → status
      sock.write(packet(varint(0))); // pedido de status
    });
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      try {
        const len = readVarint(buf, 0);
        if (!len || buf.length < len[1] + len[0]) return;
        const id = readVarint(buf, len[1]);
        const strLen = readVarint(buf, id[1]);
        const data = JSON.parse(buf.subarray(strLen[1], strLen[1] + strLen[0]).toString('utf8'));
        clearTimeout(timer);
        sock.destroy();
        resolve({ players: data.players?.online ?? 0, max: data.players?.max ?? 0, names: (data.players?.sample ?? []).map((p) => p.name).filter((n) => /^[A-Za-z0-9_]{1,16}$/.test(n)) });
      } catch (err) { clearTimeout(timer); sock.destroy(); reject(err); }
    });
    sock.on('error', (err) => { clearTimeout(timer); reject(err.code === 'ECONNREFUSED' ? new Error('desligado') : err); });
  });
}

const rconOf = (s, commands, timeoutMs) => {
  const p = readProps(s.dir);
  if (p['enable-rcon'] !== 'true' || !p['rcon.password']) return Promise.reject(new Error('RCON desligado no server.properties'));
  return rcon(Number(p['rcon.port'] || 25575), p['rcon.password'], commands, timeoutMs);
};

// ---------- launchd (um serviço por servidor) ----------

const plistPath = (s) => path.join(PLIST_DIR, `${s.label}.plist`);
const consoleLog = (s) => path.join(LOG_DIR, `minecraft-${s.id}.log`);
const xml = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function javaPath() {
  try { return path.join((await run('/usr/libexec/java_home')).stdout.trim(), 'bin/java'); } catch { return '/usr/bin/java'; }
}

// Memória: Paper recebe pela linha de comando; NeoForge/Forge pelo user_jvm_args.txt (linha gerenciada pelo painel)
async function applyModdedMemory(s, memory) {
  const file = path.join(s.dir, 'user_jvm_args.txt');
  const lines = (await fsp.readFile(file, 'utf8')).split('\n').filter((l) => !/^\s*-Xm[sx]\S+\s*$/.test(l) && l !== '# (memória definida pelo painel do Muvuca)');
  if (lines.at(-1) === '') lines.pop();
  lines.push('# (memória definida pelo painel do Muvuca)', `-Xmx${memory}`, `-Xms${memory === '2G' ? '1G' : '2G'}`, '');
  await fsp.writeFile(file, lines.join('\n'));
}

async function writePlist(s, memory) {
  let args;
  if (s.modded) {
    await applyModdedMemory(s, memory);
    args = ['/bin/sh', './run.sh'];
  } else {
    // Parâmetros recomendados pelo Paper (coleta de lixo G1 com pausas curtas)
    args = [await javaPath(), `-Xms${memory}`, `-Xmx${memory}`, '-XX:+UseG1GC', '-XX:+ParallelRefProcEnabled', '-XX:MaxGCPauseMillis=200',
      '-XX:+UnlockExperimentalVMOptions', '-XX:+DisableExplicitGC', '-XX:G1NewSizePercent=30', '-XX:G1MaxNewSizePercent=40',
      '-XX:G1HeapRegionSize=8M', '-XX:G1ReservePercent=20', '-XX:InitiatingHeapOccupancyPercent=15', '-jar', s.jar, '--nogui'];
  }
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>${xml(s.label)}</string>
    <key>ProgramArguments</key>
    <array>${args.map((a) => `<string>${xml(a)}</string>`).join('')}</array>
    <key>WorkingDirectory</key><string>${xml(s.dir)}</string>
    <key>EnvironmentVariables</key>
    <dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><false/>
    <key>ProcessType</key><string>Interactive</string>
    <key>StandardOutPath</key><string>${xml(consoleLog(s))}</string>
    <key>StandardErrorPath</key><string>${xml(consoleLog(s))}</string>
</dict>
</plist>
`;
  await fsp.mkdir(PLIST_DIR, { recursive: true });
  await fsp.writeFile(plistPath(s), plist, { mode: 0o600 });
}

async function launchdPid(s) {
  try {
    const { stdout } = await run('launchctl', ['print', `gui/${UID}/${s.label}`]);
    return Number(stdout.match(/\bpid = (\d+)/)?.[1]) || 0; // carregado; 0 = carregado mas já parou
  } catch {
    return null; // não carregado
  }
}
const bootout = (s) => run('launchctl', ['bootout', `gui/${UID}/${s.label}`]).catch(() => {});

// ---------- Estado de cada servidor ----------

const state = new Map(); // id -> { phase, pid, players, max, names, tps, rss, cpu, startedAt, emptySince, lastError, busy }
const st = (id) => { if (!state.has(id)) state.set(id, { phase: 'stopped', names: [] }); return state.get(id); };

// Memória e CPU somando o processo e os filhos (o run.sh do NeoForge chama o java como filho)
async function usage(rootPid) {
  const { stdout } = await run('ps', ['-axo', 'pid=,ppid=,rss=,%cpu=,etime=']);
  const rows = stdout.trim().split('\n').map((l) => l.trim().split(/\s+/)).map(([pid, ppid, rss, cpu, etime]) => ({ pid: +pid, ppid: +ppid, rss: +rss * 1024, cpu: +cpu, etime }));
  const tree = new Set([rootPid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const r of rows) if (!tree.has(r.pid) && tree.has(r.ppid)) { tree.add(r.pid); changed = true; }
  }
  const mine = rows.filter((r) => tree.has(r.pid));
  return { rss: mine.reduce((n, r) => n + r.rss, 0), cpu: Math.round(mine.reduce((n, r) => n + r.cpu, 0) * 10) / 10, etime: rows.find((r) => r.pid === rootPid)?.etime ?? '' };
}

// TPS (fluidez; 20 = perfeito) pelo console: só quando alguém está olhando a aba e no máximo 1 vez por minuto
// (cada consulta pelo console aparece no log do jogo)
async function refreshTps(s) {
  const x = st(s.id);
  if (x.phase !== 'running' || s.modded || Date.now() - (x.tpsAt ?? 0) < 60_000) return;
  x.tpsAt = Date.now();
  try {
    const [out] = await rconOf(s, ['tps'], 3000);
    // "TPS from last 1m, 5m, 15m: 20,0, 20,0, 20,0" (com vírgula decimal no Paper em português): o primeiro valor depois dos dois-pontos
    const n = Number(out.split(':').slice(1).join(':').match(/(\d+(?:[.,]\d+)?)/)?.[1].replace(',', '.'));
    x.tps = Number.isFinite(n) ? Math.min(20, n).toFixed(1) : null;
    x.rconError = null;
  } catch (err) {
    x.rconError = err.message;
  }
}

async function refresh(s) {
  const x = st(s.id);
  const pid = await launchdPid(s);
  let online = null;
  const port = Number(readProps(s.dir)['server-port'] || 25565);
  try {
    online = await statusPing(port);
  } catch (err) {
    x.pingError = err.message;
  }
  x.external = !pid && !!online; // ligado fora do painel (ex.: no Terminal)
  if (online) {
    if (x.phase !== 'stopping') x.phase = 'running';
    Object.assign(x, online);
    x.pingError = null;
  } else if (pid) {
    if (x.phase !== 'stopping') x.phase = 'starting'; // processo no ar, mas o jogo ainda está carregando
  } else {
    if (x.phase === 'running' || x.phase === 'starting') x.lastExit = Date.now();
    x.phase = x.busy === 'start' ? 'starting' : 'stopped';
    x.players = 0;
    x.names = [];
    x.tps = null;
  }
  x.pid = pid || null;
  if (pid) Object.assign(x, await usage(pid).catch(() => ({})));
  else { x.rss = 0; x.cpu = 0; x.etime = ''; }
  // Desligar sozinho depois de X minutos vazio (só servidores ligados pelo painel)
  const auto = Number(loadConfig()[s.id]?.autoStop ?? 0);
  if (x.phase === 'running' && pid && x.players === 0) {
    x.emptySince ??= Date.now();
    if (auto > 0 && Date.now() - x.emptySince > auto * 60_000 && !x.busy) {
      audit('painel:mc:autostop', { detail: { servidor: s.id, vazioHaMin: auto } });
      stop(s).catch(() => {});
    }
  } else {
    x.emptySince = null;
  }
}

async function sampleAll() {
  servers = discover();
  await Promise.all(servers.map((s) => refresh(s).catch((err) => { st(s.id).lastError = err.message; })));
}

// ---------- Ações ----------

async function start(s) {
  const x = st(s.id);
  if (x.busy) throw new Error(`Aguarde: ${x.busy === 'start' ? 'ligando' : x.busy === 'stop' ? 'desligando' : 'backup'} em andamento.`);
  if (x.phase === 'running' || x.phase === 'starting') throw new Error('Esse servidor já está ligado.');
  // Mesma porta de outro servidor ligado: não deixa (um derrubaria o outro)
  const port = readProps(s.dir)['server-port'];
  const clash = servers.find((o) => o !== s && ['running', 'starting'].includes(st(o.id).phase) && readProps(o.dir)['server-port'] === port);
  if (clash) throw new Error(`O servidor ${clash.id} já está usando a porta ${port}.`);
  const memory = loadConfig()[s.id]?.memory ?? (s.modded ? '4G' : '3G');
  x.busy = 'start';
  try {
    await bootout(s); // sobra de uma vez anterior
    await fsp.mkdir(LOG_DIR, { recursive: true });
    await fsp.writeFile(consoleLog(s), `[${new Date().toLocaleString('pt-BR')}] ligando pelo painel (memória ${memory})\n`);
    await writePlist(s, memory);
    await run('launchctl', ['bootstrap', `gui/${UID}`, plistPath(s)]);
    x.phase = 'starting';
    x.startedAt = Date.now();
  } finally {
    x.busy = null;
  }
}

async function stop(s) {
  const x = st(s.id);
  if (x.busy === 'stop') throw new Error('Já está desligando.');
  if (x.external) throw new Error('Esse servidor foi ligado fora do painel (no Terminal): desligue por lá ou pelo console com o comando stop.');
  const pid = await launchdPid(s);
  if (!pid) { await bootout(s); x.phase = 'stopped'; return; }
  x.busy = 'stop';
  x.phase = 'stopping';
  try {
    // "stop" salva o mundo e sai; se o console não responder, pede para o processo encerrar (o Minecraft salva ao receber)
    await rconOf(s, ['stop'], 5000).catch(() => run('launchctl', ['kill', 'SIGTERM', `gui/${UID}/${s.label}`]).catch(() => {}));
    const end = Date.now() + STOP_WAIT_MS;
    while (Date.now() < end && await launchdPid(s)) await new Promise((r) => setTimeout(r, 1500));
    await bootout(s); // se ainda estiver preso depois de 90 s, o launchd encerra à força
    x.phase = 'stopped';
  } finally {
    x.busy = null;
  }
}

async function restart(s) {
  await stop(s);
  await start(s);
}

// ---------- Backup dos mundos ----------

const backupDir = (s) => path.join(BACKUP_ROOT, s.id);

async function worldDirs(s) {
  const level = readProps(s.dir)['level-name'] || 'world';
  const names = (await fsp.readdir(s.dir)).filter((n) => n === level || n === `${level}_nether` || n === `${level}_the_end`);
  return names.filter((n) => fs.statSync(path.join(s.dir, n)).isDirectory());
}

async function dirSize(p) {
  try { return Number((await run('du', ['-sk', p])).stdout.split('\t')[0]) * 1024; } catch { return 0; }
}

// Mesmo histórico do backup do Muvuca: 3 mais recentes, 1 por dia (14 dias) e 1 por mês (6 meses)
async function pruneBackups(s) {
  const dir = backupDir(s);
  const re = new RegExp(`^${s.id}-(\\d{4}-\\d{2})-(\\d{2})_(\\d{4})\\.tar\\.gz$`);
  const files = (await fsp.readdir(dir).catch(() => [])).filter((f) => re.test(f)).sort().reverse();
  const days = new Set();
  const months = new Set();
  for (const [i, f] of files.entries()) {
    const [, month, day] = f.match(re);
    let keep = i < 3;
    if (!days.has(`${month}-${day}`)) { days.add(`${month}-${day}`); if (days.size <= 14) keep = true; }
    if (!months.has(month)) { months.add(month); if (months.size <= 6) keep = true; }
    if (!keep) await fsp.unlink(path.join(dir, f)).catch(() => {});
  }
}

async function backup(s, reason = 'manual') {
  const x = st(s.id);
  if (x.busy) throw new Error('Aguarde a ação em andamento terminar.');
  const worlds = await worldDirs(s);
  if (!worlds.length) throw new Error('Não encontrei a pasta do mundo.');
  let size = 0;
  for (const w of worlds) size += await dirSize(path.join(s.dir, w));
  const free = await fsp.statfs(os.homedir()).then((d) => d.bavail * d.bsize);
  if (free < size * 1.2 + 3 * 1024 ** 3) throw new Error(`Pouco espaço em disco para o backup (${Math.round(free / 1024 ** 3)} GB livres; o mundo tem ${Math.round(size / 1024 ** 2)} MB).`);
  x.busy = 'backup';
  const running = x.phase === 'running';
  const stamp = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const name = `${s.id}-${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())}_${pad(stamp.getHours())}${pad(stamp.getMinutes())}.tar.gz`;
  const dest = path.join(backupDir(s), name);
  try {
    await fsp.mkdir(backupDir(s), { recursive: true, mode: 0o700 });
    // Ligado: pausa o salvamento automático e força salvar tudo, para a cópia sair consistente
    if (running) await rconOf(s, ['save-off', 'save-all flush'], 60_000).catch(() => {});
    await new Promise((resolve, reject) => {
      const tar = spawn('tar', ['-czf', `${dest}.tmp`, '-C', s.dir, ...worlds], { stdio: 'ignore' });
      tar.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('falhou ao compactar o mundo'))));
      tar.on('error', reject);
    });
    await fsp.rename(`${dest}.tmp`, dest);
    await pruneBackups(s);
    const bytes = (await fsp.stat(dest)).size;
    audit('painel:mc:backup', { detail: { servidor: s.id, arquivo: name, tamanho: `${Math.round(bytes / 1024 ** 2)} MB`, motivo: reason } });
    x.lastBackup = { at: Date.now(), name, bytes };
    return { name, bytes };
  } catch (err) {
    await fsp.unlink(`${dest}.tmp`).catch(() => {});
    audit('painel:mc:backup', { ok: false, detail: { servidor: s.id, erro: err.message, motivo: reason } });
    throw err;
  } finally {
    if (running) await rconOf(s, ['save-on'], 10_000).catch(() => {});
    x.busy = null;
  }
}

// Backup diário às 4h30 de quem foi jogado desde o último backup (o level.dat muda quando o mundo é salvo)
async function dailyBackups() {
  const now = new Date();
  if (now.getHours() !== 4 || now.getMinutes() < 30) return;
  for (const s of servers) {
    const worlds = await worldDirs(s).catch(() => []);
    if (!worlds.length) continue;
    const changed = await fsp.stat(path.join(s.dir, worlds[0], 'level.dat')).then((x) => x.mtimeMs).catch(() => 0);
    const list = await listBackups(s);
    const last = list[0]?.at ?? 0;
    if (new Date(last).toDateString() === now.toDateString() || changed <= last) continue;
    await backup(s, 'diário').catch((err) => console.error(`backup do Minecraft ${s.id}:`, err.message));
  }
}

async function listBackups(s) {
  const dir = backupDir(s);
  const files = (await fsp.readdir(dir).catch(() => [])).filter((f) => f.startsWith(`${s.id}-`) && f.endsWith('.tar.gz'));
  const out = [];
  for (const f of files) { const x = await fsp.stat(path.join(dir, f)); out.push({ name: f, size: x.size, at: x.mtimeMs }); }
  return out.sort((a, b) => b.at - a.at);
}

// ---------- Logs ----------

async function tailFile(file, maxBytes = 150_000) {
  let fh;
  try {
    fh = await fsp.open(file, 'r');
    const { size } = await fh.stat();
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    return lines.filter(Boolean);
  } catch { return []; } finally { await fh?.close(); }
}
const cleanLog = (l) => l.replace(/\x1b\[[0-9;]*m/g, '').replace(/§./g, '').replace(/(rcon\.password|password)=\S+/gi, '$1=•••');

// ---------- Rotas do painel ----------

function publicServer(s) {
  const p = readProps(s.dir);
  const x = st(s.id);
  const cfg = loadConfig()[s.id] ?? {};
  let whitelist = [];
  try { whitelist = JSON.parse(fs.readFileSync(path.join(s.dir, 'whitelist.json'), 'utf8')).map((w) => w.name); } catch { /* vazio */ }
  let ops = [];
  try { ops = JSON.parse(fs.readFileSync(path.join(s.dir, 'ops.json'), 'utf8')).map((o) => o.name); } catch { /* vazio */ }
  return {
    id: s.id, version: s.version, modded: s.modded,
    port: Number(p['server-port'] || 25565), motd: readText(p.motd),
    props: Object.fromEntries(Object.keys(EDITABLE).map((k) => [k, k === 'motd' ? readText(p[k]) : p[k] ?? ''])),
    phase: x.phase, busy: x.busy ?? null, external: !!x.external,
    players: x.players ?? 0, max: x.max || Number(p['max-players'] || 0), names: x.names ?? [], tps: x.tps ?? null,
    rss: x.rss ?? 0, cpu: x.cpu ?? 0, etime: x.etime ?? '', startedAt: x.startedAt ?? null, emptySince: x.emptySince ?? null,
    rconOk: p['enable-rcon'] === 'true' && !!p['rcon.password'], rconError: x.phase === 'stopped' ? null : x.rconError ?? null,
    memory: cfg.memory ?? (s.modded ? '4G' : '3G'), autoStop: Number(cfg.autoStop ?? 0),
    whitelist, ops, lastBackup: x.lastBackup ?? null,
  };
}

export function mcRoutes({ json, readBody, clientIp }) {
  const find = (id) => { const s = byId(String(id ?? '')); if (!s) throw Object.assign(new Error('Servidor não encontrado.'), { status: 404 }); return s; };
  const wrap = (fn) => async (req, res, sess, url) => {
    try { await fn(req, res, sess, url); } catch (err) { json(res, err.status ?? 400, { error: err.message }); }
  };
  return {
    'GET /api/mc': wrap(async (req, res) => {
      await Promise.all(servers.map((s) => refreshTps(s)));
      const out = [];
      for (const s of servers) out.push({ ...publicServer(s), worldBytes: await Promise.all((await worldDirs(s).catch(() => [])).map((w) => dirSize(path.join(s.dir, w)))).then((a) => a.reduce((n, b) => n + b, 0)) });
      json(res, 200, { root: MC_ROOT, backupRoot: BACKUP_ROOT, servers: out, editable: EDITABLE, memoryChoices: MEMORY_CHOICES, autoStopChoices: AUTOSTOP_CHOICES, totalMem: os.totalmem() });
    }),
    'POST /api/mc/action': wrap(async (req, res) => {
      const body = await readBody(req);
      const s = find(body.id);
      const ip = clientIp(req);
      const act = { start, stop, restart }[body.action];
      if (body.action === 'backup') {
        backup(s).catch(() => {}); // pode demorar: roda por trás e o painel acompanha pelo estado
        return json(res, 200, { ok: true, message: 'Backup começou. Aparece na lista quando terminar.' });
      }
      if (!act) throw new Error('Ação inválida.');
      audit(`painel:mc:${body.action}`, { ip, detail: { servidor: s.id } });
      if (body.action === 'start') { await start(s); return json(res, 200, { ok: true, message: 'Ligando… o mundo leva de 30 s a alguns minutos para carregar.' }); }
      act(s).then(() => sampleAll()).catch((err) => { st(s.id).lastError = err.message; });
      json(res, 200, { ok: true, message: body.action === 'stop' ? 'Desligando (salvando o mundo)…' : 'Reiniciando…' });
    }),
    'POST /api/mc/cmd': wrap(async (req, res) => {
      const body = await readBody(req);
      const s = find(body.id);
      const command = String(body.command ?? '').replace(/^\//, '').replace(/[\r\n]/g, ' ').trim().slice(0, 256);
      if (!command) throw new Error('Digite um comando.');
      audit('painel:mc:cmd', { ip: clientIp(req), detail: { servidor: s.id, comando: command } });
      const [out] = await rconOf(s, [command], 10_000);
      json(res, 200, { output: out || '(sem resposta)' });
    }),
    'POST /api/mc/settings': wrap(async (req, res) => {
      const body = await readBody(req);
      const s = find(body.id);
      const changes = validate(body.props);
      if (Object.keys(changes).length) await writeProps(s.dir, changes);
      const cfg = loadConfig();
      cfg[s.id] ??= {};
      if (body.memory !== undefined) {
        if (!MEMORY_CHOICES.includes(body.memory)) throw new Error('Memória inválida.');
        cfg[s.id].memory = body.memory;
      }
      if (body.autoStop !== undefined) {
        if (!AUTOSTOP_CHOICES.includes(Number(body.autoStop))) throw new Error('Opção inválida.');
        cfg[s.id].autoStop = Number(body.autoStop);
      }
      saveConfig(cfg);
      audit('painel:mc:settings', { ip: clientIp(req), detail: { servidor: s.id, ...Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, readText(v)])), ...(body.memory ? { memoria: body.memory } : {}), ...(body.autoStop !== undefined ? { desligarVazioMin: Number(body.autoStop) } : {}) } });
      const needsRestart = st(s.id).phase !== 'stopped' && (Object.keys(changes).length || body.memory !== undefined);
      json(res, 200, { ok: true, message: needsRestart ? 'Salvo. Vale na próxima vez que o servidor ligar (reinicie para aplicar agora).' : 'Salvo.' });
    }),
    'POST /api/mc/whitelist': wrap(async (req, res) => {
      const body = await readBody(req);
      const s = find(body.id);
      const name = String(body.name ?? '').trim();
      if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) throw new Error('Nick inválido (3 a 16 letras, números ou _).');
      const verb = body.list === 'op' ? (body.add ? 'op' : 'deop') : `whitelist ${body.add ? 'add' : 'remove'}`;
      audit('painel:mc:cmd', { ip: clientIp(req), detail: { servidor: s.id, comando: `${verb} ${name}` } });
      const [out] = await rconOf(s, [`${verb} ${name}`, ...(body.list === 'op' ? [] : ['whitelist reload'])], 10_000)
        .catch((err) => { throw new Error(err.message === 'desligado' ? 'Ligue o servidor para mudar a lista (o jogo precisa buscar o jogador).' : err.message); });
      json(res, 200, { output: out || 'Feito.' });
    }),
    'GET /api/mc/logs': wrap(async (req, res, sess, url) => {
      const s = find(url.searchParams.get('id'));
      const which = url.searchParams.get('which') === 'console' ? consoleLog(s) : path.join(s.dir, 'logs/latest.log');
      json(res, 200, (await tailFile(which)).slice(-500).map(cleanLog));
    }),
    'GET /api/mc/backups': wrap(async (req, res, sess, url) => {
      const s = find(url.searchParams.get('id'));
      json(res, 200, { dir: backupDir(s), list: await listBackups(s), busy: st(s.id).busy === 'backup' });
    }),
  };
}

export function startMinecraft({ root, auditFn }) {
  ROOT = root;
  MC_ROOT = process.env.MINECRAFT_DIR || path.join(ROOT, 'minecraft');
  audit = auditFn;
  CONFIG_FILE = path.join(ROOT, 'data', 'minecraft.json');
  PLIST_DIR = path.join(ROOT, 'data', 'launchd');
  LOG_DIR = path.join(ROOT, 'logs');
  sampleAll();
  setInterval(() => sampleAll().catch(() => {}), SAMPLE_MS);
  setInterval(() => dailyBackups().catch(() => {}), 10 * 60_000);
}

// Para o status geral do painel (alertas e processos)
export const mcSummary = () => servers.map((s) => ({ id: s.id, phase: st(s.id).phase, players: st(s.id).players ?? 0, rss: st(s.id).rss ?? 0, cpu: st(s.id).cpu ?? 0 }));
