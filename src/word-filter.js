// Filtro de palavras do servidor (Configurações do servidor → Filtro de palavras).
// Cada linha é uma palavra; "palavra*" pega também o que começa com ela (ex.: "idiot*" pega "idiota").
// Compara sem maiúsculas e sem acento ("não" = "nao"). Modo "block" recusa a mensagem; "mask" troca por ***.
export const FILTER_MAX_WORDS = 200;

const fold = (s) => String(s).toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');

// Limpa a lista que veio da tela: sem repetidas, sem vazias, até 200, cada uma com até 40 letras
export function cleanFilter(words, mode) {
  const list = [...new Set((Array.isArray(words) ? words : String(words ?? '').split(/\n|,/))
    .map((w) => fold(w).replace(/[^\p{L}\p{N}*]/gu, '').replace(/\*+$/, '*').replace(/^\*+/, '').slice(0, 40))
    .filter((w) => w.replace('*', '').length >= 2))].slice(0, FILTER_MAX_WORDS);
  return list.length ? { words: list, mode: mode === 'mask' ? 'mask' : 'block' } : null;
}

function matcher(filter) {
  const exact = new Set();
  const prefixes = [];
  for (const w of filter?.words ?? []) (w.endsWith('*') ? prefixes.push(w.slice(0, -1)) : exact.add(w));
  return (token) => {
    const t = fold(token);
    return exact.has(t) || prefixes.some((p) => t.startsWith(p));
  };
}

// { hits: [palavras achadas], text: texto (com *** no modo mask) }
export function applyFilter(filter, text) {
  if (!filter?.words?.length || !text) return { hits: [], text };
  const bad = matcher(filter);
  const hits = [];
  const out = String(text).replace(/<[@#a:][^>]*>|[\p{L}\p{N}]+/gu, (token) => {
    if (token.startsWith('<')) return token; // menções e emojis do servidor ficam como estão
    if (!bad(token)) return token;
    hits.push(fold(token));
    return '*'.repeat(Math.min(token.length, 8));
  });
  return { hits, text: filter.mode === 'mask' ? out : text };
}
