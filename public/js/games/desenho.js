// "Desenha aí" no site: quem desenha usa o mouse/dedo na tela (cores, tamanhos, desfazer, limpar);
// os outros chutam no chat da sala. A palavra aparece como _ _ _ para quem ainda não acertou.
import { h } from '../util.js';
import { isMe } from './common.js';

let strokes = [];     // o desenho inteiro (o que o servidor confirmou)
let syncing = false;
let color = 0;
let size = 1;
let drawingNow = null; // traço em andamento: { points, sent }
let last = null;      // último estado recebido
let els = null;       // elementos montados

const ASPECT = 3 / 4;

function paint(ctx, s) {
  const cv = els?.canvas;
  if (!cv) return;
  const rect = els.board.getBoundingClientRect();
  const w = Math.max(200, Math.floor(rect.width));
  const hh = Math.floor(w * ASPECT);
  const dpr = window.devicePixelRatio || 1;
  if (cv.width !== w * dpr) { cv.width = w * dpr; cv.height = hh * dpr; cv.style.width = `${w}px`; cv.style.height = `${hh}px`; }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = '#fff';
  g.fillRect(0, 0, w, hh);
  const colors = s?.colors ?? ['#000'];
  const sizes = s?.sizes ?? [3, 8, 16, 32];
  const line = (st) => {
    g.strokeStyle = colors[st.c] ?? '#000';
    g.fillStyle = colors[st.c] ?? '#000';
    const lw = sizes[st.w] * (w / 800);
    g.lineWidth = lw;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    const pts = st.p.map(([x, y]) => [(x / 1000) * w, (y / 1000) * hh]);
    if (pts.length === 1) { g.beginPath(); g.arc(pts[0][0], pts[0][1], lw / 2, 0, Math.PI * 2); g.fill(); return; }
    g.beginPath();
    g.moveTo(...pts[0]);
    for (const p of pts.slice(1)) g.lineTo(...p);
    g.stroke();
  };
  for (const st of strokes) line(st);
  if (drawingNow) line({ c: color, w: size, p: drawingNow.points });
}

function pointFrom(e) {
  const r = els.canvas.getBoundingClientRect();
  return [Math.round(((e.clientX - r.left) / r.width) * 1000), Math.round(((e.clientY - r.top) / r.height) * 1000)];
}

// Manda o traço em pedaços (a cada 60 ms), cada pedaço começando onde o outro parou
function flush(ctx, final = false) {
  if (!drawingNow) return;
  const pts = drawingNow.points.slice(drawingNow.sent ? drawingNow.sent - 1 : 0);
  if (pts.length >= (drawingNow.sent ? 2 : 1)) {
    ctx.send({ stroke: { c: color, w: size, p: pts } });
    drawingNow.sent = drawingNow.points.length;
  }
  if (final) drawingNow = null;
}

function mountDom(el, ctx) {
  el.replaceChildren();
  const top = h('div', 'draw-top');
  const word = h('div', 'draw-word');
  const info = h('div', 'draw-info muted small');
  top.append(word, info);
  const board = h('div', 'draw-board');
  const canvas = h('canvas', 'draw-canvas');
  const cover = h('div', 'draw-cover');
  board.append(canvas, cover);
  const tools = h('div', 'draw-tools');
  const side = h('div', 'draw-scores');
  const main = h('div', 'draw-main');
  main.append(top, board, tools);
  el.append(main, side);
  els = { el, top, word, info, board, canvas, cover, tools, side };
  let timer = null;
  canvas.addEventListener('pointerdown', (e) => {
    if (!canDraw()) return;
    e.preventDefault();
    canvas.setPointerCapture?.(e.pointerId);
    drawingNow = { points: [pointFrom(e)], sent: 0 };
    timer = setInterval(() => flush(ctx), 60);
    paint(ctx, last);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drawingNow) return;
    const p = pointFrom(e);
    const q = drawingNow.points.at(-1);
    if (Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) < 4) return;
    drawingNow.points.push(p);
    if (drawingNow.points.length - drawingNow.sent > 250) flush(ctx);
    paint(ctx, last);
  });
  const end = () => { if (!drawingNow) return; clearInterval(timer); flush(ctx, true); };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('lostpointercapture', end);
  new ResizeObserver(() => paint(ctx, last)).observe(board);
}

const canDraw = () => last && !last.over && last.phase === 'draw' && isMe(last.drawer);

