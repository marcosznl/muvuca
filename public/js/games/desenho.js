// "Desenha aí" no site: quem desenha usa o mouse/dedo (pincel, borracha, linha, círculo e balde de tinta);
// os outros chutam no chat da sala. A palavra aparece como _ _ _ para quem ainda não acertou.
// No fim, a galeria: todos os desenhos da partida, voto no melhor e "mandar para o chat".
//
// O desenho é feito numa tela de tamanho fixo (1000×750) e só depois ampliado/reduzido na página:
// assim o balde de tinta pinta exatamente a mesma área em todos os computadores.
import { h, showBanner, toast, store } from '../util.js';
import { isMe } from './common.js';
import { state, serverById, rememberedTextChannel } from '../state.js';
import { upload, send, request } from '../net.js';
import { openModal, button, confirmDialog } from '../dialogs.js';

const W = 1000;
const H = 750;
const LEVELS = { facil: 'fácil', medio: 'média', dificil: 'difícil' };

let strokes = [];     // o desenho confirmado pelo servidor
let syncing = false;
let color = 0;
let size = 1;
let tool = 'brush';   // brush | eraser | line | circle | fill
let drawingNow = null; // traço em andamento: { points, sent } (pincel) ou { start, end } (linha/círculo)
let last = null;      // último estado recebido
let els = null;       // elementos montados
let gallery = null;   // desenhos da partida (chega uma vez, no começo da galeria)
let base = null;      // tela "de trás" com os traços já confirmados (desenhados um a um, sem refazer tudo)
let baseCount = 0;

// ---------- Desenhar os traços ----------

const px = ([x, y]) => [(x / 1000) * W, (y / 1000) * H];

function drawOp(g, st, colors, sizes) {
  const col = colors[st.c] ?? '#000';
  const lw = (sizes[st.w] ?? 8) * (W / 800);
  g.strokeStyle = col;
  g.fillStyle = col;
  g.lineWidth = lw;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  if (st.k === 'f') return floodFill(g, px(st.p[0]), col);
  if (st.k === 'l') {
    g.beginPath(); g.moveTo(...px(st.p[0])); g.lineTo(...px(st.p[1])); g.stroke();
    return;
  }
  if (st.k === 'o') {
    const [cx, cy] = px(st.p[0]);
    const [ex, ey] = px(st.p[1]);
    g.beginPath(); g.arc(cx, cy, Math.hypot(ex - cx, ey - cy), 0, Math.PI * 2); g.stroke();
    return;
  }
  const pts = st.p.map(px);
  if (pts.length === 1) { g.beginPath(); g.arc(pts[0][0], pts[0][1], lw / 2, 0, Math.PI * 2); g.fill(); return; }
  g.beginPath();
  g.moveTo(...pts[0]);
  for (const p of pts.slice(1)) g.lineTo(...p);
  g.stroke();
}

