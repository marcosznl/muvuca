// Peças que todos os jogos usam para desenhar: cores, foto de perfil no personagem, canvas no tamanho certo
import { imageUrl } from '../util.js';
import { state, avatarOf } from '../state.js';

export const COLORS = ['#5865f2', '#ed4245', '#3ba55c', '#faa61a', '#eb459e', '#1abc9c', '#9b59b6', '#e67e22'];
export const colorOf = (i) => COLORS[i % COLORS.length];
export const isMe = (id) => id === state.me?.id;
export const EMOJI_FONT = '"Apple Color Emoji","Segoe UI Emoji",sans-serif';

// Setas e WASD viram direções
export const DIR_KEYS = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  KeyW: 'up', KeyS: 'down', KeyA: 'left', KeyD: 'right',
};

// Deixa o canvas com w×h "ladrilhos" do maior tamanho que cabe no palco (nítido em tela retina).
// Devolve o contexto já na escala de pixels da tela e o tamanho do ladrilho.
export function fitCanvas(canvas, w, h, { minTile = 4 } = {}) {
  const stage = canvas.parentElement;
  const tile = Math.max(minTile, Math.min(stage.clientWidth / w, stage.clientHeight / h));
  const cw = Math.floor(tile * w);
  const ch = Math.floor(tile * h);
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
    canvas.style.width = `${cw}px`;
    canvas.style.height = `${ch}px`;
  }
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, cw, ch);
  return { g, tile, cw, ch };
}

// As duas últimas atualizações do servidor e quanto misturar entre elas (desenha ~60 ms "no passado", sem trancos)
export function blend(snaps) {
  if (!snaps.length) return null;
  const cur = snaps[snaps.length - 1];
  const prev = snaps[snaps.length - 2];
  if (!prev) return { cur: cur.s, prev: null, a: 1 };
  const renderAt = performance.now() - 60;
  const a = Math.max(0, Math.min(1, (renderAt - prev.at) / Math.max(1, cur.at - prev.at)));
  return { cur: cur.s, prev: prev.s, a };
}

export function roundRect(g, x, y, w, hgt, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + hgt, r);
  g.arcTo(x + w, y + hgt, x, y + hgt, r);
  g.arcTo(x, y + hgt, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

// Fotos de perfil carregadas uma vez para desenhar no jogo (GIF aparece parado)
const photos = new Map(); // userId -> { src, img, ok }
export function avatarImage(userId) {
  const id = avatarOf(userId);
  if (!id) return null;
  const src = imageUrl(id);
  let entry = photos.get(userId);
  if (!entry || entry.src !== src) {
    entry = { src, img: new Image(), ok: false };
    entry.img.onload = () => { entry.ok = true; };
    entry.img.src = src;
    photos.set(userId, entry);
  }
  return entry.ok ? entry.img : null;
}

// Bolinha do jogador: anel na cor dele e, dentro, a foto de perfil (ou a inicial); você ganha contorno branco
export function drawToken(g, cx, cy, r, p, { ring = 0.2 } = {}) {
  g.fillStyle = colorOf(p.color);
  g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill();
  const inner = r * (1 - ring);
  const photo = avatarImage(p.id);
  if (photo) {
    g.save();
    g.beginPath(); g.arc(cx, cy, inner, 0, Math.PI * 2); g.clip();
    const side = Math.min(photo.naturalWidth, photo.naturalHeight);
    g.drawImage(photo, (photo.naturalWidth - side) / 2, (photo.naturalHeight - side) / 2, side, side,
      cx - inner, cy - inner, inner * 2, inner * 2);
    g.restore();
  } else {
    g.fillStyle = '#fff';
    g.font = `700 ${Math.max(8, Math.floor(r * 0.9))}px "Noto Sans", system-ui, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(([...p.name][0] || '?').toUpperCase(), cx, cy + 1);
  }
  if (isMe(p.id)) {
    g.lineWidth = Math.max(2, r * 0.17);
    g.strokeStyle = '#fff';
    g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke();
  }
}

// Nome numa plaquinha escura (centro em cx, base em y)
export function drawLabel(g, cx, y, name, size) {
  g.font = `600 ${Math.max(9, Math.floor(size))}px "Noto Sans", system-ui, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const label = name.length > 12 ? `${name.slice(0, 11)}…` : name;
  const tw = g.measureText(label).width + 8;
  const hgt = size * 1.2;
  g.fillStyle = 'rgba(0,0,0,.6)';
  roundRect(g, cx - tw / 2, y - hgt, tw, hgt, 4);
  g.fill();
  g.fillStyle = '#fff';
  g.fillText(label, cx, y - hgt / 2 + 0.5);
}

export const clock = (ms) => {
  const secs = Math.ceil(ms / 1000);
  return `⏱ ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
};
