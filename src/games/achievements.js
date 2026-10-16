// Conquistas dos jogos, calculadas pelos números de cada pessoa (partidas com 2+ pessoas de verdade)
// Jogos que saíram continuam com o nome certo nas conquistas antigas
const NAMES = { bomberman: 'Bomberman', desenho: 'Desenha aí', stop: 'Stop', tron: 'Tron', tanks: 'Tanquinhos', agar: 'Agar', velha: 'Jogo da velha', cartas: 'Última!', impostor: 'Impostor' };

export function achievements(byGame) {
  const wins = byGame.reduce((n, g) => n + g.wins, 0);
  const played = byGame.reduce((n, g) => n + g.played, 0);
  const out = [];
  const add = (id, emoji, title, desc, got) => out.push({ id, emoji, title, desc, got });
  add('primeira', '🥇', 'Primeira vitória', 'Venceu uma partida', wins >= 1);
  add('dez', '🔟', 'Dezena', 'Venceu 10 partidas', wins >= 10);
  add('cinquenta', '💯', 'Frequentador', 'Jogou 50 partidas', played >= 50);
  add('ecletico', '🎲', 'Eclético', 'Venceu nos 3 jogos', byGame.filter((g) => g.wins > 0).length >= 3);
  for (const g of byGame) if (g.wins >= 5) add(`mestre-${g.game}`, '👑', `Mestre do ${NAMES[g.game] ?? g.game}`, `Venceu 5 vezes no ${NAMES[g.game] ?? g.game}`, true);
  return out;
}
