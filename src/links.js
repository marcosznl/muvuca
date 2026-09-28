// Prévia de links no chat: o servidor busca o título, a descrição e a imagem da página (tags og:* / twitter:*).
// Segurança: só endereços públicos da internet (nada da rede da casa, do próprio Mac ou do roteador) — o IP é
// conferido na hora da conexão (lookup), inclusive a cada redirecionamento; no máximo 3 redirecionamentos,
// 5 s e 512 KB por página. Resultados ficam guardados por 6 h.
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';

const TIMEOUT_MS = 5000;
const MAX_BYTES = 512 * 1024;
const CACHE_MS = 6 * 3_600_000;
const CACHE_MAX = 500;
const cache = new Map(); // url -> { at, preview }

// Endereços que não são da internet pública
export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateIp(v6.slice(7)); // IPv4 dentro de IPv6
  return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith('ff');
}

// Resolve o nome e recusa endereço interno (usado pela própria conexão: não dá para trocar o IP depois da conferência)
function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return callback(err);
    const list = Array.isArray(addrs) ? addrs : [{ address: addrs, family: options.family || 4 }];
    const bad = list.find((a) => isPrivateIp(a.address));
    if (bad || !list.length) return callback(new Error('endereço interno bloqueado'));
    if (options.all) return callback(null, list);
    callback(null, list[0].address, list[0].family);
  });
}

function get(url, hops = 0, accept = /html/i) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (!['http:', 'https:'].includes(u.protocol)) return reject(new Error('protocolo não aceito'));
    if (net.isIP(u.hostname.replace(/^\[|\]$/g, '')) && isPrivateIp(u.hostname.replace(/^\[|\]$/g, ''))) return reject(new Error('endereço interno bloqueado'));
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, {
      lookup: safeLookup,
      timeout: TIMEOUT_MS,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; MuvucaBot/1.0; prévia de links)',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.5',
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (hops >= 3) return reject(new Error('redirecionamentos demais'));
        return resolve(get(new URL(res.headers.location, u).href, hops + 1, accept));
      }
      if (res.statusCode !== 200 || !accept.test(res.headers['content-type'] ?? '')) {
        res.resume();
        return reject(new Error(`sem página (${res.statusCode})`));
      }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        chunks.push(c);
        if (size >= MAX_BYTES) res.destroy(); // o que interessa fica no começo da página (<head>)
      });
      const done = () => resolve({ html: Buffer.concat(chunks).toString('utf8'), url: u.href });
      res.on('end', done);
      res.on('close', done);
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('demorou demais')));
    req.on('error', reject);
  });
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
  return ENTITIES[e.toLowerCase()] ?? m;
});
const clip = (s, n) => { const t = decode(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

export function parsePreview(html, pageUrl) {
  const meta = {};
  for (const tag of html.matchAll(/<meta\s[^>]*>/gi)) {
    const attr = (name) => tag[0].match(new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'));
    const key = (attr('property') ?? attr('name'))?.slice(2).find((x) => x !== undefined)?.toLowerCase();
    const content = attr('content')?.slice(2).find((x) => x !== undefined);
    if (key && content !== undefined && !(key in meta)) meta[key] = content;
  }
  const title = clip(meta['og:title'] ?? meta['twitter:title'] ?? html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1], 120);
  if (!title) return null;
  let image = meta['og:image'] ?? meta['og:image:url'] ?? meta['twitter:image'] ?? null;
  try { image = image ? new URL(decode(image), pageUrl).href : null; } catch { image = null; }
  if (image && !/^https?:/.test(image)) image = null;
  return {
    title,
    description: clip(meta['og:description'] ?? meta['twitter:description'] ?? meta.description, 300),
    image,
    site: clip(meta['og:site_name'], 60) || new URL(pageUrl).hostname.replace(/^www\./, ''),
  };
}

// Vídeo do YouTube: id do link (youtube.com/watch?v=, youtu.be/, shorts/, music.youtube.com)
export function youtubeId(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^(www|m|music)\./, '');
    if (host === 'youtu.be') return u.pathname.slice(1, 12) || null;
    if (host !== 'youtube.com') return null;
    if (u.searchParams.get('v')) return u.searchParams.get('v').slice(0, 11);
    return u.pathname.match(/^\/(shorts|embed|live)\/([\w-]{11})/)?.[2] ?? null;
  } catch { return null; }
}

// O YouTube esconde os dados da página; o oEmbed (serviço oficial de prévias) entrega título, canal e miniatura
async function youtubePreview(id) {
  const page = await get(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`, 0, /json/i);
  const data = JSON.parse(page.html);
  return { title: clip(data.title, 120), description: clip(data.author_name, 80), image: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, site: 'YouTube', youtube: id };
}

export async function linkPreview(url) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.preview;
  let preview = null;
  try {
    const yt = youtubeId(url);
    if (yt && /^[\w-]{11}$/.test(yt)) preview = await youtubePreview(yt);
    else {
      const page = await get(url);
      preview = parsePreview(page.html, page.url);
    }
  } catch { preview = null; }
  cache.set(url, { at: Date.now(), preview });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return preview;
}
