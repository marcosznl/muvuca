// "Última!" no site: a mesa (monte, descarte e a cor da vez), os outros com as cartas viradas,
// a sua mão embaixo (as que dá para jogar sobem) e os botões Comprar / Passar / Última! / Pegou!
// Cores da bandeira e cartas com nome nosso: Deu ruim, Meia-volta, Fiado, Jeitinho e Leão da Receita.
import { h } from '../util.js';
import { fitCanvas, roundRect, drawToken, drawLabel, isMe, EMOJI_FONT } from './common.js';

const W = 16;
const H = 10;
const COLORS = ['green', 'yellow', 'blue', 'white'];
const FILL = { green: '#009c3b', yellow: '#f5c400', blue: '#002776', white: '#f4f4f5' };
const COLOR_NAME = { green: 'verde', yellow: 'amarelo', blue: 'azul', white: 'branco' };
const SYMBOL = { skip: '⊘', reverse: '⇄', draw2: '+2', wild: '', wild4: '🦁' };
const CAPTION = { skip: 'DEU RUIM', reverse: 'MEIA-VOLTA', draw2: 'FIADO', wild: 'JEITINHO', wild4: 'LEÃO DA RECEITA' };
const INK = (color) => (color === 'white' || color === 'yellow' ? '#1e1f22' : '#fff'); // texto que aparece em cima da cor
const FONT = '"Noto Sans", system-ui, sans-serif';

let hits = [];          // áreas clicáveis desta tela (em pixels do canvas)
let hover = null;       // área com o mouse em cima
let choosing = null;    // coringa escolhido, esperando a cor
let swapping = null;    // sete escolhido (regra "sete troca"), esperando com quem trocar
let latest = null;

const myTurn = (s) => !!s && !s.over && isMe(s.turn);
// Na sua vez: mesma cor/número (com acumulado, só outra de compra). Fora da vez: corte com a carta igualzinha
function playable(s, c) {
  if (!s) return false;
  if (!myTurn(s)) return !!s.rules?.corte && !s.pendingDraw && c.color !== null && c.color === s.top.color && c.value === s.top.value;
  if (s.drewThisTurn && s.drewThisTurn !== c.id) return false;
  if (s.pendingDraw) return c.value === 'wild4' || (c.value === 'draw2' && s.top.value === 'draw2');
  return c.color === null || c.color === s.color || c.value === s.top.value;
}

// ---------- Desenho de uma carta ----------

