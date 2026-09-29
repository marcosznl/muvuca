// Bomberman no site: desenha o mapa, bombas, fogo e personagens; manda direção segurada, bomba e detonar (E)
import { h } from '../util.js';
import { DIR_KEYS, EMOJI_FONT, blend, fitCanvas, roundRect, drawToken, drawLabel, clock, isMe } from './common.js';

const ITEM_EMOJI = { bomb: '💣', fire: '🔥', speed: '⚡', kick: '👟', remote: '📡', shield: '🛡️', curse: '☠️' };

// Posição de cada pessoa entre o ladrilho de saída e o de chegada
const playerPos = (p) => [p.x + (p.tx - p.x) * p.p, p.y + (p.ty - p.y) * p.p];

function positions(v) {
  const pos = new Map();
  for (const p of v.cur.players) {
    const before = v.prev?.players.find((q) => q.id === p.id);
    const [x1, y1] = playerPos(p);
    if (!before) { pos.set(p.id, [x1, y1]); continue; }
    const [x0, y0] = playerPos(before);
    pos.set(p.id, [x0 + (x1 - x0) * v.a, y0 + (y1 - y0) * v.a]);
  }
  return pos;
}

function drawEmptyBoard(g, tile, w, hh) {
  for (let y = 0; y < hh; y++) {
    for (let x = 0; x < w; x++) {
      const solid = x === 0 || y === 0 || x === w - 1 || y === hh - 1 || (x % 2 === 0 && y % 2 === 0);
      g.fillStyle = solid ? '#1e1f22' : (x + y) % 2 ? '#3a5a40' : '#3f6146';
      g.fillRect(x * tile, y * tile, tile, tile);
    }
  }
}

