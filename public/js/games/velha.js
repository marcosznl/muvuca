// Jogo da velha no site: clique numa casa na sua vez
import { h } from '../util.js';
import { fitCanvas, roundRect, colorOf, isMe, avatarImage } from './common.js';

const HEAD = 0.4; // altura da faixa de cima (em casas)
let hover = null; // casa com o mouse em cima
let latest = null;

const myTurn = () => !!latest && !latest.s.over && isMe(latest.s.turn);

function drawMark(g, p, x, y, size) {
  const cx = x + size / 2;
  const cy = y + size / 2;
  const r = size * 0.3;
  g.strokeStyle = colorOf(p.color);
  g.lineWidth = Math.max(4, size * 0.09);
  g.lineCap = 'round';
  g.beginPath();
  if (p.mark === 'X') {
    g.moveTo(cx - r, cy - r); g.lineTo(cx + r, cy + r);
    g.moveTo(cx + r, cy - r); g.lineTo(cx - r, cy + r);
  } else {
    g.arc(cx, cy, r, 0, Math.PI * 2);
  }
  g.stroke();
  // Foto pequenininha no canto de cada marca (para saber de quem é)
  const photo = avatarImage(p.id);
  if (photo) {
    const s = size * 0.2;
    g.save();
    g.beginPath(); g.arc(x + size - s * 0.8, y + s * 0.8, s / 2, 0, Math.PI * 2); g.clip();
    g.drawImage(photo, x + size - s * 1.3, y + s * 0.3, s, s);
    g.restore();
  }
}

function draw(canvas, snaps) {
  latest = snaps[snaps.length - 1] ?? null;
  const { g, tile, cw } = fitCanvas(canvas, 3, 3 + HEAD, { minTile: 60 });
  const s = latest?.s;
  // Faixa de cima: de quem é a vez e o relógio
  const left = s ? Math.max(0, s.turnLeft - (performance.now() - latest.at)) : 0;
  const who = s?.players.find((p) => p.id === s.turn);
  const status = who ? `${isMe(who.id) ? 'Sua vez' : `Vez de ${who.name}`} (${who.mark}) · ⏱ ${Math.ceil(left / 1000)}s` : '';
  if (who) {
    g.font = `700 ${Math.floor(tile * 0.17)}px "Noto Sans", system-ui, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = isMe(who.id) ? colorOf(who.color) : '#b5bac1';
    g.fillText(status, cw / 2, tile * HEAD * 0.45);
  }
  g.translate(0, tile * HEAD);
  g.fillStyle = '#2b2d31';
  roundRect(g, 0, 0, cw, tile * 3, 12);
  g.fill();
  if (s && myTurn() && hover !== null && s.board[hover] === null) {
    g.fillStyle = 'rgba(255,255,255,.06)';
    g.fillRect((hover % 3) * tile, Math.floor(hover / 3) * tile, tile, tile);
  }
  g.strokeStyle = '#4e5058';
  g.lineWidth = Math.max(3, tile * 0.03);
  g.lineCap = 'round';
  g.beginPath();
  for (let i = 1; i < 3; i++) {
    g.moveTo(i * tile, tile * 0.1); g.lineTo(i * tile, tile * 2.9);
    g.moveTo(tile * 0.1, i * tile); g.lineTo(tile * 2.9, i * tile);
  }
  g.stroke();
  if (!s) return null;
  s.board.forEach((v, i) => {
    if (v !== null) drawMark(g, s.players[v], (i % 3) * tile, Math.floor(i / 3) * tile, tile);
  });
  if (s.line) {
    const c = (i) => [(i % 3) * tile + tile / 2, Math.floor(i / 3) * tile + tile / 2];
    const [x1, y1] = c(s.line[0]);
    const [x2, y2] = c(s.line[2]);
    g.strokeStyle = 'rgba(255,255,255,.85)';
    g.lineWidth = Math.max(6, tile * 0.07);
    g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
  }

  return { status, overlay: '', end: s.winner ? null : 'Deu velha! 🤝' };
}

export default {
  emoji: '⭕',
  title: 'Jogo da velha',
  desc: '2 pessoas, ou você contra o robô. Quem começa alterna a cada partida; cada vez tem 20 segundos.',
  help: () => [h('span', 'kbd', 'clique'), ' numa casa na sua vez'],
  touchHelp: 'Toque numa casa na sua vez',
  draw,
  reset() { hover = null; },
  pointer(type, e, api) {
    const inside = e.target === e.canvas && e.x >= 0 && e.y >= 0 && e.x < 1 && e.y < 1;
    const by = (e.y * (3 + HEAD) - HEAD) / 3; // descontando a faixa de cima
    const cell = inside && by >= 0 ? Math.floor(e.x * 3) + Math.floor(Math.min(0.999, by) * 3) * 3 : null;
    if (type === 'pointermove') { hover = cell; e.canvas.style.cursor = cell !== null && myTurn() && latest.s.board[cell] === null ? 'pointer' : ''; }
    if (type === 'pointerdown' && cell !== null && myTurn() && e.button === 0) api.send({ cell });
  },
};
