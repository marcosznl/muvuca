// Painel do Muvuca (site). Tudo que vem do servidor entra como texto (nunca como HTML).
'use strict';

const $ = (sel) => document.querySelector(sel);
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v; // pelo CSSOM (a CSP não deixa atributo style)
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}
const svg = (tag, attrs = {}) => {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};

// ---------- Formatação ----------
const nf = new Intl.NumberFormat('pt-BR');
const num = (n) => nf.format(n ?? 0);
function bytes(b) {
  if (!b) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(b) / Math.log(1024)));
  return `${(b / 1024 ** i).toLocaleString('pt-BR', { maximumFractionDigits: i >= 2 ? 1 : 0 })} ${u[i]}`;
}
function bits(b) {
  if (!b) return '0 bps';
  const u = ['bps', 'Kbps', 'Mbps', 'Gbps'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(b) / Math.log(1000)));
  return `${(b / 1000 ** i).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} ${u[i]}`;
}
const when = (t) => (t ? new Date(t).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—');
function ago(t) {
  if (!t) return 'nunca';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'agora';
  if (s < 3600) return `há ${Math.floor(s / 60)} min`;
  if (s < 86400) return `há ${Math.floor(s / 3600)} h`;
  return `há ${Math.floor(s / 86400)} d`;
}
function duration(sec) {
  sec = Math.floor(sec);
  const d = Math.floor(sec / 86400); const hh = Math.floor((sec % 86400) / 3600); const m = Math.floor((sec % 3600) / 60);
  return d ? `${d} d ${hh} h` : hh ? `${hh} h ${m} min` : `${m} min`;
}
const pct = (v) => `${(v ?? 0).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;

// ---------- Servidor ----------
async function api(path, opts = {}) {
  const r = await fetch(path, {
    method: opts.method ?? 'GET',
    headers: { 'x-painel': '1', ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  if (r.status === 401 && path !== '/api/login') { showLogin(); throw new Error('Entre de novo.'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Erro ${r.status}`);
  return data;
}

function toast(text, ms = 4000) {
  const el = h('div', { class: 'toast', role: 'status' }, text);
  document.body.append(el);
  setTimeout(() => el.remove(), ms);
}

// ---------- Login ----------
function showLogin() {
  stopTimers();
  $('#app').hidden = true;
  $('#login').hidden = false;
  $('#login-user').focus();
}
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.submitter ?? $('#login-form button');
  btn.disabled = true;
  $('#login-error').textContent = '';
  try {
    await api('/api/login', { method: 'POST', body: { user: $('#login-user').value, password: $('#login-pass').value } });
    $('#login-pass').value = '';
    start();
  } catch (err) {
    $('#login-error').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});
$('#logout').addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST' }); } catch { /* já saiu */ }
  showLogin();
});

// ---------- Abas ----------
const TABS = {
  geral: ['Visão geral', viewGeral, 5000],
  aovivo: ['Ao vivo', viewAoVivo, 5000],
  usuarios: ['Usuários', viewUsuarios, 30000],
  arquivos: ['Arquivos pesados', viewArquivos, 60000],
  xp: ['XP e níveis', viewXp, 30000],
  auditoria: ['Auditoria', viewAuditoria, 0],
  acessos: ['Acessos ao site', viewAcessos, 60000],
  logs: ['Logs', viewLogs, 0],
  backups: ['Backups', viewBackups, 60000],
  atualizar: ['Atualizar o Muvuca', viewAtualizar, 4000],
  minecraft: ['Minecraft', viewMinecraft, 5000],
  internet: ['Internet', viewInternet, 4000],
  sistema: ['Sistema', viewSistema, 30000],
};
let tab = 'geral';
let timer = null;
let status = null;
const stopTimers = () => { clearInterval(timer); timer = null; };

document.querySelectorAll('.side button[data-tab]').forEach((b) => b.addEventListener('click', () => openTab(b.dataset.tab)));
function openTab(name) {
  tab = TABS[name] ? name : 'geral';
  try { localStorage.setItem('painel-tab', tab); } catch { /* sem armazenamento */ }
  document.querySelectorAll('.side button[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  const [title, fn, every] = TABS[tab];
  $('#title').textContent = title;
  const view = $('#view');
  // Mesma aba (ex.: trocou o período do gráfico): mantém o conteúdo até o novo chegar, sem piscar
  if (view.dataset.tab !== name) {
    view.replaceChildren(h('p', { class: 'muted' }, 'Carregando…'));
    view.dataset.tab = name;
  }
  stopTimers();
  const load = async (first) => {
    // Atualização automática: pula se a aba do navegador está escondida ou se você está mexendo num campo
    const typing = view.contains(document.activeElement) && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName);
    if (!first && (document.hidden || typing)) return;
    try {
      const node = await fn(first);
      if (node && tab === name) {
        const y = window.scrollY;
        view.replaceChildren(node);
        if (!first) window.scrollTo(0, y); // continua onde estava
      }
      $('#updated').textContent = `Atualizado ${new Date().toLocaleTimeString('pt-BR')}`;
    } catch (err) {
      if (first) view.replaceChildren(h('p', { class: 'error' }, err.message));
    }
  };
  load(true);
  if (every) timer = setInterval(() => load(false), every);
}

async function start() {
  try { await api('/api/me'); } catch { showLogin(); return; }
  $('#login').hidden = true;
  $('#app').hidden = false;
  let saved = 'geral';
  try { saved = localStorage.getItem('painel-tab') || 'geral'; } catch { /* sem armazenamento */ }
  openTab(saved);
  refreshTop();
  setInterval(refreshTop, 15000);
}

async function refreshTop() {
  if ($('#app').hidden) return;
  try { status = await api('/api/status'); } catch { return; }
  const m = status.main ?? {};
  const ok = m.up && !m.error;
  $('#top-status').replaceChildren(h('span', { class: `pill ${ok ? 'good' : 'bad'}` }, h('span', { class: 'dot' }), ok ? 'Muvuca no ar' : `Muvuca: ${m.error ?? 'fora do ar'}`));
}

// ---------- Componentes ----------
// bar: porcentagem da barrinha; level: cor ('', 'warn', 'bad'), senão vem da porcentagem
const stat = (label, value, sub, bar, level) => h('div', { class: 'card stat' },
  h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), sub ? h('div', { class: 'sub' }, sub) : null,
  bar !== undefined ? h('div', { class: `bar ${level ?? (bar > 90 ? 'bad' : bar > 75 ? 'warn' : '')}` }, h('span', { style: `width:${Math.min(100, bar)}%` })) : null);

function table(cols, rows, { empty = 'Nada por aqui.', rowClass } = {}) {
  if (!rows.length) return h('p', { class: 'empty' }, empty);
  return h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, cols.map((c) => h('th', { class: c.num ? 'num' : null }, c.label)))),
    h('tbody', {}, rows.map((r) => h('tr', { class: rowClass?.(r) ?? null }, cols.map((c) => h('td', { class: c.num ? 'num' : null }, c.get(r))))))));
}

