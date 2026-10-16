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

// ---------- Tema (automático, claro ou escuro) ----------
// O theme-boot.js já aplicou a escolha antes de desenhar; aqui ficam os botões do pé da lateral.
const THEMES = [['auto', 'Auto'], ['light', 'Claro'], ['dark', 'Escuro']];
const currentTheme = () => { try { return localStorage.getItem('painel-tema') || 'auto'; } catch { return 'auto'; } };
const isDark = () => document.documentElement.dataset.theme === 'dark' || (document.documentElement.dataset.theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
function applyTheme(t) {
  if (t === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  try { if (t === 'auto') localStorage.removeItem('painel-tema'); else localStorage.setItem('painel-tema', t); } catch { /* sem armazenamento */ }
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', isDark() ? '#1e1f22' : '#eceef2');
  paintThemeSeg();
  if (!$('#app').hidden) openTab(tab); // os gráficos pegam as cores do tema ao desenhar
}
function paintThemeSeg() {
  const cur = currentTheme();
  $('#theme-seg').replaceChildren(...THEMES.map(([id, label]) => h('button', { type: 'button', class: id === cur ? 'on' : null, 'aria-pressed': String(id === cur), title: id === 'auto' ? 'Automático: segue o modo claro/escuro do aparelho' : `Painel sempre ${label.toLowerCase()}`, onclick: () => applyTheme(id) }, label)));
}
paintThemeSeg();
document.querySelector('meta[name="theme-color"]')?.setAttribute('content', isDark() ? '#1e1f22' : '#eceef2');
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (currentTheme() === 'auto' && !$('#app').hidden) openTab(tab); });

// ---------- Login ----------
function showLogin() {
  stopTimers();
  $('#app').hidden = true;
  $('#login').hidden = false;
  $('#login-user').focus();
  // Tem passkey cadastrada e o aparelho aceita: mostra "Entrar com Face ID / Touch ID"
  if (window.PublicKeyCredential) {
    fetch('/api/passkey/available').then((r) => r.json()).then((d) => { $('#login-passkey').hidden = !d.available; }).catch(() => {});
  }
}
$('#login-passkey').addEventListener('click', async () => {
  const btn = $('#login-passkey');
  btn.disabled = true;
  $('#login-error').textContent = '';
  try {
    const opts = await api('/api/passkey/login-options', { method: 'POST', body: {} });
    const cred = await navigator.credentials.get({ publicKey: { challenge: fromB64u(opts.challenge), rpId: opts.rpId, timeout: opts.timeout, userVerification: 'required', allowCredentials: [] } });
    await api('/api/passkey/login', { method: 'POST', body: {
      id: toB64u(cred.rawId), clientDataJSON: toB64u(cred.response.clientDataJSON),
      authenticatorData: toB64u(cred.response.authenticatorData), signature: toB64u(cred.response.signature),
    } });
    start();
  } catch (err) {
    $('#login-error').textContent = err.name === 'NotAllowedError' ? 'Cancelado.' : err.message;
  } finally { btn.disabled = false; }
});
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
// Cada aba da lateral (página) tem uma ou mais sub-abas. Os ids das sub-abas são os antigos endereços
// (#quedas, #backups…), então os links dos alertas no celular continuam abrindo o lugar certo.
const TABS = {
  geral: ['Agora', viewGeral, 5000],
  sistema: ['Sistema', viewSistema, 30000],
  resumo: ['Resumo da semana', viewResumo, 300000],
  aovivo: ['Ao vivo', viewAoVivo, 5000],
  usuarios: ['Contas', viewUsuarios, 30000],
  convites: ['Convites', viewConvites, 60000],
  servidores: ['Servidores', viewServidores, 30000],
  mensagens: ['Mensagens', viewMensagens, 0],
  arquivos: ['Arquivos pesados', viewArquivos, 60000],
  auditoria: ['Auditoria', viewAuditoria, 0],
  acessos: ['Acessos ao site', viewAcessos, 60000],
  ips: ['IPs bloqueados', viewIps, 60000],
  internet: ['Internet', viewInternet, 4000],
  quedas: ['Quedas', viewQuedas, 30000],
  atualizar: ['Atualizar o Muvuca', viewAtualizar, 4000],
  backups: ['Backups', viewBackups, 60000],
  manut: ['Manutenção e reiniciar', viewManutencao, 30000],
  logs: ['Logs', viewLogs, 0],
  erros: ['Erros do site', viewErros, 30000],
  seguranca: ['Login (Face ID / Touch ID)', viewSeguranca, 0],
  alertas: ['Alertas no celular', viewAlertas, 0],
  aparelhos: ['Aparelhos conectados', viewAparelhos, 30000],
};
const PAGES = {
  geral: ['Visão geral', ['geral', 'sistema', 'resumo']],
  aovivo: ['Ao vivo', ['aovivo']],
  pessoas: ['Pessoas', ['usuarios', 'convites']],
  servidoresPg: ['Servidores', ['servidores']],
  conteudo: ['Conteúdo', ['mensagens', 'arquivos']],
  protecao: ['Segurança', ['auditoria', 'acessos', 'ips']],
  conexao: ['Conexão', ['internet', 'quedas']],
  manutencao: ['Manutenção', ['atualizar', 'backups', 'manut']],
  logs: ['Logs', ['logs', 'erros']],
  config: ['Configurações do painel', ['seguranca', 'alertas', 'aparelhos']],
};
const pageOf = (sub) => Object.keys(PAGES).find((p) => PAGES[p][1].includes(sub));
let tab = 'geral';
let timer = null;
let status = null;
const stopTimers = () => { clearInterval(timer); timer = null; };

// Lateral: uma linha por página (com a bolinha de pendências); no celular, a mesma lista num seletor
const tabSelect = $('#tab-select');
for (const [id, [label]] of Object.entries(PAGES)) {
  $('#side-pages').append(h('button', { 'data-page': id, onclick: () => openTab(id) }, h('span', {}, label), h('span', { class: 'side-badge', hidden: true })));
  tabSelect.append(h('option', { value: id }, label));
}
tabSelect.addEventListener('change', () => openTab(tabSelect.value));

// Última sub-aba usada em cada página (volta nela ao clicar na página)
let lastSub = {};
try { lastSub = JSON.parse(localStorage.getItem('painel-subabas') || '{}'); } catch { /* sem armazenamento */ }

// name: uma sub-aba (ex.: 'quedas') ou uma página (ex.: 'conexao', abre a última sub-aba usada nela)
function openTab(name) {
  if (!TABS[name]) name = PAGES[name] ? (PAGES[name][1].includes(lastSub[name]) ? lastSub[name] : PAGES[name][1][0]) : 'geral';
  tab = name;
  const page = pageOf(tab);
  lastSub[page] = tab;
  try { localStorage.setItem('painel-tab', tab); localStorage.setItem('painel-subabas', JSON.stringify(lastSub)); } catch { /* sem armazenamento */ }
  document.querySelectorAll('.side button[data-page]').forEach((b) => b.classList.toggle('on', b.dataset.page === page));
  tabSelect.value = page;
  const [pageTitle, subs] = PAGES[page];
  $('#title').textContent = pageTitle;
  $('#subtabs').replaceChildren(...(subs.length > 1 ? subs.map((id) => h('button', { class: id === tab ? 'on' : null, onclick: () => openTab(id) }, TABS[id][0])) : []));
  $('#subtabs').hidden = subs.length < 2;
  const [, fn, every] = TABS[tab];
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
  const fromLink = location.hash.slice(1); // alerta tocado no celular: abre a aba certa (#quedas, #backups…)
  if (TABS[fromLink] || PAGES[fromLink]) { saved = fromLink; history.replaceState(null, '', '/'); }
  openTab(saved);
  refreshTop();
  setInterval(refreshTop, 15000);
}

