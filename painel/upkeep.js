// Manutenção automática feita pelo painel (sem ninguém precisar lembrar):
//  - gira os logs que só cresciam (Muvuca, painel, backup): guarda 3 arquivos de 5 MB
//  - certificado renovado pelo Caddy: reinicia o Muvuca (o LiveKit/TURN só lê o certificado ao ligar),
//    só com ninguém em call ou jogo, de preferência de madrugada
//  - teste semanal de restauração: abre o último backup numa pasta temporária e confere o banco
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';

const run = promisify(execFile);
const ROTATE_AT = 5 * 1024 * 1024;
const ROTATE_KEEP = 3;
let ctx;
let FILE; // data/painel-manutencao.json: último teste de restauração e o que foi feito
let state = { restore: null, certRestart: null, rotated: [] };

function save() {
  try { fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(state), { mode: 0o600 }); fs.renameSync(`${FILE}.tmp`, FILE); } catch { /* tenta de novo */ }
}

// ---------- Logs ----------
// Copia e esvazia (o launchd abre o log em modo "acrescentar": quem escreve continua no arquivo, sem reiniciar)
export async function rotateLogs() {
  let names = [];
  try { names = await fsp.readdir(ctx.logsDir); } catch { return; }
  const targets = names.filter((n) => /^(malegna|painel|backup)\.log$/.test(n));
  for (const name of targets) {
    const file = path.join(ctx.logsDir, name);
    let size = 0;
    try { size = (await fsp.stat(file)).size; } catch { continue; }
    if (size < ROTATE_AT) continue;
    for (let i = ROTATE_KEEP - 1; i >= 1; i--) await fsp.rename(`${file}.${i}`, `${file}.${i + 1}`).catch(() => {});
    await fsp.copyFile(file, `${file}.1`);
    await fsp.truncate(file, 0);
    state.rotated = [{ at: Date.now(), name, size }, ...state.rotated].slice(0, 20);
    save();
  }
}

// ---------- Certificado × LiveKit ----------
export async function livekitStartedAt() {
  try {
    const pid = (await run('pgrep', ['-f', 'livekit-server --config'])).stdout.trim().split('\n')[0];
    if (!pid) return null;
    const lstart = (await run('ps', ['-o', 'lstart=', '-p', pid], { env: { ...process.env, LC_ALL: 'C' } })).stdout.trim();
    const t = Date.parse(lstart);
    return Number.isFinite(t) ? t : null;
  } catch { return null; }
}

let emptyChecks = 0;
async function certCheck() {
  const cert = ctx.certFile();
  if (!cert) return;
  let renewedAt;
  try { renewedAt = (await fsp.stat(cert)).mtimeMs; } catch { return; }
  const lkStart = await livekitStartedAt();
  if (!lkStart || renewedAt < lkStart + 60_000) { state.certPending = null; return; } // já está com o certificado novo
  state.certPending ??= Date.now();
  const a = ctx.activity();
  const empty = !a.voice && !a.lives && !a.games && !ctx.deploying();
  emptyChecks = empty ? emptyChecks + 1 : 0;
  const hour = new Date().getHours();
  const late = Date.now() - state.certPending > 3 * 86_400_000; // esperou 3 dias pela madrugada: vale qualquer hora vazia
  if (emptyChecks < 2 || !(hour >= 3 && hour < 7) && !late) return;
  emptyChecks = 0;
  ctx.markPlanned();
  ctx.audit('painel:restart', { detail: { motivo: 'certificado HTTPS renovado (o TURN da voz passa a usar o novo)', automatico: true } });
  const child = spawn('/bin/zsh', ['./malegna-service.sh', 'reiniciar'], { cwd: ctx.root, detached: true, stdio: 'ignore' });
  child.unref();
  state.certRestart = { at: Date.now(), renewedAt };
  state.certPending = null;
  save();
}

// ---------- Teste de restauração ----------
export async function restoreTest() {
  const started = Date.now();
  let list = [];
  try { list = (await fsp.readdir(ctx.backupDir)).filter((n) => /^malegna-.*\.tar\.gz$/.test(n)).sort(); } catch { /* sem pasta */ }
  const last = list.at(-1);
  const result = { at: started, file: last ?? null, ok: false };
  if (!last) { result.error = 'nenhum backup encontrado'; return finish(result); }
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'muvuca-restauracao-'));
  try {
    await run('tar', ['-xzf', path.join(ctx.backupDir, last), '-C', tmp, './malegna.db'], { timeout: 120_000 });
    const db = new DatabaseSync(path.join(tmp, 'malegna.db'), { readOnly: true });
    try {
      const integrity = db.prepare('PRAGMA integrity_check').get();
      result.integrity = Object.values(integrity)[0];
      const count = (t) => { try { return db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n; } catch { return null; } };
      result.counts = { contas: count('users'), servidores: count('servers'), mensagens: count('messages'), anexos: count('files') };
    } finally { db.close(); }
    // Comparação com o banco de agora: o backup não pode ter bem menos do que o que existe
    const live = { contas: ctx.one('SELECT COUNT(*) n FROM users').n, mensagens: ctx.one('SELECT COUNT(*) n FROM messages').n };
    result.live = live;
    const missing = result.counts.contas < live.contas * 0.9 || result.counts.mensagens < live.mensagens * 0.5;
    result.ok = result.integrity === 'ok' && !missing;
    if (result.integrity !== 'ok') result.error = `banco com problema: ${result.integrity}`;
    else if (missing) result.error = 'o backup tem bem menos dados do que o banco atual';
  } catch (err) {
    result.error = `não abriu: ${String(err.message).split('\n')[0].slice(0, 200)}`;
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
  return finish(result);

  function finish(r) {
    r.ms = Date.now() - started;
    state.restore = r;
    save();
    if (!r.ok) ctx.alert('backup', { title: '⚠️ Teste de restauração falhou', body: `O último backup não passou no teste: ${r.error}. Veja a aba Backups.`, url: '/#backups', urgent: true });
    ctx.audit('painel:restore-test', { ok: r.ok, detail: { arquivo: r.file, resultado: r.ok ? 'ok' : r.error } });
    return r;
  }
}
// Semanal: segunda às 5h (o backup roda às 4h), ou se faz mais de 8 dias do último teste
async function maybeRestoreTest() {
  const last = state.restore?.at ?? 0;
  const now = new Date();
  const due = (now.getDay() === 1 && now.getHours() === 5 && Date.now() - last > 20 * 3_600_000) || Date.now() - last > 8 * 86_400_000;
  if (due) await restoreTest();
}

export const upkeepState = () => state;

export function startUpkeep(opts) {
  ctx = opts;
  FILE = path.join(opts.dataDir, 'painel-manutencao.json');
  try { state = { ...state, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch { /* primeira vez */ }
  const every = (ms, fn, first = 60_000) => {
    setTimeout(() => fn().catch((e) => console.error('manutenção:', e.message)), first).unref();
    setInterval(() => fn().catch((e) => console.error('manutenção:', e.message)), ms).unref();
  };
  every(30 * 60_000, rotateLogs);
  every(10 * 60_000, certCheck);
  every(30 * 60_000, maybeRestoreTest, 5 * 60_000);
}
