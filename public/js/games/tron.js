// Tron no site: rastros de luz numa grade escura; as setas só viram (a moto nunca para)
import { h } from '../util.js';
import { DIR_KEYS, fitCanvas, drawToken, drawLabel, colorOf, clock, isMe } from './common.js';

const W = 64;
const H = 44;
const DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

function drawArena(g, tile, w, hh) {
  g.fillStyle = '#0b0e1a';
  g.fillRect(0, 0, w * tile, hh * tile);
  g.strokeStyle = 'rgba(88,101,242,.10)';
  g.lineWidth = 1;
  g.beginPath();
  for (let x = 0; x <= w; x += 2) { g.moveTo(x * tile, 0); g.lineTo(x * tile, hh * tile); }
  for (let y = 0; y <= hh; y += 2) { g.moveTo(0, y * tile); g.lineTo(w * tile, y * tile); }
  g.stroke();
  g.strokeStyle = 'rgba(120,140,255,.55)';
  g.lineWidth = 2;
  g.strokeRect(1, 1, w * tile - 2, hh * tile - 2);
}

function draw(canvas, snaps) {
  const last = snaps[snaps.length - 1];
  const s = last?.s;
  const w = s?.w ?? W;
  const hh = s?.h ?? H;
  const { g, tile } = fitCanvas(canvas, w, hh);
  drawArena(g, tile, w, hh);
  if (!s) return null;

  // A cabeça segue andando entre uma atualização e outra (no máximo até o próximo quadradinho)
  const moving = !s.over && !s.countdown;
  const ahead = moving ? Math.min(1, s.p + (s.speed * (performance.now() - last.at)) / 1000) : s.p;
  const center = (v) => (v + 0.5) * tile;
  const heads = new Map();
  for (const p of s.players) {
    const [dx, dy] = DIRS[p.dir];
    const t = p.alive ? ahead : 0;
    heads.set(p.id, [p.x + dx * t, p.y + dy * t]);
  }

  // Rastros (brilham; de quem já bateu ficam apagados)
  g.lineCap = 'square';
  g.lineJoin = 'miter';
  for (const p of s.players) {
    const [hx, hy] = heads.get(p.id);
    g.save();
    g.globalAlpha = p.alive ? 1 : 0.35;
    g.strokeStyle = colorOf(p.color);
    g.lineWidth = Math.max(2, tile * 0.55);
    if (p.alive) { g.shadowColor = colorOf(p.color); g.shadowBlur = tile * 0.8; }
    g.beginPath();
    const [sx, sy] = p.path[0];
    g.moveTo(center(sx), center(sy));
    for (const [x, y] of p.path.slice(1)) g.lineTo(center(x), center(y));
    g.lineTo(center(p.x), center(p.y));
    g.lineTo(center(hx), center(hy));
    g.stroke();
    g.restore();
  }

  // Cabeças com a foto; o X marca onde bateu
  for (const p of s.players) {
    const [hx, hy] = heads.get(p.id);
    const cx = center(hx);
    const cy = center(hy);
    if (!p.alive) {
      g.strokeStyle = '#fff';
      g.lineWidth = Math.max(2, tile * 0.2);
      const r = tile * 0.7;
      g.beginPath(); g.moveTo(cx - r, cy - r); g.lineTo(cx + r, cy + r); g.moveTo(cx + r, cy - r); g.lineTo(cx - r, cy + r); g.stroke();
      continue;
    }
    drawToken(g, cx, cy, Math.max(7, tile * 1.1), p, { ring: 0.25 });
    if (s.countdown || isMe(p.id)) drawLabel(g, cx, cy - tile * 1.4, p.name, Math.max(10, tile * 0.8));
  }

  const me = s.players.find((p) => isMe(p.id));
  let overlay = '';
  if (s.countdown) overlay = `Prepare-se… ${Math.ceil(s.countdown / 1000)}`;
  else if (me && !me.alive) overlay = '💥 Você bateu! Assistindo o resto…';
  return { status: `${clock(s.timeLeft)} · 🚀 ${s.speed}`, overlay };
}

export default {
  emoji: '🏍️',
  title: 'Tron',
  desc: 'De 1 a 6 pessoas. Sua moto não para e deixa um rastro de luz. Não bata em nada e feche os outros!',
  help: () => [h('span', 'kbd', '↑ ↓ ← →'), ' ou ', h('span', 'kbd', 'W A S D'), ' fazem a curva'],
  touch: { dpad: true },
  touchHelp: 'Toque nas setas para fazer a curva',
  draw,
  keydown(e, api) {
    const dir = DIR_KEYS[e.code];
    if (!dir) return false;
    if (!e.repeat) api.send({ dir });
    return true;
  },
};
