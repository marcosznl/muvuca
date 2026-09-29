// Agar no site: a câmera segue as suas bolinhas (e se afasta conforme você cresce); elas vão atrás do mouse.
// Espaço divide, W solta massa. Vírus verdes estouram quem é grande. Minimapa e placar no canto.
import { h } from '../util.js';
import { COLORS, blend, fitCanvas, drawToken, drawLabel, clock, isMe } from './common.js';

const radius = (mass) => Math.sqrt(mass) * 0.35;
const VIRUS_R = radius(100);
const BLOB_R = radius(2.5);

// Mesma conta do servidor: a comidinha número i sempre fica no mesmo lugar
function pelletPos(i, world) {
  const f = (n) => { const v = Math.sin(n * 12.9898 + 78.233) * 43758.5453; return v - Math.floor(v); };
  return [1 + f(i * 2 + 1) * (world - 2), 1 + f(i * 2 + 2) * (world - 2)];
}

const cam = { x: 40, y: 40, scale: 0, meX: null, meY: null }; // meX/meY: onde o centro das minhas partes foi desenhado
let last = { at: 0, x: null, y: null };
let lastEject = 0;

// Posição suavizada de cada parte (pelo número dela), entre o estado anterior e o atual
function positions(v) {
  const prev = new Map();
  for (const p of v.prev?.players ?? []) for (const c of p.cells ?? []) prev.set(c[0], c);
  const pos = new Map();
  for (const p of v.cur.players) {
    for (const [id, x, y] of p.cells) {
      const q = prev.get(id);
      // Acabou de nascer/renascer em outro lugar: não desliza pela arena
      if (!q || Math.hypot(x - q[1], y - q[2]) > 8) pos.set(id, [x, y]);
      else pos.set(id, [q[1] + (x - q[1]) * v.a, q[2] + (y - q[2]) * v.a]);
    }
  }
  return pos;
}

// Centro de uma pessoa (média das partes pelo tamanho) e até onde as partes se espalham
function centerOf(p, pos) {
  let m = 0; let x = 0; let y = 0;
  for (const [id, , , mass] of p.cells) { const [cx, cy] = pos.get(id); x += cx * mass; y += cy * mass; m += mass; }
  if (!m) return null;
  x /= m; y /= m;
  let spread = 0;
  for (const [id, , , mass] of p.cells) { const [cx, cy] = pos.get(id); spread = Math.max(spread, Math.hypot(cx - x, cy - y) + radius(mass)); }
  return { x, y, spread };
}

