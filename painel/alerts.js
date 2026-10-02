// Alertas no celular (notificação do painel instalado na Tela de Início) e histórico de quedas do Muvuca.
// O painel já vigia tudo a cada 10 s; aqui ele decide quando avisar:
//  - Muvuca fora do ar (e quando volta), sem contar reinícios feitos pelo próprio painel
//  - disco com pouco espaço, backup da noite que falhou ou não rodou, certificado HTTPS vencendo
//  - muitas senhas erradas em pouco tempo (alguém tentando entrar)
//  - resumo da semana, no domingo às 20h
import fs from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';

let FILE;          // data/painel-alertas.json: chaves, aparelhos inscritos e preferências
let QUEDAS;        // data/painel-quedas.json: histórico de quedas
let ctx;           // funções do painel (dados, auditoria…)
let state = { vapid: null, subs: [], prefs: {}, sent: {} };
let quedas = [];
let down = null;   // queda em andamento: { start, planned, reason, log }
let downSamples = 0;
let plannedUntil = 0;

export const ALERT_KINDS = {
  down: 'Muvuca fora do ar (e quando volta)',
  disk: 'Disco com pouco espaço (menos de 10 GB)',
  backup: 'Backup da noite falhou ou não rodou',
  cert: 'Certificado HTTPS vence em até 7 dias',
  logins: 'Muitas senhas erradas em pouco tempo',
  weekly: 'Resumo da semana (domingo às 20h)',
};

function save() {
  try { fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(state), { mode: 0o600 }); fs.renameSync(`${FILE}.tmp`, FILE); } catch (err) { console.error('alertas:', err.message); }
}
function saveQuedas() {
  try { fs.writeFileSync(`${QUEDAS}.tmp`, JSON.stringify(quedas.slice(-300)), { mode: 0o600 }); fs.renameSync(`${QUEDAS}.tmp`, QUEDAS); } catch { /* tenta de novo na próxima */ }
}

const enabled = (kind) => state.prefs[kind] !== false;

// Manda para todos os aparelhos inscritos; quem desinstalou some da lista
export async function sendAlert(kind, { title, body, url = '/', urgent = false }) {
  if (kind !== 'test' && !enabled(kind)) return 0;
  let ok = 0;
  const payload = JSON.stringify({ title, body, url, tag: `alerta-${kind}` });
  for (const sub of [...state.subs]) {
    try {
      await webpush.sendNotification(sub, payload, { TTL: urgent ? 24 * 3600 : 6 * 3600, urgency: urgent ? 'high' : 'normal' });
      ok++;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) state.subs = state.subs.filter((s) => s.endpoint !== sub.endpoint);
    }
  }
  save();
  return ok;
}

// Avisa no máximo uma vez a cada `everyMs` para o mesmo motivo
function once(key, everyMs) {
  const last = state.sent[key] ?? 0;
  if (Date.now() - last < everyMs) return false;
  state.sent[key] = Date.now();
  return true;
}

// O painel vai reiniciar o Muvuca (botão Reiniciar/Atualizar): a queda de agora é esperada
// Queda em andamento (null se está no ar) e quedas não planejadas desde `since`
export const downNow = () => down;
export const quedasSince = (since) => quedas.filter((q) => !q.planned && q.end > since);

export function markPlanned(ms = 90_000) { plannedUntil = Math.max(plannedUntil, Date.now() + ms); }
// Desligado pelo painel: queda planejada até ligar de novo (aí volta ao normal, com folga para subir)
export function setPlannedUntil(t) { plannedUntil = t; }

const fmtDur = (ms) => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
};