async function refreshTop() {
  if ($('#app').hidden) return;
  refreshAttention();
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

// ---------- Busca única (topo) ----------
// Digita um nome, @usuário, IP ou trecho de mensagem: pessoas abrem o cartão, IPs abrem a Auditoria
// filtrada, mensagens abrem Conteúdo → Mensagens com a busca. Ctrl+K (ou /) foca a busca.
const buscaInput = $('#busca');
buscaInput.placeholder = 'Buscar pessoa, servidor, #canal, IP ou mensagem… (Ctrl+K)';
const buscaRes = $('#busca-res');
let buscaTimer = null;
let buscaSeq = 0;
const fecharBusca = () => { buscaRes.hidden = true; };
function buscaGo(fn) { fecharBusca(); buscaInput.blur(); fn(); }
async function buscar() {
  const q = buscaInput.value.trim();
  if (q.length < 2) return fecharBusca();
  const seq = ++buscaSeq;
  let d;
  try { d = await api(`/api/busca?q=${encodeURIComponent(q)}`); } catch { return; }
  if (seq !== buscaSeq) return; // chegou resposta de uma busca antiga
  const item = (onPick, ...kids) => h('button', { class: 'busca-item', type: 'button', onclick: () => buscaGo(onPick) }, ...kids);
  const sec = (title, rows) => (rows.length ? [h('div', { class: 'busca-sec' }, title), ...rows] : []);
  const rows = [
    ...sec('Pessoas', d.users.map((u) => item(() => openPessoa(u.id), h('b', {}, u.name), h('span', { class: 'muted small' }, ` @${u.username}`), u.online ? h('span', { class: 'pill good' }, 'online') : null))),
    ...sec('Servidores', (d.servers ?? []).map((sv) => item(() => openServerDetail(sv.id), h('b', {}, sv.name)))),
    ...sec('Canais', (d.channels ?? []).map((c) => item(() => openServerDetail(c.server_id), h('b', {}, `${{ text: '#', voice: '🔊', music: '🎵' }[c.type] ?? '#'}${c.name}`), h('span', { class: 'muted small' }, ` · ${c.server}`)))),
    ...sec('IPs', d.ips.map((r) => item(() => { auditFilters = { ip: r.ip }; openTab('auditoria'); }, h('span', { class: 'mono' }, r.ip), h('span', { class: 'muted small' }, ` · ${r.who.join(', ') || 'sem conta'} · ${ago(r.last)}`)))),
    ...sec('Mensagens', d.messages.map((m) => item(() => { msgQuery = { q, user: '' }; openTab('mensagens'); }, h('b', {}, m.name ?? '?'), h('span', { class: 'muted small' }, ` · ${m.where}`), h('div', { class: 'busca-trecho' }, (m.text || '📎 anexo').slice(0, 120))))),
  ];
  if (d.messages.length) rows.push(item(() => { msgQuery = { q, user: '' }; openTab('mensagens'); }, h('span', { class: 'muted' }, `Ver todas as mensagens com "${q}" →`)));
  buscaRes.replaceChildren(...(rows.length ? rows : [h('p', { class: 'empty' }, 'Nada encontrado.')]));
  buscaRes.hidden = false;
}
buscaInput.addEventListener('input', () => { clearTimeout(buscaTimer); buscaTimer = setTimeout(buscar, 250); });
buscaInput.addEventListener('focus', () => { if (buscaRes.childElementCount && buscaInput.value.trim().length >= 2) buscaRes.hidden = false; });
buscaInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { fecharBusca(); buscaInput.blur(); }
  if (e.key === 'Enter') { e.preventDefault(); buscaRes.querySelector('.busca-item')?.click(); }
  if (e.key === 'ArrowDown') { e.preventDefault(); buscaRes.querySelector('.busca-item')?.focus(); }
});
buscaRes.addEventListener('keydown', (e) => {
  const items = [...buscaRes.querySelectorAll('.busca-item')];
  const i = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown') { e.preventDefault(); items[Math.min(items.length - 1, i + 1)]?.focus(); }
  if (e.key === 'ArrowUp') { e.preventDefault(); (i <= 0 ? buscaInput : items[i - 1]).focus(); }
  if (e.key === 'Escape') { fecharBusca(); buscaInput.focus(); }
});
document.addEventListener('click', (e) => { if (!e.target.closest('.top-search')) fecharBusca(); });
document.addEventListener('keydown', (e) => {
  const typing = /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName ?? '');
  if (((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') || (e.key === '/' && !typing)) {
    if ($('#app').hidden) return;
    e.preventDefault();
    buscaInput.focus();
    buscaInput.select();
  }
});

// ---------- Precisa de atenção ----------
// A lista vem do painel (/api/atencao): o que pede ação agora e em qual sub-aba se resolve.
// Também vira a bolinha com o número de pendências ao lado de cada aba da lateral.
let attentionItems = [];
function paintBadges() {
  for (const b of document.querySelectorAll('.side button[data-page]')) {
    const mine = attentionItems.filter((i) => pageOf(i.tab) === b.dataset.page);
    const badge = b.querySelector('.side-badge');
    badge.hidden = !mine.length;
    badge.textContent = mine.length;
    badge.className = `side-badge ${mine.some((i) => i.level === 'bad') ? 'bad' : mine.some((i) => i.level === 'warn') ? '' : 'info'}`;
    b.title = mine.map((i) => i.text).join('\n');
    // No celular (lista em vez da lateral): o número vai junto do nome
    const opt = tabSelect.querySelector(`option[value="${b.dataset.page}"]`);
    if (opt) opt.textContent = `${PAGES[b.dataset.page][0]}${mine.length ? ` (${mine.length})` : ''}`;
  }
}
async function refreshAttention() {
  try { attentionItems = (await api('/api/atencao')).items; } catch { return attentionItems; }
  paintBadges();
  return attentionItems;
}

function attentionCard(items) {
  return h('div', { class: 'card attention' },
    h('h2', {}, 'Precisa de atenção'),
    items.length
      ? h('div', { class: 'alerts' }, items.map((i) => h('button', { class: `alert ${i.level} alert-link`, onclick: () => openTab(i.tab) },
        h('span', {}, i.text), h('span', { class: 'alert-go' }, `${TABS[i.tab]?.[0] ?? 'Abrir'} →`))))
      : h('div', { class: 'alert good' }, 'Tudo certo ✅ Nada pedindo ação agora.'));
}

// Ações rápidas (as mesmas de Manutenção, para uma emergência pelo celular)
async function backupNow(btn) {
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = 'Fazendo backup…';
  try {
    const r = await api('/api/backup', { method: 'POST' });
    toast(r.output || (r.ok ? 'Backup feito.' : 'O backup falhou.'), 8000);
  } catch (err) { toast(err.message); } finally { btn.disabled = false; btn.textContent = label; refreshAttention(); }
}
function quickActions(mt) {
  const restart = h('button', { class: 'btn danger' }, 'Reiniciar o Muvuca');
  restart.addEventListener('click', () => restartMuvuca(restart));
  const backup = h('button', { class: 'btn' }, 'Fazer backup agora');
  backup.addEventListener('click', () => backupNow(backup));
  const maint = mt.on
    ? h('button', { class: 'btn', onclick: () => act('/api/maintenance', { on: false }, { reload: 'geral' }) }, 'Desligar manutenção')
    : h('button', { class: 'btn', onclick: () => act('/api/maintenance', { on: true, message: 'O Muvuca vai reiniciar para uma atualização. Volta em instantes!', minutes: 0, lock: false },
      { confirmText: 'Ligar o aviso de manutenção no topo do Muvuca para todo mundo? (Mais opções em Manutenção.)', reload: 'geral' }) }, 'Ligar aviso de manutenção');
  const reload = h('button', { class: 'btn', onclick: reloadAll }, 'Recarregar o site de todos');
  return h('div', { class: 'card row quick' }, h('b', {}, 'Ações rápidas'), h('span', { class: 'spacer' }), backup, reload, maint, restart);
}

// Ação com confirmação (e motivo opcional) que chama o painel e mostra o resultado
async function act(path, body, { confirmText, askReason, reload } = {}) {
  if (confirmText && !confirm(confirmText)) return;
  if (askReason) {
    const reason = prompt(askReason, '');
    if (reason === null) return;
    body = { ...body, reason };
  }
  let ok = false;
  try {
    const r = await api(path, { method: 'POST', body });
    toast(r.message ?? 'Feito.', 5000);
    ok = true;
  } catch (err) { toast(err.message, 6000); }
  if (reload) openTab(reload);
  return ok;
}
const ipBlockButton = (ip, reload) => (ip ? h('button', { class: 'btn small ghost', title: `Bloquear ${ip}`, onclick: (e) => { e.stopPropagation(); act('/api/ips/block', { ip, block: true }, { confirmText: `Bloquear o IP ${ip}? Ele não vai conseguir abrir o Muvuca nem entrar nas calls.`, askReason: 'Motivo (opcional):', reload }); } }, 'Bloquear IP') : null);

// ---------- Visão geral ----------
let range = 1;
async function viewGeral(first) {
  const [s, ov, hist, items, mt] = await Promise.all([api('/api/status'), api('/api/overview'), api(`/api/history?hours=${range}`), refreshAttention(), api('/api/maintenance')]);
  status = s;
  const m = s.main ?? {};
  const inVoice = (m.voice ?? []).reduce((n, v) => n + v.count, 0);
  const lives = (m.voice ?? []).reduce((n, v) => n + (v.people ?? []).filter((p) => p.streaming).length, 0);
  const memPct = s.mem ? (s.mem.used / s.mem.total) * 100 : 0;
  const diskPct = s.disk ? (1 - s.disk.free / s.disk.total) * 100 : 0;

  const times = hist.map((p) => p.t);
  const rangeSel = h('div', { class: 'row' }, h('span', { class: 'muted small' }, 'Período:'),
    [1, 6, 24].map((hr) => h('button', { class: `btn small ${hr === range ? 'primary' : ''}`, onclick: () => { range = hr; openTab('geral'); } }, `${hr} h`)));

  const maxDay = Math.max(1, ...ov.perDay.map((d) => d.n));
  const days = Array.from({ length: 14 }, (_, i) => ov.perDay.find((d) => d.d === i)?.n ?? 0);

  return h('div', {},
    attentionCard(items),
    h('div', { class: 'section' }, quickActions(mt)),
    h('div', { class: 'section grid cards' },
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
    { label: '', get: (r) => ({
      muvuca: h('button', { class: 'btn small ghost', onclick: reloadAll, title: 'Faz todas as abas e apps recarregarem a página' }, 'Recarregar o site de todos'),
      livekit: h('button', { class: 'btn small ghost', onclick: restartVoice, title: 'Reinicia só a voz; as calls voltam sozinhas' }, 'Reiniciar só a voz'),
      start: h('button', { class: 'btn small ghost', onclick: () => openTab('manut'), title: 'Reiniciar, desligar ou ligar o Muvuca' }, 'Reiniciar/desligar…'),
    }[r.k] ?? null) },
  ], rows);
}

// Qualidade de cada pessoa em call (relatório que o próprio site dela manda a cada 10 s)
const NET_Q = { excellent: ['good', 'excelente'], good: ['good', 'boa'], poor: ['warn', 'ruim'], lost: ['bad', 'caindo'], unknown: ['', '?'] };
const LIMIT = { bandwidth: 'internet de quem transmite', cpu: 'processador de quem transmite', other: 'outro motivo' };
function voicePeopleTable(people) {
  return h('div', { class: 'section' }, table([
    { label: 'Pessoa', get: (p) => h('span', {}, h('b', {}, p.name), h('span', { class: 'muted small' }, p.deafened ? ' · 🔇 sem som' : p.muted ? ' · 🎙️ mudo' : '')) },
    { label: 'Conexão', get: (p) => { const [k, t] = NET_Q[p.net?.q ?? 'unknown'] ?? NET_Q.unknown; return p.net ? h('span', { class: `pill ${k}` }, t) : h('span', { class: 'muted small', title: 'Sem relatório: site antigo aberto (recarregar) ou acabou de entrar' }, '—'); } },
    { label: 'Microfone', get: (p) => {
      const mic = p.net?.mic;
      if (!mic) return h('span', { class: 'muted small' }, '—');
      if (!mic.on) return h('span', { class: 'muted small' }, 'desligado');
      const silent = mic.peak !== null && mic.peak < 0.003;
      return h('span', { class: `small ${silent ? 'error' : ''}`, title: 'Volume = o maior captado nos últimos 10 s' },
        `${mic.kbps ?? '?'} kbps · volume ${mic.peak === null ? '?' : `${Math.round(mic.peak * 100)}%`}`, silent ? h('div', {}, 'captando silêncio (permissão do sistema? microfone errado?)') : null);
    } },
    { label: 'Enviando', get: (p) => (p.net?.pub?.length ? h('div', {}, p.net.pub.map((x) => h('div', { class: 'small' },
      x.src === 'screen' ? '🔴 live ' : '📷 câmera ', h('b', {}, x.w ? `${x.w}×${x.h}` : '?'), ` · ${x.fps} fps${x.kbps != null ? ` · ${mbpsText(x.kbps)}` : ''}${x.rtt != null ? ` · ${x.rtt} ms` : ''}`,
      x.limit ? h('div', { class: 'error small' }, `limitado pelo ${LIMIT[x.limit]}`) : null))) : h('span', { class: 'muted small' }, p.streaming || p.camera ? 'sem dados ainda' : 'só voz')) },
    { label: 'Recebendo', get: (p) => (p.net?.rx ? h('span', { class: `small ${p.net.rx.loss >= 5 ? 'error' : ''}` },
      `${mbpsText(p.net.rx.kbps)} · perda ${String(p.net.rx.loss ?? 0).replace('.', ',')}%${p.net.rx.jitter != null ? ` · oscilação ${p.net.rx.jitter} ms` : ''}${p.net.heard != null ? ` · volume ouvido ${Math.round(p.net.heard * 100)}%` : ''}`) : '—') },
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
          { label: 'Pessoa', get: (u) => personLink(u.id, h('b', {}, u.name), h('span', { class: 'muted small' }, ` @${u.username}`)) },
          { label: 'Status', get: (u) => { const [k, t] = statusLabel[u.status] ?? ['', u.status]; return h('span', { class: `pill ${k}` }, t); } },
          { label: 'Onde', get: (u) => h('div', { class: 'clients' }, (u.clients ?? []).map((c) => h('div', {}, clientLabel(c, s.desktopLatest)))) },
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
    h('p', { class: 'muted small' }, `IP bloqueado não abre nada do Muvuca (site, app, calls). Seu IP agora: ${d.you}. Dá para bloquear também em Ao vivo e em Acessos ao site.`),
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
      { label: 'Pessoa', get: (u) => personLink(u.id, h('b', {}, u.name), h('span', { class: 'muted small' }, ` @${u.username}`)) },
      { label: 'Agora', get: (u) => h('span', { class: `pill ${u.online ? 'good' : ''}` }, u.online ? 'online' : ago(u.last_seen)) },
      { label: 'Conta criada', get: (u) => when(u.created_at) },
      { label: 'Último login', get: (u) => h('span', {}, u.lastLogin ? ago(u.lastLogin) : '—', u.lastIp ? h('div', { class: 'mono muted' }, u.lastIp) : null) },
      { label: 'Aparelhos', num: true, get: (u) => u.sessions },
      { label: 'Mensagens', num: true, get: (u) => num(u.messages) },
      { label: 'Anexos', num: true, get: (u) => bytes(u.bytes) },
      { label: 'Servidores', num: true, get: (u) => u.servers },
      { label: 'Senha errada (7 d)', num: true, get: (u) => (u.fails7 ? h('span', { class: `pill ${u.fails7 >= 5 ? 'bad' : 'warn'}` }, u.fails7) : '0') },
      { label: '', get: (u) => h('div', { class: 'row', style: 'flex-wrap:nowrap' },
        u.blocked_at ? h('span', { class: 'pill bad', title: u.blocked_reason ?? '' }, 'bloqueada') : null,
        u.must_change ? h('span', { class: 'pill warn', title: 'Entrou com senha temporária ainda não trocada' }, 'senha temporária') : null,
        h('button', { class: 'btn small ghost', onclick: () => { auditFilters = { user: u.username }; openTab('auditoria'); } }, 'Auditoria'),
        !u.blocked_at && (u.sessions || u.online) ? h('button', { class: 'btn small ghost', onclick: () => act('/api/users/disconnect', { id: u.id }, { confirmText: `Desconectar @${u.username} de todos os aparelhos? Ela precisa entrar de novo com a senha.`, reload: 'usuarios' }) }, 'Desconectar') : null,
        u.blocked_at
          ? h('button', { class: 'btn small', onclick: () => act('/api/users/block', { id: u.id, block: false }, { confirmText: `Desbloquear @${u.username}?`, reload: 'usuarios' }) }, 'Desbloquear')
          : h('button', { class: 'btn small ghost', onclick: () => act('/api/users/block', { id: u.id, block: true }, { confirmText: `Bloquear @${u.username}? A conta sai de todos os aparelhos e não consegue mais entrar até ser desbloqueada.`, askReason: 'Motivo (opcional, fica na auditoria):', reload: 'usuarios' }) }, 'Bloquear'),
        h('button', { class: 'btn small ghost', onclick: () => resetPasswordFor(u) }, 'Nova senha'),
        u.home_owner ? null : h('button', { class: 'btn small danger-ghost', onclick: () => deleteAccountOf(u) }, 'Excluir')) },
    ], rows, { empty: 'Nenhuma conta encontrada.', rowClass: (u) => (u.blocked_at ? 'fail' : null) }));
  };
  input.addEventListener('input', () => { userFilter = input.value; render(); });
  render();
  box.append(h('div', { class: 'row' }, h('h2', {}, `${users.length} contas`), h('span', { class: 'spacer' }), input,
    h('a', { class: 'btn small', href: '/api/users.csv', title: 'Baixar a lista de contas (abre no Excel/Numbers)' }, 'Exportar planilha')), body);
  return box;
}