function drawCard(g, x, y, w, hh, card, { lift = 0, dim = false } = {}) {
  y -= lift;
  g.save();
  g.shadowColor = 'rgba(0,0,0,.45)';
  g.shadowBlur = w * 0.18;
  g.shadowOffsetY = w * 0.05;
  g.fillStyle = '#fff';
  roundRect(g, x, y, w, hh, w * 0.12);
  g.fill();
  g.restore();
  const pad = w * 0.07;
  g.fillStyle = card.color ? FILL[card.color] : '#1e1f22';
  roundRect(g, x + pad, y + pad, w - pad * 2, hh - pad * 2, w * 0.09);
  g.fill();
  if (card.color === 'white') { g.strokeStyle = '#c4c6cc'; g.lineWidth = 1; g.stroke(); }
  const cx = x + w / 2;
  const cy = y + hh / 2;
  // Oval inclinado no meio (no coringa, com as quatro cores)
  g.save();
  g.translate(cx, cy);
  g.rotate(-0.45);
  g.beginPath();
  g.ellipse(0, 0, w * 0.34, hh * 0.36, 0, 0, Math.PI * 2);
  if (card.color) { g.fillStyle = card.color === 'white' ? '#002776' : '#fff'; g.fill(); } else {
    g.clip();
    COLORS.forEach((c, i) => {
      g.fillStyle = FILL[c];
      g.fillRect(i % 2 ? 0 : -w, i < 2 ? -hh : 0, w, hh);
    });
  }
  g.restore();
  const text = SYMBOL[card.value] ?? card.value;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  if (card.value === 'wild4') {
    g.font = `${Math.floor(hh * 0.34)}px ${EMOJI_FONT}`;
    g.fillText(text, cx, cy - hh * 0.02);
  } else if (text) {
    g.font = `900 ${Math.floor(hh * (text.length > 1 ? 0.3 : 0.4))}px ${FONT}`;
    g.lineWidth = Math.max(1.5, w * 0.03);
    g.strokeStyle = card.color && card.color !== 'white' ? 'rgba(0,0,0,.25)' : '#000';
    g.fillStyle = card.color === 'white' ? '#fff' : card.color ? FILL[card.color] : '#fff';
    g.strokeText(text, cx, cy + hh * 0.02);
    g.fillText(text, cx, cy + hh * 0.02);
  }
  // Nome da carta especial, embaixo
  if (CAPTION[card.value]) {
    g.font = `900 ${Math.max(6, Math.floor(w * (CAPTION[card.value].length > 10 ? 0.095 : 0.12)))}px ${FONT}`;
    g.fillStyle = card.color ? INK(card.color) : '#fff';
    g.fillText(CAPTION[card.value], cx, y + hh * 0.8);
  }
  // Cantinhos
  g.font = `800 ${Math.floor(hh * 0.13)}px ${FONT}`;
  g.fillStyle = card.color ? INK(card.color) : '#fff';
  const corner = card.value === 'wild4' ? '+4' : text || '★';
  g.fillText(corner, x + w * 0.2, y + hh * 0.13);
  g.save();
  g.translate(x + w * 0.8, y + hh * 0.87);
  g.rotate(Math.PI);
  g.fillText(corner, 0, 0);
  g.restore();
  if (dim) {
    g.fillStyle = 'rgba(0,0,0,.35)';
    roundRect(g, x, y, w, hh, w * 0.12);
    g.fill();
  }
}