// Gráfico de linhas em SVG: series = [{ label, color, values }]
function lineChart(times, series, { format = (v) => v, max } = {}) {
  const W = 600; const H = 150; const L = 44; const B = 18; const T = 8;
  const top = max ?? Math.max(1, ...series.flatMap((s) => s.values));
  const el = svg('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img' });
  for (let i = 0; i <= 2; i++) {
    const y = T + ((H - T - B) * i) / 2;
    el.append(svg('line', { class: 'grid-line', x1: L, x2: W, y1: y, y2: y }));
    const t = svg('text', { x: L - 6, y: y + 3, 'text-anchor': 'end' });
    t.textContent = format(top * (1 - i / 2));
    el.append(t);
  }
  if (times.length > 1) {
    const t0 = times[0]; const t1 = times[times.length - 1];
    const x = (t) => L + ((W - L) * (t - t0)) / Math.max(1, t1 - t0);
    const y = (v) => T + (H - T - B) * (1 - Math.min(1, v / top));
    for (const s of series) {
      const d = s.values.map((v, i) => `${i ? 'L' : 'M'}${x(times[i]).toFixed(1)},${y(v).toFixed(1)}`).join('');
      el.append(svg('path', { d, fill: 'none', stroke: s.color, 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke', 'stroke-linejoin': 'round' }));
    }
    for (const [t, anchor] of [[t0, 'start'], [t1, 'end']]) {
      const label = svg('text', { x: anchor === 'start' ? L : W, y: H - 4, 'text-anchor': anchor });
      label.textContent = new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      el.append(label);
    }
  }
  const legend = h('div', { class: 'legend' }, series.map((s) => h('span', {}, h('i', { style: `background:${s.color}` }), s.label)));
  return h('div', {}, el, legend);
}
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// ---------- Alertas (o que merece atenção agora) ----------
function alerts(s, ov, bk) {
  const out = [];
  const m = s.main ?? {};
  if (!m.up) out.push(['bad', `O Muvuca está fora do ar (${m.error ?? 'sem resposta'}).`]);
  else if (m.error) out.push(['warn', `Muvuca: ${m.error}`]);
  for (const [name, label] of [['livekit', 'voz (LiveKit)'], ['caddy', 'HTTPS (Caddy)'], ['ddns', 'DuckDNS']]) {
    if (!s.procs?.[name]) out.push(['bad', `O serviço de ${label} não está rodando.`]);
  }
  const memPct = s.mem ? (s.mem.used / s.mem.total) * 100 : 0;
  if (memPct > 90) out.push(['warn', `Memória do Mac em ${pct(memPct)}.`]);
  if (s.cpu > 85) out.push(['warn', `Processador em ${pct(s.cpu)}.`]);
  if (s.disk && s.disk.free < 5 * 1024 ** 3) out.push(['bad', `Disco quase cheio: só ${bytes(s.disk.free)} livres.`]);
  else if (s.disk && s.disk.free < 15 * 1024 ** 3) out.push(['warn', `Pouco espaço em disco: ${bytes(s.disk.free)} livres.`]);
  const inCall = (m.voice ?? []).flatMap((v) => v.people ?? []);
  const bad = inCall.filter((p) => p.net && (p.net.q === 'poor' || p.net.q === 'lost'));
  if (bad.length) out.push(['warn', `Conexão ruim na call: ${bad.map((p) => p.name).join(', ')} (veja em Ao vivo).`]);
  const limited = inCall.filter((p) => p.net?.pub?.some((x) => x.limit === 'bandwidth' || x.limit === 'cpu'));
  if (limited.length) out.push(['warn', `Live/câmera com qualidade reduzida: ${limited.map((p) => `${p.name} (${p.net.pub.find((x) => x.limit).limit === 'cpu' ? 'processador' : 'internet'} de quem transmite)`).join(', ')}.`]);
  if (m.loopDelayMs > 100) out.push(['warn', `O Muvuca está respondendo devagar (atraso médio de ${m.loopDelayMs} ms).`]);
  for (const c of s.certs ?? []) {
    if (!c.name.endsWith('duckdns.org')) continue;
    const days = Math.floor((c.validTo - Date.now()) / 86400000);
    if (days < 14) out.push([days < 5 ? 'bad' : 'warn', `Certificado HTTPS de ${c.name} vence em ${days} dias (o Caddy renova sozinho; se não renovar, confira os logs).`]);
  }
  if (ov?.failed24 > 10) out.push(['warn', `${ov.failed24} tentativas que falharam (senha errada etc.) nas últimas 24 h — veja a Auditoria.`]);
  if (ov && !ov.auditReady) out.push(['warn', 'A auditoria ainda não está ativa: reinicie o Muvuca uma vez para criar o registro.']);
  if (bk) {
    const last = bk.local?.[0]?.at;
    if (!last || Date.now() - last > 26 * 3600000) out.push(['warn', `O último backup é de ${last ? ago(last) : 'nunca'}.`]);
    const lastWarn = (bk.warnings ?? []).find((w) => w.startsWith('[backup'));
    if (lastWarn) out.push(['warn', `Último backup com aviso: ${lastWarn.replace(/^\[backup [^\]]+\]\s*/, '')}`]);
  }
  return out;
}

// Ação com confirmação (e motivo opcional) que chama o painel e mostra o resultado
async function act(path, body, { confirmText, askReason, reload } = {}) {
  if (confirmText && !confirm(confirmText)) return;
  if (askReason) {
    const reason = prompt(askReason, '');
    if (reason === null) return;
    body = { ...body, reason };
  }
  try {
    const r = await api(path, { method: 'POST', body });
    toast(r.message ?? 'Feito.', 5000);
  } catch (err) { toast(err.message, 6000); }
  if (reload) openTab(reload);
}
const ipBlockButton = (ip, reload) => (ip ? h('button', { class: 'btn small ghost', title: `Bloquear ${ip}`, onclick: (e) => { e.stopPropagation(); act('/api/ips/block', { ip, block: true }, { confirmText: `Bloquear o IP ${ip}? Ele não vai conseguir abrir o Muvuca nem entrar nas calls.`, askReason: 'Motivo (opcional):', reload }); } }, 'Bloquear IP') : null);

// ---------- Visão geral ----------
let range = 1;
let bkCache = null;
async function viewGeral(first) {
  const [s, ov, hist] = await Promise.all([api('/api/status'), api('/api/overview'), api(`/api/history?hours=${range}`)]);
  status = s;
  // Backups entram nos alertas sem segurar a tela: usa o que já tem e atualiza por trás
  if (!bkCache || Date.now() - bkCache.t > 60000) {
    bkCache = { t: Date.now(), data: bkCache?.data ?? null };
    api('/api/backups').then((d) => { bkCache = { t: Date.now(), data: d }; }).catch(() => {});
  }
  const m = s.main ?? {};
  const inVoice = (m.voice ?? []).reduce((n, v) => n + v.count, 0);
  const lives = (m.voice ?? []).reduce((n, v) => n + (v.people ?? []).filter((p) => p.streaming).length, 0);
  const memPct = s.mem ? (s.mem.used / s.mem.total) * 100 : 0;
  const diskPct = s.disk ? (1 - s.disk.free / s.disk.total) * 100 : 0;
  const al = alerts(s, ov, bkCache.data);

  const times = hist.map((p) => p.t);
  const rangeSel = h('div', { class: 'row' }, h('span', { class: 'muted small' }, 'Período:'),
    [1, 6, 24].map((hr) => h('button', { class: `btn small ${hr === range ? 'primary' : ''}`, onclick: () => { range = hr; openTab('geral'); } }, `${hr} h`)));

  const maxDay = Math.max(1, ...ov.perDay.map((d) => d.n));
  const days = Array.from({ length: 14 }, (_, i) => ov.perDay.find((d) => d.d === i)?.n ?? 0);

  return h('div', {},
    h('div', { class: 'alerts' }, al.length ? al.map(([k, t]) => h('div', { class: `alert ${k}` }, t)) : h('div', { class: 'alert good' }, 'Tudo certo: nenhum alerta agora.')),
    h('div', { class: 'grid cards' },
      stat('Muvuca', m.up && !m.error ? 'No ar' : 'Fora', m.upSince ? `há ${duration((Date.now() - m.upSince) / 1000)}` : m.error ?? ''),
      stat('Online agora', num(m.users?.length ?? 0), `${num(m.connections ?? 0)} abas/apps conectados`),
      stat('Em call', num(inVoice), `${num((m.voice ?? []).length)} canais · ${num(lives)} ${lives === 1 ? 'live' : 'lives'}`),
      stat('Jogando', num((m.games ?? []).filter((g) => g.status === 'playing').reduce((n, g) => n + g.players.length, 0)), `${num((m.games ?? []).length)} salas abertas`),
      stat('Processador', pct(s.cpu), `Muvuca: ${pct((s.procs?.muvuca?.cpu ?? 0) + (s.procs?.livekit?.cpu ?? 0) + (s.procs?.caddy?.cpu ?? 0))}`, s.cpu),
      stat('Memória do Mac', pct(memPct), `${bytes(s.mem?.used)} de ${bytes(s.mem?.total)}`, memPct),
      stat('Rede agora', `↑ ${bits(s.net?.tx)}`, `↓ ${bits(s.net?.rx)} · ${s.net?.iface ?? ''}`),
      stat('Disco', `${bytes(s.disk?.free)} livres`, `${pct(diskPct)} usado de ${bytes(s.disk?.total)}`, diskPct, !s.disk ? '' : s.disk.free < 5 * 1024 ** 3 ? 'bad' : s.disk.free < 15 * 1024 ** 3 ? 'warn' : ''),
    ),
    h('div', { class: 'section row' }, h('h2', {}, 'Histórico'), h('span', { class: 'spacer' }), rangeSel),
    h('div', { class: 'grid two' },
      h('div', { class: 'card' }, h('h2', {}, 'Processador'), lineChart(times, [
        { label: 'Mac inteiro', color: css('--chart1'), values: hist.map((p) => p.cpu) },
        { label: 'Muvuca + voz + HTTPS', color: css('--chart2'), values: hist.map((p) => p.mcpu / (s.cores || 1)) },
      ], { format: (v) => `${Math.round(v)}%`, max: 100 })),
      h('div', { class: 'card' }, h('h2', {}, 'Memória'), lineChart(times, [
        { label: 'Mac inteiro', color: css('--chart1'), values: hist.map((p) => p.mem) },
        { label: 'Muvuca + voz + HTTPS', color: css('--chart2'), values: hist.map((p) => p.mrss) },
      ], { format: bytes, max: s.mem?.total })),
      h('div', { class: 'card' }, h('h2', {}, 'Rede'), lineChart(times, [
        { label: 'Envio (upload)', color: css('--chart2'), values: hist.map((p) => p.tx) },
        { label: 'Recebimento', color: css('--chart1'), values: hist.map((p) => p.rx) },
      ], { format: bits })),
      h('div', { class: 'card' }, h('h2', {}, 'Pessoas'), lineChart(times, [
        { label: 'Online', color: css('--chart1'), values: hist.map((p) => p.online) },
        { label: 'Em call', color: css('--chart3'), values: hist.map((p) => p.voice) },
        { label: 'Lives', color: css('--chart2'), values: hist.map((p) => p.lives) },
      ], { format: (v) => Math.round(v) })),
    ),
    h('div', { class: 'section grid cards' },
      stat('Contas', num(ov.users), `${num(ov.usersNew7)} novas em 7 dias`),
      stat('Ativas', ov.active24 === null ? '—' : num(ov.active24), ov.active7 === null ? '' : `24 h · ${num(ov.active7)} em 7 dias`),
      stat('Mensagens', num(ov.messages), `${num(ov.messages24)} nas últimas 24 h`),
      stat('Servidores', num(ov.servers), `${num(ov.channels)} canais · ${num(ov.dms)} conversas diretas`),
      stat('Anexos', num(ov.files), bytes(ov.filesBytes)),
      stat('Sessões abertas', num(ov.sessions), 'aparelhos conectados às contas'),
    ),
    h('div', { class: 'section grid two' },
      h('div', { class: 'card' }, h('h2', {}, 'Mensagens por dia (14 dias)'),
        h('div', { class: 'bars' }, days.map((n, i) => h('div', { title: `${n} mensagens`, style: `height:${Math.max(2, (n / maxDay) * 100)}%` }))),
        h('div', { class: 'legend' }, h('span', {}, 'há 14 dias'), h('span', { class: 'spacer' }), h('span', {}, 'hoje'))),
      h('div', { class: 'card' }, h('h2', {}, 'Jogos mais jogados (7 dias)'),
        table([{ label: 'Jogo', get: (r) => r.game }, { label: 'Partidas', num: true, get: (r) => num(r.n) }], ov.games7, { empty: 'Nenhuma partida nesta semana.' })),
    ),
    h('div', { class: 'section card' }, h('h2', {}, 'Processos'), processTable(s)),
  );
}

function processTable(s) {
  const names = { muvuca: 'Muvuca (site, chat, jogos)', livekit: 'LiveKit (voz, vídeo, live)', caddy: 'Caddy (HTTPS)', ddns: 'DuckDNS', start: 'Supervisor (start.sh)', painel: 'Este painel' };
  const rows = Object.entries(names).map(([k, label]) => ({ k, label, p: s.procs?.[k] }));
  return table([
    { label: 'Serviço', get: (r) => r.label },
    { label: 'Estado', get: (r) => h('span', { class: `pill ${r.p ? 'good' : 'bad'}` }, r.p ? 'rodando' : 'parado') },
    { label: 'CPU', num: true, get: (r) => (r.p ? pct(r.p.cpu) : '—') },
    { label: 'RAM', num: true, get: (r) => (r.p ? bytes(r.p.rss) : '—') },
    { label: 'Ligado há', num: true, get: (r) => r.p?.etime ?? '—' },
    { label: 'PID', num: true, get: (r) => r.p?.pid ?? '—' },
  ], rows);
}

// Qualidade de cada pessoa em call (relatório que o próprio site dela manda a cada 10 s)
const NET_Q = { excellent: ['good', 'excelente'], good: ['good', 'boa'], poor: ['warn', 'ruim'], lost: ['bad', 'caindo'], unknown: ['', '?'] };
const LIMIT = { bandwidth: 'internet de quem transmite', cpu: 'processador de quem transmite', other: 'outro motivo' };
function voicePeopleTable(people) {
  return h('div', { class: 'section' }, table([
    { label: 'Pessoa', get: (p) => h('span', {}, h('b', {}, p.name), h('span', { class: 'muted small' }, p.deafened ? ' · 🔇 sem som' : p.muted ? ' · 🎙️ mudo' : '')) },
    { label: 'Conexão', get: (p) => { const [k, t] = NET_Q[p.net?.q ?? 'unknown'] ?? NET_Q.unknown; return p.net ? h('span', { class: `pill ${k}` }, t) : h('span', { class: 'muted small', title: 'Sem relatório: site antigo aberto (recarregar) ou acabou de entrar' }, '—'); } },
    { label: 'Enviando', get: (p) => (p.net?.pub?.length ? h('div', {}, p.net.pub.map((x) => h('div', { class: 'small' },
      x.src === 'screen' ? '🔴 live ' : '📷 câmera ', h('b', {}, x.w ? `${x.w}×${x.h}` : '?'), ` · ${x.fps} fps${x.kbps != null ? ` · ${mbpsText(x.kbps)}` : ''}${x.rtt != null ? ` · ${x.rtt} ms` : ''}`,
      x.limit ? h('div', { class: 'error small' }, `limitado pelo ${LIMIT[x.limit]}`) : null))) : h('span', { class: 'muted small' }, p.streaming || p.camera ? 'sem dados ainda' : 'só voz')) },
    { label: 'Recebendo', get: (p) => (p.net?.rx ? h('span', { class: `small ${p.net.rx.loss >= 5 ? 'error' : ''}` },
      `${mbpsText(p.net.rx.kbps)} · perda ${String(p.net.rx.loss ?? 0).replace('.', ',')}%${p.net.rx.jitter != null ? ` · oscilação ${p.net.rx.jitter} ms` : ''}`) : '—') },
  ], people));
}
const mbpsText = (kbps) => (kbps == null ? '?' : kbps >= 1000 ? `${(kbps / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} Mbps` : `${kbps} kbps`);

// ---------- Ao vivo ----------
async function viewAoVivo() {
  const s = await api('/api/status');
  const m = s.main ?? {};
  if (!m.up || m.error) return h('p', { class: 'error' }, `Sem dados ao vivo: ${m.error ?? 'o Muvuca está fora do ar'}.`);
  const statusLabel = { online: ['good', 'online'], idle: ['warn', 'ausente'], dnd: ['bad', 'não perturbe'], invisible: ['', 'invisível'] };
  return h('div', {},
    h('div', { class: 'grid two' },
      h('div', { class: 'card' }, h('h2', {}, `Online (${m.users.length})`),
        table([
          { label: 'Pessoa', get: (u) => h('span', {}, h('b', {}, u.name), ' ', h('span', { class: 'muted small' }, `@${u.username}`)) },
          { label: 'Status', get: (u) => { const [k, t] = statusLabel[u.status] ?? ['', u.status]; return h('span', { class: `pill ${k}` }, t); } },
          { label: 'Abas', num: true, get: (u) => `${u.tabs}${u.hidden ? ' (em segundo plano)' : ''}` },
          { label: 'IP', get: (u) => h('span', { class: 'mono' }, u.ip ?? '—') },
          { label: '', get: (u) => ipBlockButton(u.ip, 'aovivo') },
        ], m.users, { empty: 'Ninguém online agora.' })),
      h('div', { class: 'card' }, h('h2', {}, 'Canais de voz'),
        m.voice.length ? m.voice.map((v) => h('div', { class: 'section' },
          v.private ? h('div', {}, h('b', {}, 'Ligação privada'), h('span', { class: 'muted' }, ` · ${v.count} ${v.count === 1 ? 'pessoa' : 'pessoas'}`))
            : h('div', {}, h('b', {}, `🔊 ${v.name}`), h('span', { class: 'muted' }, ` · ${v.server} · ${v.count} ${v.count === 1 ? 'pessoa' : 'pessoas'}`)),
          v.people ? voicePeopleTable(v.people) : null,
        )) : h('p', { class: 'empty' }, 'Ninguém em call.')),
    ),
    h('div', { class: 'section grid two' },
      h('div', { class: 'card' }, h('h2', {}, 'Salas de jogo'),
        table([
          { label: 'Jogo', get: (g) => g.game },
          { label: 'Estado', get: (g) => h('span', { class: `pill ${g.status === 'playing' ? 'good' : ''}` }, g.status === 'playing' ? 'jogando' : 'esperando') },
          { label: 'Jogadores', get: (g) => g.players.join(', ') },
          { label: 'Assistindo', num: true, get: (g) => g.spectators },
        ], m.games, { empty: 'Nenhuma sala aberta.' })),
      h('div', { class: 'card' }, h('h2', {}, 'Salas de música'),
        table([
          { label: 'Canal', get: (r) => `${r.name} · ${r.server}` },
          { label: 'Ouvindo', num: true, get: (r) => r.listeners },
          { label: 'Tocando', get: (r) => r.track ?? '—' },
        ], m.music, { empty: 'Ninguém ouvindo música.' })),
    ),
  );
}

// ---------- Usuários ----------
let userFilter = '';
async function ipsCard() {
  const d = await api('/api/ips');
  const ip = h('input', { type: 'text', placeholder: 'IP (ex.: 187.10.20.30 ou 2804:…)', size: 28 });
  const add = h('button', { class: 'btn small primary' }, 'Bloquear');
  add.addEventListener('click', () => ip.value.trim() && act('/api/ips/block', { ip: ip.value.trim(), block: true }, { confirmText: `Bloquear o IP ${ip.value.trim()}?`, askReason: 'Motivo (opcional):', reload: tab }));
  return h('div', { class: 'card' }, h('h2', {}, 'IPs bloqueados'),
    h('p', { class: 'muted small' }, `IP bloqueado não abre nada do Muvuca (site, app, calls). Seu IP agora: ${d.you}. Dá para bloquear também pelas abas Ao vivo e Acessos.`),
    table([
      { label: 'IP', get: (r) => h('span', { class: 'mono' }, r.ip) },
      { label: 'Motivo', get: (r) => r.reason ?? '—' },
      { label: 'Desde', get: (r) => when(r.created_at) },
      { label: '', get: (r) => h('button', { class: 'btn small', onclick: () => act('/api/ips/block', { ip: r.ip, block: false }, { confirmText: `Desbloquear ${r.ip}?`, reload: tab }) }, 'Desbloquear') },
    ], d.blocked, { empty: 'Nenhum IP bloqueado.' }),
    h('div', { class: 'row section' }, ip, add));
}

async function viewUsuarios() {
  const users = await api('/api/users');
  const box = h('div', { class: 'card' });
  const input = h('input', { type: 'search', placeholder: 'Buscar por nome ou usuário…', value: userFilter });
  const body = h('div');
  const render = () => {
    const q = userFilter.toLowerCase();
    const rows = users.filter((u) => !q || u.username.toLowerCase().includes(q) || u.name.toLowerCase().includes(q));
    body.replaceChildren(table([
      { label: 'Pessoa', get: (u) => h('span', {}, h('b', {}, u.name), ' ', h('span', { class: 'muted small' }, `@${u.username}`)) },
      { label: 'Agora', get: (u) => h('span', { class: `pill ${u.online ? 'good' : ''}` }, u.online ? 'online' : ago(u.last_seen)) },
      { label: 'Nível', num: true, get: (u) => (u.level ? h('span', { title: `${num(u.level.total)} XP · ${num(u.level.into)}/${num(u.level.need)} para o próximo` }, h('b', {}, u.level.level), h('span', { class: 'muted small' }, ` · ${num(u.level.total)} XP`)) : '—') },
      { label: 'Conta criada', get: (u) => when(u.created_at) },
      { label: 'Último login', get: (u) => h('span', {}, u.lastLogin ? ago(u.lastLogin) : '—', u.lastIp ? h('div', { class: 'mono muted' }, u.lastIp) : null) },
      { label: 'Aparelhos', num: true, get: (u) => u.sessions },
      { label: 'Mensagens', num: true, get: (u) => num(u.messages) },
      { label: 'Anexos', num: true, get: (u) => bytes(u.bytes) },
      { label: 'Servidores', num: true, get: (u) => u.servers },
      { label: 'Senha errada (7 d)', num: true, get: (u) => (u.fails7 ? h('span', { class: `pill ${u.fails7 >= 5 ? 'bad' : 'warn'}` }, u.fails7) : '0') },
      { label: '', get: (u) => h('div', { class: 'row', style: 'flex-wrap:nowrap' },
        u.blocked_at ? h('span', { class: 'pill bad', title: u.blocked_reason ?? '' }, 'bloqueada') : null,
        h('button', { class: 'btn small ghost', onclick: () => { auditFilters = { user: u.username }; openTab('auditoria'); } }, 'Auditoria'),
        !u.blocked_at && (u.sessions || u.online) ? h('button', { class: 'btn small ghost', onclick: () => act('/api/users/disconnect', { id: u.id }, { confirmText: `Desconectar @${u.username} de todos os aparelhos? Ela precisa entrar de novo com a senha.`, reload: 'usuarios' }) }, 'Desconectar') : null,
        u.blocked_at
          ? h('button', { class: 'btn small', onclick: () => act('/api/users/block', { id: u.id, block: false }, { confirmText: `Desbloquear @${u.username}?`, reload: 'usuarios' }) }, 'Desbloquear')
          : h('button', { class: 'btn small ghost', onclick: () => act('/api/users/block', { id: u.id, block: true }, { confirmText: `Bloquear @${u.username}? A conta sai de todos os aparelhos e não consegue mais entrar até ser desbloqueada.`, askReason: 'Motivo (opcional, fica na auditoria):', reload: 'usuarios' }) }, 'Bloquear')) },
    ], rows, { empty: 'Nenhuma conta encontrada.', rowClass: (u) => (u.blocked_at ? 'fail' : null) }));
  };
  input.addEventListener('input', () => { userFilter = input.value; render(); });
  render();
  box.append(h('div', { class: 'row' }, h('h2', {}, `${users.length} contas`), h('span', { class: 'spacer' }), input), body);
  return h('div', {}, box, h('div', { class: 'section' }, await ipsCard()));
}

// ---------- Auditoria ----------
const KEY_LABELS = {
  contaExiste: 'conta existe', outrosAparelhosDesconectados: 'outros aparelhos desconectados', pessoasEmCall: 'pessoas em call',
  expiresIn: 'validade', maxUses: 'usos', userLimit: 'limite de pessoas', name: 'nome', type: 'tipo', topic: 'tópico', word: 'palavra',
  code: 'código', color: 'cor', bitrate: 'qualidade', pinned: 'fixada', on: 'ligado', usuario: 'usuário tentado', texto: 'texto',
};
// "Mozilla/5.0 (Macintosh…) Chrome/…" → "Chrome no Mac" (o texto completo fica na dica ao passar o mouse)
function device(ua) {
  ua = String(ua ?? '');
  if (!ua) return '—';
  const app = /Muvuca\//.test(ua) ? 'App do Muvuca' : /Electron\//.test(ua) ? 'App' : /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera'
    : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /curl\//.test(ua) ? 'curl' : ua.split(/[ /]/)[0];
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X|Macintosh/.test(ua) ? 'Mac'
    : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${app} no ${os}` : app;
}
let auditFilters = {};
async function viewAuditoria() {
  const labels = (await api('/api/audit?limit=1')).labels;
  const f = auditFilters;
  const user = h('input', { type: 'search', placeholder: 'Usuário', value: f.user ?? '', size: 12 });
  const text = h('input', { type: 'search', placeholder: 'Texto (canal, servidor…)', value: f.text ?? '', size: 18 });
  const ip = h('input', { type: 'search', placeholder: 'IP', value: f.ip ?? '', size: 14 });
  const action = h('select', {}, h('option', { value: '' }, 'Todas as ações'),
    Object.entries(labels).map(([k, v]) => h('option', { value: k, selected: f.action === k }, v)));
  const group = h('select', {},
    [['', 'Todos os tipos'], ['seguranca', 'Segurança'], ['contas', 'Contas e acesso'], ['moderacao', 'Moderação'], ['painel', 'Painel'], ['minecraft', 'Minecraft']]
      .map(([k, v]) => h('option', { value: k, selected: f.group === k }, v)));
  const period = h('select', {},
    [['', 'Sempre'], ['1', 'Últimas 24 h'], ['7', '7 dias'], ['30', '30 dias']].map(([k, v]) => h('option', { value: k, selected: f.days === k }, v)));
  const onlyFail = h('input', { type: 'checkbox', checked: f.ok === '0' });
  const list = h('div');
  const more = h('button', { class: 'btn small', hidden: true }, 'Carregar mais');
  let rows = [];

  const params = (extra = {}) => {
    const p = new URLSearchParams();
    const v = { user: user.value.trim(), text: text.value.trim(), ip: ip.value.trim(), action: action.value, group: group.value, ok: onlyFail.checked ? '0' : '' };
    auditFilters = { ...v, days: period.value };
    for (const [k, val] of Object.entries(v)) if (val) p.set(k, val);
    if (period.value) p.set('from', String(Date.now() - Number(period.value) * 86400000));
    for (const [k, val] of Object.entries(extra)) p.set(k, val);
    return p;
  };
  const describe = (d) => (d ? Object.entries(d).map(([k, v]) => h('span', {}, `${KEY_LABELS[k] ?? k}: `,
    h('b', { title: k === 'aparelho' ? String(v) : null }, k === 'aparelho' ? device(v) : Array.isArray(v) ? v.join(', ') : v === true ? 'sim' : v === false ? 'não' : String(v)), '  ')) : '');
  const render = () => list.replaceChildren(table([
    { label: 'Quando', get: (r) => h('span', { title: when(r.at) }, when(r.at)) },
    { label: 'Quem', get: (r) => h('b', {}, r.user_name ?? '—') },
    { label: 'O quê', get: (r) => h('span', {}, r.ok ? '' : '❌ ', r.label) },
    { label: 'Detalhes', get: (r) => h('div', { class: 'detail' }, describe(r.detail)) },
    { label: 'IP', get: (r) => h('span', { class: 'mono' }, r.ip ?? '') },
  ], rows, { empty: 'Nenhum registro com esses filtros.', rowClass: (r) => (r.ok ? null : 'fail') }));

  const load = async (append) => {
    const extra = { limit: '100' };
    if (append && rows.length) extra.before = String(rows[rows.length - 1].id);
    const data = await api(`/api/audit?${params(extra)}`);
    rows = append ? rows.concat(data.rows) : data.rows;
    more.hidden = data.rows.length < 100;
    render();
  };
  more.addEventListener('click', () => load(true));
  for (const el of [action, group, period, onlyFail]) el.addEventListener('change', () => load(false));
  for (const el of [user, text, ip]) el.addEventListener('keydown', (e) => { if (e.key === 'Enter') load(false); });
  const csv = h('button', { class: 'btn small', onclick: () => { location.href = `/api/audit.csv?${params()}`; } }, 'Exportar CSV');
  await load(false);
  return h('div', { class: 'card' },
    h('div', { class: 'row' }, user, text, ip, action, group, period, h('label', { class: 'row small' }, onlyFail, 'Só falhas'),
      h('button', { class: 'btn small primary', onclick: () => load(false) }, 'Filtrar'), h('span', { class: 'spacer' }), csv),
    h('p', { class: 'muted small' }, 'Registra logins (e erros de senha), cadastros, trocas de senha, entradas em canais de voz e todas as ações de gerenciamento: servidores, canais, cargos, convites, expulsões e mensagens apagadas por moderadores. Conversas privadas e mensagens comuns não entram. Guardado por 180 dias.'),
    list, h('div', { class: 'row section' }, more));
}

// ---------- Acessos ----------
async function viewAcessos() {
  const [sum, recent] = await Promise.all([api('/api/access'), api('/api/logs?which=caddy&lines=200')]);
  const pairs = (list, a, b, withBlock) => table([{ label: a, get: (r) => h('span', { class: 'mono' }, r[0]) }, { label: b, num: true, get: (r) => num(r[1]) },
    ...(withBlock ? [{ label: '', get: (r) => ipBlockButton(r[0], 'acessos') }] : [])], list);
  const reqCols = [
    { label: 'Quando', get: (r) => when(r.at) },
    { label: 'IP', get: (r) => h('span', { class: 'row' }, h('span', { class: 'mono' }, r.ip), ipBlockButton(r.ip, 'acessos')) },
    { label: 'Pedido', get: (r) => h('span', { class: 'mono' }, `${r.method} ${r.path}`) },
    { label: 'Status', num: true, get: (r) => h('span', { class: `pill ${r.status >= 500 ? 'bad' : r.status >= 400 ? 'warn' : 'good'}` }, r.status) },
    { label: 'Tempo', num: true, get: (r) => `${r.ms} ms` },
  ];
  return h('div', {},
    h('div', { class: 'grid cards' },
      stat('Pedidos em 24 h', num(sum.total)),
      stat('Sucesso (2xx/3xx)', num((sum.status['2xx'] ?? 0) + (sum.status['3xx'] ?? 0))),
      stat('Recusados (4xx)', num(sum.status['4xx'] ?? 0)),
      stat('Erros (5xx)', num(sum.status['5xx'] ?? 0)),
    ),
    h('div', { class: 'section grid two' },
      h('div', { class: 'card' }, h('h2', {}, 'IPs que mais acessaram (24 h)'), pairs(sum.ips, 'IP', 'Pedidos', true)),
      h('div', { class: 'card' }, h('h2', {}, 'Endereços mais pedidos (24 h)'), pairs(sum.paths, 'Caminho', 'Pedidos')),
    ),
    h('div', { class: 'section card' }, h('h2', {}, 'Recusados: sem permissão ou tentativas demais'), table(reqCols, sum.denied, { empty: 'Nenhum nas últimas 24 h.' })),
    h('div', { class: 'section card' }, h('h2', {}, 'Erros do servidor'), table(reqCols, sum.errors, { empty: 'Nenhum erro nas últimas 24 h.' })),
    h('div', { class: 'section card' }, h('h2', {}, 'Últimos pedidos'), table(reqCols, recent)),
  );
}

// ---------- Logs ----------
let logWhich = 'muvuca';
let logFilter = '';
async function viewLogs() {
  const sel = h('select', {}, [['muvuca', 'Muvuca (servidor)'], ['backup', 'Backups'], ['painel', 'Painel']].map(([k, v]) => h('option', { value: k, selected: k === logWhich }, v)));
  const search = h('input', { type: 'search', placeholder: 'Filtrar linhas…', value: logFilter });
  const pre = h('pre', { class: 'log' });
  const auto = h('input', { type: 'checkbox' });
  let lines = [];
  const render = () => {
    const q = logFilter.toLowerCase();
    const shown = lines.filter((l) => !q || l.toLowerCase().includes(q));
    pre.textContent = shown.length ? shown.join('\n') : '(vazio)';
    pre.scrollTop = pre.scrollHeight;
  };
  const load = async () => { lines = await api(`/api/logs?which=${logWhich}&lines=800`); render(); };
  sel.addEventListener('change', () => { logWhich = sel.value; load(); });
  search.addEventListener('input', () => { logFilter = search.value; render(); });
  auto.addEventListener('change', () => { stopTimers(); if (auto.checked) timer = setInterval(load, 3000); });
  await load();
  return h('div', { class: 'card' },
    h('div', { class: 'row' }, sel, search, h('label', { class: 'row small' }, auto, 'Acompanhar ao vivo'), h('span', { class: 'spacer' }), h('button', { class: 'btn small', onclick: load }, 'Atualizar')),
    h('div', { class: 'section' }, pre));
}

// ---------- Backups ----------
async function viewBackups() {
  const b = await api('/api/backups');
  const cols = [{ label: 'Arquivo', get: (r) => h('span', { class: 'mono' }, r.name) }, { label: 'Tamanho', num: true, get: (r) => bytes(r.size) }, { label: 'Quando', get: (r) => `${when(r.at)} (${ago(r.at)})` }];
  const btn = h('button', { class: 'btn primary' }, 'Fazer backup agora');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Fazendo backup…';
    try {
      const r = await api('/api/backup', { method: 'POST' });
      toast(r.output || (r.ok ? 'Backup feito.' : 'O backup falhou.'), 8000);
      bkCache = null;
      openTab('backups');
    } catch (err) { toast(err.message); } finally { btn.disabled = false; }
  });
  return h('div', {},
    h('div', { class: 'card row' }, h('div', {}, h('b', {}, 'Backup automático todo dia às 4h'), h('div', { class: 'muted small' }, `Banco de dados (todos os servidores e conversas), emojis, fotos, sons e chave das notificações, em ${b.dir}. Guarda os 3 mais recentes, 1 por dia nos últimos 14 dias e 1 por mês nos últimos 6 meses. Os anexos do chat vão para a subpasta anexos (só os novos a cada vez).`)), h('span', { class: 'spacer' }), btn),
    b.warnings.length ? h('div', { class: 'alerts section' }, b.warnings.map((w) => h('div', { class: 'alert warn mono' }, w))) : null,
    h('div', { class: 'section grid two' },
      h('div', { class: 'card' }, h('h2', {}, `Histórico (${b.local?.length ?? 0})`), b.local ? table(cols, b.local, { empty: 'Nenhum backup ainda.' }) : h('p', { class: 'empty' }, 'Pasta não encontrada.')),
      h('div', { class: 'card' }, h('h2', {}, 'Anexos do chat'), h('p', {}, `Cópia dos anexos: ${bytes(b.anexos)}`),
        h('p', { class: 'muted small' }, 'Por enquanto os backups ficam só neste Mac: se o disco dele morrer, eles vão junto. Uma cópia fora do Mac (HD externo ou nuvem) fica para depois.')),
    ),
    h('div', { class: 'section card' }, h('h2', {}, 'Últimos resultados'), h('pre', { class: 'log' }, b.results.join('\n') || '(nenhum)')),
  );
}

// ---------- Sistema ----------
function maintenanceCard(mt) {
  const msg = h('input', { type: 'text', maxlength: 200, style: 'flex:1;min-width:240px', value: mt.on ? mt.message : 'O Muvuca vai reiniciar para uma atualização. Volta em instantes!' });
  const minutes = h('select', {}, [[0, 'sem horário'], [2, 'em 2 min'], [5, 'em 5 min'], [10, 'em 10 min'], [30, 'em 30 min'], [60, 'em 1 hora']].map(([v, l]) => h('option', { value: v }, l)));
  const lock = h('input', { type: 'checkbox', checked: !!mt.lock });
  const on = h('button', { class: 'btn primary' }, mt.on ? 'Atualizar aviso' : 'Ligar manutenção');
  on.addEventListener('click', () => act('/api/maintenance', { on: true, message: msg.value, minutes: minutes.value, lock: lock.checked },
    { confirmText: lock.checked ? 'Travar o acesso? Todo mundo (menos você) sai e vê a tela de manutenção até você desligar.' : null, reload: 'sistema' }));
  const off = h('button', { class: 'btn' }, 'Desligar');
  off.addEventListener('click', () => act('/api/maintenance', { on: false }, { reload: 'sistema' }));
  return h('div', { class: 'card' },
    h('div', { class: 'row' }, h('h2', {}, '🛠️ Modo manutenção'), mt.on ? h('span', { class: `pill ${mt.lock ? 'bad' : 'warn'}` }, mt.lock ? 'ligado · acesso travado' : 'ligado · só aviso') : h('span', { class: 'pill' }, 'desligado')),
    h('p', { class: 'muted small' }, 'Mostra uma faixa de aviso no topo do Muvuca para todo mundo. Travando o acesso, todos (menos você) veem a tela "Em manutenção" até você desligar, e o Muvuca volta sozinho para eles.'),
    h('div', { class: 'row' }, msg, minutes),
    h('div', { class: 'row section' }, h('label', { class: 'row small' }, lock, 'Travar o acesso (só o dono entra)'), h('span', { class: 'spacer' }), mt.on ? off : null, on));
}

async function viewSistema() {
  const [s, sessions, mt] = await Promise.all([api('/api/status'), api('/api/sessions'), api('/api/maintenance')]);
  const m = s.main ?? {};
  const sz = s.sizes ?? {};
  const restart = h('button', { class: 'btn danger' }, 'Reiniciar o Muvuca');
  restart.addEventListener('click', async () => {
    if (!confirm('Reiniciar o Muvuca agora? Quem estiver conectado cai por uns 10 segundos e volta sozinho.')) return;
    restart.disabled = true;
    try {
      let r = await api('/api/restart', { method: 'POST', body: {} });
      if (r.needsForce && confirm(`${r.output}\nReiniciar mesmo assim?`)) r = await api('/api/restart', { method: 'POST', body: { force: true } });
      toast(r.output, 8000);
    } catch (err) { toast(err.message); } finally { setTimeout(() => { restart.disabled = false; }, 15000); }
  });
  const logoutAll = h('button', { class: 'btn small', onclick: async () => { await api('/api/logout-all', { method: 'POST' }); toast('Os outros aparelhos saíram do painel.'); openTab('sistema'); } }, 'Tirar os outros aparelhos');
  const site = `https://${s.domain}${s.publicPort && s.publicPort !== '443' ? ` (IPv4: porta ${s.publicPort})` : ''}`;
  return h('div', {},
    maintenanceCard(mt),
    h('div', { class: 'section grid two' },
      h('div', { class: 'card' }, h('h2', {}, 'Muvuca'), table([{ label: '', get: (r) => h('span', { class: 'muted' }, r[0]) }, { label: '', get: (r) => r[1] }], [
        ['Endereço', site],
        ['Estado', m.up && !m.error ? 'no ar' : m.error ?? 'fora do ar'],
        ['Ligado desde', m.upSince ? `${when(m.upSince)} (${duration((Date.now() - m.upSince) / 1000)})` : '—'],
        ['Node.js', m.node ?? '—'],
        ['Memória do Node', m.memory ? `${bytes(m.memory.rss)} (heap ${bytes(m.memory.heapUsed)} de ${bytes(m.memory.heapTotal)})` : '—'],
        ['Atraso de resposta', m.loopDelayMs !== undefined ? `${m.loopDelayMs} ms em média (pico ${m.loopDelayMaxMs} ms)` : '—'],
        ['Conexões abertas', num(m.connections ?? 0)],
      ])),
      h('div', { class: 'card' }, h('h2', {}, 'Mac'), table([{ label: '', get: (r) => h('span', { class: 'muted' }, r[0]) }, { label: '', get: (r) => r[1] }], [
        ['Ligado há', duration(s.uptime ?? 0)],
        ['Processador', `${pct(s.cpu)} de ${s.cores} núcleos · carga ${(s.load ?? []).join(' / ')}`],
        ['Memória', `${bytes(s.mem?.used)} de ${bytes(s.mem?.total)} (${bytes(s.mem?.compressed)} comprimida)`],
        ['Disco', `${bytes(s.disk?.free)} livres de ${bytes(s.disk?.total)}`],
        ['Rede', `${s.net?.iface ?? '—'} · total enviado ${bytes(s.net?.totalTx)} · recebido ${bytes(s.net?.totalRx)}`],
      ])),
    ),
    h('div', { class: 'section grid two' },
      h('div', { class: 'card' }, h('h2', {}, 'Espaço usado pelos dados'), table([{ label: 'O quê', get: (r) => r[0] }, { label: 'Tamanho', num: true, get: (r) => bytes(r[1]) }], [
        ['Banco de dados', (sz['malegna.db'] ?? 0) + (sz['malegna.db-wal'] ?? 0)],
        ['Anexos do chat', sz.anexos ?? 0], ['Fotos (perfil, banner, ícones)', sz.fotos ?? 0], ['Emojis', sz.emojis ?? 0], ['Sons', sz.sons ?? 0], ['Backups no Mac', sz.backups ?? 0],
      ]), h('p', { class: 'muted small' }, `Medido ${ago(sz.at)} (a cada 10 min).`)),
      h('div', { class: 'card' }, h('h2', {}, 'Certificados HTTPS'), table([
        { label: 'Endereço', get: (c) => c.name },
        { label: 'Vence', get: (c) => { const d = Math.floor((c.validTo - Date.now()) / 86400000); return h('span', { class: `pill ${d < 5 ? 'bad' : d < 14 ? 'warn' : 'good'}` }, `em ${d} dias`); } },
        { label: 'Emissor', get: (c) => c.issuer },
      ], s.certs ?? [], { empty: 'Nenhum certificado encontrado.' }), h('p', { class: 'muted small' }, 'O Caddy renova sozinho cerca de 30 dias antes de vencer.')),
    ),
    h('div', { class: 'section card' }, h('h2', {}, 'Processos'), processTable(s)),
    h('div', { class: 'section card' }, h('div', { class: 'row' }, h('h2', {}, 'Aparelhos conectados ao painel'), h('span', { class: 'spacer' }), logoutAll),
      table([
        { label: 'Aparelho', get: (x) => h('span', { title: x.ua }, x.current ? h('span', { class: 'pill good' }, 'este') : null, ' ', device(x.ua)) },
        { label: 'IP', get: (x) => h('span', { class: 'mono' }, x.ip) },
        { label: 'Entrou', get: (x) => when(x.created) },
        { label: 'Último uso', get: (x) => ago(x.last) },
      ], sessions)),
    h('div', { class: 'section card row' }, h('div', {}, h('b', {}, 'Reiniciar o Muvuca'), h('div', { class: 'muted small' }, 'Reinicia o site, a voz e o HTTPS (fica registrado na auditoria). O painel continua no ar. Se tiver gente em call, ele avisa antes.')), h('span', { class: 'spacer' }), restart),
  );
}

// ---------- Minecraft ----------
let mcSel = null;          // servidor aberto
let mcSub = 'console';     // seção aberta
const mcConsole = {};      // id -> linhas do console desta sessão
const mcDraft = {};        // id -> mudanças ainda não salvas nas configurações
let mcLogWhich = 'jogo';
const PHASE = {
  stopped: ['', 'Desligado'], sleeping: ['', '💤 Dormindo'], starting: ['warn', 'Ligando…'], running: ['good', 'Ligado'], stopping: ['warn', 'Desligando…'],
};

async function mcAction(id, action, confirmText) {
  if (confirmText && !confirm(confirmText)) return;
  try {
    const r = await api('/api/mc/action', { method: 'POST', body: { id, action } });
    toast(r.message ?? 'Feito.');
  } catch (err) { toast(err.message, 6000); }
  setTimeout(() => openTab('minecraft'), 800);
}

async function viewMinecraft() {
  const d = await api('/api/mc');
  if (!d.servers.length) return h('p', { class: 'empty' }, `Nenhum servidor encontrado em ${d.root}.`);
  // Abre de cara o servidor que está ligado (senão, o primeiro)
  if (!d.servers.some((x) => x.id === mcSel)) mcSel = (d.servers.find((x) => x.phase !== 'stopped') ?? d.servers[0]).id;
  const cards = h('div', { class: 'grid two' }, d.servers.map((x) => mcCard(x, d)));
  const sel = d.servers.find((x) => x.id === mcSel);
  return h('div', {}, mcAddressBox(d), h('div', { class: 'section' }, cards), h('div', { class: 'section' }, await mcDetail(sel, d)));
}

// Endereço para entrar: domínio (+ porta, se não for a padrão 25565)
const mcJoin = (d, x) => `${d.address.domain}${x.port === 25565 ? '' : `:${x.port}`}`;

function copyButton(text) {
  const b = h('button', { class: 'btn small ghost', title: `Copiar ${text}` }, 'Copiar');
  b.addEventListener('click', async (e) => {
    e.stopPropagation();
    try { await navigator.clipboard.writeText(text); toast(`Copiado: ${text}`); } catch { toast(text); }
  });
  return b;
}

function mcAddressBox(d) {
  const a = d.address;
  const ip = (label, value) => h('span', {}, h('span', { class: 'muted' }, `${label}: `), value ? h('span', { class: 'mono' }, value) : h('span', { class: 'muted' }, '—'));
  return h('div', { class: 'card' },
    h('div', { class: 'row' }, h('h2', {}, '🌐 Endereço dos servidores'), h('span', { class: 'spacer' }), h('span', { class: 'muted small' }, 'O mesmo do Muvuca: muda só a porta')),
    h('div', { class: 'row' }, ip('IP público (IPv4)', a.ipv4), ip('IPv6', a.ipv6)),
    h('p', { class: 'muted small' }, `Para os amigos: use o endereço de cada servidor abaixo (o nome ${a.domain} acompanha o IP sozinho, mesmo quando ele muda). Só funciona se o roteador encaminhar a porta do servidor para este Mac.`));
}

function mcCard(x, d) {
  const [cls, label] = x.external ? ['good', 'Ligado (fora do painel)'] : PHASE[x.phase] ?? ['', x.phase];
  const on = x.phase === 'running' || x.phase === 'starting';
  const kind = `${x.version.kind} · Minecraft ${x.version.minecraft}${x.version.mods ? ` · ${x.version.mods} mods` : ''}`;
  const busy = x.busy ? h('span', { class: 'pill warn' }, x.busy === 'backup' ? 'fazendo backup…' : x.busy === 'stop' ? 'desligando…' : 'ligando…') : null;
  const btns = h('div', { class: 'row section' },
    !on ? h('button', { class: 'btn primary', disabled: !!x.busy, onclick: () => mcAction(x.id, 'start') }, 'Ligar') : null,
    on ? h('button', { class: 'btn', disabled: !!x.busy || x.external, onclick: () => mcAction(x.id, 'stop', `Desligar o ${x.id}?${x.players ? ` Tem ${x.players} jogando agora.` : ''} O mundo é salvo antes.`) }, 'Desligar') : null,
    on ? h('button', { class: 'btn', disabled: !!x.busy || x.external, onclick: () => mcAction(x.id, 'restart', `Reiniciar o ${x.id}?${x.players ? ` Tem ${x.players} jogando agora.` : ''}`) }, 'Reiniciar') : null,
  );
  // Os botões do cartão fazem só a ação deles (não trocam o servidor aberto)
  btns.addEventListener('click', (e) => e.stopPropagation());
  const memPct = (x.rss / d.totalMem) * 100;
  // Clicar no cartão abre os dados do servidor logo abaixo
  const select = () => { if (mcSel !== x.id) { mcSel = x.id; openTab('minecraft'); } };
  return h('div', {
    class: `card mc-card${x.id === mcSel ? ' selected' : ''}`, role: 'button', tabindex: '0', 'aria-pressed': String(x.id === mcSel),
    title: x.id === mcSel ? null : `Mostrar ${x.id} abaixo`, onclick: select,
    onkeydown: (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); select(); } },
  },
    h('div', { class: 'row' }, h('h2', {}, `⛏️ ${x.id}`), h('span', { class: `pill ${cls}` }, h('span', { class: 'dot' }), label), busy),
    h('div', { class: 'muted small' }, kind, ` · porta ${x.port}`),
    h('div', { class: 'row', style: 'margin-top:6px' }, h('span', { class: 'small' }, 'Entrar: ', h('b', { class: 'mono' }, mcJoin(d, x))), copyButton(mcJoin(d, x))),
    x.motd ? h('div', { class: 'small' }, `“${x.motd}”`) : null,
    h('div', { class: 'grid cards section' },
      stat('Jogando', x.phase === 'running' ? `${x.players}/${x.max}` : '—', x.names.length ? x.names.join(', ') : x.phase === 'running' ? 'ninguém agora' : ''),
      stat('Memória', on ? bytes(x.rss) : '—', `limite ${x.memory}`, on ? memPct : undefined),
      stat('Processador', on ? pct(x.cpu) : '—', x.tps ? `TPS ${x.tps} (20 = perfeito)` : x.etime ? `ligado há ${x.etime}` : ''),
    ),
    x.phase === 'sleeping' ? h('p', { class: 'muted small' }, 'Aparece na lista do Minecraft como “Dormindo — entre para acordar” e liga sozinho quando alguém tenta entrar.') : null,
    x.sleepError ? h('p', { class: 'error small' }, `Modo dormindo sem funcionar: ${x.sleepError}.`) : null,
    x.phase === 'running' && x.autoStop && x.emptySince ? h('p', { class: 'muted small' }, `Sem ninguém ${ago(x.emptySince)}: desliga sozinho depois de ${x.autoStop} min vazio.`) : null,
    x.rconError && x.phase === 'running' ? h('p', { class: 'error small' }, `Console: ${x.rconError}`) : null,
    btns);
}