async function viewIps() { return ipsCard(); }

// Senha temporária: você escolhe (ou usa a sugerida), passa para a pessoa, e ela troca no primeiro login
function resetPasswordFor(u) {
  const words = ['sol', 'lua', 'mar', 'rio', 'gato', 'bola', 'pipa', 'vento', 'nuvem', 'festa', 'jogo', 'som'];
  const pick = () => words[crypto.getRandomValues(new Uint32Array(1))[0] % words.length];
  const suggestion = `${pick()}-${pick()}-${String(crypto.getRandomValues(new Uint32Array(1))[0] % 900 + 100)}`;
  const password = prompt(`Senha temporária para @${u.username} (pelo menos 6 caracteres).\n\nA pessoa sai de todos os aparelhos agora, entra com esta senha e escolhe a nova na hora.`, suggestion);
  if (password === null) return;
  if (password.trim().length < 6) return toast('A senha temporária precisa ter pelo menos 6 caracteres.', 5000);
  closePessoa();
  act('/api/users/reset-password', { id: u.id, password: password.trim() }, { reload: tab });
}

// Excluir a conta: pede o @ de novo (não dá para desfazer)
function deleteAccountOf(u) {
  const typed = prompt(`EXCLUIR a conta @${u.username} (${u.name})?\n\nApaga para sempre: as mensagens dela (em servidores e conversas privadas), anexos, foto, banner e amizades. Servidores que ela criou passam para o membro mais antigo (ou somem, se só ela estava lá). Não dá para desfazer (só voltando um backup).\n\nPara confirmar, digite o usuário dela:`, '');
  if (typed === null) return;
  closePessoa();
  act('/api/users/delete', { id: u.id, confirm: typed }, { reload: tab });
}

// ---------- Servidores ----------
// Lista (um cartão por servidor) e, ao clicar, tudo do servidor: canais, membros, cargos, convites e
// movimento, com as ações de renomear, passar a posse e excluir (pelo Muvuca, fica na auditoria).
let serverSel = null;
function openServerDetail(id) { serverSel = id; openTab('servidores'); }
const serverIcon = (sv, size = 40) => (sv.icon
  ? h('img', { class: 'sv-icon', src: `/api/img?id=${encodeURIComponent(sv.icon)}`, alt: '', width: size, height: size })
  : h('span', { class: 'sv-icon sv-initials', style: `background:${sv.color ?? '#5865f2'};width:${size}px;height:${size}px` }, sv.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase()));

async function viewServidores() {
  if (serverSel) return serverDetailView(serverSel);
  const list = await api('/api/servers');
  if (!list.length) return h('p', { class: 'empty' }, 'Nenhum servidor ainda.');
  return h('div', {},
    h('p', { class: 'muted small' }, 'Servidores criados no Muvuca (conversas privadas não aparecem aqui). Clique para ver tudo de um servidor.'),
    h('div', { class: 'grid sv-grid' }, list.map((sv) => h('button', { class: 'card sv-card', onclick: () => openServerDetail(sv.id) },
      h('div', { class: 'row' }, serverIcon(sv), h('div', {}, h('b', { class: 'sv-name' }, sv.name),
        h('div', { class: 'muted small' }, sv.owner ? `dono: @${sv.owner.username}` : h('span', { class: 'error' }, 'sem dono'))),
        h('span', { class: 'spacer' }), sv.home ? h('span', { class: 'pill' }, 'principal') : null),
      h('div', { class: 'sv-stats' },
        h('span', {}, h('b', {}, num(sv.members)), ' membros'), h('span', {}, h('b', {}, num(sv.online)), ' online'),
        sv.inCall ? h('span', { class: 'pill good' }, `${sv.inCall} em call`) : null),
      h('div', { class: 'muted small' }, `${sv.channels.text} texto · ${sv.channels.voice} voz · ${sv.channels.music} música · ${num(sv.msgs7)} mensagens em 7 dias · ${bytes(sv.bytes)} de anexos`),
      h('div', { class: 'muted small' }, `criado em ${when(sv.createdAt)}`)))));
}