function draw(canvas, snaps) {
  const v = blend(snaps);
  const w = v?.cur.w ?? 15;
  const hh = v?.cur.h ?? 13;
  const { g, tile } = fitCanvas(canvas, w, hh, { minTile: 12 });
  if (!v) { drawEmptyBoard(g, tile, w, hh); return null; }
  const s = v.cur;
  const pos = positions(v);

  // Chão, paredes e blocos
  for (let y = 0; y < hh; y++) {
    for (let x = 0; x < w; x++) {
      const c = s.grid[y * w + x];
      const px = x * tile;
      const py = y * tile;
      if (c === 'o') {
        // Buraco: chão escuro com borda (ninguém passa; o fogo passa por cima)
        g.fillStyle = (x + y) % 2 ? '#3a5a40' : '#3f6146';
        g.fillRect(px, py, tile, tile);
        g.fillStyle = '#0b0c0e';
        g.beginPath(); g.ellipse(px + tile / 2, py + tile / 2, tile * 0.42, tile * 0.36, 0, 0, Math.PI * 2); g.fill();
        g.strokeStyle = '#2a2b2e';
        g.lineWidth = Math.max(1, tile * 0.06);
        g.stroke();
      } else if (c === '#') {
        g.fillStyle = '#1e1f22';
        g.fillRect(px, py, tile, tile);
        g.fillStyle = '#2b2d31';
        g.fillRect(px + 2, py + 2, tile - 4, tile - 6);
      } else {
        g.fillStyle = (x + y) % 2 ? '#3a5a40' : '#3f6146'; // grama em xadrez
        g.fillRect(px, py, tile, tile);
        if (c === 'x') {
          g.fillStyle = '#9c6b3f';
          roundRect(g, px + 2, py + 2, tile - 4, tile - 4, tile * 0.15);
          g.fill();
          g.strokeStyle = 'rgba(0,0,0,.25)';
          g.lineWidth = Math.max(1, tile * 0.05);
          g.beginPath();
          g.moveTo(px + 4, py + tile / 2); g.lineTo(px + tile - 4, py + tile / 2);
          g.moveTo(px + tile / 2, py + 4); g.lineTo(px + tile / 2, py + tile / 2);
          g.stroke();
        }
      }
    }
  }
  // Power-ups
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (const [x, y, k] of s.items) {
    g.fillStyle = 'rgba(0,0,0,.35)';
    roundRect(g, x * tile + tile * 0.12, y * tile + tile * 0.12, tile * 0.76, tile * 0.76, tile * 0.2);
    g.fill();
    g.font = `${Math.floor(tile * 0.55)}px ${EMOJI_FONT}`;
    g.fillText(ITEM_EMOJI[k], x * tile + tile / 2, y * tile + tile / 2 + 1);
  }
  // Fogo
  for (const [x, y] of s.flames) {
    const grad = g.createRadialGradient(x * tile + tile / 2, y * tile + tile / 2, 1, x * tile + tile / 2, y * tile + tile / 2, tile * 0.7);
    grad.addColorStop(0, '#fff3b0');
    grad.addColorStop(0.4, '#ffb703');
    grad.addColorStop(1, '#e85d04');
    g.fillStyle = grad;
    roundRect(g, x * tile + 1, y * tile + 1, tile - 2, tile - 2, tile * 0.25);
    g.fill();
  }
  // Bombas (pulsam mais rápido perto de explodir)
  const now = performance.now();
  for (const b of s.bombs) {
    const pulse = 1 + 0.08 * Math.sin(now / (60 + b.fuse / 20));
    const cx = b.x * tile + tile / 2;
    const cy = b.y * tile + tile / 2 + tile * 0.05;
    g.fillStyle = '#111';
    g.beginPath(); g.arc(cx, cy, tile * 0.34 * pulse, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(255,255,255,.35)';
    g.beginPath(); g.arc(cx - tile * 0.1, cy - tile * 0.1, tile * 0.08, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#c9a227';
    g.lineWidth = Math.max(1.5, tile * 0.06);
    g.beginPath(); g.moveTo(cx + tile * 0.15, cy - tile * 0.25); g.quadraticCurveTo(cx + tile * 0.3, cy - tile * 0.45, cx + tile * 0.2, cy - tile * 0.45); g.stroke();
    g.fillStyle = Math.floor(now / 90) % 2 ? '#ffd166' : '#ef476f';
    g.beginPath(); g.arc(cx + tile * 0.2, cy - tile * 0.45, tile * 0.07, 0, Math.PI * 2); g.fill();
    // Bomba com detonador: luzinha vermelha piscando no meio
    if (b.remote) {
      g.fillStyle = Math.floor(now / 250) % 2 ? '#ff3b3b' : '#6b0000';
      g.beginPath(); g.arc(cx, cy, tile * 0.1, 0, Math.PI * 2); g.fill();
    }
  }
  // Pessoas
  for (const p of s.players) {
    if (!p.alive) continue;
    const [x, y] = pos.get(p.id) ?? playerPos(p);
    const cx = x * tile + tile / 2;
    const cy = y * tile + tile / 2;
    g.fillStyle = 'rgba(0,0,0,.3)';
    g.beginPath(); g.ellipse(cx, cy + tile * 0.33, tile * 0.28, tile * 0.1, 0, 0, Math.PI * 2); g.fill();
    // Escudo: bolha azul em volta; maldição: aura roxa
    if (p.shield || p.cursed) {
      g.strokeStyle = p.shield ? 'rgba(88,166,255,.9)' : 'rgba(170,80,255,.9)';
      g.lineWidth = Math.max(2, tile * 0.08);
      g.beginPath(); g.arc(cx, cy, tile * 0.5 + Math.sin(now / 150) * tile * 0.03, 0, Math.PI * 2); g.stroke();
    }
    drawToken(g, cx, cy, tile * 0.4, p);
    drawLabel(g, cx, cy - tile * 0.48, (p.cursed ? '☠️ ' : '') + p.name, tile * 0.26);
  }

  // Morte súbita: borda vermelha pulsando
  if (s.sudden) {
    g.strokeStyle = `rgba(237,66,69,${0.45 + 0.35 * Math.sin(now / 200)})`;
    g.lineWidth = Math.max(3, tile * 0.18);
    g.strokeRect(0, 0, w * tile, hh * tile);
  }

  const me = s.players.find((p) => isMe(p.id));
  const extras = me ? [me.kick && '👟', me.remote && '📡 E detona', me.shield && '🛡️', me.cursed && '☠️ invertido'].filter(Boolean).join(' ') : '';
  const warn = s.sudden ? ' · ⚠️ MORTE SÚBITA' : s.suddenIn !== null && s.suddenIn < 10_000 ? ` · ⚠️ morte súbita em ${Math.ceil(s.suddenIn / 1000)}s` : '';
  return {
    status: clock(s.timeLeft) + (me ? ` · 💣 ${me.bombs} · 🔥 ${me.range} · ⚡ ${me.speed}${extras ? ` · ${extras}` : ''}` : '') + warn,
    overlay: me && !me.alive ? '💥 Você explodiu! Assistindo o resto…' : '',
    end: s.botsWon ? '🤖 Os robôs venceram!' : undefined,
  };
}

// Setas seguradas: a última apertada vale; soltar para
let held = [];
let sentDir = null;

function sendDir(api) {
  const dir = held[held.length - 1] ?? null;
  if (dir === sentDir) return;
  sentDir = dir;
  api.send({ dir });
}

export default {
  emoji: '💣',
  title: 'Bomberman',
  desc: 'De 1 a 4 pessoas (e robôs). Bombas, itens como chute, detonador e escudo, 4 mapas, morte súbita e série melhor de 3 ou 5.',
  help: () => [h('span', 'kbd', '↑ ↓ ← →'), ' ou ', h('span', 'kbd', 'W A S D'), ' andam · ', h('span', 'kbd', 'Espaço'), ' bomba · ', h('span', 'kbd', 'E'), ' detona (📡)'],
  touch: { dpad: true, action: '💣', action2: '📡' },
  touchHelp: 'Setas andam · 💣 bomba · 📡 detona',
  draw,
  reset() { held = []; sentDir = null; },
  keydown(e, api) {
    if (e.code === 'Space') {
      if (!e.repeat) api.send({ bomb: true });
      return true;
    }
    if (e.code === 'KeyE' || e.code === 'Action2') { // detonador (📡)
      if (!e.repeat) api.send({ act: 'boom' });
      return true;
    }
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
};
