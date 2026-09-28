// "Última!": jogo de cartas de descartar, com a nossa cara: cores da bandeira (verde, amarelo, azul, branco) e
// cartas especiais "Deu ruim" (pular), "Meia-volta" (inverter), "Fiado" (+2), "Jeitinho" (coringa) e
// "Leão da Receita" (+4). Quem fica com uma carta grita "Última!"; se esquecer e alguém pegar antes, compra 2.
// Regras da casa (quem manda na sala liga antes de começar): acumular, corte, zero troca e sete troca.
// Com menos de 3 pessoas entram robôs. Cada pessoa só recebe as próprias cartas (stateFor).

export const MAX_PLAYERS = 8;
export const HAND = 7;
export const TURN_MS = 25_000;
export const CATCH_MS = 4000;      // janela para alguém pegar quem esqueceu de gritar
const BOT_DELAY_MS = 1100;
const MIN_SEATS = 3;               // com menos gente, completa com robôs
export const COLORS = ['green', 'yellow', 'blue', 'white'];

// Regras da casa (as que todo brasileiro joga); o site mostra como opções da sala
export const RULES = {
  acumular: { label: 'Acumular', hint: 'Fiado em cima de Fiado (e Leão em cima de tudo) vai somando até alguém não ter para jogar.', default: true },
  corte: { label: 'Corte', hint: 'Tem a carta igualzinha à da mesa? Joga na hora, mesmo fora da vez.', default: false },
  zero: { label: 'Zero troca', hint: 'Jogou um 0: todo mundo passa a mão para o lado.', default: false },
  sete: { label: 'Sete troca', hint: 'Jogou um 7: troca a mão com quem quiser.', default: false },
};
export const defaultRules = () => Object.fromEntries(Object.entries(RULES).map(([k, r]) => [k, r.default]));

// 108 cartas: por cor, um 0, dois de 1 a 9, dois pular/inverter/+2; mais 4 coringas e 4 +4
export function buildDeck() {
  const deck = [];
  let id = 0;
  for (const color of COLORS) {
    deck.push({ id: id++, color, value: '0' });
    for (let k = 0; k < 2; k++) {
      for (let n = 1; n <= 9; n++) deck.push({ id: id++, color, value: String(n) });
      for (const v of ['skip', 'reverse', 'draw2']) deck.push({ id: id++, color, value: v });
    }
  }
  for (let k = 0; k < 4; k++) {
    deck.push({ id: id++, color: null, value: 'wild' });
    deck.push({ id: id++, color: null, value: 'wild4' });
  }
  return deck;
}

export class Cartas {
  constructor(players, { random = Math.random, bots = true, rules = {} } = {}) {
    this.random = random;
    this.rules = { ...defaultRules(), ...Object.fromEntries(Object.keys(RULES).map((k) => [k, rules[k] ?? RULES[k].default])) };
    this.pendingDraw = 0;       // acumular: quantas cartas o próximo vai ter que comprar
    const list = players.slice(0, MAX_PLAYERS).map((p) => ({ id: p.id, name: p.name }));
    const botCount = bots ? Math.max(0, MIN_SEATS - list.length) : 0;
    for (let i = 1; i <= botCount; i++) list.push({ id: `bot${i}`, name: `Robô ${i}`, bot: true });
    this.players = list.map((p, i) => ({ ...p, color: i, hand: [], called: false, alive: true }));
    this.draw = this.shuffle(buildDeck());
    this.discard = [];
    for (const p of this.players) p.hand = this.take(HAND);
    // Primeira carta da mesa: nunca um +4; coringa vira uma cor sorteada
    let first = this.draw.pop();
    while (first.value === 'wild4') { this.draw.unshift(first); first = this.draw.pop(); }
    this.discard.push(first);
    this.color = first.color ?? COLORS[Math.floor(this.random() * 4)];
    this.dir = 1;
    this.turn = 0;
    this.drewThisTurn = null;   // carta comprada nesta vez (pode ser jogada ou passar)
    this.pendingCatch = null;   // { id, until } quem ficou com 1 carta sem gritar
    this.turnLeft = TURN_MS;
    this.botWait = BOT_DELAY_MS;
    this.log = [];              // últimos acontecimentos (aparece na mesa)
    this.over = false;
    this.winner = null;
    this.dirty = true;
    // A primeira carta vale como jogada (pular, inverter, +2)
    this.applyStart(first);
  }

