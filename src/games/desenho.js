// "Desenha aí" (estilo Gartic): um desenha, os outros chutam no chat da sala.
// Rodada: quem desenha escolhe 1 de 3 palavras (15 s), desenha (80 s), e a palavra é revelada (5 s).
// Acertou: pontos pela rapidez; quem desenha ganha um pouco por cada acerto. Letras aparecem como dica com o tempo.
// Os traços vão como eventos (drainEvents) e quem chega no meio pede o desenho inteiro (fullState).

export const MAX_PLAYERS = 10;
export const CHOOSE_MS = 15_000;
export const DRAW_MS = 80_000;
export const REVEAL_MS = 5000;
const MAX_STROKES = 2500;
export const COLORS = ['#000000', '#ffffff', '#7f7f7f', '#e5484d', '#f76b15', '#f5c400', '#30a46c', '#0090ff', '#8e4ec6', '#a0522d', '#ffb3c6'];
export const SIZES = [3, 8, 16, 32];

export const WORDS = `abacaxi abelha avião bala balão banana barco bateria bicicleta bola boné borboleta cachorro cadeira café
caixa camelo caminhão cama caneta carro casa castelo cavalo cebola celular chapéu chave chocolate chuva chuveiro cobra
coração coroa computador copo cuscuz dado dente dinossauro elefante escada escova espada esqueleto estrela faca fantasma
flor fogão foguete formiga futebol galinha garfo gato girafa guarda-chuva guitarra helicóptero hambúrguer igreja ilha
janela jacaré lâmpada lápis leão livro lua maçã mala mão martelo melancia mesa milho montanha moto óculos onda ovo
palhaço panela pão papagaio pato peixe pente pipa pipoca pirata pizza planeta porco praia presente queijo raio relógio
robô rosa sapato sereia sofá sol sorvete tartaruga telefone televisão tesoura tigre tomate trem tubarão unicórnio uva
vaca vassoura vela vulcão xícara zebra saci churrasco coxinha brigadeiro carnaval capivara feijoada rede cafuné jangada
fusca pastel caipirinha tucano arara berimbau farofa açaí biquíni chinelo sanfona`.split(/\s+/).filter(Boolean);

// Sem acento e sem maiúsculas ("Maçã" == "maca")
export const fold = (t) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 -]/g, '').trim();

// Diferença de uma letra (trocada, faltando ou sobrando): "quase!"
function nearly(a, b) {
  if (Math.abs(a.length - b.length) > 1 || a === b) return false;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return a.slice(i + 1) === b.slice(i + 1) || a.slice(i) === b.slice(i + 1) || a.slice(i + 1) === b.slice(i);
}

export class Desenho {
  constructor(players, { random = Math.random } = {}) {
    this.random = random;
    this.players = players.slice(0, MAX_PLAYERS).map((p, i) => ({ id: p.id, name: p.name, color: i, score: 0, alive: true }));
    this.order = this.players.map((p) => p.id);
    this.rounds = this.players.length <= 3 ? 2 : 1; // cada um desenha 1 vez (2 se for pouca gente)
    this.turnIndex = -1;
    this.used = new Set();
    this.events = [];
    this.strokes = [];
    this.over = false;
    this.winner = null;
    this.dirty = true;
    this.nextTurn();
  }

  player(id) { return this.players.find((p) => p.id === id); }
  get drawer() { return this.player(this.order[this.turnIndex % this.order.length]); }
  get round() { return Math.floor(this.turnIndex / this.order.length) + 1; }
  line(text, kind = 'info', to = null) { this.events.push({ type: 'line', text, kind, ...(to ? { to } : {}) }); }
  drainEvents() { const e = this.events; this.events = []; return e; }

  pickWords() {
    const pool = WORDS.filter((w) => !this.used.has(w));
    const out = [];
    while (out.length < 3 && pool.length) out.push(pool.splice(Math.floor(this.random() * pool.length), 1)[0]);
    return out;
  }

  nextTurn() {
    // Pula quem saiu
    do { this.turnIndex++; } while (this.turnIndex < this.order.length * this.rounds && !this.drawer?.alive);
    if (this.turnIndex >= this.order.length * this.rounds || this.players.filter((p) => p.alive).length < 1) return this.finish();
    this.phase = 'choose';
    this.timeLeft = CHOOSE_MS;
    this.choices = this.pickWords();
    this.word = null;
    this.guessed = new Set();
    this.revealed = new Set();
    this.clearCanvas();
    this.line(`✏️ Vez de ${this.drawer.name} desenhar!`);
    this.dirty = true;
  }

  choose(index) {
    this.word = this.choices[index] ?? this.choices[0];
    this.used.add(this.word);
    this.phase = 'draw';
    this.timeLeft = DRAW_MS;
    this.dirty = true;
  }

  clearCanvas() {
    this.strokes = [];
    this.events.push({ type: 'clear' });
  }

