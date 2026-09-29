// Curva de níveis do XP da conta (mais difícil que a do bot do Discord / MEE6): do nível n para o n+1
// precisa de 25n² + 100n + 250 XP. Nível 1 = 250 XP, nível 10 ≈ 14 mil, nível 20 ≈ 86 mil, nível 30 ≈ 256 mil.
export const xpToNext = (n) => 25 * n * n + 100 * n + 250;

// { total, level, into (XP dentro do nível), need (XP do nível inteiro) }
export function xpInfo(total) {
  total = Math.max(0, Math.floor(Number(total) || 0));
  let level = 0;
  let base = 0;
  while (total >= base + xpToNext(level)) { base += xpToNext(level); level++; }
  return { total, level, into: total - base, need: xpToNext(level) };
}

// Como se ganha XP (usado pelo Muvuca em src/xp.js e mostrado no painel)
export const XP_RULES = {
  message: { min: 15, max: 25, cooldownMs: 60_000, minChars: 5 },
  voicePerMinute: 3,  // em call com pelo menos mais 1 pessoa, sem estar ensurdecido
  gamePlayed: 10,     // partida com 2 ou mais pessoas
  gameWon: 40,
};