function drawBack(g, x, y, w, hh) {
  g.fillStyle = '#fff';
  roundRect(g, x, y, w, hh, w * 0.12);
  g.fill();
  // Verso com a bandeira: fundo verde, losango amarelo e o círculo azul
  g.fillStyle = FILL.green;
  roundRect(g, x + w * 0.07, y + w * 0.07, w * 0.86, hh - w * 0.14, w * 0.09);
  g.fill();
  const cx = x + w / 2;
  const cy = y + hh / 2;
  g.fillStyle = FILL.yellow;
  g.beginPath();
  g.moveTo(cx, cy - hh * 0.36); g.lineTo(cx + w * 0.36, cy); g.lineTo(cx, cy + hh * 0.36); g.lineTo(cx - w * 0.36, cy);
  g.closePath();
  g.fill();
  g.fillStyle = FILL.blue;
  g.beginPath(); g.arc(cx, cy, w * 0.2, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#fff';
  g.font = `900 ${Math.floor(w * 0.1)}px ${FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('ÚLTIMA!', cx, cy + 1);
}

function button(g, x, y, w, hh, label, color, action) {
  g.fillStyle = color;
  roundRect(g, x, y, w, hh, hh * 0.3);
  g.fill();
  if (hover === action) { g.fillStyle = 'rgba(255,255,255,.18)'; g.fill(); } // clareia com o mouse em cima
  g.fillStyle = '#fff';
  g.font = `800 ${Math.floor(hh * 0.42)}px ${FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(label, x + w / 2, y + hh / 2 + 1);
  hits.push({ x, y, w, h: hh, action });
}

// ---------- A mesa ----------

function draw(canvas, snaps) {
  const snap = snaps[snaps.length - 1];
  latest = snap ?? null;
  const { g, tile: t, cw, ch } = fitCanvas(canvas, W, H);
  hits = [];
  // Feltro
  const grad = g.createRadialGradient(cw / 2, ch * 0.45, t, cw / 2, ch / 2, cw * 0.7);
  grad.addColorStop(0, '#1f5f46');
  grad.addColorStop(1, '#123829');
  g.fillStyle = grad;
  roundRect(g, 0, 0, cw, ch, t * 0.4);
  g.fill();
  const s = snap?.s;
  if (!s) return null;

  // Os outros, em cima: foto, nome e as cartas viradas
  const others = s.players.filter((p) => !isMe(p.id));
  const slot = W / Math.max(1, others.length);
  others.forEach((p, i) => {
    const cx = (slot * i + slot / 2) * t;
    const turn = s.turn === p.id;
    g.globalAlpha = p.alive ? 1 : 0.35;
    if (turn) {
      g.fillStyle = 'rgba(255,209,102,.18)';
      roundRect(g, cx - slot * t * 0.45, t * 0.15, slot * t * 0.9, t * 2.35, t * 0.3);
      g.fill();
    }
    drawToken(g, cx - t * 0.9, t * 0.9, t * 0.45, p, { ring: 0.14 });
    const n = Math.min(p.cards, 7);
    for (let k = 0; k < n; k++) drawBack(g, cx - t * 0.2 + k * t * 0.16, t * 0.45, t * 0.62, t * 0.9);
    g.font = `800 ${Math.floor(t * 0.34)}px ${FONT}`;
    g.fillStyle = '#fff';
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    g.fillText(String(p.cards), cx + t * 0.55 + n * t * 0.16, t * 0.9);
    drawLabel(g, cx, t * 2.2, (turn ? '▶ ' : '') + p.name, t * 0.3);
    if (p.cards === 1 && p.called) {
      g.font = `900 ${Math.floor(t * 0.3)}px ${FONT}`;
      g.fillStyle = '#ffd166';
      g.textAlign = 'center';
      g.fillText('ÚLTIMA!', cx, t * 0.3);
    }
    g.globalAlpha = 1;
  });

  // Centro: monte, descarte e a cor que vale agora
  const cardW = t * 1.5;
  const cardH = t * 2.2;
  const pileX = t * 5.4;
  const pileY = t * 3;
  drawBack(g, pileX, pileY, cardW, cardH);
  g.fillStyle = 'rgba(255,255,255,.75)';
  g.font = `600 ${Math.floor(t * 0.26)}px ${FONT}`;
  g.textAlign = 'center';
  g.fillText(`${s.drawCount} no monte`, pileX + cardW / 2, pileY + cardH + t * 0.3);
  const discX = t * 7.4;
  roundRect(g, discX - t * 0.18, pileY - t * 0.18, cardW + t * 0.36, cardH + t * 0.36, t * 0.3);
  g.strokeStyle = 'rgba(255,255,255,.7)'; // contorno claro por fora: a moldura aparece até em azul-escuro
  g.lineWidth = t * 0.2;
  g.stroke();
  g.strokeStyle = FILL[s.color];
  g.lineWidth = t * 0.12;
  g.stroke();
  drawCard(g, discX, pileY, cardW, cardH, s.top);
  // "vale azul": texto branco com a bolinha da cor (azul-escuro no feltro verde não dá para ler)
  g.font = `800 ${Math.floor(t * 0.28)}px ${FONT}`;
  const valeText = `vale ${COLOR_NAME[s.color]}`;
  const vw = g.measureText(valeText).width;
  const vy = pileY + cardH + t * 0.42;
  g.fillStyle = FILL[s.color];
  g.beginPath(); g.arc(discX + cardW / 2 - vw / 2 - t * 0.2, vy, t * 0.13, 0, Math.PI * 2); g.fill();
  g.strokeStyle = '#fff';
  g.lineWidth = 1.5;
  g.stroke();
  g.fillStyle = '#fff';
  g.fillText(valeText, discX + cardW / 2 + t * 0.08, vy);
  // Acumulado (regra acumular)
  if (s.pendingDraw) {
    g.font = `900 ${Math.floor(t * 0.42)}px ${FONT}`;
    g.fillStyle = '#ffd166';
    g.fillText(`Acumulado: +${s.pendingDraw}`, discX + cardW / 2, pileY - t * 0.45);
  }
  // Sentido da rodada
  g.fillStyle = 'rgba(255,255,255,.55)';
  g.font = `${Math.floor(t * 0.8)}px ${EMOJI_FONT}`;
  g.fillText(s.dir === 1 ? '↻' : '↺', t * 4.4, pileY + cardH / 2);

  // O que acabou de acontecer
  g.font = `600 ${Math.floor(t * 0.27)}px ${FONT}`;
  g.fillStyle = 'rgba(255,255,255,.85)';
  s.log.slice(-2).forEach((line, i) => g.fillText(line, W * t / 2, t * 6.15 + i * t * 0.36));

  // Botões à direita
  const me = s.players.find((p) => isMe(p.id));
  const bx = t * 10.6;
  let by = t * 3;
  if (myTurn(s) && !s.drewThisTurn) {
    button(g, bx, by, t * 2.6, t * 0.75, s.pendingDraw ? `Comprar ${s.pendingDraw}` : 'Comprar', s.pendingDraw ? '#e5484d' : '#5865f2', 'draw');
    by += t * 0.95;
  }
  if (myTurn(s) && s.drewThisTurn) { button(g, bx, by, t * 2.6, t * 0.75, 'Passar', '#4e5058', 'pass'); by += t * 0.95; }
  if (me && me.cards <= 2 && !me.called && me.alive) { button(g, bx, by, t * 2.6, t * 0.75, 'ÚLTIMA! 📣', '#e5484d', 'call'); by += t * 0.95; }
  if (s.catchable && !isMe(s.catchable)) {
    const who = s.players.find((p) => p.id === s.catchable)?.name ?? 'alguém';
    button(g, bx, by, t * 2.6, t * 0.75, `PEGOU ${who.split(' ')[0].toUpperCase()}!`, '#f0b429', 'catch');
  }

  // Minha mão
  const hand = s.hand;
  const hw = t * 1.3;
  const hh = t * 1.9;
  const gap = Math.min(hw * 1.08, (W * t - t * 1.2 - hw) / Math.max(1, hand.length - 1));
  const total = gap * (hand.length - 1) + hw;
  const start = (W * t - total) / 2;
  const baseY = H * t - hh - t * 0.25;
  hand.forEach((c, i) => {
    const x = start + i * gap;
    const can = playable(s, c);
    const action = `card:${c.id}`;
    const lift = (can ? t * 0.35 : 0) + (hover === action && can ? t * 0.2 : 0);
    drawCard(g, x, baseY, hw, hh, c, { lift, dim: myTurn(s) && !can });
    // Área clicável: a parte visível (a última carta inteira)
    hits.push({ x, y: baseY - lift, w: i === hand.length - 1 ? hw : gap, h: hh + lift, action });
  });

  // Escolhendo a cor do coringa
  if (choosing) {
    g.fillStyle = 'rgba(0,0,0,.6)';
    g.fillRect(0, 0, cw, ch);
    g.fillStyle = '#fff';
    g.font = `800 ${Math.floor(t * 0.4)}px ${FONT}`;
    g.textAlign = 'center';
    g.fillText('Escolha a cor', cw / 2, t * 2.4);
    COLORS.forEach((c, i) => {
      const x = cw / 2 - t * 3.3 + i * t * 1.7;
      const on = hover === `color:${c}`;
      g.fillStyle = FILL[c];
      roundRect(g, x, t * 3 - (on ? t * 0.15 : 0), t * 1.5, t * 1.5, t * 0.3);
      g.fill();
      if (c === 'white') { g.strokeStyle = '#c4c6cc'; g.lineWidth = 2; g.stroke(); }
      g.fillStyle = '#fff';
      g.font = `700 ${Math.floor(t * 0.26)}px ${FONT}`;
      g.fillText(COLOR_NAME[c], x + t * 0.75, t * 4.9);
      hits.push({ x, y: t * 3 - t * 0.15, w: t * 1.5, h: t * 1.8, action: `color:${c}` });
    });
    button(g, cw / 2 - t * 1, t * 5.6, t * 2, t * 0.65, 'Cancelar', '#4e5058', 'cancel');
  }

  // Sete troca: com quem trocar a mão
  if (swapping) {
    g.fillStyle = 'rgba(0,0,0,.6)';
    g.fillRect(0, 0, cw, ch);
    g.fillStyle = '#fff';
    g.font = `800 ${Math.floor(t * 0.4)}px ${FONT}`;
    g.textAlign = 'center';
    g.fillText('Trocar a mão com quem?', cw / 2, t * 2.4);
    const targets = s.players.filter((p) => !isMe(p.id) && p.alive);
    targets.forEach((p, i) => {
      const bw = t * 3;
      const x = cw / 2 - (targets.length * (bw + t * 0.3)) / 2 + i * (bw + t * 0.3);
      button(g, x, t * 3.2, bw, t * 0.8, `${p.name.split(' ')[0]} (${p.cards})`, '#5865f2', `swap:${p.id}`);
    });
    button(g, cw / 2 - t * 1, t * 4.5, t * 2, t * 0.65, 'Cancelar', '#4e5058', 'cancel');
  }

  const left = Math.max(0, s.turnLeft - (performance.now() - snap.at));
  const who = s.players.find((p) => p.id === s.turn);
  let status = '';
  if (who) status = `${isMe(who.id) ? 'Sua vez' : `Vez de ${who.name}`}${who.bot ? '' : ` · ⏱ ${Math.ceil(left / 1000)}s`}`;
  return { status, overlay: '', end: s.winner ? null : 'Fim de jogo' };
}

// ---------- Cliques ----------

function hitAt(e) {
  const px = e.x * e.canvas.clientWidth;
  const py = e.y * e.canvas.clientHeight;
  // De trás para frente: o que foi desenhado por último fica por cima
  for (let i = hits.length - 1; i >= 0; i--) {
    const r = hits[i];
    if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) return r.action;
  }
  return null;
}

function click(action, api) {
  const s = latest?.s;
  if (!s || !action) return;
  if (choosing) {
    if (action.startsWith('color:')) api.send({ card: choosing, color: action.slice(6) });
    if (action.startsWith('color:') || action === 'cancel') choosing = null;
    return;
  }
  if (swapping) {
    if (action.startsWith('swap:')) api.send({ card: swapping, target: action.slice(5) });
    if (action.startsWith('swap:') || action === 'cancel') swapping = null;
    return;
  }
  if (['draw', 'pass', 'call', 'catch'].includes(action)) return api.send({ act: action });
  if (action.startsWith('card:')) {
    const id = Number(action.slice(5));
    const c = s.hand.find((x) => x.id === id);
    if (!c || !playable(s, c)) return;
    if (c.color === null) { choosing = id; return; } // coringa: primeiro a cor
    if (s.rules?.sete && c.value === '7' && s.hand.length > 1) { swapping = id; return; } // sete troca: com quem?
    api.send({ card: id });
  }
}

export default {
  emoji: '🃏',
  title: 'Última!',
  desc: 'De 2 a 8 pessoas (com robôs quando tem pouca gente). Nas cores da bandeira, com Deu ruim, Meia-volta, Fiado, Jeitinho e o temido Leão da Receita. Com uma carta, grite "Última!" antes que te peguem!',
  help: () => [h('span', 'kbd', 'clique'), ' na carta para jogar · ', h('span', 'kbd', 'Espaço'), ' compra · ', h('span', 'kbd', 'U'), ' grita Última!'],
  touchHelp: 'Toque na carta para jogar · botões à direita',
  draw,
  reset() { choosing = null; swapping = null; hover = null; },
  pointer(type, e, api) {
    if (e.target !== e.canvas) return;
    const action = hitAt(e);
    if (type === 'pointermove') {
      hover = action;
      e.canvas.style.cursor = action ? 'pointer' : '';
    }
    if (type === 'pointerdown' && e.button === 0) click(action, api);
  },
  keydown(e, api) {
    if (e.code === 'Space') { if (!e.repeat && myTurn(latest?.s)) api.send({ act: latest.s.drewThisTurn ? 'pass' : 'draw' }); return true; }
    if (e.code === 'KeyU') { api.send({ act: 'call' }); return true; }
    if (e.code === 'KeyP') { api.send({ act: 'catch' }); return true; }
    if (e.code === 'Escape' && (choosing || swapping)) { choosing = null; swapping = null; return true; }
    return false;
  },
};
