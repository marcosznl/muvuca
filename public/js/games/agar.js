// Agar no site: a câmera segue a sua bolinha (e se afasta conforme você cresce); a bolinha vai atrás do mouse
import { h } from '../util.js';
import { COLORS, blend, fitCanvas, drawToken, drawLabel, clock, isMe } from './common.js';

const radius = (mass) => Math.sqrt(mass) * 0.35;

// Mesma conta do servidor: a comidinha número i sempre fica no mesmo lugar
function pelletPos(i, world) {
  const f = (n) => { const v = Math.sin(n * 12.9898 + 78.233) * 43758.5453; return v - Math.floor(v); };
  return [1 + f(i * 2 + 1) * (world - 2), 1 + f(i * 2 + 2) * (world - 2)];
}

const cam = { x: 40, y: 40, scale: 0, meX: null, meY: null }; // meX/meY: onde a minha bolinha foi desenhada
let last = { at: 0, x: null, y: null };

function positions(v) {
  const pos = new Map();
  for (const p of v.cur.players) {
    const q = v.prev?.players.find((o) => o.id === p.id);
    // Acabou de renascer em outro lugar: não desliza pela arena
    if (!q || !q.alive || Math.hypot(p.x - q.x, p.y - q.y) > 5) { pos.set(p.id, [p.x, p.y]); continue; }
    pos.set(p.id, [q.x + (p.x - q.x) * v.a, q.y + (p.y - q.y) * v.a]);
  }
  return pos;
}

