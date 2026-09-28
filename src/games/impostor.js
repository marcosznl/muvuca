// Quem é o impostor: todos recebem a mesma palavra, menos um (que só sabe o tema).
// Cada um dá uma dica na sua vez (2 voltas), depois todo mundo vota. Pegaram o impostor? Ele ainda pode
// chutar a palavra: acertou, ganha mesmo assim. Não pegaram: o impostor ganha. Precisa de 3 pessoas ou mais.

export const MIN_PLAYERS = 3;
export const MAX_PLAYERS = 10;
export const CLUE_MS = 30_000;
export const VOTE_MS = 45_000;
export const GUESS_MS = 30_000;
export const CLUE_ROUNDS = 2;

export const THEMES = {
  Comida: ['pizza', 'feijoada', 'coxinha', 'brigadeiro', 'churrasco', 'lasanha', 'sushi', 'pastel', 'pão de queijo', 'açaí', 'tapioca', 'hambúrguer', 'pipoca', 'moqueca', 'farofa'],
  Lugar: ['praia', 'escola', 'hospital', 'shopping', 'aeroporto', 'cinema', 'academia', 'padaria', 'estádio', 'igreja', 'farmácia', 'biblioteca', 'balada', 'feira', 'rodoviária'],
  Animal: ['cachorro', 'gato', 'papagaio', 'capivara', 'jacaré', 'girafa', 'pinguim', 'tubarão', 'formiga', 'cavalo', 'macaco', 'coruja', 'tartaruga', 'onça', 'abelha'],
  Profissão: ['médico', 'professor', 'bombeiro', 'policial', 'padeiro', 'motorista', 'dentista', 'cozinheiro', 'jogador de futebol', 'cantor', 'advogado', 'engenheiro', 'garçom', 'pedreiro', 'piloto'],
  Objeto: ['guarda-chuva', 'celular', 'geladeira', 'escova de dente', 'chinelo', 'mochila', 'violão', 'óculos', 'travesseiro', 'controle remoto', 'relógio', 'tesoura', 'vassoura', 'bicicleta', 'panela'],
  Esporte: ['futebol', 'vôlei', 'basquete', 'natação', 'surfe', 'skate', 'tênis', 'boxe', 'capoeira', 'judô', 'xadrez', 'corrida', 'ciclismo', 'handebol', 'futevôlei'],
};

const fold = (t) => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

export class Impostor {
  constructor(players, { random = Math.random } = {}) {
    this.random = random;
    this.players = players.slice(0, MAX_PLAYERS).map((p, i) => ({ id: p.id, name: p.name, color: i, alive: true }));
    const themes = Object.keys(THEMES);
    this.theme = themes[Math.floor(this.random() * themes.length)];
    const words = THEMES[this.theme];
    this.word = words[Math.floor(this.random() * words.length)];
    this.impostor = this.players[Math.floor(this.random() * this.players.length)].id;
    // Ordem das dicas embaralhada (o impostor não é sempre o primeiro nem o último)
    this.order = this.players.map((p) => p.id).sort(() => this.random() - 0.5);
    this.clues = []; // { id, text }
    this.turn = 0;
    this.phase = 'clues';
    this.timeLeft = CLUE_MS;
    this.votes = new Map();
    this.voted = null;
    this.guess = null;
    this.events = [];
    this.over = false;
    this.winner = null;
    this.winners = [];
    this.dirty = true;
    this.line(`🕵️ O tema é ${this.theme}. Um de vocês é o impostor…`);
  }

  player(id) { return this.players.find((p) => p.id === id); }
  line(text, kind = 'info') { this.events.push({ type: 'line', text, kind }); }
  drainEvents() { const e = this.events; this.events = []; return e; }
  get alive() { return this.players.filter((p) => p.alive); }
  get current() { return this.order[this.turn % this.order.length]; }

  nextClue() {
    do { this.turn++; } while (this.turn < this.order.length * CLUE_ROUNDS && !this.player(this.current)?.alive);
    if (this.turn >= this.order.length * CLUE_ROUNDS) {
      this.phase = 'vote';
      this.timeLeft = VOTE_MS;
      this.line('🗳️ Hora de votar: quem é o impostor?');
    } else this.timeLeft = CLUE_MS;
    this.dirty = true;
  }