async function serverDetailView(id) {
  let d;
  try { d = await api(`/api/server?id=${encodeURIComponent(id)}`); } catch (err) { serverSel = null; throw err; }
  const back = h('button', { class: 'btn small ghost', onclick: () => { serverSel = null; openTab('servidores'); } }, '← Todos os servidores');
  const typeIcon = { text: '#', voice: '🔊', music: '🎵' };
  const maxDay = Math.max(1, ...d.perDay);
  const top = [...d.channels].sort((a, b) => b.msgs7 - a.msgs7)[0];
  const rename = () => {
    const name = prompt('Novo nome do servidor:', d.name);
    if (name === null || !name.trim() || name.trim() === d.name) return;
    act('/api/server/rename', { id: d.id, name: name.trim() }, { reload: 'servidores' });
  };
  const transferSel = h('select', {}, h('option', { value: '' }, 'Escolha o novo dono…'),
    d.members.filter((m) => !m.owner).map((m) => h('option', { value: m.id }, `${m.name} (@${m.username})`)));
  const transfer = () => {
    const m = d.members.find((x) => String(x.id) === transferSel.value);
    if (!m) return toast('Escolha quem vai ser o novo dono.');
    act('/api/server/transfer', { id: d.id, userId: m.id }, { confirmText: `Passar a posse de "${d.name}" para ${m.name} (@${m.username})? ${d.owner ? `@${d.owner.username} continua no servidor, com os cargos que já tem.` : ''}`, reload: 'servidores' });
  };
  const remove = () => {
    const typed = prompt(`EXCLUIR o servidor "${d.name}"?\n\nApaga para sempre os canais, as mensagens, os emojis e os sons dele, e todo mundo sai. Não dá para desfazer (só voltando um backup).\n\nPara confirmar, digite o nome do servidor:`, '');
    if (typed === null) return;
    act('/api/server/delete', { id: d.id, confirm: typed }, {}).then((ok) => { if (ok) { serverSel = null; openTab('servidores'); } });
  };
  return h('div', {},
    h('div', { class: 'row' }, back),
    h('div', { class: 'card section row' }, serverIcon(d, 56),
      h('div', {}, h('h2', { class: 'sv-title' }, d.name, d.home ? h('span', { class: 'pill' }, 'principal') : null),
        h('div', { class: 'muted small' }, d.owner ? h('span', {}, 'dono: ', personLink(d.owner.id, h('b', {}, `${d.owner.name} (@${d.owner.username})`))) : h('span', { class: 'error' }, 'sem dono (a conta foi excluída)'),
          ` · criado em ${when(d.createdAt)} · ${num(d.members.length)} membros (${num(d.members.filter((m) => m.online).length)} online)`)),
      h('span', { class: 'spacer' }),
      h('div', { class: 'row' }, h('button', { class: 'btn small', onclick: rename }, 'Renomear'), transferSel, h('button', { class: 'btn small', onclick: transfer }, 'Passar a posse'),
        d.home ? null : h('button', { class: 'btn small danger-ghost', onclick: remove }, 'Excluir servidor'))),
    h('div', { class: 'section grid cards' },
      stat('Mensagens (7 dias)', num(d.channels.reduce((n, c) => n + c.msgs7, 0)), top?.msgs7 ? `mais movimentado: ${typeIcon[top.type]}${top.name}` : 'nenhuma ainda'),
      stat('Em call agora', num(d.channels.reduce((n, c) => n + c.inCall.length, 0)), d.channels.filter((c) => c.inCall.length).map((c) => c.name).join(', ') || 'ninguém'),
      stat('Anexos', bytes(d.bytes)),
      stat('Emojis e sons', `${num(d.emojis)} · ${num(d.sounds)}`, 'emojis próprios · sons do soundboard')),
    h('div', { class: 'section card' }, h('h2', {}, 'Mensagens por dia (14 dias)'),
      h('div', { class: 'bars' }, d.perDay.map((n) => h('div', { title: `${n} mensagens`, style: `height:${Math.max(2, (n / maxDay) * 100)}%` }))),
      h('div', { class: 'legend' }, h('span', {}, 'há 14 dias'), h('span', { class: 'spacer' }), h('span', {}, 'hoje'))),
    h('div', { class: 'section card' }, h('h2', {}, `Canais (${d.channels.length})`), table([
      { label: 'Canal', get: (c) => h('span', {}, h('b', {}, `${typeIcon[c.type]} ${c.name}`), c.category ? h('span', { class: 'muted small' }, ` · ${c.category}`) : null) },
      { label: 'Quem vê', get: (c) => (c.private ? h('span', { class: 'pill warn', title: 'Canal privado' }, `🔒 ${c.roles.join(', ') || 'só administradores'}`) : h('span', { class: 'muted small' }, 'todos')) },
      { label: 'Regras', get: (c) => [c.slowmode ? `modo lento ${c.slowmode} s` : null, c.userLimit ? `até ${c.userLimit} pessoas` : null].filter(Boolean).join(' · ') || '—' },
      { label: 'Mensagens (7 d)', num: true, get: (c) => (c.type === 'voice' ? '—' : num(c.msgs7)) },
      { label: 'Agora', get: (c) => (c.inCall.length ? h('span', { class: 'pill good' }, c.inCall.join(', ')) : '') },
      { label: '', get: (c) => (c.type === 'voice' ? null : h('a', { class: 'btn small ghost', href: `/api/channel.csv?id=${encodeURIComponent(c.id)}`, title: 'Baixar as mensagens deste canal (abre no Excel/Numbers)' }, 'Planilha')) },
    ], d.channels)),
    h('div', { class: 'section grid two' },
      h('div', { class: 'card' }, h('h2', {}, `Membros (${d.members.length})`), table([
        { label: 'Pessoa', get: (m) => personLink(m.id, h('b', {}, m.nick ?? m.name), h('span', { class: 'muted small' }, ` @${m.username}`)) },
        { label: 'Cargos', get: (m) => [m.owner ? h('span', { class: 'pill' }, 'dono') : null, ...m.roles.map((r) => h('span', { class: 'pill' }, r))] },
        { label: 'Entrou', get: (m) => when(m.joinedAt) },
        { label: '', get: (m) => (m.online ? h('span', { class: 'pill good' }, 'online') : '') },
      ], d.members)),
      h('div', { class: 'card' }, h('h2', {}, 'Cargos e permissões'),
        d.roles.map((r) => h('div', { class: 'sv-role' },
          h('div', {}, h('b', { style: r.color ? `color:${r.color}` : null }, r.name), h('span', { class: 'muted small' }, ` · ${num(r.count)} ${r.count === 1 ? 'pessoa' : 'pessoas'}`)),
          h('div', { class: 'muted small' }, r.perms.length ? r.perms.join(' · ') : 'sem permissões extras'))),
        h('h2', { class: 'section' }, `Convites valendo (${d.invites.length})`),
        table([
          { label: 'Código', get: (i) => h('span', { class: 'mono' }, i.code) },
          { label: 'Criado por', get: (i) => (i.username ? `@${i.username}` : '—') },
          { label: 'Usos', num: true, get: (i) => `${i.uses}${i.max_uses ? `/${i.max_uses}` : ''}` },
          { label: 'Vence', get: (i) => (i.expires_at ? when(i.expires_at) : 'nunca') },
        ], d.invites, { empty: 'Nenhum convite valendo (crie em Pessoas → Convites).' }))),
  );
}

// ---------- Cartão da pessoa ----------
// Clicar no nome de alguém (Contas, Ao vivo, Auditoria, Mensagens, busca) abre tudo da conta num lugar só,
// com as ações (desconectar, bloquear, nova senha, excluir). ref: id (12 ou "u12") ou @usuário.
const personLink = (ref, label, extra) => (ref ? h('button', { class: 'person-link', title: 'Abrir o cartão da pessoa', onclick: (e) => { e.stopPropagation(); openPessoa(ref); } }, label, extra ?? null) : h('b', {}, label));
let pessoaOverlay = null;
function closePessoa() { pessoaOverlay?.remove(); pessoaOverlay = null; }
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && pessoaOverlay) closePessoa(); });

