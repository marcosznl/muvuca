// Anti-spam do chat: segura quem manda a mesma coisa várias vezes ou marca gente demais de uma vez
// (mensagens rápidas demais já são seguradas pelo limite de 5 a cada 5 s). Quem cai aqui fica um tempo sem mandar
// mensagem (1 min, depois 5, depois 15 se repetir na mesma hora) e a auditoria registra.
// A trava é só de mensagens: a pessoa continua na call, nos jogos etc.
export const SPAM_RULES = {
  repeatCount: 4,          // a mesma mensagem 4 vezes…
  repeatWindowMs: 60_000,  // …em 1 minuto (em qualquer canal) = spam
  maxMentions: 6,          // pessoas diferentes marcadas numa mensagem só
  timeouts: [60_000, 5 * 60_000, 15 * 60_000],
  strikeWindowMs: 60 * 60_000, // as travas vão aumentando dentro de 1 hora
};

const people = new Map(); // userId -> { recent: [{ key, at }], strikes: [at], until }

const entry = (userId) => {
  let e = people.get(userId);
  if (!e) people.set(userId, (e = { recent: [], strikes: [], until: 0 }));
  return e;
};

// Texto comparável: sem maiúsculas, espaços e pontuação repetida ("oi!!!" = "oi !")
const normalize = (text) => String(text).toLowerCase().normalize('NFKC').replace(/\s+/g, ' ').replace(/(.)\1{2,}/gu, '$1$1').trim();

const minutes = (ms) => (ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.ceil(ms / 1000)} s`);

export class SpamError extends Error { // o chat devolve a mensagem para a pessoa (vira ActionError lá)
  constructor(message, { reason = null, timeoutMs = 0 } = {}) {
    super(message);
    this.reason = reason;     // preenchido só quando a pessoa acabou de ser travada (para a auditoria)
    this.timeoutMs = timeoutMs;
  }
}

function strike(e, now, reason) {
  e.strikes = e.strikes.filter((t) => now - t < SPAM_RULES.strikeWindowMs);
  const ms = SPAM_RULES.timeouts[Math.min(e.strikes.length, SPAM_RULES.timeouts.length - 1)];
  e.strikes.push(now);
  e.until = now + ms;
  e.recent = [];
  return new SpamError(`${reason}. Você ficou sem mandar mensagens por ${minutes(ms)}.`, { reason, timeoutMs: ms });
}

// Chamado antes de aceitar a mensagem. Lança SpamError se não pode mandar.
export function checkSpam(userId, text, { now = Date.now() } = {}) {
  const e = entry(userId);
  if (e.until > now) throw new SpamError(`Calma! Você está sem mandar mensagens por mais ${minutes(e.until - now)} (spam).`);
  const mentions = new Set(String(text).match(/<@u\d+>/g) ?? []);
  if (mentions.size > SPAM_RULES.maxMentions) throw strike(e, now, `Marcou ${mentions.size} pessoas de uma vez`);
  const key = normalize(text);
  if (key.length < 4) return; // "kkkk", "sim", emoji solto, só anexo: conversa normal, não conta como repetição
  e.recent = e.recent.filter((r) => now - r.at < SPAM_RULES.repeatWindowMs);
  const same = e.recent.filter((r) => r.key === key).length;
  if (same + 1 >= SPAM_RULES.repeatCount) throw strike(e, now, 'Mandou a mesma mensagem várias vezes');
  e.recent.push({ key, at: now });
  if (e.recent.length > 20) e.recent.shift();
}

// Painel/testes: tira a trava de alguém
export function clearSpam(userId) { people.delete(userId); }

// Limpa quem já não tem nada guardado (a cada 10 min)
setInterval(() => {
  const now = Date.now();
  for (const [id, e] of people) {
    if (e.until < now && !e.recent.some((r) => now - r.at < SPAM_RULES.repeatWindowMs) && !e.strikes.some((t) => now - t < SPAM_RULES.strikeWindowMs)) people.delete(id);
  }
}, 10 * 60_000).unref();