// ---------- Vigia (a cada 10 s, depois da coleta) ----------
async function watch() {
  const latest = ctx.latest();
  if (!latest.at) return;
  const main = latest.main ?? {};
  const isDown = !main.up || !!main.error;
  const planned = Date.now() < plannedUntil || ctx.deploying();

  // Queda: 2 leituras seguidas (20 s) fora do ar para contar
  if (isDown) {
    downSamples++;
    if (!down && downSamples >= 2) {
      down = { start: Date.now() - 10_000, planned, reason: main.error || 'fora do ar', log: await ctx.lastLog() };
      if (!planned) sendAlert('down', { title: '🔴 Muvuca fora do ar', body: `Não responde há 20 s (${down.reason}). O painel continua vigiando.`, url: '/#quedas', urgent: true });
    }
  } else {
    downSamples = 0;
    if (down) {
      const q = { ...down, end: Date.now() };
      quedas.push(q);
      saveQuedas();
      if (!q.planned) sendAlert('down', { title: '🟢 Muvuca voltou', body: `Ficou fora por ${fmtDur(q.end - q.start)}.`, url: '/#quedas' });
      down = null;
    }
  }

  // Disco
  const free = latest.disk?.free ?? Infinity;
  if (free < 10 * 1024 ** 3 && once('disk', 24 * 3_600_000)) {
    sendAlert('disk', { title: '💾 Disco quase cheio', body: `Só ${(free / 1024 ** 3).toFixed(1)} GB livres no Mac. Veja a aba Arquivos pesados.`, url: '/#arquivos' });
  }

  // Muitas senhas erradas (site e painel) em 10 min
  try {
    const n = ctx.one("SELECT COUNT(*) n FROM audit_log WHERE at > ? AND action IN ('auth:login:fail', 'painel:login:fail')", Date.now() - 10 * 60_000).n;
    if (n >= 10 && once('logins', 3_600_000)) sendAlert('logins', { title: '🚫 Muitas senhas erradas', body: `${n} tentativas erradas nos últimos 10 min. Veja quem foi na Auditoria.`, url: '/#auditoria', urgent: true });
  } catch { /* banco ocupado: fica para a próxima */ }
}

// Coisas que mudam devagar: a cada 30 min
async function slowChecks() {
  // Backup: a última linha do log diz "FALHOU", ou faz mais de 26 h sem backup
  const last = await ctx.lastBackup();
  if (last && /FALHOU/.test(last.line) && once(`backup-fail-${last.at}`, 365 * 86_400_000)) {
    sendAlert('backup', { title: '⚠️ O backup falhou', body: 'Veja o motivo em Manutenção → Backups.', url: '/#backups', urgent: true });
  } else if (last && Date.now() - last.at > 26 * 3_600_000 && once('backup-late', 24 * 3_600_000)) {
    sendAlert('backup', { title: '⚠️ Backup atrasado', body: `O último backup foi há ${fmtDur(Date.now() - last.at)}.`, url: '/#backups' });
  }
  // Certificado
  for (const c of await ctx.certificates()) {
    const days = (c.validTo - Date.now()) / 86_400_000;
    if (days < 7 && once(`cert-${c.name}`, 24 * 3_600_000)) {
      sendAlert('cert', { title: '🔒 Certificado vencendo', body: `${c.name} vence em ${Math.max(0, Math.floor(days))} dia(s). O Caddy costuma renovar sozinho: se não renovar, veja o log do Caddy.`, url: '/#sistema' });
    }
  }
  // Resumo da semana: domingo, a partir das 20h (uma vez por semana)
  const now = new Date();
  if (now.getDay() === 0 && now.getHours() >= 20) {
    const week = `${now.getFullYear()}-${now.toISOString().slice(0, 10)}`;
    if (once(`weekly-${week}`, 6 * 86_400_000)) {
      const s = ctx.weekly();
      const top = s.ranking.slice(0, 3).map((r) => r.name).join(', ');
      const hours = Math.round(s.cur.voiceMin / 6) / 10;
      sendAlert('weekly', { title: '📊 Resumo da semana', body: `${s.cur.active} pessoas ativas · ${hours} h de call · ${s.cur.messages} mensagens${top ? ` · Destaques: ${top}` : ''}`, url: '/#resumo' });
    }
  }
  save();
}

