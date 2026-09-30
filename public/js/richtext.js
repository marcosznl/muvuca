// Regras de texto do chat, sem tela (dá para testar no Node): emojis do servidor, menções, GIFs.
// Na mensagem guardada, emojis ficam como <:nome:id> (<a:…> se animado) e menções como <@u12>:
// assim renomear o emoji ou a pessoa não quebra mensagens antigas.

// Mensagem que é só um GIF do Giphy (só desse endereço vira imagem; links quaisquer continuam links)
export const GIF_URL = /^https:\/\/(media\d?|i)\.giphy\.com\/media\/[\w.\/-]+\.(gif|webp)$/;
export const CUSTOM_EMOJI = /<(a?):(\w{2,32}):(e-[0-9a-f]{10})>/g;
export const MENTION = /<@(u\d+|todos|&r-[0-9a-f]+)>/g; // pessoa, @todos ou cargo
const ONLY_EMOJIS = /^(?:\s|<a?:\w{2,32}:e-[0-9a-f]{10}>|\p{Extended_Pictographic}|\p{Emoji_Modifier}|️|‍)+$/u;

// Só emojis (até 27) ficam grandes, como no Discord
export function isJumbo(text) {
  const count = (text.match(CUSTOM_EMOJI) || []).length + (text.replace(CUSTOM_EMOJI, '').match(/\p{Extended_Pictographic}/gu) || []).length;
  return count > 0 && count <= 27 && ONLY_EMOJIS.test(text);
}

// Emojis que dá para usar: os do servidor aberto primeiro, depois os dos outros servidores da pessoa
export function usableEmojis(servers, currentServerId) {
  const current = servers.find((s) => s.id === currentServerId);
  return [current, ...servers.filter((s) => s !== current)]
    .filter(Boolean)
    .flatMap((srv) => (srv.emojis ?? []).map((e) => ({ ...e, server: srv })));
}

// Ao enviar: :nome: vira <:nome:id> (nome exato primeiro; senão, ignorando maiúsculas)
export function encodeCustomEmojis(text, emojis) {
  return text.replace(/(?<!<a?):(\w{2,32}):(?!e-[0-9a-f]{10}>)/g, (whole, name) => {
    const e = emojis.find((x) => x.name === name) ?? emojis.find((x) => x.name.toLowerCase() === name.toLowerCase());
    return e ? `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>` : whole;
  });
}

// Ao enviar/editar: "@Nome" ou "@usuario" de alguém do servidor vira <@id>
// (nomes mais longos primeiro: "@Ana Clara" antes de "@Ana")
export function encodeMentions(text, members) {
  const keys = members
    .flatMap((m) => [[m.name, m.id], [m.username, m.id]])
    .sort((a, b) => b[0].length - a[0].length);
  let out = text;
  for (const [key, id] of keys) {
    const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`(^|[^\\w<])@${esc}(?![\\p{L}\\p{N}_])`, 'giu'), `$1<@${id}>`);
  }
  return out;
}

export const encodeMessage = (text, { emojis, members }) => encodeMentions(encodeCustomEmojis(text, emojis), members);

// No campo de edição e nos resumos: emojis voltam a ser :nome: e menções voltam a ser @Nome
export const decodeMessage = (text, nameOf) =>
  text.replace(CUSTOM_EMOJI, ':$2:').replace(MENTION, (_, id) => `@${nameOf(id) ?? 'alguém'}`);

// Resumo de uma linha (citação do reply)
export const snippet = (text, nameOf) =>
  (GIF_URL.test(text) ? 'GIF' : text ? decodeMessage(plainText(text), nameOf).replace(/\s+/g, ' ').slice(0, 120) : '📎 Anexo');

// Busca sem acento e sem maiúsculas ("jose" acha "José")
export const fold = (t) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Sugestões ao digitar @: quem começa com o texto primeiro, depois quem só contém; no máximo 8
export function mentionSuggestions(members, query) {
  const q = fold(query);
  return members
    .filter((p) => !q || fold(p.name).includes(q) || fold(p.username).includes(q))
    .sort((a, b) => Number(!fold(a.name).startsWith(q)) - Number(!fold(b.name).startsWith(q)) || a.name.localeCompare(b.name, 'pt-BR'))
    .slice(0, 8);
}

// ---------- Formatação (como no Discord) ----------
// **negrito**, *itálico* ou _itálico_, ~~riscado~~, `código`, ```bloco de código```, ||spoiler|| e "> citação".
// Links, menções e emojis do servidor ficam inteiros (um link com _ no meio não vira itálico).
// Devolve uma árvore: { type: 'text' | 'code' | 'codeblock' | 'bold' | 'italic' | 'strike' | 'spoiler' | 'quote', text?, children? }

const INLINE = /(https?:\/\/[^\s<>"]+|<a?:\w{2,32}:e-[0-9a-f]{10}>|<@u\d+>)|`([^`\n]+)`|\|\|([\s\S]+?)\|\||\*\*([\s\S]+?)\*\*|~~([\s\S]+?)~~|\*(?![\s*])([^*\n]+?)\*|(?<![\w])_(?![\s_])([^_\n]+?)_(?![\w])/g;

function parseInline(text) {
  const out = [];
  let last = 0;
  const pushText = (t) => { if (!t) return; const prev = out[out.length - 1]; if (prev?.type === 'text') prev.text += t; else out.push({ type: 'text', text: t }); };
  for (const m of text.matchAll(INLINE)) {
    pushText(text.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[1] !== undefined) pushText(m[1]);                                   // link, menção ou emoji: inteiro
    else if (m[2] !== undefined) out.push({ type: 'code', text: m[2] });
    else if (m[3] !== undefined) out.push({ type: 'spoiler', children: parseInline(m[3]) });
    else if (m[4] !== undefined) out.push({ type: 'bold', children: parseInline(m[4]) });
    else if (m[5] !== undefined) out.push({ type: 'strike', children: parseInline(m[5]) });
    else out.push({ type: 'italic', children: parseInline(m[6] ?? m[7]) });
  }
  pushText(text.slice(last));
  return out;
}

// Citações ("> " no começo da linha) juntam as linhas seguidas
function parseLines(text) {
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (/^> ?/.test(lines[i]) && lines[i] !== '>') {
      const quoted = [];
      while (i < lines.length && /^> ?/.test(lines[i])) quoted.push(lines[i++].replace(/^> ?/, ''));
      i--;
      out.push({ type: 'quote', children: parseInline(quoted.join('\n')) });
    } else {
      const inline = parseInline(lines[i] + (i < lines.length - 1 ? '\n' : ''));
      for (const n of inline) {
        const prev = out[out.length - 1];
        if (n.type === 'text' && prev?.type === 'text') prev.text += n.text; else out.push(n);
      }
    }
  }
  return out;
}

export function parseMarkdown(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(/```(?:([\w+-]{1,15})\n)?([\s\S]*?)```/g)) {
    out.push(...parseLines(text.slice(last, m.index)));
    out.push({ type: 'codeblock', lang: m[1] ?? '', text: m[2].replace(/^\n|\n$/g, '') });
    last = m.index + m[0].length;
  }
  out.push(...parseLines(text.slice(last)));
  return out.filter((n) => n.type !== 'text' || n.text);
}

// Só o texto, sem as marcações (resumos e notificações)
export function plainText(text) {
  const walk = (nodes) => nodes.map((n) => (n.children ? walk(n.children) : n.type === 'spoiler' ? '▒▒▒' : n.text)).join('');
  return walk(parseMarkdown(text).map((n) => (n.type === 'spoiler' ? { type: 'text', text: '▒▒▒' } : n)));
}
