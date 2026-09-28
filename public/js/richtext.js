// Regras de texto do chat, sem tela (dá para testar no Node): emojis do servidor, menções, GIFs.
// Na mensagem guardada, emojis ficam como <:nome:id> (<a:…> se animado) e menções como <@u12>:
// assim renomear o emoji ou a pessoa não quebra mensagens antigas.

// Mensagem que é só um GIF do Giphy (só desse endereço vira imagem; links quaisquer continuam links)
export const GIF_URL = /^https:\/\/(media\d?|i)\.giphy\.com\/media\/[\w.\/-]+\.(gif|webp)$/;
export const CUSTOM_EMOJI = /<(a?):(\w{2,32}):(e-[0-9a-f]{10})>/g;
export const MENTION = /<@(u\d+)>/g;
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
  (GIF_URL.test(text) ? 'GIF' : text ? decodeMessage(text, nameOf).replace(/\s+/g, ' ').slice(0, 120) : '📎 Anexo');

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
