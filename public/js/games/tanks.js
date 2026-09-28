// Tanquinhos no site: arena vista de cima; setas/WASD andam (diagonal também), o mouse mira, clique ou Espaço atira
import { h } from '../util.js';
import { DIR_KEYS, blend, fitCanvas, roundRect, drawToken, drawLabel, colorOf, clock, isMe } from './common.js';

const W = 20;
const H = 13;
const TANK_R = 0.45;

// Ângulo misturando pelo lado mais curto (de 350° para 10° passa pelo 0°, não dá a volta)
function lerpAngle(a, b, t) {
  const d = Math.atan2(Math.sin(b - a), Math.cos(b - a));
  return a + d * t;
}

function positions(v) {
  const pos = new Map();
  for (const p of v.cur.players) {
    const q = v.prev?.players.find((o) => o.id === p.id);
    if (!q) { pos.set(p.id, p); continue; }
    pos.set(p.id, {
      x: q.x + (p.x - q.x) * v.a,
      y: q.y + (p.y - q.y) * v.a,
      angle: lerpAngle(q.angle, p.angle, v.a),
      aim: lerpAngle(q.aim, p.aim, v.a),
    });
  }
  return pos;
}

function drawFloor(g, tile, walls) {
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      g.fillStyle = (x + y) % 2 ? '#3d3a2e' : '#423f32'; // terra batida em xadrez
      g.fillRect(x * tile, y * tile, tile + 0.5, tile + 0.5);
    }
  }
  for (const [x, y, w, hh] of walls) {
    g.fillStyle = '#1e1f22';
    g.fillRect(x * tile, y * tile, w * tile, hh * tile);
    g.fillStyle = '#34363c';
    g.fillRect(x * tile + 2, y * tile + 2, w * tile - 4, hh * tile - tile * 0.18);
  }
}

function drawTank(g, tile, p, at) {
  const cx = at.x * tile;
  const cy = at.y * tile;
  const size = TANK_R * 2 * tile;
  g.save();
  g.translate(cx, cy);
  if (!p.alive) { // destroço
    g.rotate(at.angle);
    g.fillStyle = '#2a2a2a';
    roundRect(g, -size / 2, -size * 0.42, size, size * 0.84, size * 0.15);
    g.fill();
    g.restore();
    g.strokeStyle = 'rgba(255,255,255,.6)';
    g.lineWidth = Math.max(2, tile * 0.08);
    const r = tile * 0.25;
    g.beginPath(); g.moveTo(cx - r, cy - r); g.lineTo(cx + r, cy + r); g.moveTo(cx + r, cy - r); g.lineTo(cx - r, cy + r); g.stroke();
    return;
  }
  // Corpo com as esteiras, virado para onde anda
  g.rotate(at.angle);
  g.fillStyle = 'rgba(0,0,0,.35)';
  roundRect(g, -size / 2 + 2, -size * 0.42 + 3, size, size * 0.84, size * 0.15);
  g.fill();
  g.fillStyle = '#26282c';
  g.fillRect(-size / 2, -size * 0.45, size, size * 0.2);
  g.fillRect(-size / 2, size * 0.25, size, size * 0.2);
  g.fillStyle = colorOf(p.color);
  roundRect(g, -size * 0.44, -size * 0.3, size * 0.88, size * 0.6, size * 0.12);
  g.fill();
  g.rotate(-at.angle);
  // Cano, virado para a mira
  g.rotate(at.aim);
  g.fillStyle = '#d9d9d9';
  g.fillRect(0, -tile * 0.08, tile * 0.68, tile * 0.16);
  g.fillStyle = '#9a9a9a';
  g.fillRect(tile * 0.58, -tile * 0.1, tile * 0.12, tile * 0.2);
  g.restore();
  // Torre com a foto
  drawToken(g, cx, cy, tile * 0.3, p, { ring: 0.22 });
  // Vida
  for (let i = 0; i < 3; i++) {
    g.fillStyle = i < p.hp ? '#3ba55c' : 'rgba(0,0,0,.45)';
    g.fillRect(cx - tile * 0.36 + i * tile * 0.25, cy + tile * 0.56, tile * 0.21, tile * 0.09);
  }
  drawLabel(g, cx, cy - tile * 0.55, p.name, tile * 0.26);
}

