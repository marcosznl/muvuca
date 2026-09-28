// GIFs do chat (Giphy, a mesma chave do bot do Discord). A chave fica só aqui no servidor.

const API = 'https://api.giphy.com/v1';
const PAGE = 30;
const CACHE_MS = 30 * 60_000;       // buscas repetidas não gastam o limite da chave
const HOME_CACHE_MS = 6 * 3_600_000; // os blocos de categoria mudam pouco

// Blocos da tela inicial (termo buscado -> texto mostrado)
const CATEGORIES = [
  ['oi', 'oi'], ['kkkkk', 'kkkkk'], ['amor', 'amor'], ['feliz aniversário', 'feliz aniversário'],
  ['triste', 'triste'], ['bravo', 'bravo'], ['dança', 'dança'], ['obrigado', 'obrigado'],
  ['sim', 'sim'], ['não', 'não'], ['uau', 'uau'], ['boa noite', 'boa noite'],
];

// Tira o ?cid=... (rastreamento) dos links
// e o trecho /v1.xxxx/ (identificador da busca), que deixa o link enorme; o arquivo é o mesmo
const bare = (url) => (url ? url.split('?')[0].replace(/\/media\/v1\.[^/]+\//, '/media/') : null);

function toItem(g) {
  const im = g.images ?? {};
  const preview = im.fixed_width ?? im.fixed_height ?? im.original;
  const full = im.downsized ?? im.downsized_medium ?? im.original; // o que vai para o chat: GIF de até ~2 MB
  return {
    id: g.id,
    title: g.title ?? '',
    url: bare(full?.url),
    preview: bare(preview?.webp || preview?.url),
    width: Number(preview?.width) || 200,
    height: Number(preview?.height) || 150,
  };
}

export function createGifs(apiKey) {
  const cache = new Map(); // chave -> { at, value }

  async function call(path, params, ttl = CACHE_MS) {
    if (!apiKey) throw new Error('GIFs indisponíveis: falta a GIPHY_API_KEY no .env.');
    const key = `${path}?${new URLSearchParams(params)}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.value;
    const url = `${API}${path}?${new URLSearchParams({ api_key: apiKey, rating: 'pg-13', lang: 'pt', ...params })}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (res.status === 429) throw new Error('Muitas buscas de GIF agora. Tente de novo em alguns minutos.');
    if (!res.ok) throw new Error(`O Giphy respondeu com erro (${res.status}).`);
    const value = await res.json();
    cache.set(key, { at: Date.now(), value });
    if (cache.size > 500) cache.delete(cache.keys().next().value);
    return value;
  }

  return {
    enabled: !!apiKey,

    // Busca (ou "em alta", sem termo)
    async search({ q = '', offset = 0 }) {
      const params = { limit: PAGE, offset: Math.max(0, Math.min(4000, Number(offset) || 0)) };
      const data = q
        ? await call('/gifs/search', { ...params, q })
        : await call('/gifs/trending', params);
      const items = (data.data ?? []).map(toItem).filter((x) => x.url && x.preview);
      const total = data.pagination?.total_count ?? 0;
      return { items, nextOffset: params.offset + (data.pagination?.count ?? items.length), hasMore: params.offset + items.length < total };
    },

    // Tela inicial: um GIF de fundo para "em alta" e para cada categoria
    async home() {
      const first = async (path, params) => {
        try {
          const data = await call(path, { ...params, limit: 1 }, HOME_CACHE_MS);
          return data.data?.[0] ? toItem(data.data[0]).preview : null;
        } catch { return null; }
      };
      const [trending, ...previews] = await Promise.all([
        first('/gifs/trending', {}),
        ...CATEGORIES.map(([q]) => first('/gifs/search', { q })),
      ]);
      return { trending, categories: CATEGORIES.map(([q, label], i) => ({ q, label, preview: previews[i] })) };
    },
  };
}
