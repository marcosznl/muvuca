// Atualizar o Muvuca pelo painel, com volta atrás.
//
// "Versão" = os arquivos que o Muvuca usa para rodar (servidor em src/ e arquivos soltos, e o site em public/).
// O site novo fica preparado em public_next/; o servidor é editado no lugar e só vale depois de reiniciar.
//
// Publicar: testes automáticos → backup do banco → guarda a versão que está no ar → copia public_next/ para
// public/ → reinicia → confere se voltou. Não voltou em 60 s: volta sozinho para a versão anterior.
// Voltar: guarda a versão atual (para poder desfazer) → põe os arquivos da versão escolhida → reinicia → confere.
// O banco de dados não volta junto (as mudanças dele só acrescentam colunas e tabelas; o backup fica guardado).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ENV = { ...process.env, PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin' };
const KEEP = 10; // versões guardadas (as mais antigas são apagadas a cada publicação)
// O que faz parte de uma versão do Muvuca (o painel e os servidores de Minecraft ficam de fora)
const APP_FILES = ['server.js', 'db.js', 'music.js', 'gifs.js', 'channels.json', 'package.json', 'package-lock.json',
  'start.sh', 'Caddyfile', 'livekit.yaml', 'backup.sh', 'malegna-service.sh', 'ddns-update.sh'];
const APP_DIRS = ['src', 'public'];

let ROOT;
let DIR;       // data/releases
let INDEX;     // data/releases/index.json
let MAIN_URL;
let audit = () => {};
let activity = () => ({});
let setNotice = async () => {};
let job = null; // { kind, startedAt, step, log: [], done, ok }
// Atualização em andamento (o Muvuca pode reiniciar: a queda não é uma queda de verdade)
export const deploying = () => !!job && (!job.done || Date.now() - (job.endedAt ?? 0) < 30_000);

function loadIndex() {
  try { return JSON.parse(fs.readFileSync(INDEX, 'utf8')); } catch { return { live: null, releases: [] }; }
}
function saveIndex(ix) {
  ix.releases = ix.releases.slice(-50);
  fs.writeFileSync(`${INDEX}.tmp`, JSON.stringify(ix, null, 2), { mode: 0o600 });
  fs.renameSync(`${INDEX}.tmp`, INDEX);
}

// ---------- Impressão digital dos arquivos (para saber o que mudou) ----------

async function walk(dir, base = dir, out = {}) {
  let entries = [];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === '.DS_Store') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, base, out);
    else if (e.isFile()) out[path.relative(base, p)] = crypto.createHash('sha1').update(await fsp.readFile(p)).digest('hex');
  }
  return out;
}

// Arquivos do servidor (tudo menos public/) como estão agora no disco
async function serverFiles(root = ROOT) {
  const out = {};
  for (const f of APP_FILES) {
    try { out[f] = crypto.createHash('sha1').update(await fsp.readFile(path.join(root, f))).digest('hex'); } catch { /* não existe */ }
  }
  const src = await walk(path.join(root, 'src'));
  for (const [k, v] of Object.entries(src)) out[`src/${k}`] = v;
  return out;
}

const diff = (a, b) => {
  const changed = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (a[k] === b[k]) continue;
    changed.push({ file: k, kind: !(k in a) ? 'novo' : !(k in b) ? 'removido' : 'mudou' });
  }
  return changed.sort((x, y) => x.file.localeCompare(y.file));
};

// O que está esperando para ir ao ar: site (public_next × public) e servidor (disco × versão no ar)
async function pending() {
  const ix = loadIndex();
  const live = ix.releases.find((r) => r.id === ix.live);
  const site = diff(await walk(path.join(ROOT, 'public')), await walk(path.join(ROOT, 'public_next')));
  const server = live?.server ? diff(live.server, await serverFiles()) : [];
  return { site, server, hasBaseline: !!live };
}

// O que está esperando para ir ao ar (para o quadro "Precisa de atenção"); null se não deu para ver
export async function pendingUpdate() {
  // Sem public_next/ (cópia de trabalho do site) não há o que comparar
  if (!ROOT || !fs.existsSync(path.join(ROOT, 'public_next'))) return null;
  try { return await pending(); } catch { return null; }
}

// ---------- Versões guardadas ----------