// Balde de tinta: pinta a área da mesma cor em volta do ponto (com uma folga para as bordas suavizadas)
function floodFill(g, [sx, sy], hex) {
  const x0 = Math.floor(sx);
  const y0 = Math.floor(sy);
  if (x0 < 0 || y0 < 0 || x0 >= W || y0 >= H) return;
  const img = g.getImageData(0, 0, W, H);
  const d = img.data;
  const at = (x, y) => (y * W + x) * 4;
  const t = at(x0, y0);
  const target = [d[t], d[t + 1], d[t + 2]];
  const fill = [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
  if (Math.abs(target[0] - fill[0]) + Math.abs(target[1] - fill[1]) + Math.abs(target[2] - fill[2]) < 12) return;
  const TOL = 96;
  const same = (i) => Math.abs(d[i] - target[0]) + Math.abs(d[i + 1] - target[1]) + Math.abs(d[i + 2] - target[2]) <= TOL;
  const seen = new Uint8Array(W * H);
  const stack = [[x0, y0]];
  while (stack.length) {
    const [x, y] = stack.pop();
    if (seen[y * W + x]) continue;
    let lx = x;
    while (lx > 0 && !seen[y * W + lx - 1] && same(at(lx - 1, y))) lx--;
    let rx = x;
    while (rx < W - 1 && !seen[y * W + rx + 1] && same(at(rx + 1, y))) rx++;
    for (let i = lx; i <= rx; i++) {
      const k = at(i, y);
      seen[y * W + i] = 1;
      d[k] = fill[0]; d[k + 1] = fill[1]; d[k + 2] = fill[2]; d[k + 3] = 255;
      if (y > 0 && !seen[(y - 1) * W + i] && same(at(i, y - 1))) stack.push([i, y - 1]);
      if (y < H - 1 && !seen[(y + 1) * W + i] && same(at(i, y + 1))) stack.push([i, y + 1]);
    }
  }
  g.putImageData(img, 0, 0);
}

function newCanvas() {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#fff';
  g.fillRect(0, 0, W, H);
  return c;
}

// Todos os traços de novo numa tela (galeria e quando o desenho muda por inteiro: desfazer, chegar no meio)
function renderAll(list, s) {
  const c = newCanvas();
  const g = c.getContext('2d', { willReadFrequently: true });
  for (const st of list) drawOp(g, st, s?.colors ?? ['#000'], s?.sizes ?? [3, 8, 16, 32]);
  return c;
}

function rebuildBase() {
  base = renderAll(strokes, last);
  baseCount = strokes.length;
}
function commitNew() {
  if (!base || baseCount > strokes.length) return rebuildBase();
  const g = base.getContext('2d', { willReadFrequently: true });
  while (baseCount < strokes.length) drawOp(g, strokes[baseCount++], last?.colors ?? ['#000'], last?.sizes ?? [3, 8, 16, 32]);
}

function paint() {
  const cv = els?.canvas;
  if (!cv) return;
  if (!base) rebuildBase();
  const g = cv.getContext('2d');
  g.drawImage(base, 0, 0);
  if (!drawingNow || !last) return;
  const c = tool === 'eraser' ? 1 : color;
  if (drawingNow.points) drawOp(g, { c, w: size, p: drawingNow.points }, last.colors, last.sizes);
  else if (drawingNow.end) drawOp(g, { c, w: size, k: tool === 'line' ? 'l' : 'o', p: [drawingNow.start, drawingNow.end] }, last.colors, last.sizes);
}

function pointFrom(e) {
  const r = els.canvas.getBoundingClientRect();
  const clamp = (v) => Math.max(0, Math.min(1000, Math.round(v)));
  return [clamp(((e.clientX - r.left) / r.width) * 1000), clamp(((e.clientY - r.top) / r.height) * 1000)];
}

// Pincel/borracha: manda o traço em pedaços (a cada 60 ms), cada pedaço começando onde o outro parou
function flush(ctx, final = false) {
  if (!drawingNow?.points) return;
  const pts = drawingNow.points.slice(drawingNow.sent ? drawingNow.sent - 1 : 0);
  if (pts.length >= (drawingNow.sent ? 2 : 1)) {
    ctx.send({ stroke: { c: tool === 'eraser' ? 1 : color, w: size, p: pts } });
    drawingNow.sent = drawingNow.points.length;
  }
  if (final) drawingNow = null;
}

// ---------- Montagem da tela ----------

function mountDom(el, ctx) {
  el.replaceChildren();
  const top = h('div', 'draw-top');
  const word = h('div', 'draw-word');
  const info = h('div', 'draw-info muted small');
  top.append(word, info);
  const board = h('div', 'draw-board');
  const canvas = h('canvas', 'draw-canvas');
  canvas.width = W;
  canvas.height = H;
  const cover = h('div', 'draw-cover');
  board.append(canvas, cover);
  const tools = h('div', 'draw-tools');
  const side = h('div', 'draw-scores');
  const main = h('div', 'draw-main');
  const galleryBox = h('div', 'draw-gallery');
  galleryBox.hidden = true;
  main.append(top, board, tools, galleryBox);
  el.append(main, side);
  els = { el, top, word, info, board, canvas, cover, tools, side, galleryBox, galleryKey: null };
  let timer = null;
  canvas.addEventListener('pointerdown', (e) => {
    if (!canDraw()) return;
    e.preventDefault();
    try { canvas.setPointerCapture?.(e.pointerId); } catch {}
    const p = pointFrom(e);
    if (tool === 'fill') { ctx.send({ stroke: { c: color, w: size, k: 'f', p: [p] } }); return; }
    if (tool === 'line' || tool === 'circle') { drawingNow = { start: p, end: p }; paint(); return; }
    drawingNow = { points: [p], sent: 0 };
    timer = setInterval(() => flush(ctx), 60);
    paint();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drawingNow) return;
    const p = pointFrom(e);
    if (drawingNow.start) { drawingNow.end = p; paint(); return; }
    const q = drawingNow.points.at(-1);
    if (Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) < 4) return;
    drawingNow.points.push(p);
    if (drawingNow.points.length - drawingNow.sent > 250) flush(ctx);
    paint();
  });
  const end = () => {
    if (!drawingNow) return;
    if (drawingNow.start) {
      const { start, end: stop } = drawingNow;
      drawingNow = null;
      if (Math.abs(start[0] - stop[0]) + Math.abs(start[1] - stop[1]) > 3) ctx.send({ stroke: { c: color, w: size, k: tool === 'line' ? 'l' : 'o', p: [start, stop] } });
      paint();
      return;
    }
    clearInterval(timer);
    flush(ctx, true);
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('lostpointercapture', end);
}