function renderTools(ctx, s) {
  const t = els.tools;
  t.replaceChildren();
  if (!canDraw()) return;
  s.colors.forEach((c, i) => {
    const b = h('button', i === color ? 'draw-color on' : 'draw-color');
    b.type = 'button';
    b.style.background = c;
    b.title = 'Cor';
    b.onclick = () => { color = i; renderTools(ctx, s); };
    t.append(b);
  });
  t.append(h('span', 'draw-sep'));
  s.sizes.forEach((px, i) => {
    const b = h('button', i === size ? 'draw-size on' : 'draw-size');
    b.type = 'button';
    const dot = h('span', 'draw-dot');
    dot.style.width = dot.style.height = `${Math.min(26, px * 0.8 + 3)}px`;
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

export default {
  emoji: '🎨',
  title: 'Desenha aí',
  desc: 'De 2 a 10 pessoas. Um desenha, o resto chuta no chat. Quanto mais rápido acertar, mais pontos. Estilo Gartic!',
  help: () => [h('span', 'kbd', 'mouse'), ' desenha · palpites pelo ', h('span', 'kbd', 'chat da sala')],
  touchHelp: 'Desenhe com o dedo · chute no chat da sala',
  dom: true,
  chatPlaceholder: 'Chute a palavra aqui…',
  reset() { strokes = []; drawingNow = null; color = 0; size = 1; },
  mount() { els = null; },
  onEvents(events, ctx) {
    for (const ev of events) {
      if (ev.type === 'stroke') strokes.push(ev.stroke);
      if (ev.type === 'clear') strokes = [];
      if (ev.type === 'undo') strokes.pop();
    }
    paint(ctx, last);
  },
  render(el, s, ctx) {
    if (!els || els.el !== el || !el.isConnected) mountDom(el, ctx);
    const prev = last;
    last = s;
    // Chegou no meio (ou perdeu eventos): pede o desenho inteiro
    if (s.strokeCount !== strokes.length && !syncing && !drawingNow) {
      syncing = true;
      ctx.request({ t: 'game:sync', roomId: ctx.room.id }).then((r) => { if (r.data) strokes = r.data.strokes; paint(ctx, last); })
        .finally(() => { syncing = false; });
    }
    const drawer = s.players.find((p) => p.id === s.drawer);
    const secs = Math.ceil(s.timeLeft / 1000);
    // Palavra
    els.word.replaceChildren();
    if (s.phase === 'choose') {
      els.word.append(isMe(s.drawer) ? 'Escolha a palavra:' : `${drawer?.name ?? '?'} está escolhendo a palavra…`);
    } else if (s.word) {
      const spaced = h('span', 'draw-letters', [...s.word].join(' '));
      els.word.append(spaced, h('span', 'muted small', ` (${s.wordLength} letras)`));
    }
    els.info.textContent = `Rodada ${s.round}/${s.rounds} · ⏱ ${secs}s`;
    // Cobertura: escolher a palavra (quem desenha) ou aviso
    els.cover.replaceChildren();
    els.cover.hidden = true;
    if (s.phase === 'choose' && isMe(s.drawer) && s.choices) {
      els.cover.hidden = false;
      const box = h('div', 'draw-choices');
      box.append(h('div', 'draw-choose-title', 'O que você vai desenhar?'));
      s.choices.forEach((w, i) => {
        const b = h('button', 'btn primary', w);
        b.type = 'button';
        b.onclick = () => ctx.send({ cell: i });
        box.append(b);
      });
      els.cover.append(box);
    } else if (s.phase === 'reveal') {
      els.cover.hidden = false;
      els.cover.append(h('div', 'draw-reveal', `A palavra era: ${s.word?.toUpperCase()}`));
    }
    els.canvas.classList.toggle('can-draw', canDraw());
    if (s.phase !== prev?.phase || s.drawer !== prev?.drawer || !els.tools.children.length !== !canDraw()) renderTools(ctx, s);
    // Placar da rodada
    els.side.replaceChildren(h('div', 'draw-scores-title', 'Pontos'));
    for (const p of [...s.players].sort((a, b) => b.score - a.score)) {
      const row = h('div', 'draw-score-row');
      row.classList.toggle('guessed', s.guessed.includes(p.id));
      row.classList.toggle('gone', !p.alive);
      const mark = p.id === s.drawer ? '✏️' : s.guessed.includes(p.id) ? '✅' : '';
      row.append(h('span', 'draw-mark', mark), h('span', 'draw-name', p.name + (isMe(p.id) ? ' (você)' : '')), h('span', 'draw-pts', String(p.score)));
      els.side.append(row);
    }
    paint(ctx, s);
    let status = `⏱ ${secs}s`;
    if (s.phase === 'draw' && !isMe(s.drawer) && !s.guessed.includes(ctx.me)) status += ' · chute no chat!';
    return { status, overlay: '', end: s.winner ? null : 'Fim de jogo' };
  },
};