async function openPessoa(ref) {
  closePessoa();
  const box = h('div', { class: 'pessoa-box', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Cartão da pessoa' }, h('p', { class: 'muted' }, 'Carregando…'));
  pessoaOverlay = h('div', { class: 'preview-overlay', onclick: (e) => { if (e.target === pessoaOverlay) closePessoa(); } }, box);
  document.body.append(pessoaOverlay);
  let d;
  const q = /^u?\d+$/.test(String(ref)) ? `id=${encodeURIComponent(ref)}` : `user=${encodeURIComponent(String(ref).replace(/^@/, ''))}`;
  try { d = await api(`/api/pessoa?${q}`); } catch (err) { box.replaceChildren(h('p', { class: 'error' }, err.message), h('button', { class: 'btn', onclick: closePessoa }, 'Fechar')); return; }
  const u = d.user;
  // Depois de uma ação: fecha o cartão e atualiza a aba aberta
  const doAct = (path, body, opts) => { closePessoa(); act(path, body, { ...opts, reload: tab }); };
  const fact = (label, value) => h('div', { class: 'fact' }, h('span', { class: 'muted small' }, label), h('b', {}, value));
  box.replaceChildren(
    h('div', { class: 'row' },
      h('div', {}, h('h2', { class: 'pessoa-nome' }, u.name), h('span', { class: 'muted' }, `@${u.username}`)),
      h('span', { class: `pill ${u.online ? 'good' : ''}` }, u.online ? 'online' : `visto ${ago(u.last_seen)}`),
      u.blocked_at ? h('span', { class: 'pill bad', title: u.blocked_reason ?? '' }, 'bloqueada') : null,
      u.must_change ? h('span', { class: 'pill warn' }, 'senha temporária') : null,
      u.home_owner ? h('span', { class: 'pill' }, 'dono do servidor principal') : null,
      h('span', { class: 'spacer' }), h('button', { class: 'btn ghost small', onclick: closePessoa, 'aria-label': 'Fechar' }, '✕')),
    h('div', { class: 'facts section' },
      fact('Mensagens', num(u.messages)), fact('Anexos', bytes(u.bytes)), fact('Servidores', num(u.servers)),
      fact('Aparelhos', num(u.sessions)), fact('Conta criada', when(u.created_at)),
      fact('Último login', u.lastLogin ? `${ago(u.lastLogin)}` : '—'), fact('Senha errada (7 d)', num(u.fails7))),
    h('div', { class: 'row section pessoa-acoes' },
      !u.blocked_at && (u.sessions || u.online) ? h('button', { class: 'btn small', onclick: () => doAct('/api/users/disconnect', { id: u.id }, { confirmText: `Desconectar @${u.username} de todos os aparelhos? Ela precisa entrar de novo com a senha.` }) }, 'Desconectar') : null,
      u.blocked_at
        ? h('button', { class: 'btn small', onclick: () => doAct('/api/users/block', { id: u.id, block: false }, { confirmText: `Desbloquear @${u.username}?` }) }, 'Desbloquear')
        : h('button', { class: 'btn small', onclick: () => doAct('/api/users/block', { id: u.id, block: true }, { confirmText: `Bloquear @${u.username}? A conta sai de todos os aparelhos e não consegue mais entrar até ser desbloqueada.`, askReason: 'Motivo (opcional, fica na auditoria):' }) }, 'Bloquear'),
      h('button', { class: 'btn small', onclick: () => resetPasswordFor(u) }, 'Nova senha'),
      h('button', { class: 'btn small', onclick: () => { closePessoa(); auditFilters = { user: u.username }; openTab('auditoria'); } }, 'Auditoria completa'),
      h('button', { class: 'btn small', onclick: () => { closePessoa(); msgQuery = { q: '', user: u.username }; openTab('mensagens'); } }, 'Todas as mensagens'),
      u.home_owner ? null : h('button', { class: 'btn small danger-ghost', onclick: () => deleteAccountOf(u) }, 'Excluir conta')),
    h('div', { class: 'grid two section' },
      h('div', {}, h('h3', {}, 'Servidores'), d.servers.length
        ? h('ul', { class: 'plain' }, d.servers.map((x) => h('li', {}, x.name, x.nick ? h('span', { class: 'muted small' }, ` (apelido: ${x.nick})`) : null, x.owner ? h('span', { class: 'pill' }, 'dono') : null)))
        : h('p', { class: 'empty' }, 'Em nenhum servidor.'),
      h('h3', { class: 'section' }, 'Uso nos últimos 7 dias'),
      h('ul', { class: 'plain' },
        h('li', {}, 'Tempo em call: ', h('b', {}, d.usage7.callMinutes >= 60 ? `${Math.floor(d.usage7.callMinutes / 60)} h ${d.usage7.callMinutes % 60} min` : `${d.usage7.callMinutes} min`)),
        h('li', {}, 'Mensagens: ', h('b', {}, num(d.usage7.messages))),
        d.usage7.games.length
          ? h('li', {}, 'Jogos: ', h('b', {}, d.usage7.games.map((g) => `${g.game} (${g.n}${g.wins ? `, ${g.wins} ${g.wins === 1 ? 'vitória' : 'vitórias'}` : ''})`).join(', ')))
          : h('li', { class: 'muted' }, 'Nenhuma partida.'))),
      h('div', {}, h('h3', {}, 'IPs usados'), table([
        { label: 'IP', get: (r) => h('span', { class: 'mono' }, r.ip) },
        { label: 'Último', get: (r) => ago(r.last) },
        { label: '', get: (r) => (d.blockedIps.includes(r.ip) ? h('span', { class: 'pill bad' }, 'bloqueado') : ipBlockButton(r.ip, tab)) },
      ], d.ips, { empty: 'Nenhum IP registrado.' }))),
    h('h3', { class: 'section' }, `Aparelhos conectados (${d.devices.length})`),
    table([
      { label: 'Aparelho', get: (x) => clientLabel({ ...(x.client ?? { app: 'web' }), ua: x.ua }, d.desktopLatest) },
      { label: 'Último uso', get: (x) => ago(x.lastSeen) },
      { label: 'IP', get: (x) => h('span', { class: 'mono' }, x.ip ?? '—') },
      { label: 'Entrou', get: (x) => when(x.createdAt) },
    ], d.devices, { empty: 'Nenhum aparelho conectado (a conta precisa entrar de novo).' }),
    h('h3', { class: 'section' }, 'Últimas mensagens (servidores)'),
    d.messages.length ? h('div', { class: 'msg-list' }, d.messages.map((m) => h('div', { class: 'msg-item' },
      h('div', { class: 'muted small' }, `${m.where} · ${when(m.at)}`), m.text ? h('div', { class: 'msg-text' }, m.text) : h('div', { class: 'muted small' }, `📎 ${m.files.length} anexo(s)`))))
      : h('p', { class: 'empty' }, 'Nenhuma mensagem em servidores.'),
    h('h3', { class: 'section' }, 'Últimas ações registradas'),
    table([
      { label: 'Quando', get: (r) => when(r.at) },
      { label: 'O quê', get: (r) => h('span', {}, r.ok ? '' : '❌ ', r.label) },
      { label: 'IP', get: (r) => h('span', { class: 'mono' }, r.ip ?? '') },
    ], d.audit, { empty: 'Nada registrado.', rowClass: (r) => (r.ok ? null : 'fail') }),
  );
}

// ---------- Auditoria ----------
const KEY_LABELS = {
  contaExiste: 'conta existe', outrosAparelhosDesconectados: 'outros aparelhos desconectados', pessoasEmCall: 'pessoas em call',
  expiresIn: 'validade', maxUses: 'usos', userLimit: 'limite de pessoas', name: 'nome', type: 'tipo', topic: 'tópico', word: 'palavra',
  code: 'código', color: 'cor', bitrate: 'qualidade', pinned: 'fixada', on: 'ligado', usuario: 'usuário tentado', texto: 'texto',
  trava: 'trava', de: 'de', onde: 'onde', arquivo: 'arquivo', tamanho: 'tamanho', anexos: 'anexos', mensagemApagada: 'mensagem apagada junto',
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
// "App 1.4.5 (Windows) · desatualizado", "App instalado (iPhone)", "Chrome no Mac"
const newerVersion = (a, b) => {
  const pa = String(a).split('.').map(Number); const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};
function clientLabel(c, latestVersion) {
  if (!c) return h('span', { class: 'muted small' }, '—');
  if (c.app === 'desktop') {
    const old = latestVersion && c.version && newerVersion(latestVersion, c.version);
    return h('span', { class: 'small', title: c.ua ?? '' }, `App ${c.version ?? '?'}${c.platform ? ` (${c.platform})` : ''}`,
      old ? h('span', { class: 'pill warn', title: `A versão mais nova é a ${latestVersion}` }, 'desatualizado') : null);
  }
  if (c.app === 'pwa') return h('span', { class: 'small', title: c.ua ?? '' }, `App instalado${c.platform ? ` (${c.platform})` : ''}`);
  return h('span', { class: 'small', title: c.ua ?? '' }, device(c.ua));
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
    [['', 'Todos os tipos'], ['seguranca', 'Segurança'], ['contas', 'Contas e acesso'], ['moderacao', 'Moderação'], ['painel', 'Painel']]
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
    { label: 'Quem', get: (r) => (r.user_id ? personLink(r.user_id, h('b', {}, r.user_name ?? '—')) : h('b', {}, r.user_name ?? '—')) },
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

// ---------- Erros do site ----------
// O que quebrou no navegador/app de alguém, agrupado pela mensagem. "Resolvido" tira da lista (volta se acontecer de novo).
let errDays = 7;
async function viewErros() {
  const d = await api(`/api/client-errors?days=${errDays}`);
  const period = h('select', { onchange: (e) => { errDays = Number(e.target.value); openTab('erros'); } },
    [[1, 'Últimas 24 h'], [7, '7 dias'], [30, '30 dias']].map(([v, l]) => h('option', { value: v, selected: v === errDays }, l)));
  const clearAll = h('button', { class: 'btn small ghost', onclick: () => act('/api/client-errors/clear', {}, { confirmText: 'Limpar toda a lista de erros?', reload: 'erros' }) }, 'Limpar tudo');
  return h('div', {},
    h('div', { class: 'card row' }, h('div', {}, h('b', {}, 'Erros que aconteceram no site ou no app de alguém'),
      h('div', { class: 'muted small' }, 'Chegam sozinhos, sem a pessoa precisar avisar. Extensões do navegador, falta de internet e permissões negadas ficam de fora. Guardados por 30 dias.')),
      h('span', { class: 'spacer' }), period, d.groups.length ? clearAll : null),
    d.groups.length ? h('div', { class: 'section err-list' }, d.groups.map((g) => h('div', { class: 'card err-card' },
      h('div', { class: 'row' }, h('b', { class: 'err-msg' }, g.message), h('span', { class: 'spacer' }),
        h('span', { class: `pill ${g.people.length >= 3 || g.count >= 20 ? 'bad' : 'warn'}` }, `${num(g.count)}× · ${g.people.length} ${g.people.length === 1 ? 'pessoa' : 'pessoas'}`),
        h('button', { class: 'btn small', onclick: () => act('/api/client-errors/clear', { message: g.message }, { reload: 'erros' }) }, 'Resolvido')),
      h('div', { class: 'muted small' }, `Primeira vez ${when(g.first)} · última ${ago(g.last)}${g.pages.length ? ` · página ${g.pages.join(', ')}` : ''}`),
      h('div', { class: 'row small' }, 'Quem: ', g.people.map((u) => personLink(`@${u}`, h('b', {}, `@${u}`))), h('span', { class: 'muted' }, ` · ${g.devices.join(' · ')}`)),
      g.stack || g.source ? h('details', {}, h('summary', { class: 'small' }, 'Detalhes técnicos'), h('pre', { class: 'log' }, [g.source, g.stack].filter(Boolean).join('\n'))) : null)))
      : h('p', { class: 'empty section' }, 'Nenhum erro no período. 🎉'));
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
  const [b, up] = await Promise.all([api('/api/backups'), api('/api/upkeep').catch(() => ({}))]);
  // Teste de restauração: abre o último backup numa pasta temporária e confere o banco (toda segunda às 5h)
  const r = up.restore;
  const testBtn = h('button', { class: 'btn' }, 'Testar agora');
  testBtn.addEventListener('click', async () => {
    testBtn.disabled = true;
    testBtn.textContent = 'Testando…';
    try { const res = await api('/api/upkeep/restore-test', { method: 'POST' }); toast(res.message, 8000); openTab('backups'); } catch (err) { toast(err.message); } finally { testBtn.disabled = false; }
  });
  const restoreCard = h('div', { class: 'section card row' },
    h('div', {}, h('b', {}, 'Teste de restauração'),
      h('div', { class: 'small' }, !r ? h('span', { class: 'muted' }, 'Ainda não testado (roda sozinho toda segunda às 5h).')
        : r.ok ? h('span', {}, h('span', { class: 'pill good' }, h('span', { class: 'dot' }), 'ok'), ` ${when(r.at)} · ${r.file} abriu certinho: ${num(r.counts?.contas)} contas, ${num(r.counts?.mensagens)} mensagens`)
          : h('span', {}, h('span', { class: 'pill bad' }, h('span', { class: 'dot' }), 'falhou'), ` ${when(r.at)} · ${r.error}`)),
      h('div', { class: 'muted small' }, 'Abre o último backup numa pasta temporária, confere a integridade do banco e compara com o de agora. Se falhar, chega alerta no celular.')),
    h('span', { class: 'spacer' }), testBtn);
  const cols = [{ label: 'Arquivo', get: (r) => h('span', { class: 'mono' }, r.name) }, { label: 'Tamanho', num: true, get: (r) => bytes(r.size) }, { label: 'Quando', get: (r) => `${when(r.at)} (${ago(r.at)})` }];
  const btn = h('button', { class: 'btn primary' }, 'Fazer backup agora');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Fazendo backup…';
    try {
      const r = await api('/api/backup', { method: 'POST' });
      toast(r.output || (r.ok ? 'Backup feito.' : 'O backup falhou.'), 8000);
      refreshAttention();
      openTab('backups');
    } catch (err) { toast(err.message); } finally { btn.disabled = false; }
  });
  return h('div', {},
    h('div', { class: 'card row' }, h('div', {}, h('b', {}, 'Backup automático todo dia às 4h'), h('div', { class: 'muted small' }, `Banco de dados (todos os servidores e conversas), emojis, fotos, sons e chave das notificações, em ${b.dir}. Guarda os 3 mais recentes, 1 por dia nos últimos 14 dias e 1 por mês nos últimos 6 meses. Os anexos do chat vão para a subpasta anexos (só os novos a cada vez).`)), h('span', { class: 'spacer' }), btn),
    b.warnings.length ? h('div', { class: 'alerts section' }, b.warnings.map((w) => h('div', { class: 'alert warn mono' }, w))) : null,
    restoreCard,
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
    { confirmText: lock.checked ? 'Travar o acesso? Todo mundo (menos você) sai e vê a tela de manutenção até você desligar.' : null, reload: 'manut' }));
  const off = h('button', { class: 'btn' }, 'Desligar');
  off.addEventListener('click', () => act('/api/maintenance', { on: false }, { reload: 'manut' }));
  return h('div', { class: 'card' },
    h('div', { class: 'row' }, h('h2', {}, '🛠️ Modo manutenção'), mt.on ? h('span', { class: `pill ${mt.lock ? 'bad' : 'warn'}` }, mt.lock ? 'ligado · acesso travado' : 'ligado · só aviso') : h('span', { class: 'pill' }, 'desligado')),
    h('p', { class: 'muted small' }, 'Mostra uma faixa de aviso no topo do Muvuca para todo mundo. Travando o acesso, todos (menos você) veem a tela "Em manutenção" até você desligar, e o Muvuca volta sozinho para eles.'),
    h('div', { class: 'row' }, msg, minutes),
    h('div', { class: 'row section' }, h('label', { class: 'row small' }, lock, 'Travar o acesso (só o dono entra)'), h('span', { class: 'spacer' }), mt.on ? off : null, on));
}

// Reiniciar o Muvuca (com confirmação; se tiver gente em call, pergunta de novo)
async function restartMuvuca(btn) {
  if (!confirm('Reiniciar o Muvuca agora? Quem estiver conectado cai por uns 10 segundos e volta sozinho.')) return;
  if (btn) btn.disabled = true;
  try {
    let r = await api('/api/restart', { method: 'POST', body: {} });
    if (r.needsForce && confirm(`${r.output}\nReiniciar mesmo assim?`)) r = await api('/api/restart', { method: 'POST', body: { force: true } });
    toast(r.output, 8000);
  } catch (err) { toast(err.message); } finally { if (btn) setTimeout(() => { btn.disabled = false; }, 15000); }
}

// Serviços: recarregar o site de todos, reiniciar só a voz, desligar e ligar o Muvuca
const reloadAll = () => act('/api/service', { what: 'reload' }, { confirmText: 'Recarregar o Muvuca em todas as abas e apps abertos? Quem está em call volta sozinho para a call; mensagem que alguém estava digitando pode se perder.' });
const restartVoice = () => {
  const inVoice = (status?.main?.voice ?? []).reduce((n, v) => n + v.count, 0);
  return act('/api/service', { what: 'voice' }, { confirmText: `Reiniciar só a voz (LiveKit)? ${inVoice ? `As ${inVoice} pessoas em call caem por uns segundos e voltam sozinhas.` : 'Ninguém está em call agora.'} O chat, os jogos e a música continuam.`, reload: tab });
};
function stopMuvuca() {
  const typed = prompt('DESLIGAR o Muvuca?\n\nTodo mundo sai (site, calls, jogos) até você ligar de novo por aqui. O painel continua funcionando. Para um aviso rápido, use o modo manutenção.\n\nPara confirmar, digite DESLIGAR:', '');
  if (typed === null) return;
  act('/api/service', { what: 'stop', confirm: typed }, { reload: tab });
}
const startMuvuca = () => act('/api/service', { what: 'start' }, { reload: tab });

async function viewManutencao() {
  const mt = await api('/api/maintenance');
  const restart = h('button', { class: 'btn danger' }, 'Reiniciar o Muvuca');
  restart.addEventListener('click', () => restartMuvuca(restart));
  const s = await api('/api/status').catch(() => ({}));
  const off = !!s.stoppedByPanel;
  const svc = (title, text, btn) => h('div', { class: 'section card row' }, h('div', {}, h('b', {}, title), h('div', { class: 'muted small' }, text)), h('span', { class: 'spacer' }), btn);
  return h('div', {},
    off ? h('div', { class: 'alerts' }, h('div', { class: 'alert warn' }, `O Muvuca está desligado pelo painel desde ${when(s.stoppedByPanel.at)}.`)) : null,
    maintenanceCard(mt),
    svc('Recarregar o site de todos', 'Faz todas as abas e apps abertos recarregarem a página (nada reinicia no servidor). Útil depois de publicar uma atualização do site ou se algo ficou estranho na tela de todo mundo. Quem está em call volta sozinho.',
      h('button', { class: 'btn', onclick: reloadAll }, 'Recarregar o site de todos')),
    svc('Reiniciar só a voz', 'Reinicia só o LiveKit (calls, câmeras e lives). As calls caem por uns segundos e voltam sozinhas; o chat, os jogos e a música não caem. Bom para voz travada ou alguém que não consegue entrar.',
      h('button', { class: 'btn', onclick: restartVoice }, 'Reiniciar só a voz')),
    svc(off ? 'Ligar o Muvuca' : 'Desligar o Muvuca', off ? 'Liga o site, a voz e o HTTPS de novo (uns 10 segundos).' : 'Desliga tudo (site, voz, HTTPS) até você ligar de novo por aqui. Para manutenções longas; para avisos rápidos, use o modo manutenção.',
      off ? h('button', { class: 'btn primary', onclick: startMuvuca }, 'Ligar o Muvuca') : h('button', { class: 'btn danger-ghost', onclick: stopMuvuca }, 'Desligar o Muvuca')),
    h('div', { class: 'section card row' }, h('div', {}, h('b', {}, 'Reiniciar o Muvuca'), h('div', { class: 'muted small' }, 'Reinicia o site, a voz e o HTTPS (fica registrado na auditoria). O painel continua no ar. Se tiver gente em call, ele avisa antes.')), h('span', { class: 'spacer' }), restart),
  );
}

async function viewAparelhos() {
  const sessions = await api('/api/sessions');
  const logoutAll = h('button', { class: 'btn small', onclick: async () => { await api('/api/logout-all', { method: 'POST' }); toast('Os outros aparelhos saíram do painel.'); openTab('aparelhos'); } }, 'Tirar os outros aparelhos');
  return h('div', { class: 'card' }, h('div', { class: 'row' }, h('h2', {}, 'Aparelhos conectados ao painel'), h('span', { class: 'spacer' }), logoutAll),
    table([
      { label: 'Aparelho', get: (x) => h('span', { title: x.ua }, x.current ? h('span', { class: 'pill good' }, 'este') : null, ' ', device(x.ua)) },
      { label: 'IP', get: (x) => h('span', { class: 'mono' }, x.ip) },
      { label: 'Entrou', get: (x) => when(x.created) },
      { label: 'Último uso', get: (x) => ago(x.last) },
    ], sessions));
}

async function viewSistema() {
  const s = await api('/api/status');
  const m = s.main ?? {};
  const sz = s.sizes ?? {};
  const site = `https://${s.domain}${s.publicPort && s.publicPort !== '443' ? ` (IPv4: porta ${s.publicPort})` : ''}`;
  return h('div', {},
    h('div', { class: 'grid two' },
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
  );
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

// Trava de velocidade dos arquivos que saem do Mac: protege a call e a live quando alguém baixa algo grande
async function bandwidthCard() {
  const st = await api('/api/status').catch(() => null);
  const bw = st?.main?.bandwidth;
  if (!bw) return h('div', { class: 'section card' }, h('h2', {}, 'Trava de velocidade dos arquivos'), h('p', { class: 'muted small' }, 'Reinicie o Muvuca para ativar.'));
  const per = h('input', { type: 'number', min: 5, max: 1000, step: 5, value: bw.perMbps, style: 'width:90px' });
  const total = h('input', { type: 'number', min: 10, max: 1000, step: 10, value: bw.totalMbps, style: 'width:90px' });
  const smart = h('input', { type: 'checkbox', checked: bw.smart });
  const save = h('button', { class: 'btn primary', onclick: () => act('/api/bandwidth', { perMbps: Number(per.value), totalMbps: Number(total.value), smart: smart.checked }, { reload: 'internet' }) }, 'Salvar');
  return h('div', { class: 'section card' },
    h('div', { class: 'row' }, h('h2', {}, 'Trava de velocidade dos arquivos'), h('span', { class: 'spacer' }),
      h('span', { class: `pill ${bw.limiting ? 'warn' : 'good'}` }, h('span', { class: 'dot' }), bw.limiting ? 'travando agora' : 'solta agora (ninguém na call)')),
    h('p', { class: 'muted small' }, 'Anexos, instaladores do app, fotos e sons que saem do Mac não podem ocupar o upload todo: a call e a live ficam com o resto. Voz e live não passam por esta trava.'),
    h('div', { class: 'row' },
      h('label', { class: 'row small' }, 'Por arquivo, até ', per, ' Mbps'),
      h('label', { class: 'row small' }, 'Todos juntos, até ', total, ' Mbps'),
      h('label', { class: 'row small' }, smart, 'Só com gente na call (sem ninguém, vai no máximo)'),
      h('span', { class: 'spacer' }), save),
    h('p', { class: 'muted small' }, `Agora: ${bw.streams} ${bw.streams === 1 ? 'download' : 'downloads'} em andamento · ${bw.mbpsNow.toLocaleString('pt-BR')} Mbps saindo em arquivos.`));
}

async function viewInternet() {
  const d = await api('/api/speedtest');
  const last = d.lastOk;
  const up = h('button', { class: 'btn primary', disabled: !!d.running }, 'Testar upload (recomendado)');
  const full = h('button', { class: 'btn', disabled: !!d.running }, 'Teste completo (download + upload)');
  up.addEventListener('click', () => startSpeedtest('upload', [up, full]));
  full.addEventListener('click', () => startSpeedtest('full', [up, full]));
  const a = d.activity;
  const using = [a.voice && `${a.voice} em call`, a.lives && `${a.lives} em live`].filter(Boolean);
  const top = h('div', { class: 'card' },
    h('div', { class: 'row' }, up, full, h('span', { class: 'spacer' }),
      d.running ? h('span', { class: 'pill warn' }, h('span', { class: 'dot' }), `Testando (${d.modes[d.running.mode]})… ${Math.round((Date.now() - d.running.startedAt) / 1000)} s`) : null),
    h('p', { class: 'muted small' }, 'Usa o teste da própria Apple (vem no macOS). Ocupa a internet inteira por uns 20 a 40 s: quem estiver em call, live ou jogando sente. ',
      'O teste só de upload gasta uns 600 MB de dados; o completo, de 1 a 2 GB.'),
    using.length ? h('div', { class: 'alert warn' }, `Agora tem gente usando: ${using.join(', ')}. Se possível, teste depois.`) : null,
    d.lastError && !d.running ? h('div', { class: 'alert bad' }, `O último teste falhou: ${d.lastError}.`) : null);

  const [rk, rl] = rpmLevel(last?.rpm);
  const stats = last ? h('div', { class: 'section grid cards' },
    stat('Upload', mbps(last.up), 'o que limita o servidor (lives e calls)'),
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

  return h('div', {}, top, await bandwidthCard(), stats, capCard, chart, list);
}

// ---------- Mensagens (moderação) ----------
let msgQuery = { q: '', user: '' };
async function viewMensagens() {
  const params = new URLSearchParams(msgQuery);
  const list = await api(`/api/messages?${params}`);
  const q = h('input', { type: 'search', placeholder: 'Texto da mensagem…', value: msgQuery.q, 'aria-label': 'Texto' });
  const who = h('input', { type: 'search', placeholder: '@usuário', value: msgQuery.user, 'aria-label': 'Usuário', class: 'narrow' });
  const go = (e) => { e?.preventDefault(); msgQuery = { q: q.value.trim(), user: who.value.trim() }; openTab('mensagens'); };
  const form = h('form', { class: 'row', onsubmit: go }, q, who, h('button', { class: 'btn primary', type: 'submit' }, 'Buscar'),
    msgQuery.q || msgQuery.user ? h('button', { class: 'btn ghost', type: 'button', onclick: () => { msgQuery = { q: '', user: '' }; openTab('mensagens'); } }, 'Limpar') : null);
  const items = list.map((m) => h('div', { class: 'msg-item' },
    h('div', { class: 'row' },
      m.user ? personLink(`@${m.user}`, h('b', {}, m.name ?? '?')) : h('b', {}, m.name ?? '?'), h('span', { class: 'muted small' }, m.user ? `@${m.user}` : '(conta apagada)'),
      h('span', { class: 'muted small' }, `· ${m.where} · ${when(m.at)}${m.edited ? ' · editada' : ''}${m.pinned ? ' · 📌 fixada' : ''}`),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn small ghost', onclick: () => deleteMessage(m) }, 'Apagar')),
    m.text ? h('div', { class: 'msg-text' }, m.text) : null,
    m.files.length ? h('div', { class: 'row' }, m.files.map((f) => h('button', { class: 'chip-btn', title: 'Ver prévia',
      onclick: () => previewFile({ ...f, user: m.user ?? '?', where: m.where, text: m.text, messageId: m.id }) },
    `${KIND_LABEL[f.kind]?.split(' ')[0] ?? '📎'} ${f.name} (${bytes(f.size)})`))) : null));
  return h('div', {},
    h('div', { class: 'card' },
      form,
      h('p', { class: 'muted small' }, 'As 100 mais recentes dos servidores (conversas privadas nunca aparecem aqui). Apagar some na hora para todo mundo e fica registrado na auditoria.')),
    h('div', { class: 'section card' },
      h('h2', {}, msgQuery.q || msgQuery.user ? `${list.length} encontradas` : 'Últimas mensagens'),
      items.length ? h('div', { class: 'msg-list' }, items) : h('p', { class: 'empty' }, 'Nenhuma mensagem encontrada.')));
}

// ---------- Resumo da semana ----------
let summaryWeek = 0;
function delta(cur, prev) {
  if (!prev && !cur) return 'igual à semana anterior';
  if (!prev) return 'novo nesta semana';
  const p = Math.round(((cur - prev) / prev) * 100);
  return p === 0 ? 'igual à semana anterior' : `${p > 0 ? '▲' : '▼'} ${Math.abs(p)}% vs semana anterior`;
}
const hoursMin = (min) => (min >= 60 ? `${Math.floor(min / 60)} h ${min % 60 ? `${min % 60} min` : ''}`.trim() : `${min} min`);
async function viewResumo() {
  const d = await api(`/api/summary?week=${summaryWeek}`);
  const day = (t) => new Date(t).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  const sel = h('select', {}, Array.from({ length: 8 }, (_, i) => h('option', { value: i, selected: i === summaryWeek },
    i === 0 ? 'Últimos 7 dias' : i === 1 ? '7 dias antes disso' : `Há ${i} semanas`)));
  sel.addEventListener('change', () => { summaryWeek = Number(sel.value); openTab('resumo'); });
  const maxDay = Math.max(1, ...d.byDay.map((x) => x.messages)); const maxVoice = Math.max(1, ...d.byDay.map((x) => x.voiceMin));
  const days = h('div', { class: 'week-bars' }, d.byDay.map((x) => h('div', { class: 'week-day', title: `${num(x.messages)} mensagens · ${hoursMin(x.voiceMin)} de call` },
    h('div', { class: 'week-cols' },
      h('span', { class: 'wb msg', style: `height:${Math.round((x.messages / maxDay) * 100)}%` }),
      h('span', { class: 'wb voice', style: `height:${Math.round((x.voiceMin / maxVoice) * 100)}%` })),
    h('div', { class: 'muted small' }, new Date(x.at).toLocaleDateString('pt-BR', { weekday: 'short' }).replace('.', '')))));
  const s = d.safety;
  return h('div', {},
    h('div', { class: 'row' }, h('p', { class: 'muted' }, `${day(d.start)} a ${day(d.end)}`), h('span', { class: 'spacer' }), sel),
    h('div', { class: 'grid cards' },
      stat('Pessoas ativas', num(d.cur.active), delta(d.cur.active, d.prev.active)),
      stat('Tempo de call', hoursMin(d.cur.voiceMin), delta(d.cur.voiceMin, d.prev.voiceMin)),
      stat('Mensagens nos servidores', num(d.cur.messages), delta(d.cur.messages, d.prev.messages)),
      stat('Mensagens privadas', num(d.cur.dms), 'só a quantidade'),
      stat('Partidas de jogos', num(d.cur.games), delta(d.cur.games, d.prev.games)),
      stat('Anexos enviados', num(d.files.n), bytes(d.files.bytes))),
    h('div', { class: 'section card' },
      h('div', { class: 'row' }, h('h2', {}, 'Dia a dia'), h('span', { class: 'spacer' }),
        h('span', { class: 'legend' }, h('i', { class: 'wb msg' }), 'mensagens'), h('span', { class: 'legend' }, h('i', { class: 'wb voice' }), 'call')),
      days),
    h('div', { class: 'section card' }, h('h2', {}, 'Quem mais usou'),
      table([
        { label: 'Pessoa', get: (r) => h('span', {}, h('b', {}, r.name), ' ', h('span', { class: 'muted small' }, `@${r.username}`)) },
        { label: 'Call', num: true, get: (r) => (r.voiceMin ? hoursMin(r.voiceMin) : '—') },
        { label: 'Mensagens', num: true, get: (r) => num(r.messages) },
        { label: 'Jogos', num: true, get: (r) => (r.games ? `${num(r.games)}${r.wins ? ` (${r.wins} 🏆)` : ''}` : '—') },
      ], d.ranking, { empty: 'Ninguém usou nesta semana.' })),
    h('div', { class: 'section grid two' },
      h('div', { class: 'card' }, h('h2', {}, 'Canais mais movimentados'), table([
        { label: 'Canal', get: (r) => `${r.server} · #${r.channel}` },
        { label: 'Mensagens', num: true, get: (r) => num(r.n) },
      ], d.channels, { empty: 'Nenhuma mensagem nos servidores.' })),
      h('div', { class: 'card' }, h('h2', {}, 'Segurança e moderação'), table([
        { label: 'O quê', get: (r) => r[0] }, { label: 'Vezes', num: true, get: (r) => h('b', { class: r[1] && r[2] ? 'bad-text' : null }, num(r[1])) },
      ], [['Travados pelo anti-spam', s.spam, true], ['Senhas erradas (site e painel)', s.failedLogins, s.failedLogins > 20], ['Mensagens/anexos apagados', s.moderation, false], ['Bloqueios de conta ou IP', s.blocks, true]]),
      d.newUsers.length ? h('p', { class: 'small' }, h('b', {}, 'Contas novas: '), d.newUsers.map((u) => `${u.name} (@${u.username})`).join(', ')) : h('p', { class: 'muted small' }, 'Nenhuma conta nova.'))));
}

// ---------- Arquivos pesados ----------
const KIND_LABEL = { image: '🖼️ Imagem', video: '🎬 Vídeo', audio: '🎵 Áudio', file: '📄 Documento' };
const fileUrl = (r, download) => `/api/file?id=${encodeURIComponent(r.id)}${download ? '&download=1' : ''}`;

// Prévia em pop-up: imagem, vídeo ou áudio ali mesmo; documento só baixa (fecha com Esc ou clicando fora)
function previewFile(r) {
  const src = fileUrl(r);
  const media = r.kind === 'image' ? h('img', { src, alt: r.name })
    : r.kind === 'video' ? h('video', { src, controls: true, autoplay: true, playsinline: true })
      : r.kind === 'audio' ? h('audio', { src, controls: true, autoplay: true })
        : h('p', { class: 'muted' }, 'Documentos não abrem aqui (por segurança). Use o botão Baixar.');
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const overlay = h('div', { class: 'preview-overlay', onclick: (e) => { if (e.target === overlay) close(); } },
    h('div', { class: 'preview-box', role: 'dialog', 'aria-modal': 'true', 'aria-label': r.name },
      h('div', { class: 'row preview-head' },
        h('div', { class: 'preview-title' }, h('b', {}, r.name), h('div', { class: 'muted small' }, `${KIND_LABEL[r.kind] ?? r.kind} · ${bytes(r.size)} · @${r.user} · ${r.where}`)),
        h('span', { class: 'spacer' }),
        r.kind !== 'file' ? h('a', { class: 'btn small ghost', href: src, target: '_blank', rel: 'noopener' }, 'Abrir em nova aba') : null,
        h('a', { class: 'btn small ghost', href: fileUrl(r, true) }, 'Baixar'),
        h('button', { class: 'btn small', onclick: close, 'aria-label': 'Fechar' }, '✕')),
      h('div', { class: 'preview-media' }, media),
      r.text ? h('div', { class: 'preview-text' }, h('span', { class: 'muted small' }, 'Texto da mensagem: '), r.text) : null,
      h('div', { class: 'row preview-actions' },
        h('span', { class: 'muted small' }, 'Moderação:'),
        h('button', { class: 'btn small danger', onclick: () => deleteFile(r, close) }, 'Apagar este anexo'),
        r.messageId ? h('button', { class: 'btn small ghost', onclick: () => deleteMessage({ id: r.messageId, user: r.user, where: r.where }, close) }, 'Apagar a mensagem inteira') : null)));
  document.addEventListener('keydown', onKey);
  document.body.append(overlay);
}

// Apagar pelo painel: some na hora para todo mundo e fica na auditoria
async function deleteFile(r, done) {
  if (!confirm(`Apagar o anexo "${r.name}" de @${r.user}? Ele some do chat para todo mundo e não dá para desfazer.`)) return;
  try {
    const res = await api('/api/files/delete', { method: 'POST', body: { id: r.id } });
    toast(res.message, 5000);
    done?.();
    openTab(tab);
  } catch (err) { toast(err.message, 6000); }
}
async function deleteMessage(m, done) {
  if (!confirm(`Apagar esta mensagem de @${m.user ?? '?'} (${m.where})? Os anexos dela vão junto e não dá para desfazer.`)) return;
  try {
    const res = await api('/api/messages/delete', { method: 'POST', body: { id: m.id } });
    toast(res.message, 5000);
    done?.();
    openTab(tab);
  } catch (err) { toast(err.message, 6000); }
}
let filesKind = '';
async function viewArquivos() {
  const d = await api(`/api/files${filesKind ? `?kind=${filesKind}` : ''}`);
  const sel = h('select', {}, [['', 'Todos os tipos'], ['image', 'Imagens'], ['video', 'Vídeos'], ['audio', 'Áudios'], ['file', 'Documentos']]
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
      h('p', { class: 'muted small' }, 'Os 200 maiores. Clique no nome para ver a prévia. Em conversas privadas não aparecem o nome do arquivo, o canal nem a prévia.'),
      small([
        { label: 'Arquivo', get: (r) => (!r.name ? h('span', { class: 'muted' }, '(conversa privada)')
          : r.id ? h('button', { class: 'link-btn', title: 'Ver prévia', onclick: () => previewFile(r) }, r.kind === 'file' ? '📄 ' : '👁️ ', r.name)
            : h('span', {}, r.name)) },
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

// ---------- Passkey (Face ID / Touch ID) e alertas: utilidades ----------
const toB64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function fromB64u(s) {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const installed = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const deviceName = () => {
  const u = navigator.userAgent;
  return /iPhone/.test(u) ? 'iPhone' : /iPad/.test(u) || isIOS() ? 'iPad' : /Android/.test(u) ? 'Android' : /Mac/.test(u) ? 'Mac' : /Windows/.test(u) ? 'Windows' : 'Aparelho';
};
let swReg = null;
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').then((r) => { swReg = r; }).catch(() => {});

// ---------- Alertas no celular ----------
async function viewAlertas() {
  const d = await api('/api/alerts');
  const box = h('div', {});
  // Este aparelho
  const here = h('div', { class: 'card' }, h('h2', {}, 'Este aparelho'));
  const pushOk = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  let mySub = null;
  // Sem esperar para sempre: em navegador sem service worker, a tela abre do mesmo jeito
  try { mySub = await (swReg ?? await navigator.serviceWorker?.getRegistration())?.pushManager.getSubscription(); } catch { /* sem service worker */ }
  const subscribed = !!mySub && d.devices.some((x) => x.endpoint === mySub.endpoint);
  if (isIOS() && !installed()) {
    here.append(h('p', {}, 'No iPhone, os alertas só funcionam com o painel instalado como app:'),
      h('ol', { class: 'steps' }, h('li', {}, 'Toque em Compartilhar (o quadrado com a seta) no Safari.'), h('li', {}, 'Escolha "Adicionar à Tela de Início".'), h('li', {}, 'Abra o Painel pelo ícone novo, entre e volte nesta aba.')));
  } else if (!pushOk) {
    here.append(h('p', { class: 'muted' }, 'Este navegador não aceita notificações.'));
  } else if (subscribed) {
    here.append(h('p', {}, h('span', { class: 'pill good' }, h('span', { class: 'dot' }), 'Recebendo alertas')),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: () => act('/api/alerts/test', {}, { reload: 'alertas' }) }, 'Enviar um teste'),
        h('button', { class: 'btn ghost', onclick: async () => { await mySub.unsubscribe().catch(() => {}); act('/api/alerts/unsubscribe', { endpoint: mySub.endpoint }, { reload: 'alertas' }); } }, 'Parar neste aparelho')));
  } else {
    here.append(h('p', {}, 'Receba um aviso no celular quando o Muvuca cair, o disco encher, o backup falhar e mais.'),
      h('button', { class: 'btn primary', onclick: subscribeHere }, 'Receber alertas neste aparelho'));
  }
  box.append(here);
  // O que avisar
  const prefs = h('div', { class: 'section card' }, h('h2', {}, 'O que avisar'));
  for (const [k, label] of Object.entries(d.kinds)) {
    const cb = h('input', { type: 'checkbox', checked: d.prefs[k] });
    cb.addEventListener('change', () => api('/api/alerts/prefs', { method: 'POST', body: { [k]: cb.checked } }).then(() => toast('Salvo.')).catch((e) => toast(e.message)));
    prefs.append(h('label', { class: 'check' }, cb, label));
  }
  prefs.append(h('p', { class: 'muted small' }, 'Reinícios feitos pelo painel (botão Reiniciar ou Atualizar) não viram alerta de queda. Cada tipo de aviso repete no máximo uma vez por hora ou por dia.'));
  box.append(prefs);
  // Aparelhos inscritos
  box.append(h('div', { class: 'section card' }, h('h2', {}, `Aparelhos inscritos — ${d.devices.length}`),
    table([
      { label: 'Aparelho', get: (x) => h('span', {}, x.name, mySub?.endpoint === x.endpoint ? h('span', { class: 'muted small' }, ' (este)') : null) },
      { label: 'Desde', get: (x) => when(x.at) },
      { label: '', get: (x) => h('button', { class: 'btn small ghost', onclick: () => act('/api/alerts/unsubscribe', { endpoint: x.endpoint }, { confirmText: `Parar os alertas em "${x.name}"?`, reload: 'alertas' }) }, 'Remover') },
    ], d.devices, { empty: 'Nenhum aparelho recebendo alertas ainda.' })));
  return box;

  async function subscribeHere() {
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') return toast('Notificações bloqueadas. Libere nas configurações do aparelho.', 6000);
      const reg = swReg ?? await navigator.serviceWorker.getRegistration() ?? await navigator.serviceWorker.register('/sw.js');
      const sub = await reg.pushManager.getSubscription() ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromB64u(d.key) });
      await act('/api/alerts/subscribe', { sub: sub.toJSON(), name: deviceName() }, { reload: 'alertas' });
    } catch (err) { toast(`Não deu para ativar: ${err.message}`, 6000); }
  }
}

// ---------- Histórico de quedas ----------
function durFmt(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}
async function viewQuedas() {
  const d = await api('/api/quedas');
  const box = h('div', {});
  if (d.now) {
    box.append(h('div', { class: 'card bad-card' }, h('h2', {}, `🔴 Fora do ar agora (há ${durFmt(d.now.forMs)})`),
      h('p', {}, d.now.planned ? 'Reinício feito pelo painel: deve voltar em segundos.' : `Motivo: ${d.now.reason}`),
      d.now.log?.length ? h('pre', { class: 'log small' }, d.now.log.join('\n')) : null));
  }
  box.append(h('div', { class: 'grid cards' },
    stat('No ar (30 dias)', `${d.uptime30.toLocaleString('pt-BR', { maximumFractionDigits: d.uptime30 < 100 ? 3 : 0 })}%`, 'sem contar reinícios do painel'),
    stat('Quedas (30 dias)', num(d.total30), d.total30 ? `${num(d.minutes30)} min fora no total` : 'nenhuma, que beleza'),
    stat('Reinícios planejados', num(d.list.filter((q) => q.planned).length), 'atualizações e botão Reiniciar')));
  const list = h('div', { class: 'section card' }, h('h2', {}, 'Últimos 30 dias'));
  if (!d.list.length) list.append(h('p', { class: 'empty' }, 'Nenhuma queda registrada. O histórico começa a contar a partir de agora.'));
  for (const q of d.list) {
    const row = h('details', { class: `queda${q.planned ? ' planned' : ''}` },
      h('summary', {}, h('b', {}, q.planned ? '🔧 Reinício planejado' : '🔴 Queda'), ` · ${when(q.start)} · ficou fora ${durFmt(q.end - q.start)}`,
        q.planned ? null : h('span', { class: 'muted small' }, ` · ${q.reason}`)),
      q.log?.length ? h('pre', { class: 'log small' }, q.log.join('\n')) : h('p', { class: 'muted small' }, 'Sem linhas de log guardadas.'));
    list.append(row);
  }
  box.append(list);
  return box;
}

// ---------- Convites ----------
const EXPIRY = [[1800000, '30 minutos'], [3600000, '1 hora'], [86400000, '1 dia'], [604800000, '7 dias'], [null, 'Nunca']];
async function viewConvites() {
  const d = await api('/api/invites');
  const server = h('select', {}, d.servers.map((x) => h('option', { value: x.id }, x.name)));
  const expiry = h('select', {}, EXPIRY.map(([v, l]) => h('option', { value: v ?? '', selected: v === 604800000 }, l)));
  const uses = h('select', {}, [['', 'Sem limite'], [1, '1 uso'], [5, '5 usos'], [10, '10 usos'], [25, '25 usos'], [100, '100 usos']].map(([v, l]) => h('option', { value: v }, l)));
  const result = h('div', { class: 'invite-result' });
  const create = h('button', { class: 'btn primary', onclick: async () => {
    try {
      const r = await api('/api/invites/create', { method: 'POST', body: { serverId: server.value, expiresIn: expiry.value ? Number(expiry.value) : null, maxUses: uses.value ? Number(uses.value) : null } });
      const input = h('input', { value: r.link, readonly: true, class: 'invite-link' });
      const copy = h('button', { class: 'btn small', onclick: () => navigator.clipboard?.writeText(r.link).then(() => toast('Link copiado!')) }, 'Copiar link');
      result.replaceChildren(h('div', { class: 'row' }, input, copy));
      input.select();
      setTimeout(() => openTab('convites'), 15000);
    } catch (err) { toast(err.message, 6000); }
  } }, 'Criar convite');
  const box = h('div', {},
    h('div', { class: 'card' }, h('h2', {}, 'Novo convite'),
      h('div', { class: 'row' }, h('label', {}, 'Servidor ', server), h('label', {}, 'Vale por ', expiry), h('label', {}, 'Usos ', uses), create),
      result),
    h('div', { class: 'section card' }, h('h2', {}, `Convites valendo — ${d.active.length}`),
      table([
        { label: 'Código', get: (i) => h('code', {}, i.code) },
        { label: 'Servidor', get: (i) => i.server },
        { label: 'Criado por', get: (i) => (i.by ? `@${i.by}` : '—') },
        { label: 'Usos', num: true, get: (i) => `${i.uses}${i.maxUses ? ` / ${i.maxUses}` : ''}` },
        { label: 'Vence', get: (i) => (i.expiresAt ? when(i.expiresAt) : 'nunca') },
        { label: 'Quem entrou', get: (i) => (i.joined.length ? i.joined.map((u) => `@${u}`).join(', ') : h('span', { class: 'muted' }, '—')) },
        { label: '', get: (i) => h('span', { class: 'row' },
          h('button', { class: 'btn small ghost', onclick: () => navigator.clipboard?.writeText(`https://${d.domain}/?convite=${i.code}`).then(() => toast('Link copiado!')) }, 'Copiar'),
          h('button', { class: 'btn small ghost', onclick: () => act('/api/invites/revoke', { code: i.code }, { confirmText: `Cancelar o convite ${i.code}? Quem tiver o link não entra mais.`, reload: 'convites' }) }, 'Cancelar')) },
      ], d.active, { empty: 'Nenhum convite valendo.' })),
    h('div', { class: 'section card' }, h('h2', {}, 'Quem entrou (e por onde)'),
      table([
        { label: 'Quando', get: (j) => when(j.at) },
        { label: 'Pessoa', get: (j) => `@${j.user}` },
        { label: 'Como', get: (j) => (j.kind === 'cadastro' ? 'Criou a conta' : 'Já tinha conta') },
        { label: 'Por', get: (j) => (j.code ? h('code', {}, j.code) : j.via ?? '—') },
        { label: 'Servidor', get: (j) => j.server ?? '—' },
      ], d.joins, { empty: 'Ninguém entrou por convite ainda.' })));
  return box;
}

// ---------- Segurança: passkeys ----------
async function viewSeguranca() {
  const list = await api('/api/passkeys');
  const supported = !!window.PublicKeyCredential;
  const add = h('button', { class: 'btn primary', disabled: !supported, onclick: async () => {
    const name = prompt('Nome deste aparelho (para você reconhecer depois):', deviceName());
    if (name === null) return;
    try {
      const o = await api('/api/passkey/register-options', { method: 'POST', body: {} });
      const cred = await navigator.credentials.create({ publicKey: {
        challenge: fromB64u(o.challenge), rp: o.rp, user: { ...o.user, id: fromB64u(o.user.id) },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        excludeCredentials: o.excludeCredentials.map((c) => ({ type: 'public-key', id: fromB64u(c.id) })),
        attestation: 'none', timeout: o.timeout,
      } });
      await act('/api/passkey/register', { name, clientDataJSON: toB64u(cred.response.clientDataJSON), attestationObject: toB64u(cred.response.attestationObject) }, { reload: 'seguranca' });
    } catch (err) { toast(err.name === 'NotAllowedError' ? 'Cancelado.' : err.name === 'InvalidStateError' ? 'Este aparelho já tem passkey cadastrada.' : err.message, 6000); }
  } }, 'Cadastrar este aparelho');
  return h('div', {},
    h('div', { class: 'card' }, h('h2', {}, 'Entrar com Face ID / Touch ID'),
      h('p', {}, 'Cadastre este aparelho e, na próxima vez, entre no painel só com Face ID, Touch ID, digital ou o PIN do aparelho, sem digitar a senha. A senha continua valendo como reserva.'),
      supported ? add : h('p', { class: 'muted' }, 'Este navegador não aceita passkeys.'),
      h('p', { class: 'muted small' }, 'A chave fica guardada no seu aparelho (e sincroniza pelo iCloud/Google, se estiver ligado); o painel guarda só a parte pública para conferir.')),
    h('div', { class: 'section card' }, h('h2', {}, `Passkeys cadastradas — ${list.length}`),
      table([
        { label: 'Aparelho', get: (c) => c.name },
        { label: 'Cadastrada', get: (c) => when(c.created) },
        { label: 'Último uso', get: (c) => (c.lastUsed ? ago(c.lastUsed) : 'nunca') },
        { label: '', get: (c) => h('button', { class: 'btn small ghost', onclick: () => act('/api/passkey/delete', { id: c.id }, { confirmText: `Apagar a passkey "${c.name}"? Esse aparelho vai precisar da senha de novo.`, reload: 'seguranca' }) }, 'Apagar') },
      ], list, { empty: 'Nenhuma passkey ainda.' })),
    h('p', { class: 'muted small section' }, 'As sessões abertas (e o botão para tirar os outros aparelhos) ficam em Aparelhos conectados.'));
}

start();