const canDraw = () => last && !last.over && last.phase === 'draw' && isMe(last.drawer);

const TOOLS = [['brush', '✏️', 'Pincel'], ['eraser', '🧽', 'Borracha'], ['line', '📏', 'Linha reta'], ['circle', '⭕', 'Círculo'], ['fill', '🪣', 'Balde de tinta']];

function renderTools(ctx, s) {
  const t = els.tools;
  t.replaceChildren();
  if (!canDraw()) return;
  for (const [id, emoji, title] of TOOLS) {
    const b = h('button', id === tool ? 'draw-tool on' : 'draw-tool', emoji);
    b.type = 'button';
    b.title = title;
    b.onclick = () => { tool = id; renderTools(ctx, s); };
    t.append(b);
  }
  t.append(h('span', 'draw-sep'));
  s.colors.forEach((c, i) => {
    const b = h('button', i === color && tool !== 'eraser' ? 'draw-color on' : 'draw-color');
    b.type = 'button';
    b.style.background = c;
    b.title = 'Cor';
    b.onclick = () => { color = i; if (tool === 'eraser') tool = 'brush'; renderTools(ctx, s); };
    t.append(b);
  });
  t.append(h('span', 'draw-sep'));
  s.sizes.forEach((sz, i) => {
    const b = h('button', i === size ? 'draw-size on' : 'draw-size');
    b.type = 'button';
    const dot = h('span', 'draw-dot');
    dot.style.width = dot.style.height = `${Math.min(26, sz * 0.8 + 3)}px`;
    b.append(dot);
    b.onclick = () => { size = i; renderTools(ctx, s); };
    t.append(b);
  });
  t.append(h('span', 'draw-sep'));
  const undo = h('button', 'btn secondary', '↶ Desfazer');
  undo.type = 'button';
  undo.onclick = () => ctx.send({ act: 'undo' });
  const clear = h('button', 'btn danger-outline', 'Limpar');
  clear.type = 'button';
  clear.onclick = () => ctx.send({ act: 'clear' });
  t.append(undo, clear);
}

// ---------- Galeria do fim ----------

// Manda um desenho da galeria como imagem para o último canal de texto usado
async function shareToChat(item) {
  const server = serverById(store.get('lastServer')) ?? state.servers.find((x) => x.kind !== 'dm' && x.kind !== 'dj');
  const channel = server && rememberedTextChannel(server);
  if (!channel) return showBanner('Abra um canal de texto primeiro.', { timeout: 4000 });
  const ok = await confirmDialog({ title: 'Mandar para o chat', message: `Mandar o desenho de ${item.name} ("${item.word}") para #${channel.name} em ${server.name}?`, confirm: 'Mandar', danger: false });
  if (!ok) return;
  try {
    const blob = await new Promise((r) => renderAll(item.strokes, last).toBlob(r, 'image/png'));
    const up = await upload('/api/attach', { channel: channel.id, name: `desenho-${item.word}.png`, w: W, h: H }, blob);
    send({ t: 'msg', channel: channel.id, text: `🎨 Desenho de ${item.name} no Desenha aí: **${item.word}**`, attachments: [up.id] });
    toast(`Desenho mandado para #${channel.name}!`);
  } catch (err) {
    showBanner(err.message, { timeout: 5000 });
  }
}

