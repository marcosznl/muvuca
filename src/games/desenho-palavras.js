// Palavras do "Desenha aí", por tema e dificuldade. As fáceis valem os pontos normais; médias e difíceis valem mais.
// "Palavras da galera" (cadastradas pelo dono do servidor) entram à parte (ver desenho.js).

const list = (s) => s.split(',').map((w) => w.trim()).filter(Boolean);

export const THEMES = {
  comida: {
    label: 'Comida',
    facil: list('banana, maçã, pizza, bolo, ovo, pão, uva, sorvete, pipoca, melancia, cenoura, queijo, hambúrguer, tomate, milho, chocolate, pera, limão, pirulito, biscoito'),
    medio: list('coxinha, brigadeiro, pastel, sushi, cachorro-quente, abacaxi, cebola, panqueca, sanduíche, espaguete, torrada, morango, café, cupcake, batata frita, salsicha, cereja, abacate, rosquinha, picolé'),
    dificil: list('feijoada, açaí, farofa, cuscuz, lasanha, churrasco, fondue, pudim, tapioca, strogonoff, baião de dois, pão de queijo, acarajé, empadão, marmita'),
  },
  animais: {
    label: 'Animais',
    facil: list('gato, cachorro, peixe, pato, vaca, porco, cobra, leão, elefante, girafa, galinha, sapo, abelha, borboleta, coelho, cavalo, rato, ovelha, aranha, joaninha'),
    medio: list('tartaruga, tubarão, jacaré, polvo, pinguim, macaco, zebra, camelo, papagaio, formiga, caracol, coruja, baleia, tigre, golfinho, esquilo, raposa, lobo, urso, minhoca'),
    dificil: list('capivara, tucano, arara, bicho-preguiça, ornitorrinco, camaleão, flamingo, canguru, lagosta, morcego, cavalo-marinho, tamanduá, pavão, água-viva, lhama'),
  },
  objetos: {
    label: 'Objetos',
    facil: list('bola, carro, cadeira, mesa, livro, chave, óculos, relógio, lápis, copo, cama, sapato, chapéu, balão, guarda-chuva, porta, janela, garfo, colher, tesoura'),
    medio: list('martelo, escova de dentes, telefone, televisão, computador, vassoura, guitarra, bicicleta, mochila, lâmpada, escada, pipa, vela, xícara, violão, microfone, câmera, travesseiro, geladeira, patinete'),
    dificil: list('berimbau, sanfona, microscópio, ventilador, aspirador, controle remoto, fone de ouvido, ampulheta, bússola, cadeado, liquidificador, secador de cabelo, cabide, grampeador, extintor'),
  },
  lugares: {
    label: 'Lugares',
    facil: list('praia, escola, igreja, castelo, ponte, ilha, montanha, fazenda, piscina, hospital, casa, floresta, rua, jardim, lago'),
    medio: list('farol, vulcão, deserto, cachoeira, aeroporto, circo, museu, cinema, estádio, parque de diversões, supermercado, zoológico, padaria, biblioteca, posto de gasolina'),
    dificil: list('Cristo Redentor, Pão de Açúcar, pirâmide, Torre Eiffel, planetário, labirinto, estação espacial, oásis, Estátua da Liberdade, iglu, submarino, torre de controle, caverna, geleira, arranha-céu'),
  },
  personagens: {
    label: 'Personagens',
    facil: list('palhaço, pirata, fantasma, robô, sereia, rei, princesa, bruxa, astronauta, esqueleto, fada, anjo, boneco de neve, dinossauro, monstro'),
    medio: list('vampiro, zumbi, ninja, mágico, dragão, unicórnio, alienígena, cowboy, mergulhador, bombeiro, cavaleiro, detetive, múmia, gênio da lâmpada, lobisomem'),
    dificil: list('Saci, Mula sem cabeça, Curupira, Papai Noel, Batman, Homem-Aranha, Pikachu, Mario, Bob Esponja, Shrek, Iara, Boto-cor-de-rosa, Chapeuzinho Vermelho, Pinóquio, Coelhinho da Páscoa'),
  },
  brasil: {
    label: 'Brasilidades',
    facil: list('futebol, carnaval, samba, chinelo, rede, biquíni, pandeiro, coqueiro, bandeira do Brasil, cadeira de praia, sol, roda de violão, bala de coco, coco, abacaxi com canudo'),
    medio: list('jangada, fusca, cafuné, orelhão, guaraná, forró, capoeira, festa junina, cocada, fogueira, pé de moleque, pipa no céu, bloco de carnaval, escola de samba, marmita da vó'),
    dificil: list('bumba meu boi, frevo, quadrilha, carro de som, feira livre, churrasco na laje, pagode, barraca de praia, trio elétrico, mate com limão, Amazônia, pororoca, boia na piscina, vendedor de mate, prato feito'),
  },
};

export const DIFFICULTIES = { facil: { label: 'Fácil', bonus: 1 }, medio: { label: 'Média', bonus: 1.25 }, dificil: { label: 'Difícil', bonus: 1.5 } };

// Todas as palavras de um tema (ou de todos) numa dificuldade (ou em todas): [{ word, theme, level }]
export function wordsFor(theme = 'todos', level = 'misturado') {
  const themes = theme === 'todos' ? Object.keys(THEMES) : [theme].filter((t) => THEMES[t]);
  const levels = level === 'misturado' ? Object.keys(DIFFICULTIES) : [level].filter((l) => DIFFICULTIES[l]);
  const out = [];
  for (const t of themes) for (const l of levels) for (const word of THEMES[t][l]) out.push({ word, theme: t, level: l });
  return out;
}