function drawVirus(g, x, y, r) {
  const spikes = 18;
  g.fillStyle = '#33c46a';
  g.strokeStyle = '#1f8a47';
  g.lineWidth = Math.max(1.5, r * 0.08);
  g.beginPath();
  for (let i = 0; i <= spikes * 2; i++) {
    const a = (i / (spikes * 2)) * Math.PI * 2;
    const rr = i % 2 ? r : r * 1.1;
    g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  g.closePath();
  g.globalAlpha = 0.85;
  g.fill();
  g.globalAlpha = 1;
  g.stroke();
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

  // Câmera: nas minhas partes; assistindo (ou esperando renascer), na maior
  const me = s.players.find((p) => isMe(p.id));
  const focus = me?.alive && me.cells?.length ? me : [...s.players].filter((p) => p.alive && p.cells?.length).sort((a, b) => b.mass - a.mass)[0];
  const fc = focus ? centerOf(focus, pos) : null;
  const [fx, fy] = fc ? [fc.x, fc.y] : [world / 2, world / 2];
  const view = Math.min(80, Math.max(26, 20 + radius(focus?.mass ?? 10) * 6, (fc?.spread ?? 0) * 2.6));
  const scale = Math.min(cw, ch) / view;
  const k = cam.scale ? 0.2 : 1; // suaviza a câmera
  cam.x += (fx - cam.x) * k;
  cam.y += (fy - cam.y) * k;
  cam.scale += (scale - cam.scale) * (cam.scale ? 0.08 : 1);
  const sx = (x) => cw / 2 + (x - cam.x) * cam.scale;
  const sy = (y) => ch / 2 + (y - cam.y) * cam.scale;
  const onScreen = (px, py, r) => px > -r && py > -r && px < cw + r && py < ch + r;

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
    if (!onScreen(px, py, pr)) continue;
    g.fillStyle = COLORS[i % COLORS.length];
    g.beginPath(); g.arc(px, py, pr, 0, Math.PI * 2); g.fill();
  }
  // Massa solta
  g.fillStyle = '#c9cdd6';
  for (const [x, y] of s.blobs ?? []) {
    const r = Math.max(3, BLOB_R * cam.scale);
    g.beginPath(); g.arc(sx(x), sy(y), r, 0, Math.PI * 2); g.fill();
  }

  // Partes de todo mundo, as menores por baixo (as pequenas ficam escondidas sob os vírus)
  const cells = [];
  for (const p of s.players) if (p.alive) for (const [id, , , mass] of p.cells ?? []) cells.push({ p, id, mass });
  cells.sort((a, b) => a.mass - b.mass);
  const virusR = VIRUS_R * cam.scale;
  const drawViruses = () => { for (const [x, y] of s.viruses ?? []) if (onScreen(sx(x), sy(y), virusR * 1.2)) drawVirus(g, sx(x), sy(y), virusR); };
  let virusesDrawn = false;
  for (const { p, id, mass } of cells) {
    if (!virusesDrawn && mass >= 100) { drawViruses(); virusesDrawn = true; }
    const [x, y] = pos.get(id);
    const r = radius(mass) * cam.scale;
    const px = sx(x);
    const py = sy(y);
    if (!onScreen(px, py, r + 20)) continue;
    g.save();
    g.shadowColor = 'rgba(0,0,0,.5)';
    g.shadowBlur = 12;
    drawToken(g, px, py, r, p, { ring: 0.1 });
    g.restore();
    if (r > 9) drawLabel(g, px, py - r - 4, p.name, Math.max(11, Math.min(18, r * 0.35)));
    g.font = `600 ${Math.max(10, Math.min(16, r * 0.3))}px "Noto Sans", system-ui, sans-serif`;
    g.fillStyle = 'rgba(255,255,255,.85)';
    g.textAlign = 'center';
    g.fillText(String(mass), px, py + r + 10);
  }
  if (!virusesDrawn) drawViruses();

  // Onde o centro das minhas partes foi desenhado (o mouse é medido a partir dele)
  const mc = me?.alive && me.cells?.length ? centerOf(me, pos) : null;
  cam.meX = mc ? sx(mc.x) : null;
  cam.meY = mc ? sy(mc.y) : null;

  scoreboard(g, cw, s);
  minimap(g, cw, ch, s, pos);

  let overlay = '';
  if (s.countdown) overlay = `Prepare-se… ${Math.ceil(s.countdown / 1000)}`;
  else if (me && !me.alive) overlay = '😵 Você foi engolido! Voltando…';
  const team = me && s.teams ? ` · ${s.teams[me.team].label}` : '';
  const pieces = me?.cells?.length > 1 ? ` · ✂️ ${me.cells.length}` : '';
  const end = s.teams ? (s.winnerTeam === null ? 'Empate entre os times!' : `🏆 Time ${s.teams[s.winnerTeam].label} venceu!`) : undefined;
  return { status: clock(s.timeLeft) + (me ? ` · ⚖️ ${me.mass} · 🍽️ ${me.eaten}${pieces}${team}` : ''), overlay, end };
}