  shuffle(cards) {
    for (let i = cards.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      [cards[i], cards[j]] = [cards[j], cards[i]];
    }
    return cards;
  }

  // Compra do monte; acabou, embaralha o descarte (menos a carta de cima)
  take(n) {
    const out = [];
    for (let i = 0; i < n; i++) {
      if (!this.draw.length) {
        const top = this.discard.pop();
        this.draw = this.shuffle(this.discard);
        this.discard = [top];
      }
      if (!this.draw.length) break; // todas as cartas estão nas mãos
      out.push(this.draw.pop());
    }
    return out;
  }

  player(id) { return this.players.find((p) => p.id === id); }
  get current() { return this.players[this.turn]; }
  get top() { return this.discard[this.discard.length - 1]; }
  next(steps = 1) {
    const n = this.players.length;
    let t = this.turn;
    for (let k = 0; k < steps; k++) {
      do { t = (t + this.dir + n) % n; } while (!this.players[t].alive && this.players.some((p) => p.alive));
    }
    return t;
  }

  canPlay(card) {
    // Com cartas acumuladas, só dá para jogar outra de compra (Fiado em Fiado, Leão em qualquer uma)
    if (this.pendingDraw) return card.value === 'wild4' || (card.value === 'draw2' && this.top.value === 'draw2');
    return card.color === null || card.color === this.color || card.value === this.top.value;
  }

  // Corte: carta igualzinha à de cima (mesma cor e valor), fora da vez
  canCut(card) {
    return this.rules.corte && !this.pendingDraw && card.color !== null && card.color === this.top.color && card.value === this.top.value;
  }

  say(text) {
    this.log.push(text);
    if (this.log.length > 4) this.log.shift();
  }

  applyStart(card) {
    if (card.value === 'skip') this.turn = this.next();
    if (card.value === 'reverse') { this.dir = -1; if (this.players.length === 2) this.turn = this.next(); else this.turn = this.players.length - 1; }
    if (card.value === 'draw2') { this.current.hand.push(...this.take(2)); this.turn = this.next(); }
  }

  // Comandos: { card, color, target } joga; { act: 'draw' | 'pass' | 'call' | 'catch' }
  input(id, { card, color, act, target } = {}) {
    const p = this.player(id);
    if (!p || !p.alive || this.over) return;
    if (act === 'call') return this.call(p);
    if (act === 'catch') return this.catchFor(p);
    // Corte: fora da vez, com a carta igual à de cima, a vez passa a ser de quem cortou
    if (this.current !== p && Number.isInteger(card)) {
      const c = p.hand.find((x) => x.id === card);
      if (!c || !this.canCut(c)) return;
      this.turn = this.players.indexOf(p);
      this.drewThisTurn = null;
      this.say(`${p.name} cortou! ✂️`);
      return this.play(p, card, color, target);
    }
    if (this.current !== p) return;
    if (act === 'draw') return this.drawCard(p);
    if (act === 'pass') return this.pass(p);
    if (Number.isInteger(card)) this.play(p, card, color, target);
  }

  eliminate(id) {
    const p = this.player(id);
    if (!p || !p.alive) return;
    const wasTurn = this.current === p;
    p.alive = false;
    this.draw.unshift(...p.hand); // as cartas dele voltam para o fundo do monte
    p.hand = [];
    this.say(`${p.name} saiu.`);
    const left = this.players.filter((x) => x.alive && !x.bot);
    const alive = this.players.filter((x) => x.alive);
    if (!left.length || alive.length === 1) {
      this.over = true;
      this.winner = alive.length === 1 ? alive[0].id : null;
    } else if (wasTurn) this.advance(1);
    this.dirty = true;
  }