function renderGallery(s, ctx) {
  const box = els.galleryBox;
  const show = !!gallery?.length && (s.phase === 'gallery' || s.over);
  box.hidden = !show;
  els.board.hidden = show;
  els.tools.hidden = show;
  if (!show) return;
  const key = JSON.stringify([gallery.length, s.votes, s.myVote, s.best, s.over]);
  if (els.galleryKey === key) return;
  els.galleryKey = key;
  box.replaceChildren(h('div', 'draw-gallery-title', s.over ? '🖼️ Galeria da partida' : '🖼️ Vote no melhor desenho (não vale o seu)'));
  const grid = h('div', 'draw-gallery-grid');
  gallery.forEach((item, i) => {
    const card = h('div', 'draw-gallery-item');
    if (s.best?.includes(i)) card.classList.add('best');
    if (s.myVote === i) card.classList.add('voted');
    const img = h('img', 'draw-gallery-img');
    img.alt = item.word;
    img.src = renderAll(item.strokes, last).toDataURL('image/png');
    const cap = h('div', 'draw-gallery-cap');
    cap.append(h('strong', '', item.word), h('span', 'muted small', ` por ${item.name}`));
    const row = h('div', 'draw-gallery-row');
    const votes = s.votes?.[i] ?? 0;
    row.append(h('span', 'draw-gallery-votes', `${s.best?.includes(i) ? '🏅 ' : ''}${votes} ${votes === 1 ? 'voto' : 'votos'}`));
    if (!s.over && s.phase === 'gallery' && ctx.isPlayer && !isMe(item.drawer)) {
      const vote = h('button', s.myVote === i ? 'btn primary small' : 'btn secondary small', s.myVote === i ? '✓ Seu voto' : 'Votar');
      vote.type = 'button';
      vote.onclick = () => ctx.send({ act: 'vote', target: String(i) });
      row.append(vote);
    }
    const share = h('button', 'btn link small', '📤 Mandar pro chat');
    share.type = 'button';
    share.onclick = () => shareToChat(item);
    row.append(share);
    card.append(img, cap, row);
    grid.append(card);
  });
  box.append(grid);
}

// ---------- Palavras da galera (quem gerencia o servidor principal) ----------

async function openWords() {
  let data;
  try { data = await request({ t: 'game:words' }); } catch (err) { return showBanner(err.message, { timeout: 4000 }); }
  const content = h('div', 'form');
  const list = h('div', 'draw-words');
  const paintList = (d) => {
    list.replaceChildren();
    if (!d.canManage) {
      list.append(h('p', 'muted', `${d.count} ${d.count === 1 ? 'palavra cadastrada' : 'palavras cadastradas'} pelo dono do servidor. A lista fica escondida para não estragar a surpresa!`));
      return;
    }
    if (!d.words.length) list.append(h('p', 'muted small', 'Nenhuma ainda. Coloque apelidos, piadas internas, lugares da galera…'));
    for (const w of d.words) {
      const chip = h('span', 'draw-word-chip', w);
      const x = h('button', 'draw-word-x', '×');
      x.type = 'button';
      x.title = 'Tirar';
      x.onclick = async () => { try { paintList(await request({ t: 'game:word:remove', word: w })); } catch (err) { showBanner(err.message, { timeout: 4000 }); } };
      chip.append(x);
      list.append(chip);
    }
  };
  content.append(h('p', 'muted small', 'Elas entram no sorteio junto com as normais (e sozinhas no tema "Só palavras da galera"). Valem como palavra média.'));
  if (data.canManage) {
    const form = h('form', 'draw-words-add');
    const input = h('input');
    Object.assign(input, { placeholder: 'Nova palavra (ex.: Tio Zé)', maxLength: 40 });
    const add = h('button', 'btn primary', 'Adicionar');
    form.append(input, add);
    form.onsubmit = async (e) => {
      e.preventDefault();
      if (!input.value.trim()) return;
      try { paintList(await request({ t: 'game:word:add', word: input.value })); input.value = ''; input.focus(); } catch (err) { showBanner(err.message, { timeout: 4000 }); }
    };
    content.append(form);
    setTimeout(() => input.focus(), 0);
  }
  content.append(list);
  paintList(data);
  const done = button('Pronto', { kind: 'secondary' });
  const modal = openModal({ title: '✏️ Palavras da galera', content, actions: [done] });
  done.onclick = () => modal.close();
}