async function commitInfo() {
  try {
    const hash = (await run('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT })).stdout.trim();
    const subject = (await run('git', ['log', '-1', '--format=%s'], { cwd: ROOT })).stdout.trim();
    return { hash, subject: subject.slice(0, 140) };
  } catch { return null; }
}

// Guarda os arquivos de `root` (o projeto, ou uma pasta temporária) como uma versão
async function snapshot({ kind, note, root = ROOT, commit = null }) {
  await fsp.mkdir(DIR, { recursive: true, mode: 0o700 });
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const id = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const items = [...APP_FILES, ...APP_DIRS].filter((f) => fs.existsSync(path.join(root, f)));
  await run('tar', ['-czf', path.join(DIR, `${id}.tar.gz`), '-C', root, ...items], { env: ENV });
  const rel = { id, at: Date.now(), kind, note, commit: commit ?? await commitInfo(), server: await serverFiles(root), site: Object.keys(await walk(path.join(root, 'public'))).length };
  const ix = loadIndex();
  ix.releases.push(rel);
  saveIndex(ix);
  await prune();
  return rel;
}

async function prune() {
  const ix = loadIndex();
  const keep = new Set(ix.releases.slice(-KEEP).map((r) => r.id));
  keep.add(ix.live);
  for (const r of ix.releases) if (!keep.has(r.id)) await fsp.unlink(path.join(DIR, `${r.id}.tar.gz`)).catch(() => {});
  ix.releases = ix.releases.filter((r) => keep.has(r.id));
  saveIndex(ix);
}

// Primeira vez: a versão no ar é a do último commit do git (é o que foi publicado; o que mudou depois está pendente)
async function ensureBaseline(log) {
  const ix = loadIndex();
  if (ix.live && ix.releases.some((r) => r.id === ix.live)) return;
  log('Primeira vez: guardando a versão que está no ar (último commit do git)…');
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'muvuca-base-'));
  try {
    const items = [...APP_FILES, ...APP_DIRS];
    const files = (await run('git', ['ls-files', '--', ...items], { cwd: ROOT, maxBuffer: 10 * 1024 * 1024 })).stdout.split('\n').filter(Boolean);
    const archive = spawn('git', ['archive', '--format=tar', 'HEAD', '--', ...files], { cwd: ROOT });
    const untar = spawn('tar', ['-xf', '-', '-C', tmp]);
    archive.stdout.pipe(untar.stdin);
    await new Promise((resolve, reject) => { untar.on('exit', (c) => (c === 0 ? resolve() : reject(new Error('não deu para ler o git')))); untar.on('error', reject); });
    const rel = await snapshot({ kind: 'base', note: 'Versão que estava no ar (último commit)', root: tmp });
    const ix2 = loadIndex();
    ix2.live = rel.id;
    saveIndex(ix2);
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}

// Põe os arquivos de uma versão no lugar: public/ é trocado inteiro; o resto é sobrescrito
async function restore(id) {
  const tar = path.join(DIR, `${id}.tar.gz`);
  if (!fs.existsSync(tar)) throw new Error('O arquivo dessa versão não existe mais.');
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'muvuca-volta-'));
  try {
    await run('tar', ['-xzf', tar, '-C', tmp], { env: ENV });
    if (fs.existsSync(path.join(tmp, 'public'))) await run('rsync', ['-a', '--delete', `${path.join(tmp, 'public')}/`, `${path.join(ROOT, 'public')}/`], { env: ENV });
    if (fs.existsSync(path.join(tmp, 'src'))) await run('rsync', ['-a', `${path.join(tmp, 'src')}/`, `${path.join(ROOT, 'src')}/`], { env: ENV });
    for (const f of APP_FILES) if (fs.existsSync(path.join(tmp, f))) await fsp.copyFile(path.join(tmp, f), path.join(ROOT, f));
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}

// ---------- Reiniciar e conferir ----------