  input(id, { text, target, act } = {}) {
    const p = this.player(id);
    if (!p || !p.alive || this.over) return;
    if (this.phase === 'clues' && id === this.current && text?.trim()) {
      const clue = text.replace(/\s+/g, ' ').trim().slice(0, 30);
      // Quem sabe a palavra não pode entregar
      if (id !== this.impostor && fold(clue).includes(fold(this.word))) return;
      this.clues.push({ id, text: clue });
      return this.nextClue();
    }
    if (this.phase === 'vote' && target && target !== id && this.player(target)?.alive) {
      this.votes.set(id, target);
      this.dirty = true;
      if (this.alive.every((x) => this.votes.has(x.id))) this.countVotes();
    }
    if (this.phase === 'guess' && id === this.impostor && text?.trim()) {
      this.guess = text.trim().slice(0, 40);
      this.end(fold(this.guess) === fold(this.word) ? 'guessed' : 'caught');
    }
    if (act === 'skip' && this.phase === 'clues' && id === this.current) this.nextClue();
  }

  countVotes() {
    const tally = new Map();
    for (const t of this.votes.values()) tally.set(t, (tally.get(t) ?? 0) + 1);
    const top = Math.max(0, ...tally.values());
    const leaders = [...tally].filter(([, n]) => n === top).map(([t]) => t);
    this.voted = leaders.length === 1 ? leaders[0] : null; // empate: ninguém sai
    if (this.voted === this.impostor) {
      this.phase = 'guess';
      this.timeLeft = GUESS_MS;
      this.line(`🎯 Pegaram o impostor: ${this.player(this.impostor).name}! Última chance: qual era a palavra?`, 'good');
      this.dirty = true;
    } else this.end('escaped');
  }

  end(how) {
    this.over = true;
    this.outcome = how;
    const town = this.players.filter((p) => p.id !== this.impostor).map((p) => p.id);
    this.winners = how === 'caught' ? town : [this.impostor];
    this.winner = this.winners.length === 1 ? this.winners[0] : null;
    const imp = this.player(this.impostor).name;
    const msg = {
      caught: `✅ Os inocentes venceram! ${imp} era o impostor e não acertou a palavra (${this.word}).`,
      guessed: `😈 ${imp} foi pego, mas acertou a palavra (${this.word}) e venceu!`,
      escaped: `😈 ${this.voted ? `Votaram em ${this.player(this.voted)?.name}, que era inocente. ` : this.votes.size ? 'Empate na votação. ' : ''}${imp} era o impostor e escapou! A palavra era ${this.word}.`,
    }[how];
    this.line(msg, how === 'caught' ? 'good' : 'info');
    this.dirty = true;
  }

  eliminate(id) {
    const p = this.player(id);
    if (!p || this.over) return;
    p.alive = false;
    if (id === this.impostor) return this.end('caught'); // o impostor fugiu
    if (this.alive.length < 2) return this.end('escaped');
    if (this.phase === 'clues' && this.current === id) this.nextClue();
    if (this.phase === 'vote') { this.votes.delete(id); if (this.alive.every((x) => this.votes.has(x.id))) this.countVotes(); }
    this.dirty = true;
  }

  tick(ms) {
    if (this.over) return;
    const before = Math.ceil(this.timeLeft / 1000);
    this.timeLeft -= ms;
    if (Math.ceil(this.timeLeft / 1000) !== before) this.dirty = true;
    if (this.timeLeft > 0) return;
    if (this.phase === 'clues') { this.clues.push({ id: this.current, text: '(não deu dica)' }); this.nextClue(); }
    else if (this.phase === 'vote') this.countVotes();
    else if (this.phase === 'guess') this.end('caught');
  }

  stateFor(viewer) {
    const isImpostor = viewer === this.impostor;
    const reveal = this.over;
    return {
      phase: this.phase,
      theme: this.theme,
      word: reveal || (viewer && !isImpostor && this.player(viewer)) ? this.word : null,
      role: !this.player(viewer) ? 'plateia' : isImpostor ? 'impostor' : 'inocente',
      impostor: reveal ? this.impostor : null,
      current: this.phase === 'clues' ? this.current : null,
      clueTurn: this.turn,
      clueTotal: this.order.length * CLUE_ROUNDS,
      clues: this.clues,
      myVote: this.votes.get(viewer) ?? null,
      votedCount: this.votes.size,
      votes: reveal || this.phase === 'guess' ? Object.fromEntries(this.votes) : null,
      voted: this.voted,
      guess: reveal ? this.guess : null,
      outcome: reveal ? this.outcome : null,
      timeLeft: Math.max(0, this.timeLeft),
      players: this.players.map((p) => ({ id: p.id, name: p.name, color: p.color, alive: p.alive })),
      over: this.over,
      winner: this.winner,
      winners: reveal ? this.winners : [],
    };
  }

  state() { return this.stateFor(null); }
}