  input(id, { cell, stroke, act } = {}) {
    const p = this.player(id);
    if (!p || this.over || p !== this.drawer) return;
    if (this.phase === 'choose' && Number.isInteger(cell)) return this.choose(cell);
    if (this.phase !== 'draw') return;
    if (stroke && stroke.p.length && this.strokes.length < MAX_STROKES) {
      const s = { c: Math.max(0, Math.min(COLORS.length - 1, stroke.c)), w: Math.max(0, Math.min(SIZES.length - 1, stroke.w)), p: stroke.p };
      this.strokes.push(s);
      this.events.push({ type: 'stroke', stroke: s });
    }
    if (act === 'clear') this.clearCanvas();
    if (act === 'undo' && this.strokes.length) { this.strokes.pop(); this.events.push({ type: 'undo' }); }
  }

  // Palpites chegam pelo chat da sala
  chat(id, text) {
    const p = this.player(id);
    if (!p || this.phase !== 'draw' || !this.word) return null;
    const guess = fold(text);
    const target = fold(this.word);
    if (p === this.drawer) return guess.includes(target) ? { hide: true, private: 'Não entrega a palavra! 🤐' } : null;
    if (this.guessed.has(id)) return guess.includes(target) ? { hide: true, private: 'Você já acertou! 😉' } : null;
    // A palavra certa, sozinha ou dentro da frase ("é uma casa?"), conta como acerto
    if (guess === target || ` ${guess} `.includes(` ${target} `)) {
      const elapsed = DRAW_MS - this.timeLeft;
      const points = Math.max(50, Math.round(300 * (1 - elapsed / DRAW_MS)) + (this.guessed.size === 0 ? 50 : 0));
      p.score += points;
      this.drawer.score += 25;
      this.guessed.add(id);
      this.line(`✅ ${p.name} acertou! (+${points})`, 'good');
      this.dirty = true;
      const guessers = this.players.filter((x) => x.alive && x !== this.drawer);
      if (guessers.every((x) => this.guessed.has(x.id))) this.endDraw();
      return { hide: true };
    }
    if (nearly(guess, target)) return { hide: false, private: `"${text}" está quase! 🔥` };
    return null;
  }

  endDraw() {
    this.phase = 'reveal';
    this.timeLeft = REVEAL_MS;
    this.line(`A palavra era: ${this.word.toUpperCase()}`);
    this.dirty = true;
  }

  eliminate(id) {
    const p = this.player(id);
    if (!p) return;
    p.alive = false;
    if (this.players.filter((x) => x.alive).length < 1) return this.finish();
    if (p === this.drawer && !this.over) { this.line(`${p.name} saiu; próxima vez.`); this.nextTurn(); }
  }

  tick(ms) {
    if (this.over) return;
    const before = Math.ceil(this.timeLeft / 1000);
    this.timeLeft -= ms;
    if (Math.ceil(this.timeLeft / 1000) !== before) this.dirty = true; // o relógio anda de segundo em segundo
    if (this.phase === 'draw' && this.word) {
      // Dicas: uma letra aos 50% do tempo, outra aos 75% (palavras de 4+ letras)
      const shown = this.timeLeft < DRAW_MS * 0.25 ? 2 : this.timeLeft < DRAW_MS * 0.5 ? 1 : 0;
      const letters = [...this.word].map((ch, i) => (/[\p{L}\d]/u.test(ch) ? i : -1)).filter((i) => i >= 0);
      while (this.revealed.size < shown && letters.length >= 4) {
        const left = letters.filter((i) => !this.revealed.has(i));
        this.revealed.add(left[Math.floor(this.random() * left.length)]);
        this.dirty = true;
      }
    }
    if (this.timeLeft > 0) return;
    if (this.phase === 'choose') return this.choose(Math.floor(this.random() * 3));
    if (this.phase === 'draw') return this.endDraw();
    if (this.phase === 'reveal') this.nextTurn();
  }

  finish() {
    this.over = true;
    const best = [...this.players].sort((a, b) => b.score - a.score)[0];
    this.winner = best && best.score > 0 ? best.id : null;
    this.dirty = true;
  }

  mask() {
    return [...this.word].map((ch, i) => (/[\p{L}\d]/u.test(ch) ? (this.revealed.has(i) ? ch : '_') : ch)).join('');
  }

  stateFor(viewer) {
    const drawing = this.drawer?.id === viewer;
    const knows = drawing || this.phase === 'reveal' || this.over || this.guessed?.has(viewer);
    return {
      phase: this.phase,
      drawer: this.drawer?.id ?? null,
      round: this.round,
      rounds: this.rounds,
      timeLeft: Math.max(0, this.timeLeft),
      choices: drawing && this.phase === 'choose' ? this.choices : null,
      word: this.word ? (knows ? this.word : this.mask()) : null,
      wordLength: this.word ? [...this.word].length : null,
      guessed: [...(this.guessed ?? [])],
      strokeCount: this.strokes.length,
      players: this.players.map((p) => ({ id: p.id, name: p.name, color: p.color, score: p.score, alive: p.alive })),
      colors: COLORS,
      sizes: SIZES,
      over: this.over,
      winner: this.winner,
    };
  }

  state() { return this.stateFor(null); }
  fullState() { return { strokes: this.strokes }; }
}