function draw(canvas, snaps) {
  const stage = canvas.parentElement;
  const { g, cw, ch } = fitCanvas(canvas, Math.max(200, stage.clientWidth), Math.max(200, stage.clientHeight), { minTile: 1 });
  g.fillStyle = '#111214';
  g.fillRect(0, 0, cw, ch);
  const v = blend(snaps);
  if (!v) return null;
  const s = v.cur;
  const world = s.world;
  const pos = positions(v);

  // Câmera: na minha bolinha; assistindo (ou esperando renascer), na maior
  const me = s.players.find((p) => isMe(p.id));
  const focus = me?.alive ? me : [...s.players].filter((p) => p.alive).sort((a, b) => b.mass - a.mass)[0];
  const [fx, fy] = focus ? pos.get(focus.id) : [world / 2, world / 2];
  const view = Math.min(70, Math.max(26, 20 + radius(focus?.mass ?? 10) * 6));
  const scale = Math.min(cw, ch) / view;
  const k = cam.scale ? 0.2 : 1; // suaviza a câmera
  cam.x += (fx - cam.x) * k;
  cam.y += (fy - cam.y) * k;
  cam.scale += (scale - cam.scale) * (cam.scale ? 0.08 : 1);
  const sx = (x) => cw / 2 + (x - cam.x) * cam.scale;
  const sy = (y) => ch / 2 + (y - cam.y) * cam.scale;

  // Arena com grade
  g.fillStyle = '#1b1c20';
  g.fillRect(sx(0), sy(0), world * cam.scale, world * cam.scale);
  g.strokeStyle = 'rgba(255,255,255,.05)';
  g.lineWidth = 1;
  g.beginPath();
  for (let i = 0; i <= world; i += 4) {
    g.moveTo(sx(i), sy(0)); g.lineTo(sx(i), sy(world));
    g.moveTo(sx(0), sy(i)); g.lineTo(sx(world), sy(i));
  }
  g.stroke();
  g.strokeStyle = 'rgba(237,66,69,.6)';
  g.lineWidth = 3;
  g.strokeRect(sx(0), sy(0), world * cam.scale, world * cam.scale);

  // Comidinhas (só as que aparecem na tela)
  const pr = Math.max(2, 0.3 * cam.scale);
  for (let i = 0; i < s.pellets.length; i++) {
    if (s.pellets[i] !== '1') continue;
    const [x, y] = pelletPos(i, world);
    const px = sx(x);
    const py = sy(y);
    if (px < -pr || py < -pr || px > cw + pr || py > ch + pr) continue;
    g.fillStyle = COLORS[i % COLORS.length];
    g.beginPath(); g.arc(px, py, pr, 0, Math.PI * 2); g.fill();
  }

  // Bolinhas: as menores por baixo
  cam.meX = null;
  for (const p of [...s.players].filter((o) => o.alive).sort((a, b) => a.mass - b.mass)) {
    const [x, y] = pos.get(p.id);
    const r = radius(p.mass) * cam.scale;
    const px = sx(x);
    const py = sy(y);
    if (isMe(p.id)) { cam.meX = px; cam.meY = py; }
    g.save();
    g.shadowColor = 'rgba(0,0,0,.5)';
    g.shadowBlur = 12;
    drawToken(g, px, py, r, p, { ring: 0.1 });
    g.restore();
    drawLabel(g, px, py - r - 4, p.name, Math.max(11, Math.min(18, r * 0.35)));
    g.font = `600 ${Math.max(10, Math.min(16, r * 0.3))}px "Noto Sans", system-ui, sans-serif`;
    g.fillStyle = 'rgba(255,255,255,.85)';
    g.textAlign = 'center';
    g.fillText(String(p.mass), px, py + r + 10);
  }

  // Placar dos maiores
  const top = [...s.players].sort((a, b) => b.mass - a.mass).slice(0, 5);
  g.fillStyle = 'rgba(0,0,0,.45)';
  g.fillRect(cw - 170, 10, 160, 26 + top.length * 20);
  g.font = '700 13px "Noto Sans", system-ui, sans-serif';
  g.textAlign = 'left';
  g.fillStyle = '#fff';
  g.fillText('Maiores', cw - 158, 28);
  top.forEach((p, i) => {
    g.font = `${isMe(p.id) ? 700 : 500} 13px "Noto Sans", system-ui, sans-serif`;
    g.fillStyle = isMe(p.id) ? '#ffd166' : 'rgba(255,255,255,.85)';
    const name = p.name.length > 12 ? `${p.name.slice(0, 11)}…` : p.name;
    g.fillText(`${i + 1}. ${name}`, cw - 158, 50 + i * 20);
    g.textAlign = 'right';
    g.fillText(String(p.mass), cw - 18, 50 + i * 20);
    g.textAlign = 'left';
  });

  let overlay = '';
  if (s.countdown) overlay = `Prepare-se… ${Math.ceil(s.countdown / 1000)}`;
  else if (me && !me.alive) overlay = '😵 Você foi engolido! Voltando…';
  return { status: clock(s.timeLeft) + (me ? ` · ⚖️ ${me.mass} · 🍽️ ${me.eaten}` : ''), overlay };
}

export default {
  emoji: '🟢',
  title: 'Agar',
  desc: 'De 1 a 8 pessoas (com robôs quando tem pouca gente). Coma as bolinhas, cresça e engula quem for menor. Ganha quem estiver maior no fim.',
  help: () => [h('span', 'kbd', 'mouse'), ' guia a sua bolinha · quanto maior, mais devagar'],
  touchHelp: 'Arraste o dedo na arena para guiar a bolinha',
  draw,
  reset() { cam.scale = 0; last = { at: 0, x: null, y: null }; },
  pointer(type, e, api) {
    if ((type !== 'pointermove' && type !== 'pointerdown') || cam.meX === null) return;
    const rect = e.canvas.getBoundingClientRect();
    const x = Math.round(((e.x * rect.width - cam.meX) / cam.scale) * 10) / 10;
    const y = Math.round(((e.y * rect.height - cam.meY) / cam.scale) * 10) / 10;
    const now = performance.now();
    if (last.x !== null && (now - last.at < 50 || Math.hypot(x - last.x, y - last.y) < 0.3)) return;
    last = { at: now, x, y };
    api.send({ x, y });
  },
};