async function mcDetail(x, d) {
  const subs = [['console', 'Console'], ['config', 'Configurações'], ['jogadores', 'Jogadores'], ['backups', 'Backups do mundo'], ['logs', 'Logs']];
  const nav = h('div', { class: 'row' }, h('h2', {}, `Gerenciar ${x.id}`), h('span', { class: 'spacer' }),
    subs.map(([k, v]) => h('button', { class: `btn small ${mcSub === k ? 'primary' : ''}`, onclick: () => { mcSub = k; openTab('minecraft'); } }, v)));
  const body = mcSub === 'console' ? mcConsoleView(x) : mcSub === 'config' ? mcConfigView(x, d) : mcSub === 'jogadores' ? mcPlayersView(x)
    : mcSub === 'backups' ? await mcBackupsView(x) : await mcLogsView(x);
  return h('div', { class: 'card' }, nav, h('div', { class: 'section' }, body));
}

function mcConsoleView(x) {
  const lines = (mcConsole[x.id] ??= []);
  const pre = h('pre', { class: 'log' }, lines.length ? lines.join('\n') : 'Os comandos que você mandar e as respostas aparecem aqui.');
  const input = h('input', { type: 'text', placeholder: x.phase === 'running' ? 'Comando (ex.: say olá, time set day, gamemode creative Nick)' : 'Ligue o servidor para usar o console', disabled: x.phase !== 'running', style: 'flex:1;min-width:200px' });
  const send = async (cmd) => {
    cmd = (cmd ?? input.value).trim();
    if (!cmd) return;
    lines.push(`> ${cmd}`);
    input.value = '';
    try {
      const r = await api('/api/mc/cmd', { method: 'POST', body: { id: x.id, command: cmd } });
      lines.push(r.output);
    } catch (err) { lines.push(`(erro: ${err.message})`); }
    if (lines.length > 300) lines.splice(0, lines.length - 300);
    pre.textContent = lines.join('\n');
    pre.scrollTop = pre.scrollHeight;
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
  const quick = [['Quem está online', 'list'], ['Salvar o mundo', 'save-all'], ['Deixar de dia', 'time set day'], ['Tempo limpo', 'weather clear']];
  setTimeout(() => { pre.scrollTop = pre.scrollHeight; }, 0);
  return h('div', {},
    h('div', { class: 'row' }, quick.map(([label, cmd]) => h('button', { class: 'btn small', disabled: x.phase !== 'running', onclick: () => send(cmd) }, label))),
    h('div', { class: 'section' }, pre),
    h('div', { class: 'row section' }, input, h('button', { class: 'btn primary', disabled: x.phase !== 'running', onclick: () => send() }, 'Enviar')),
    h('p', { class: 'muted small' }, 'Tudo o que é mandado por aqui fica registrado na auditoria. Para desligar, use o botão Desligar (salva o mundo).'));
}

function mcConfigView(x, d) {
  const draft = (mcDraft[x.id] ??= {});
  const val = (k) => (k in draft ? draft[k] : x.props[k]);
  const field = (k, def) => {
    let input;
    if (def.type === 'bool') input = h('input', { type: 'checkbox', checked: val(k) === 'true' || val(k) === true });
    else if (def.type === 'enum') input = h('select', {}, def.choices.map(([v, l]) => h('option', { value: v, selected: val(k) === v }, l)));
    else input = h('input', { type: def.type === 'int' ? 'number' : 'text', value: val(k) ?? '', min: def.min, max: def.max, maxlength: def.max, style: def.type === 'text' ? 'width:100%' : 'width:90px' });
    input.addEventListener('change', () => { draft[k] = def.type === 'bool' ? input.checked : input.value; });
    return h('tr', {}, h('td', {}, def.label), h('td', {}, input));
  };
  const memory = h('select', {}, d.memoryChoices.map((m) => h('option', { value: m, selected: (draft.__memory ?? x.memory) === m }, `${m}${m === '4G' && x.modded ? ' (recomendado para modpack)' : m === '3G' && !x.modded ? ' (recomendado)' : ''}`)));
  memory.addEventListener('change', () => { draft.__memory = memory.value; });
  const auto = h('select', {}, d.autoStopChoices.map((m) => h('option', { value: m, selected: Number(draft.__auto ?? x.autoStop) === m }, m ? `depois de ${m} min vazio` : 'nunca')));
  auto.addEventListener('change', () => { draft.__auto = auto.value; });
  const sleep = h('input', { type: 'checkbox', checked: draft.__sleep ?? x.sleep });
  sleep.addEventListener('change', () => { draft.__sleep = sleep.checked; });
  const save = h('button', { class: 'btn primary' }, 'Salvar');
  save.addEventListener('click', async () => {
    const props = Object.fromEntries(Object.entries(draft).filter(([k]) => !k.startsWith('__')));
    try {
      const r = await api('/api/mc/settings', { method: 'POST', body: { id: x.id, props, memory: draft.__memory, autoStop: draft.__auto, sleep: draft.__sleep } });
      mcDraft[x.id] = {};
      toast(r.message, 6000);
      openTab('minecraft');
    } catch (err) { toast(err.message, 6000); }
  });
  const gb = Math.round(d.totalMem / 1024 ** 3);
  return h('div', {},
    h('table', {}, h('tbody', {},
      h('tr', {}, h('td', {}, h('b', {}, 'Memória do servidor')), h('td', {}, memory, h('div', { class: 'muted small' }, `O Mac tem ${gb} GB no total e o Muvuca também usa. Com calls e lives, prefira não passar de 4G.`))),
      h('tr', {}, h('td', {}, h('b', {}, 'Modo dormindo')), h('td', {}, h('label', { class: 'row small' }, sleep, 'Desligado, fica “dormindo”: liga sozinho quando alguém tenta entrar'), h('div', { class: 'muted small' }, 'Quem entra vê “Acordando o servidor” e entra de novo em alguns segundos. Com a lista de permitidos ativa, só quem está nela acorda o servidor.'))),
      h('tr', {}, h('td', {}, h('b', {}, 'Desligar sozinho')), h('td', {}, auto, h('div', { class: 'muted small' }, 'Economiza memória: sem ninguém jogando, salva e desliga (no modo dormindo, volta a dormir).'))),
      Object.entries(d.editable).map(([k, def]) => field(k, def)))),
    h('div', { class: 'row section' }, save, h('span', { class: 'muted small' }, x.phase === 'stopped' ? 'Vale na próxima vez que ligar.' : 'Vale na próxima vez que ligar (reinicie para aplicar agora).')));
}

function mcPlayersView(x) {
  const listBox = (title, names, list, hint) => {
    const input = h('input', { type: 'text', placeholder: 'Nick no Minecraft', maxlength: 16 });
    const call = async (name, add) => {
      try {
        const r = await api('/api/mc/whitelist', { method: 'POST', body: { id: x.id, name, add, list } });
        toast(r.output, 5000);
        setTimeout(() => openTab('minecraft'), 600);
      } catch (err) { toast(err.message, 6000); }
    };
    return h('div', { class: 'card' }, h('h2', {}, title), h('p', { class: 'muted small' }, hint),
      names.length ? h('div', { class: 'people' }, names.map((n) => h('span', { class: 'pill' }, n, ' ', h('button', { class: 'btn small ghost', title: 'Remover', disabled: x.phase !== 'running', onclick: () => confirm(`Tirar ${n}?`) && call(n, false) }, '✕')))) : h('p', { class: 'empty' }, 'Ninguém.'),
      h('div', { class: 'row section' }, input, h('button', { class: 'btn small primary', disabled: x.phase !== 'running', onclick: () => input.value.trim() && call(input.value.trim(), true) }, 'Adicionar')));
  };
  const wl = x.props['white-list'] === 'true';
  return h('div', {},
    x.phase !== 'running' ? h('p', { class: 'muted small' }, 'Para mudar as listas o servidor precisa estar ligado (o jogo confere o nick na Mojang).') : null,
    h('div', { class: 'grid two' },
      listBox('Lista de permitidos', x.whitelist, 'whitelist', wl ? 'Ativada: só quem está aqui entra.' : 'Desativada: qualquer pessoa com o endereço entra. Ative em Configurações.'),
      listBox('Administradores (op)', x.ops, 'op', 'Podem usar comandos dentro do jogo.')));
}

async function mcBackupsView(x) {
  const b = await api(`/api/mc/backups?id=${encodeURIComponent(x.id)}`);
  const btn = h('button', { class: 'btn primary', disabled: b.busy || !!x.busy }, b.busy ? 'Fazendo backup…' : 'Fazer backup agora');
  btn.addEventListener('click', () => mcAction(x.id, 'backup'));
  return h('div', {},
    h('div', { class: 'row' }, h('div', {}, h('div', {}, `Mundo: ${bytes(x.worldBytes)}`), h('div', { class: 'muted small' }, `Guardados em ${b.dir}. Todo dia às 4h30, se o mundo foi jogado. Mantém os 3 mais recentes, 1 por dia (14 dias) e 1 por mês (6 meses). Com o servidor ligado, o mundo é salvo antes da cópia.`)), h('span', { class: 'spacer' }), btn),
    h('div', { class: 'section' }, table([
      { label: 'Arquivo', get: (r) => h('span', { class: 'mono' }, r.name) },
      { label: 'Tamanho', num: true, get: (r) => bytes(r.size) },
      { label: 'Quando', get: (r) => `${when(r.at)} (${ago(r.at)})` },
    ], b.list, { empty: 'Nenhum backup deste mundo ainda.' })));
}

async function mcLogsView(x) {
  const lines = await api(`/api/mc/logs?id=${encodeURIComponent(x.id)}&which=${mcLogWhich === 'console' ? 'console' : 'jogo'}`);
  const sel = h('select', {}, [['jogo', 'Log do jogo (latest.log)'], ['console', 'Saída ao ligar (erros de inicialização)']].map(([k, v]) => h('option', { value: k, selected: k === mcLogWhich }, v)));
  sel.addEventListener('change', () => { mcLogWhich = sel.value; openTab('minecraft'); });
  const pre = h('pre', { class: 'log' }, lines.length ? lines.join('\n') : '(vazio)');
  setTimeout(() => { pre.scrollTop = pre.scrollHeight; }, 0);
  return h('div', {}, h('div', { class: 'row' }, sel, h('span', { class: 'muted small' }, 'Atualiza sozinho a cada 5 s.')), h('div', { class: 'section' }, pre));
}

// ---------- Internet (teste de velocidade, só no botão) ----------
const mbps = (b) => (b == null ? '—' : `${(b / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: b < 1e7 ? 1 : 0 })} Mbps`);
// Responsividade (RPM): quanto a conexão engasga quando está cheia; afeta voz e jogo
const rpmLevel = (r) => (r == null ? ['', '—'] : r >= 800 ? ['good', 'alta'] : r >= 200 ? ['warn', 'média'] : ['bad', 'baixa']);

async function startSpeedtest(mode, btns) {
  btns.forEach((b) => { b.disabled = true; });
  try {
    let r = await api('/api/speedtest', { method: 'POST', body: { mode } });
    if (r.needsForce && confirm(`${r.message}\nTestar mesmo assim?`)) r = await api('/api/speedtest', { method: 'POST', body: { mode, force: true } });
    if (r.message) toast(r.message);
  } catch (err) { toast(err.message, 6000); }
  openTab('internet');
}

async function viewInternet() {
  const d = await api('/api/speedtest');
  const last = d.lastOk;
  const up = h('button', { class: 'btn primary', disabled: !!d.running }, 'Testar upload (recomendado)');
  const full = h('button', { class: 'btn', disabled: !!d.running }, 'Teste completo (download + upload)');
  up.addEventListener('click', () => startSpeedtest('upload', [up, full]));
  full.addEventListener('click', () => startSpeedtest('full', [up, full]));
  const a = d.activity;
  const using = [a.voice && `${a.voice} em call`, a.lives && `${a.lives} em live`, a.minecraft && `${a.minecraft} no Minecraft`].filter(Boolean);
  const top = h('div', { class: 'card' },
    h('div', { class: 'row' }, up, full, h('span', { class: 'spacer' }),
      d.running ? h('span', { class: 'pill warn' }, h('span', { class: 'dot' }), `Testando (${d.modes[d.running.mode]})… ${Math.round((Date.now() - d.running.startedAt) / 1000)} s`) : null),
    h('p', { class: 'muted small' }, 'Usa o teste da própria Apple (vem no macOS). Ocupa a internet inteira por uns 20 a 40 s: quem estiver em call, live ou jogando sente. ',
      'O teste só de upload gasta uns 600 MB de dados; o completo, de 1 a 2 GB.'),
    using.length ? h('div', { class: 'alert warn' }, `Agora tem gente usando: ${using.join(', ')}. Se possível, teste depois.`) : null,
    d.lastError && !d.running ? h('div', { class: 'alert bad' }, `O último teste falhou: ${d.lastError}.`) : null);

  const [rk, rl] = rpmLevel(last?.rpm);
  const stats = last ? h('div', { class: 'section grid cards' },
    stat('Upload', mbps(last.up), 'o que limita o servidor (lives, calls, Minecraft)'),
    stat('Download', mbps(last.down), last.down == null ? 'não medido (teste só de upload)' : 'o que você recebe'),
    stat('Responsividade', last.rpm == null ? '—' : `${num(last.rpm)} RPM`, last.rpm == null ? 'medida só no teste completo' : h('span', {}, h('span', { class: `pill ${rk}` }, rl), ' quanto menos engasga, melhor para voz e jogo')),
    stat('Latência', last.rtt == null ? '—' : `${last.rtt} ms`, 'sem carga, até o servidor de teste'),
  ) : h('p', { class: 'empty section' }, 'Nenhum teste ainda. Aperte "Testar upload" com o servidor vazio.');

  const c = d.capacity;
  const capCard = c ? h('div', { class: 'card section' },
    h('h2', {}, 'Quanto cabe com esse upload'),
    h('p', { class: 'muted small' }, `Pelo teste de ${when(d.capacityFrom)}, deixando 20% de folga. São números aproximados de quem está assistindo ou ouvindo ao mesmo tempo.`),
    h('div', { class: 'grid cards' },
      stat('Live 1080p', `~${num(c.live1080)}`, 'pessoas assistindo (≈5 Mbps cada)'),
      stat('Live 720p', `~${num(c.live720)}`, 'pessoas assistindo (≈2,5 Mbps cada)'),
      stat('Câmera', `~${num(c.camera)}`, 'câmeras sendo vistas (≈1,5 Mbps)'),
      stat('Voz', c.voice > 500 ? 'centenas' : `~${num(c.voice)}`, 'pessoas ouvindo (≈0,1 Mbps)'),
      stat('Minecraft', `~${num(c.minecraft)}`, 'jogadores (≈0,5 Mbps)'),
    ),
    h('p', { class: 'muted small' }, 'Tudo divide a mesma internet: uma live com 10 pessoas assistindo já usa ~50 Mbps do total.')) : null;

  const ok = d.history.filter((r) => r.ok);
  const chart = ok.length > 1 ? h('div', { class: 'card section' }, h('h2', {}, 'Histórico'),
    lineChart(ok.map((r) => r.at), [
      { label: 'Upload', color: css('--chart2'), values: ok.map((r) => r.up ?? 0) },
      ...(ok.some((r) => r.down) ? [{ label: 'Download', color: css('--chart1'), values: ok.map((r) => r.down ?? 0) }] : []),
    ], { format: bits })) : null;

  const list = h('div', { class: 'card section' }, h('h2', {}, 'Testes feitos'), table([
    { label: 'Quando', get: (r) => when(r.at) },
    { label: 'Tipo', get: (r) => d.modes[r.mode] ?? r.mode },
    { label: 'Upload', num: true, get: (r) => (r.ok ? mbps(r.up) : '—') },
    { label: 'Download', num: true, get: (r) => (r.ok ? mbps(r.down) : '—') },
    { label: 'Responsividade', num: true, get: (r) => (r.ok && r.rpm != null ? h('span', { class: `pill ${rpmLevel(r.rpm)[0]}` }, `${num(r.rpm)} RPM`) : '—') },
    { label: 'Latência', num: true, get: (r) => (r.ok && r.rtt != null ? `${r.rtt} ms` : '—') },
    { label: 'Resultado', get: (r) => (r.ok ? h('span', { class: 'muted small' }, `${r.iface ?? ''} · ${bytes(r.bytes)}`) : h('span', { class: 'error small' }, r.error)) },
  ], [...d.history].reverse(), { empty: 'Nenhum teste ainda.', rowClass: (r) => (r.ok ? null : 'fail') }));

  return h('div', {}, top, stats, capCard, chart, list);
}

// ---------- Arquivos pesados ----------
const KIND_LABEL = { image: '🖼️ Imagem', video: '🎬 Vídeo', audio: '🎵 Áudio', document: '📄 Documento' };
let filesKind = '';
async function viewArquivos() {
  const d = await api(`/api/files${filesKind ? `?kind=${filesKind}` : ''}`);
  const sel = h('select', {}, [['', 'Todos os tipos'], ['image', 'Imagens'], ['video', 'Vídeos'], ['audio', 'Áudios'], ['document', 'Documentos']]
    .map(([k, v]) => h('option', { value: k, selected: k === filesKind }, v)));
  sel.addEventListener('change', () => { filesKind = sel.value; openTab('arquivos'); });
  const small = (cols, rows) => table(cols, rows, { empty: 'Nenhum anexo.' });
  return h('div', {},
    h('div', { class: 'grid cards' },
      stat('Anexos no total', num(d.total.n), bytes(d.total.bytes)),
      d.byKind.map((k) => stat(KIND_LABEL[k.kind] ?? k.kind, bytes(k.bytes), `${num(k.n)} arquivos`))),
    h('div', { class: 'section grid two' },
      h('div', { class: 'card' }, h('h2', {}, 'Quem mais ocupa'), small([
        { label: 'Pessoa', get: (r) => h('span', {}, h('b', {}, r.name ?? '—'), ' ', h('span', { class: 'muted small' }, r.username ? `@${r.username}` : '')) },
        { label: 'Arquivos', num: true, get: (r) => num(r.n) },
        { label: 'Espaço', num: true, get: (r) => bytes(r.bytes) },
      ], d.byUser)),
      h('div', { class: 'card' }, h('h2', {}, 'Onde'), small([
        { label: 'Servidor', get: (r) => r.place ?? '?' },
        { label: 'Arquivos', num: true, get: (r) => num(r.n) },
        { label: 'Espaço', num: true, get: (r) => bytes(r.bytes) },
      ], d.byPlace))),
    h('div', { class: 'section card' },
      h('div', { class: 'row' }, h('h2', {}, 'Maiores anexos'), h('span', { class: 'spacer' }), sel),
      h('p', { class: 'muted small' }, 'Os 200 maiores. Em conversas privadas não aparecem o nome do arquivo nem o canal.'),
      small([
        { label: 'Arquivo', get: (r) => (r.name ? h('span', {}, r.name) : h('span', { class: 'muted' }, '(conversa privada)')) },
        { label: 'Tipo', get: (r) => KIND_LABEL[r.kind] ?? r.kind },
        { label: 'Tamanho', num: true, get: (r) => h('b', {}, bytes(r.size)) },
        { label: 'Quem mandou', get: (r) => `@${r.user}` },
        { label: 'Onde', get: (r) => h('span', { class: 'small' }, r.where, r.orphan ? h('span', { class: 'muted' }, ' (mensagem apagada)') : null) },
        { label: 'Quando', get: (r) => when(r.at) },
      ], d.files)));
}

// ---------- Atualizar o Muvuca (com volta atrás) ----------
const KIND_REL = { base: 'versão inicial', publicada: 'publicada', 'antes de voltar': 'guardada antes de voltar' };
async function deployAction(path, body, confirmText) {
  if (!confirm(confirmText)) return;
  try {
    let r = await api(path, { method: 'POST', body });
    if (r.needsForce && confirm(`${r.message}\nContinuar mesmo assim?`)) r = await api(path, { method: 'POST', body: { ...body, force: true } });
    if (r.message) toast(r.message, 5000);
  } catch (err) { toast(err.message, 6000); }
  openTab('atualizar');
}

async function viewAtualizar() {
  const d = await api('/api/deploy');
  const running = d.job && !d.job.done;
  const p = d.pending;
  const nothing = p.hasBaseline && !p.site.length && !p.server.length;
  const notify = h('input', { type: 'checkbox' });
  const publish = h('button', { class: 'btn primary', disabled: running || nothing }, 'Publicar atualização');
  publish.addEventListener('click', () => deployAction('/api/deploy', { notify: notify.checked },
    'Publicar agora? O painel roda os testes, faz backup, guarda a versão atual e reinicia o Muvuca (quem estiver conectado cai por uns 10 segundos e volta sozinho). Se não subir, volta sozinho para a versão anterior.'));
  const fileList = (items, empty) => (items.length ? h('div', { class: 'mono small' }, items.slice(0, 40).map((x) => h('div', {}, `${x.kind === 'novo' ? '+' : x.kind === 'removido' ? '−' : '~'} ${x.file}`)),
    items.length > 40 ? h('div', { class: 'muted' }, `… e mais ${items.length - 40}`) : null) : h('p', { class: 'empty' }, empty));
  const top = h('div', { class: 'card' },
    h('div', { class: 'row' }, h('h2', {}, 'O que vai ao ar'), h('span', { class: 'spacer' }), h('label', { class: 'row small' }, notify, 'Avisar o pessoal 1 minuto antes'), publish),
    d.inUse.length && (p.server.length || !p.hasBaseline) ? h('div', { class: 'alert warn' }, `Agora tem gente usando: ${d.inUse.join(', ')}. A atualização derruba a call por uns 10 segundos.`) : null,
    p.hasBaseline && p.site.length && !p.server.length ? h('div', { class: 'alert good' }, 'Só o site mudou: publica sem reiniciar o Muvuca (ninguém cai da call).') : null,
    !p.hasBaseline ? h('p', { class: 'muted small' }, 'Primeira atualização pelo painel: a versão que está no ar hoje será guardada a partir do último commit do git, e tudo que mudou depois dele entra como novidade.') : null,
    h('div', { class: 'grid two section' },
      h('div', {}, h('b', {}, `Site (${p.site.length})`), h('p', { class: 'muted small' }, 'Diferenças entre public_next (preparado) e public (no ar)'), fileList(p.site, 'Nada novo no site.')),
      h('div', {}, h('b', {}, `Servidor (${p.server.length})`), h('p', { class: 'muted small' }, p.hasBaseline ? 'Arquivos do servidor alterados desde a versão no ar' : 'Será calculado na primeira atualização'), fileList(p.server, p.hasBaseline ? 'Nada novo no servidor.' : '—'))),
    h('p', { class: 'muted small' }, 'Sempre: testes automáticos → backup do banco → guarda a versão atual → publica → reinicia → confere. Se o Muvuca não voltar em 60 s, volta sozinho para a versão anterior. O banco de dados não volta junto com a versão (o backup fica guardado).'));

  const jobCard = d.job ? h('div', { class: 'card section' },
    h('div', { class: 'row' }, h('h2', {}, d.job.kind === 'voltar' ? 'Voltando de versão' : 'Atualização'),
      h('span', { class: `pill ${running ? 'warn' : d.job.ok ? 'good' : 'bad'}` }, running ? 'em andamento…' : d.job.ok ? 'concluída' : 'não concluída'),
      h('span', { class: 'muted small' }, when(d.job.startedAt))),
    h('pre', { class: 'log' }, d.job.log.join('\n') || 'Começando…')) : null;

  const versions = h('div', { class: 'card section' }, h('h2', {}, 'Versões guardadas'),
    h('p', { class: 'muted small' }, 'As 15 mais recentes. "Voltar" guarda antes a versão atual, então sempre dá para desfazer.'),
    table([
      { label: 'Versão', get: (r) => h('span', {}, h('span', { class: 'mono' }, r.id), r.id === d.live ? h('span', { class: 'pill good', style: 'margin-left:6px' }, 'no ar') : null) },
      { label: 'Tipo', get: (r) => KIND_REL[r.kind] ?? r.kind },
      { label: 'Commit', get: (r) => (r.commit ? h('span', { class: 'small', title: r.commit.subject }, h('span', { class: 'mono' }, r.commit.hash), ` ${r.commit.subject.slice(0, 60)}${r.commit.subject.length > 60 ? '…' : ''}`) : '—') },
      { label: 'Detalhe', get: (r) => h('span', { class: 'muted small' }, r.note ?? '') },
      { label: '', get: (r) => (r.id !== d.live && r.hasFile ? h('button', { class: 'btn small', disabled: running, onclick: () => deployAction('/api/rollback', { id: r.id }, `Voltar o Muvuca para a versão ${r.id}? A versão atual fica guardada, e o Muvuca reinicia (uns 10 segundos).`) }, 'Voltar para esta') : null) },
    ], d.releases, { empty: 'Nenhuma versão guardada ainda: a primeira é guardada na primeira atualização.' }));
  return h('div', {}, top, jobCard, versions);
}

// ---------- XP e níveis ----------
let xpFilter = '';
function xpBar(info) {
  const bar = h('div', { class: 'bar', title: `${num(info.into)} / ${num(info.need)} XP para o nível ${info.level + 1}` }, h('span', { style: `width:${Math.round((info.into / info.need) * 100)}%` }));
  return h('div', { style: 'min-width:120px' }, bar, h('div', { class: 'muted small' }, `${num(info.into)} / ${num(info.need)}`));
}

async function xpAdjust(u) {
  const raw = prompt(`Dar ou tirar XP de @${u.username} (tem ${num(u.xp)} XP, nível ${u.info.level}).\nDigite um número: 500 dá, -500 tira.`, '');
  if (raw === null) return;
  const amount = Math.trunc(Number(String(raw).replace(/\./g, '').replace(',', '.')));
  if (!amount) return toast('Digite um número diferente de zero.');
  const reason = prompt('Motivo (opcional, fica na auditoria):', '');
  if (reason === null) return;
  await act('/api/xp/adjust', { id: u.id, amount, reason }, { reload: 'xp' });
}

async function viewXp() {
  const d = await api('/api/xp');
  if (!d.ready) return h('p', { class: 'error' }, 'O XP ainda não está ativo no Muvuca (atualize o Muvuca na aba Atualizar).');
  const r = d.rules;
  const input = h('input', { type: 'search', placeholder: 'Buscar pessoa…', value: xpFilter });
  const body = h('div');
  const render = () => {
    const q = xpFilter.toLowerCase();
    const rows = d.users.filter((u) => !q || u.username.toLowerCase().includes(q) || (u.name ?? '').toLowerCase().includes(q));
    body.replaceChildren(table([
      { label: '#', num: true, get: (u) => h('b', {}, u.rank) },
      { label: 'Pessoa', get: (u) => h('span', {}, h('b', {}, u.name), ' ', h('span', { class: 'muted small' }, `@${u.username}`), u.blocked_at ? h('span', { class: 'pill bad', style: 'margin-left:6px' }, 'bloqueada') : null) },
      { label: 'Nível', num: true, get: (u) => h('b', { style: 'font-size:16px' }, u.info.level) },
      { label: 'XP total', num: true, get: (u) => num(u.xp) },
      { label: 'Progresso', get: (u) => xpBar(u.info) },
      { label: '24 h', num: true, get: (u) => (u.day ? `+${num(u.day)}` : '—') },
      { label: '7 dias', num: true, get: (u) => (u.week ? h('span', { title: Object.entries(u.weekBy).map(([k, v]) => `${k}: ${num(v)}`).join('\n') }, `+${num(u.week)}`, h('div', { class: 'muted small' }, Object.entries(u.weekBy).map(([k, v]) => `${k} ${num(v)}`).join(' · '))) : '—') },
      { label: '', get: (u) => h('div', { class: 'row', style: 'flex-wrap:nowrap' },
        h('button', { class: 'btn small ghost', onclick: () => xpAdjust(u) }, 'Dar/tirar XP'),
        u.xp ? h('button', { class: 'btn small ghost', onclick: () => act('/api/xp/adjust', { id: u.id, reset: true }, { confirmText: `Zerar o XP de @${u.username}? Ela volta ao nível 0 (tem ${num(u.xp)} XP).`, askReason: 'Motivo (opcional):', reload: 'xp' }) }, 'Zerar') : null) },
    ], rows, { empty: 'Ninguém encontrado.' }));
  };
  input.addEventListener('input', () => { xpFilter = input.value; render(); });
  render();
  const weekTotal = Object.values(d.week).reduce((a, b) => a + b, 0);
  return h('div', {},
    h('div', { class: 'grid cards' },
      stat('XP dado em 7 dias', num(weekTotal), 'para todo mundo'),
      Object.entries(d.week).map(([k, v]) => stat(`Por ${k}`, num(v), weekTotal ? `${Math.round((v / weekTotal) * 100)}% do total` : '')),
      stat('Maior nível', d.users[0] ? `${d.users[0].info.level}` : '—', d.users[0] ? `@${d.users[0].username}` : ''),
    ),
    h('div', { class: 'section card' }, h('div', { class: 'row' }, h('h2', {}, 'Ranking'), h('span', { class: 'spacer' }), input),
      h('p', { class: 'muted small' }, 'XP é da conta (vale em todos os servidores). "Dar/tirar" e "Zerar" avisam a pessoa na hora e ficam na Auditoria.'), body),
    h('div', { class: 'section grid two' },
      h('div', { class: 'card' }, h('h2', {}, 'Como se ganha XP'), table([{ label: '', get: (x) => x[0] }, { label: '', get: (x) => h('b', {}, x[1]) }], [
        ['Mensagem (com conteúdo)', `${r.message.min} a ${r.message.max} XP, no máximo 1 a cada ${Math.round(r.message.cooldownMs / 60000)} min (mínimo de ${r.message.minChars} caracteres)`],
        ['Tempo em call', `${r.voicePerMinute} XP por minuto (com mais alguém na call, sem estar ensurdecido)`],
        ['Partida com 2+ pessoas', `${r.gamePlayed} XP (+${r.gameWon} para quem vence)`],
      ])),
      h('div', { class: 'card' }, h('h2', {}, 'Curva de níveis'), table([
        { label: 'Nível', num: true, get: (c) => c.level },
        { label: 'XP total', num: true, get: (c) => num(c.total) },
        { label: 'Só esse nível', num: true, get: (c) => num(c.step) },
      ], d.curve))));
}

start();