export default {
  emoji: '🎨',
  title: 'Desenha aí',
  desc: 'De 2 a 10 pessoas. Um desenha, o resto chuta no chat. Temas, palavras da galera, balde de tinta e galeria no fim. Estilo Gartic!',
  help: () => [h('span', 'kbd', 'mouse'), ' desenha · palpites pelo ', h('span', 'kbd', 'chat da sala')],
  touchHelp: 'Desenhe com o dedo · chute no chat da sala',
  dom: true,
  chatPlaceholder: 'Chute a palavra aqui…',
  // Botão extra na sala (antes de começar): palavras da galera
  roomExtras() {
    const b = h('button', 'btn secondary small', '✏️ Palavras da galera');
    b.type = 'button';
    b.onclick = openWords;
    return b;
  },
  reset() { strokes = []; drawingNow = null; color = 0; size = 1; tool = 'brush'; gallery = null; base = null; baseCount = 0; },
  mount() { els = null; base = null; baseCount = 0; },
  onEvents(events) {
    let rebuild = false;
    for (const ev of events) {
      if (ev.type === 'stroke') strokes.push(ev.stroke);
      if (ev.type === 'clear') { strokes = []; rebuild = true; }
      if (ev.type === 'undo') { strokes.pop(); rebuild = true; }
      if (ev.type === 'gallery') gallery = ev.gallery;
    }
    if (rebuild) rebuildBase(); else commitNew();
    paint();
  },
  render(el, s, ctx) {
    if (!els || els.el !== el || !el.isConnected) mountDom(el, ctx);
    const prev = last;
    last = s;
    // Chegou no meio (ou perdeu eventos): pede o desenho inteiro (e a galeria, se já estiver nela)
    const needGallery = (s.phase === 'gallery' || s.over) && s.galleryCount > 1 && !gallery;
    if ((s.strokeCount !== strokes.length || needGallery) && !syncing && !drawingNow) {
      syncing = true;
      ctx.request({ t: 'game:sync', roomId: ctx.room.id }).then((r) => {
        if (r.data) { strokes = r.data.strokes; if (r.data.gallery) gallery = r.data.gallery; rebuildBase(); paint(); }
      }).finally(() => { syncing = false; });
    }
    const drawer = s.players.find((p) => p.id === s.drawer);
    const secs = Math.ceil(s.timeLeft / 1000);
    // Palavra (com o nível, para quem já sabe)
    els.word.replaceChildren();
    if (s.phase === 'gallery') {
      els.word.append('Galeria da partida');
    } else if (s.phase === 'choose') {
      els.word.append(isMe(s.drawer) ? 'Escolha a palavra:' : `${drawer?.name ?? '?'} está escolhendo a palavra…`);
    } else if (s.word) {
      els.word.append(h('span', 'draw-letters', [...s.word].join(' ')), h('span', 'muted small', ` (${s.wordLength} letras)`));
      if (s.level) els.word.append(h('span', `draw-level ${s.level}`, LEVELS[s.level]));
    }
    els.info.textContent = s.phase === 'gallery' ? `⏱ ${secs}s para votar` : `Rodada ${s.round}/${s.rounds} · ⏱ ${secs}s`;
    // Cobertura: escolher a palavra (quem desenha) ou aviso
    els.cover.replaceChildren();
    els.cover.hidden = true;
    if (s.phase === 'choose' && isMe(s.drawer) && s.choices) {
      els.cover.hidden = false;
      const box = h('div', 'draw-choices');
      box.append(h('div', 'draw-choose-title', 'O que você vai desenhar?'));
      s.choices.forEach((c, i) => {
        const b = h('button', 'btn primary draw-choice');
        b.type = 'button';
        b.append(h('span', '', c.word), h('span', `draw-level ${c.galera ? 'galera' : c.level}`, c.galera ? 'galera' : LEVELS[c.level]));
        b.onclick = () => ctx.send({ cell: i });
        box.append(b);
      });
      els.cover.append(box);
    } else if (s.phase === 'reveal') {
      els.cover.hidden = false;
      els.cover.append(h('div', 'draw-reveal', `A palavra era: ${s.word?.toUpperCase()}`));
    }
    els.canvas.classList.toggle('can-draw', canDraw());
    els.canvas.dataset.tool = tool;
    if (s.phase !== prev?.phase || s.drawer !== prev?.drawer || !els.tools.children.length !== !canDraw()) renderTools(ctx, s);
    renderGallery(s, ctx);
    // Placar
    els.side.replaceChildren(h('div', 'draw-scores-title', 'Pontos'));
    for (const p of [...s.players].sort((a, b) => b.score - a.score)) {
      const row = h('div', 'draw-score-row');
      row.classList.toggle('guessed', s.guessed.includes(p.id));
      row.classList.toggle('gone', !p.alive);
      const mark = p.id === s.drawer && s.phase !== 'gallery' ? '✏️' : s.guessed.includes(p.id) ? '✅' : '';
      row.append(h('span', 'draw-mark', mark), h('span', 'draw-name', p.name), h('span', 'draw-pts', String(p.score)));
      els.side.append(row);
    }
    if (!prev || prev.phase !== s.phase) paint();
    let status = s.phase === 'gallery' ? `🖼️ Galeria · ⏱ ${secs}s` : `⏱ ${secs}s`;
    if (s.phase === 'draw' && !isMe(s.drawer) && !s.guessed.includes(ctx.me)) status += ' · chute no chat!';
    return { status, overlay: '', end: s.winner ? null : 'Fim de jogo' };
  },
};