function draw(canvas, snaps) {
  const v = blend(snaps);
  const { g, tile } = fitCanvas(canvas, W, H);
  drawFloor(g, tile, v?.cur.walls ?? []);
  if (!v) return null;
  const s = v.cur;
  const pos = positions(v);
  for (const p of s.players.filter((o) => !o.alive)) drawTank(g, tile, p, pos.get(p.id));
  for (const p of s.players.filter((o) => o.alive)) drawTank(g, tile, p, pos.get(p.id));
  // Balas
  g.save();
  g.fillStyle = '#ffe066';
  g.shadowColor = '#ffb703';
  g.shadowBlur = tile * 0.5;
  for (const [x, y] of s.bullets) { g.beginPath(); g.arc(x * tile, y * tile, tile * 0.14, 0, Math.PI * 2); g.fill(); }
  g.restore();

  const me = s.players.find((p) => isMe(p.id));
  let overlay = '';
  if (s.countdown) overlay = `Prepare-se… ${Math.ceil(s.countdown / 1000)}`;
  else if (me && !me.alive) overlay = '💥 Seu tanque estourou! Assistindo o resto…';
  return { status: clock(s.timeLeft) + (me ? ` · ❤️ ${me.hp} · 🎯 ${me.kills}` : ''), overlay };
}

// ---------- Controles ----------

let held = [];     // direções seguradas (a última de cada eixo vale)
let sentDir = null;
let mouseAim = false; // enquanto não mexe o mouse, o cano aponta para onde anda
let lastAim = { at: 0, value: null };
let latest = null; // última atualização do servidor (para saber onde está o meu tanque)

function combined() {
  const v = [...held].reverse().find((d) => d === 'up' || d === 'down');
  const hz = [...held].reverse().find((d) => d === 'left' || d === 'right');
  return v && hz ? `${v}-${hz}` : v ?? hz ?? null;
}

const DIR_ANGLE = {
  right: 0, 'down-right': Math.PI / 4, down: Math.PI / 2, 'down-left': (3 * Math.PI) / 4,
  left: Math.PI, 'up-left': (-3 * Math.PI) / 4, up: -Math.PI / 2, 'up-right': -Math.PI / 4,
};

function sendDir(api) {
  const dir = combined();
  if (dir === sentDir) return;
  sentDir = dir;
  api.send(dir && !mouseAim ? { dir, aim: DIR_ANGLE[dir] } : { dir });
}

export default {
  emoji: '🪖',
  title: 'Tanquinhos',
  desc: 'De 1 a 4 pessoas. Mire com o mouse e acerte os outros tanques: a bala quica na parede. 3 tiros e já era. Sozinho, você treina contra um robô.',
  help: () => [h('span', 'kbd', 'W A S D'), ' ou ', h('span', 'kbd', '↑ ↓ ← →'), ' andam · ', h('span', 'kbd', 'mouse'), ' mira · ',
    h('span', 'kbd', 'clique'), ' ou ', h('span', 'kbd', 'Espaço'), ' atira'],
  touch: { dpad: true, action: '💥' },
  touchHelp: 'Setas andam · toque no mapa para mirar e atirar · 💥 atira',
  draw(canvas, snaps) {
    latest = snaps[snaps.length - 1]?.s ?? null;
    return draw(canvas, snaps);
  },
  reset() { held = []; sentDir = null; mouseAim = false; lastAim = { at: 0, value: null }; },
  keydown(e, api) {
    if (e.code === 'Space') { api.send({ fire: true }); return true; }
    const dir = DIR_KEYS[e.code];
    if (!dir) return false;
    if (!held.includes(dir)) held.push(dir);
    sendDir(api);
    return true;
  },
  keyup(e, api) {
    const dir = DIR_KEYS[e.code];
    if (!dir) return;
    held = held.filter((d) => d !== dir);
    sendDir(api);
  },
  blur(api) { held = []; sendDir(api); },
  pointer(type, e, api) {
    const me = latest?.players.find((p) => isMe(p.id));
    if (!me?.alive) return;
    const aim = Math.round(Math.atan2(e.y * H - me.y, e.x * W - me.x) * 100) / 100;
    const now = performance.now();
    if (type === 'pointerdown' && e.target === e.canvas && e.button === 0) {
      mouseAim = true;
      lastAim = { at: now, value: aim };
      api.send({ aim, fire: true });
      return;
    }
    if (type !== 'pointermove') return;
    // Mira: manda no máximo ~25x por segundo e só quando mudou de verdade
    if (lastAim.value !== null && (now - lastAim.at < 40 || Math.abs(aim - lastAim.value) < 0.02)) return;
    mouseAim = true;
    lastAim = { at: now, value: aim };
    api.send({ aim });
  },
};