// Placar: os 5 maiores (no modo equipes, a massa de cada time em cima)
function scoreboard(g, cw, s) {
  const top = [...s.players].sort((a, b) => b.mass - a.mass).slice(0, 5);
  const teamRows = s.teams ? s.teams.length : 0;
  const x = cw - 170;
  g.fillStyle = 'rgba(0,0,0,.45)';
  g.fillRect(x, 10, 160, 26 + (top.length + teamRows) * 20 + (teamRows ? 6 : 0));
  g.font = '700 13px "Noto Sans", system-ui, sans-serif';
  g.textAlign = 'left';
  g.fillStyle = '#fff';
  g.fillText(s.teams ? 'Times' : 'Maiores', x + 12, 28);
  let row = 0;
  const line = (left, right, color, bold) => {
    const y = 50 + row * 20;
    g.font = `${bold ? 700 : 500} 13px "Noto Sans", system-ui, sans-serif`;
    g.fillStyle = color;
    g.textAlign = 'left';
    g.fillText(left, x + 12, y);
    g.textAlign = 'right';
    g.fillText(right, cw - 18, y);
    row++;
  };
  for (const t of s.teams ?? []) line(t.label, String(t.mass), COLORS[t.color], true);
  if (teamRows) row += 0.3;
  top.forEach((p, i) => {
    const name = p.name.length > 12 ? `${p.name.slice(0, 11)}…` : p.name;
    line(`${i + 1}. ${name}`, String(p.mass), isMe(p.id) ? '#ffd166' : 'rgba(255,255,255,.85)', isMe(p.id));
  });
}

// Minimapa no canto de baixo: a arena inteira, todo mundo como pontinho e o pedaço que você está vendo
function minimap(g, cw, ch, s, pos) {
  const size = Math.min(120, Math.max(70, Math.min(cw, ch) * 0.2));
  const x0 = cw - size - 10;
  const y0 = ch - size - 10;
  const k = size / s.world;
  g.fillStyle = 'rgba(0,0,0,.5)';
  g.fillRect(x0, y0, size, size);
  g.strokeStyle = 'rgba(255,255,255,.25)';
  g.lineWidth = 1;
  g.strokeRect(x0 + 0.5, y0 + 0.5, size - 1, size - 1);
  g.fillStyle = 'rgba(51,196,106,.6)';
  for (const [x, y] of s.viruses ?? []) { g.beginPath(); g.arc(x0 + x * k, y0 + y * k, 2, 0, Math.PI * 2); g.fill(); }
  for (const p of s.players) {
    if (!p.alive) continue;
    g.fillStyle = COLORS[p.color % COLORS.length];
    for (const [id, , , mass] of p.cells ?? []) {
      const [x, y] = pos.get(id);
      g.beginPath(); g.arc(x0 + x * k, y0 + y * k, Math.max(2, radius(mass) * k), 0, Math.PI * 2); g.fill();
      if (isMe(p.id)) { g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.stroke(); }
    }
  }
  // O que aparece na tela
  const vw = (cw / cam.scale) * k;
  const vh = (ch / cam.scale) * k;
  g.strokeStyle = 'rgba(255,255,255,.6)';
  g.lineWidth = 1;
  g.save();
  g.beginPath(); g.rect(x0, y0, size, size); g.clip();
  g.strokeRect(x0 + cam.x * k - vw / 2, y0 + cam.y * k - vh / 2, vw, vh);
  g.restore();
}

export default {
  emoji: '🟢',
  title: 'Agar',
  desc: 'De 1 a 8 pessoas (com robôs quando tem pouca gente). Coma, cresça, divida-se para dar o bote e fuja dos vírus. Tem modo equipes.',
  help: () => [h('span', 'kbd', 'mouse'), ' guia · ', h('span', 'kbd', 'Espaço'), ' divide · ', h('span', 'kbd', 'W'), ' solta massa · vírus 🟢 estouram quem é grande'],
  touch: { action: '✂️', action2: '💧' },
  touchHelp: 'Arraste o dedo na arena para guiar · ✂️ divide · 💧 solta massa',
  draw,
  reset() { cam.scale = 0; last = { at: 0, x: null, y: null }; lastEject = 0; },
  keydown(e, api) {
    if (e.code === 'Space') {
      if (!e.repeat) api.send({ act: 'split' });
      return true;
    }
    if (e.code === 'KeyW' || e.code === 'Action2') {
      const now = performance.now();
      if (now - lastEject > 110) { lastEject = now; api.send({ act: 'eject' }); } // segurando, solta várias
      return true;
    }
    return false;
  },
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
