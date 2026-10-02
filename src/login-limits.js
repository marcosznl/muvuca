// Limite de senhas erradas por conta (vale de qualquer IP): 10 erros seguidos = espera de 1 min, dobrando
// até 15 min. Assim ninguém fica tentando senhas de uma conta trocando de IP. Sem dependências (dá para testar).
export function accountLimiter({ maxFails = 10, firstLockMs = 60_000, maxLockMs = 15 * 60_000, forgetMs = 3_600_000 } = {}) {
  const fails = new Map(); // usuário -> { count, until, lockMs, last }
  return {
    locked: (username, now = Date.now()) => (fails.get(username)?.until ?? 0) > now,
    failed(username, now = Date.now()) {
      const f = fails.get(username) ?? { count: 0, until: 0, lockMs: firstLockMs / 2 };
      f.count++;
      f.last = now;
      if (f.count >= maxFails) { f.lockMs = Math.min(f.lockMs * 2, maxLockMs); f.until = now + f.lockMs; f.count = 0; }
      fails.set(username, f);
    },
    succeeded: (username) => fails.delete(username),
    // Esquece a conta 1 hora depois do último erro e do fim do bloqueio (não antes: quem ainda está
    // errando senhas mantém a contagem, mesmo sem ter sido bloqueado ainda)
    cleanup(now = Date.now()) {
      for (const [name, f] of fails) if (Math.max(f.until, f.last) < now - forgetMs) fails.delete(name);
    },
    size: () => fails.size,
  };
}