export function startAlerts(opts) {
  ctx = opts;
  FILE = path.join(opts.dataDir, 'painel-alertas.json');
  QUEDAS = path.join(opts.dataDir, 'painel-quedas.json');
  try { state = { ...state, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch { /* primeira vez */ }
  try { quedas = JSON.parse(fs.readFileSync(QUEDAS, 'utf8')); } catch { quedas = []; }
  if (!state.vapid) { state.vapid = webpush.generateVAPIDKeys(); save(); }
  webpush.setVapidDetails(`mailto:painel@${opts.domain}`, state.vapid.publicKey, state.vapid.privateKey);
  setInterval(() => watch().catch((err) => console.error('vigia:', err.message)), 10_000).unref();
  setInterval(() => slowChecks().catch((err) => console.error('alertas:', err.message)), 30 * 60_000).unref();
  setTimeout(() => slowChecks().catch(() => {}), 60_000).unref();
}

export function alertRoutes({ json, readBody, audit, clientIp }) {
  return {
    'GET /api/alerts': (req, res) => json(res, 200, {
      key: state.vapid.publicKey, devices: state.subs.map((s) => ({ endpoint: s.endpoint, name: s.name ?? 'Aparelho', at: s.at ?? null })),
      prefs: Object.fromEntries(Object.keys(ALERT_KINDS).map((k) => [k, enabled(k)])), kinds: ALERT_KINDS,
    }),
    'POST /api/alerts/subscribe': async (req, res) => {
      const b = await readBody(req);
      const sub = b.sub;
      if (!sub?.endpoint || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) return json(res, 400, { error: 'Inscrição inválida.' });
      state.subs = state.subs.filter((s) => s.endpoint !== sub.endpoint);
      state.subs.push({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, name: String(b.name ?? 'Aparelho').slice(0, 60), at: Date.now() });
      save();
      audit('painel:alerts', { ip: clientIp(req), detail: { aparelho: String(b.name ?? '').slice(0, 60), inscrito: true } });
      json(res, 200, { ok: true, message: 'Este aparelho vai receber os alertas.' });
    },
    'POST /api/alerts/unsubscribe': async (req, res) => {
      const b = await readBody(req);
      state.subs = state.subs.filter((s) => s.endpoint !== b.endpoint);
      save();
      json(res, 200, { ok: true, message: 'Aparelho removido dos alertas.' });
    },
    'POST /api/alerts/prefs': async (req, res) => {
      const b = await readBody(req);
      for (const k of Object.keys(ALERT_KINDS)) if (typeof b[k] === 'boolean') state.prefs[k] = b[k];
      save();
      json(res, 200, { ok: true });
    },
    'POST /api/alerts/test': async (req, res) => {
      const n = await sendAlert('test', { title: '🔔 Teste do painel', body: 'Se você está lendo isto, os alertas estão funcionando.' });
      json(res, 200, { ok: n > 0, message: n ? `Enviado para ${n} ${n === 1 ? 'aparelho' : 'aparelhos'}.` : 'Nenhum aparelho inscrito ainda.' });
    },
    // Histórico de quedas (a mais nova primeiro) e a que está acontecendo agora
    'GET /api/quedas': (req, res) => {
      const since = Date.now() - 30 * 86_400_000;
      const list = quedas.filter((q) => q.end > since).reverse();
      const unplanned = list.filter((q) => !q.planned);
      json(res, 200, {
        now: down ? { ...down, forMs: Date.now() - down.start } : null,
        list,
        total30: unplanned.length,
        minutes30: Math.round(unplanned.reduce((n, q) => n + (q.end - q.start), 0) / 60_000),
        uptime30: Math.max(0, 100 - (unplanned.reduce((n, q) => n + (q.end - q.start), 0) / (30 * 86_400_000)) * 100),
      });
    },
  };
}