  play(p, cardId, color, target) {
    const i = p.hand.findIndex((c) => c.id === cardId);
    if (i < 0) return;
    const card = p.hand[i];
    if (!this.canPlay(card) && !this.canCut(card)) return;
    if (this.drewThisTurn && this.drewThisTurn !== card.id) return; // depois de comprar, só a comprada
    if (card.color === null && !COLORS.includes(color)) return;       // coringa precisa da cor
    // Sete troca: precisa dizer com quem (se ainda sobrar carta depois de jogar)
    const swapWith = this.rules.sete && card.value === '7' && p.hand.length > 1 ? this.players.find((x) => x.id === target && x !== p && x.alive) : null;
    if (this.rules.sete && card.value === '7' && p.hand.length > 1 && !swapWith) return;
    p.hand.splice(i, 1);
    this.discard.push(card);
    this.color = card.color ?? color;
    this.say(`${p.name} jogou ${label(card, this.color)}.`);
    // Ficou com 1 carta sem ter gritado: abre a janela para os outros pegarem
    if (p.hand.length === 1 && !p.called) this.pendingCatch = { id: p.id, until: CATCH_MS };
    if (p.hand.length !== 1) p.called = false;
    if (!p.hand.length) {
      this.over = true;
      this.winner = p.id;
      this.dirty = true;
      return;
    }
    let skip = 1;
    if (card.value === 'skip') skip = 2;
    if (card.value === 'reverse') {
      this.dir = -this.dir;
      if (this.players.filter((x) => x.alive).length === 2) skip = 2; // com 2, inverter = pular
    }
    if (card.value === 'draw2' || card.value === 'wild4') {
      const n = card.value === 'draw2' ? 2 : 4;
      if (this.rules.acumular) {
        // Acumula: o próximo cobre com outra (e passa adiante) ou compra tudo
        this.pendingDraw += n;
        this.say(`Acumulou! Quem não tiver para jogar compra ${this.pendingDraw}.`);
      } else {
        const victim = this.players[this.next()];
        victim.hand.push(...this.take(n));
        victim.called = false;
        this.say(`${victim.name} ${n === 2 ? 'comprou 2 fiado' : 'caiu no Leão da Receita: +4'} e perdeu a vez.`);
        skip = 2;
      }
    }
    if (swapWith) {
      [p.hand, swapWith.hand] = [swapWith.hand, p.hand];
      this.say(`${p.name} trocou de mão com ${swapWith.name}! 🔄`);
      this.afterSwap();
    }
    if (this.rules.zero && card.value === '0') {
      // Todo mundo passa a mão para o próximo, no sentido da rodada
      const alive = this.players.filter((x) => x.alive);
      const order = this.dir === 1 ? alive : [...alive].reverse();
      const hands = order.map((x) => x.hand);
      order.forEach((x, k) => { x.hand = hands[(k - 1 + order.length) % order.length]; });
      this.say('Zero! Todo mundo passou a mão para o lado. 🔄');
      this.afterSwap();
    }
    this.advance(skip);
  }

  // Depois de trocar mãos: quem ficou com uma carta está salvo (não foi culpa dele)
  afterSwap() {
    this.pendingCatch = null;
    for (const x of this.players) x.called = x.hand.length === 1;
  }

  drawCard(p) {
    if (this.drewThisTurn) return;
    // Não tinha como cobrir o acumulado: compra tudo e perde a vez
    if (this.pendingDraw) {
      const n = this.pendingDraw;
      this.pendingDraw = 0;
      p.hand.push(...this.take(n));
      p.called = false;
      this.say(`${p.name} ${n >= 8 ? 'se afundou em' : 'comprou'} ${n} cartas! 😱`);
      return this.advance(1);
    }
    const [card] = this.take(1);
    p.called = false;
    if (!card) return this.advance(1);
    p.hand.push(card);
    this.say(`${p.name} comprou uma carta.`);
    if (this.canPlay(card)) { this.drewThisTurn = card.id; this.dirty = true; } // pode jogar a comprada ou passar
    else this.advance(1);
  }

  pass(p) {
    if (!this.drewThisTurn) return; // só passa depois de comprar
    this.say(`${p.name} passou.`);
    this.advance(1);
  }

  // Gritou "Última!": vale com 2 cartas (antes de jogar) ou com 1 (antes de alguém pegar)
  call(p) {
    if (p.hand.length > 2 || p.called) return;
    p.called = true;
    if (this.pendingCatch?.id === p.id) this.pendingCatch = null;
    this.say(`${p.name}: ÚLTIMA! 📣`);
    this.dirty = true;
  }