async function health() {
  try {
    const r = await fetch(`${MAIN_URL}/health`, { signal: AbortSignal.timeout(3000) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

async function restartAndCheck(log) {
  const before = Date.now();
  log('Reiniciando o Muvuca…');
  await run('/bin/zsh', ['./malegna-service.sh', 'reiniciar'], { cwd: ROOT, env: ENV, timeout: 30_000 });
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const h = await health();
    if (h?.ok && Date.parse(h.upSince) >= before - 1000) { log(`Muvuca no ar de novo (${Math.round((Date.now() - before) / 1000)} s).`); return true; }
  }
  log('O Muvuca não voltou em 60 s.');
  return false;
}

// ---------- Tarefas (uma por vez, rodando por trás; a tela acompanha pelo log) ----------

function startJob(kind, fn) {
  if (job && !job.done) throw new Error('Já tem uma atualização em andamento.');
  job = { kind, startedAt: Date.now(), log: [], done: false, ok: false };
  const log = (line) => { job.log.push(`[${new Date().toLocaleTimeString('pt-BR')}] ${line}`); };
  fn(log).then((ok) => { job.ok = ok; }).catch((err) => { log(`Erro: ${err.message}`); job.ok = false; }).finally(() => { job.done = true; job.endedAt = Date.now(); });
}

async function runTests(log) {
  log('Rodando os testes automáticos (leva ~1 minuto)…');
  return new Promise((resolve) => {
    execFile('npm', ['test'], { cwd: ROOT, env: { ...ENV, PUBLIC_DIR: path.join(ROOT, 'public_next') }, timeout: 6 * 60_000, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = `${stdout}${stderr}`;
      const pass = out.match(/ℹ pass (\d+)/)?.[1];
      const fail = out.match(/ℹ fail (\d+)/)?.[1];
      if (!err && fail === '0') { log(`Testes ok (${pass} passaram).`); resolve(true); return; }
      const failed = out.split('\n').filter((l) => /^✖ /.test(l)).slice(0, 8);
      log(`Testes falharam (${fail ?? '?'} de ${Number(pass ?? 0) + Number(fail ?? 0)}): nada foi publicado.`);
      for (const l of failed) log(`  ${l}`);
      resolve(false);
    });
  });
}

async function deploy(log, { notify, skipTests, ip }) {
  // Sem o site preparado, copiar public_next apagaria o site no ar
  if (!fs.existsSync(path.join(ROOT, 'public_next', 'index.html'))) { log('Não existe public_next/index.html: nada foi publicado.'); return false; }
  const pend = await pending();
  if (pend.hasBaseline && !pend.site.length && !pend.server.length) { log('Nada novo para publicar.'); return true; }
  if (!skipTests && !(await runTests(log))) {
    audit('painel:deploy', { ip, ok: false, detail: { resultado: 'testes falharam' } });
    return false;
  }
  await ensureBaseline(log);
  const previous = loadIndex().live;
  log('Backup do banco de dados…');
  try {
    const { stdout } = await run('/bin/zsh', ['./backup.sh'], { cwd: ROOT, env: ENV, timeout: 10 * 60_000 });
    const line = stdout.trim().split('\n').pop() ?? '';
    log(line.replace(/^\[backup [^\]]+\]\s*/, 'Backup '));
    await fsp.appendFile(path.join(ROOT, 'logs', 'backup.log'), `${stdout.trim()}\n`).catch(() => {}); // aparece na aba Backups
  } catch {
    log('Aviso: o backup falhou (seguindo mesmo assim; os anteriores continuam guardados).');
  }
  if (notify) {
    log('Avisando quem está conectado (1 minuto)…');
    await setNotice({ on: true, message: 'O Muvuca vai reiniciar para uma atualização. Volta em instantes!', minutes: 1 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 60_000));
  }
  log('Copiando o site novo (public_next → public)…');
  await run('rsync', ['-a', '--delete', `${path.join(ROOT, 'public_next')}/`, `${path.join(ROOT, 'public')}/`], { env: ENV });
  // Só o site mudou: o servidor entrega os arquivos novos direto do disco, sem reiniciar (ninguém cai da call)
  const siteOnly = pend.hasBaseline && !pend.server.length;
  if (siteOnly) log('Só o site mudou: sem reiniciar (quem recarregar a página já pega a versão nova).');
  if (siteOnly || await restartAndCheck(log)) {
    const rel = await snapshot({ kind: 'publicada', note: `${pend.site.length} arquivo(s) do site, ${pend.server.length} do servidor` });
    const ix = loadIndex();
    ix.live = rel.id;
    saveIndex(ix);
    if (notify) await setNotice({ on: false }).catch(() => {});
    audit('painel:deploy', { ip, detail: { versao: rel.id, site: pend.site.length, servidor: pend.server.length, commit: rel.commit?.hash } });
    log(`Pronto! Versão ${rel.id} no ar.`);
    return true;
  }
  // Não voltou: desfaz sozinho
  log(`Voltando automaticamente para a versão anterior (${previous})…`);
  await restore(previous);
  const back = await restartAndCheck(log);
  if (notify) await setNotice({ on: false }).catch(() => {});
  audit('painel:deploy', { ip, ok: false, detail: { resultado: back ? 'não subiu; voltou sozinho para a versão anterior' : 'não subiu nem com a versão anterior', versaoAnterior: previous } });
  log(back ? 'Voltou para a versão anterior: o Muvuca está no ar. A versão nova ficou pendente (veja o log do Muvuca).' : 'ATENÇÃO: nem a versão anterior subiu. Veja o log do Muvuca na aba Logs.');
  return false;
}

async function rollback(log, { id, ip }) {
  const ix = loadIndex();
  const target = ix.releases.find((r) => r.id === id);
  if (!target) throw new Error('Versão não encontrada.');
  await ensureBaseline(log);
  log('Guardando a versão atual antes de voltar (para poder desfazer)…');
  const saved = await snapshot({ kind: 'antes de voltar', note: `Estava no ar antes de voltar para ${id}` });
  log(`Colocando a versão ${id}…`);
  await restore(id);
  const ok = await restartAndCheck(log);
  const ix2 = loadIndex();
  if (ok) { ix2.live = id; saveIndex(ix2); } else {
    log('Não subiu: voltando para como estava…');
    await restore(saved.id);
    await restartAndCheck(log);
  }
  audit('painel:rollback', { ip, ok, detail: { versao: id, guardadaAntes: saved.id } });
  const left = ok ? await pending() : null;
  log(ok ? `Pronto: versão ${id} no ar.${left?.site.length || left?.server.length ? ' O que tinha de mais novo continua preparado e aparece como pendente (dá para publicar de novo).' : ''}` : 'Não deu certo; ficou como estava.');
  return ok;
}

// ---------- Rotas ----------

export function deployRoutes({ json, readBody, clientIp, root, mainUrl, auditFn, activityFn, noticeFn }) {
  ROOT = root;
  DIR = path.join(ROOT, 'data', 'releases');
  INDEX = path.join(DIR, 'index.json');
  MAIN_URL = mainUrl;
  audit = auditFn;
  activity = activityFn;
  setNotice = noticeFn;
  const inUse = () => {
    const a = activity();
    return [a.voice && `${a.voice} em call`, a.lives && `${a.lives} em live`].filter(Boolean);
  };
  return {
    'GET /api/deploy': async (req, res) => {
      const ix = loadIndex();
      json(res, 200, {
        job, live: ix.live, pending: await pending(), inUse: inUse(),
        releases: [...ix.releases].reverse().map(({ server, ...r }) => ({ ...r, files: Object.keys(server ?? {}).length, hasFile: fs.existsSync(path.join(DIR, `${r.id}.tar.gz`)) })),
      });
    },
    'POST /api/deploy': async (req, res) => {
      const b = await readBody(req);
      const busy = inUse();
      const p = await pending();
      const needsRestart = !p.hasBaseline || p.server.length > 0; // só site: publica sem reiniciar
      if (needsRestart && busy.length && !b.force) return json(res, 200, { ok: false, needsForce: true, message: `Tem gente usando agora (${busy.join(', ')}): a call cai por uns 10 segundos durante o reinício.` });
      startJob('publicar', (log) => deploy(log, { notify: b.notify === true, skipTests: false, ip: clientIp(req) }));
      json(res, 200, { ok: true, message: 'Atualização começou: acompanhe abaixo.' });
    },
    'POST /api/rollback': async (req, res) => {
      const b = await readBody(req);
      const busy = inUse();
      if (busy.length && !b.force) return json(res, 200, { ok: false, needsForce: true, message: `Tem gente usando agora (${busy.join(', ')}): a call cai por uns 10 segundos durante o reinício.` });
      if (!/^[\d_-]{10,20}$/.test(String(b.id ?? ''))) return json(res, 400, { error: 'Versão inválida.' });
      startJob('voltar', (log) => rollback(log, { id: b.id, ip: clientIp(req) }));
      json(res, 200, { ok: true, message: 'Voltando de versão: acompanhe abaixo.' });
    },
  };
}