  catchFor(catcher) {
    const pc = this.pendingCatch;
    if (!pc || pc.id === catcher.id) return;
    const target = this.player(pc.id);
    this.pendingCatch = null;
    if (!target || target.hand.length !== 1) return;
    target.hand.push(...this.take(2));
    this.say(`${catcher.name} pegou ${target.name}! Esqueceu de gritar: +2.`);
    this.dirty = true;
  }

  advance(steps) {
    this.turn = this.next(steps);
    this.drewThisTurn = null;
    this.turnLeft = TURN_MS;
    this.botWait = BOT_DELAY_MS + this.random() * 600;
    this.dirty = true;
  }

  tick(ms) {
    if (this.over) return;
    if (this.pendingCatch) {
      this.pendingCatch.until -= ms;
      // Robôs atentos pegam quem esqueceu (depois de uns 2 s)
      if (this.pendingCatch.until < CATCH_MS - 2000) {
        const bot = this.players.find((b) => b.bot && b.alive && b.id !== this.pendingCatch.id);
        if (bot && this.random() < 0.05) this.catchFor(bot);
      }
      if (this.pendingCatch && this.pendingCatch.until <= 0) { this.pendingCatch = null; this.dirty = true; }
    }
    const p = this.current;
    if (p.bot) {
      this.botWait -= ms;
      if (this.botWait <= 0) this.botMove(p);
      return;
    }
    this.turnLeft -= ms;
    if (this.turnLeft <= 0) {
      // Demorou: compra uma (ou o acumulado) e passa a vez
      this.say(`${p.name} demorou demais.`);
      if (this.pendingDraw) return this.drawCard(p);
      if (!this.drewThisTurn) {
        const [card] = this.take(1);
        if (card) p.hand.push(card);
      }
      this.advance(1);
    }
  }

  // Robô: grita quando pode (às vezes esquece), joga a primeira carta que serve (coringa por último)
  botMove(p) {
    if (p.hand.length === 2 && !p.called && this.random() < 0.8) this.call(p);
    const playable = p.hand.filter((c) => this.canPlay(c) && (!this.drewThisTurn || c.id === this.drewThisTurn));
    playable.sort((a, b) => (a.color === null) - (b.color === null));
    const card = playable[0];
    if (card) {
      const counts = COLORS.map((c) => p.hand.filter((x) => x.color === c).length);
      const best = COLORS[counts.indexOf(Math.max(...counts))];
      // Sete troca: troca com quem tem menos cartas
      const target = this.players.filter((x) => x !== p && x.alive).sort((a, b) => a.hand.length - b.hand.length)[0]?.id;
      return this.play(p, card.id, best, target);
    }
    if (this.drewThisTurn) return this.pass(p);
    this.drawCard(p);
    this.botWait = BOT_DELAY_MS * 0.6;
  }

  // O que cada pessoa vê: a própria mão inteira; dos outros, só quantas cartas
  stateFor(viewerId) {
    const me = this.player(viewerId);
    return {
      top: this.top,
      color: this.color,
      dir: this.dir,
      drawCount: this.draw.length,
      turn: this.over ? null : this.current.id,
      turnLeft: Math.max(0, Math.round(this.turnLeft)),
      drewThisTurn: this.drewThisTurn,
      catchable: this.pendingCatch?.id ?? null,
      pendingDraw: this.pendingDraw,
      rules: this.rules,
      log: this.log,
      players: this.players.map((p) => ({
        id: p.id, name: p.name, color: p.color, bot: !!p.bot, alive: p.alive, cards: p.hand.length, called: p.called,
      })),
      hand: me ? me.hand : [],
      over: this.over,
      winner: this.winner,
    };
  }

  state() { return this.stateFor(null); }
}

// Nome da carta nos avisos da mesa
const COLOR_NAME = { green: 'verde', yellow: 'amarelo', blue: 'azul', white: 'branco' };
export function label(card, chosen) {
  const names = { skip: 'Deu ruim', reverse: 'Meia-volta', draw2: 'Fiado', wild: 'Jeitinho', wild4: 'Leão da Receita' };
  const v = names[card.value] ?? card.value;
  if (card.color === null) return `${v} (${COLOR_NAME[chosen]})`;
  return `${v} ${COLOR_NAME[card.color]}`;
}
