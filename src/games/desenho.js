// "Desenha aí" (estilo Gartic): um desenha, os outros chutam no chat da sala.
// Rodada: quem desenha escolhe 1 de 3 palavras (15 s), desenha (60/80/120 s, opção da sala), e a palavra é revelada (5 s).
// No fim, a galeria: todo mundo vê os desenhos da partida e vota no melhor (quem ganha leva +100).
// Opções: tema, dificuldade (médias e difíceis valem mais), tempo e "palavras da galera" (cadastradas pelo dono).
// Acertou: pontos pela rapidez; quem desenha ganha um pouco por cada acerto. Letras aparecem como dica com o tempo.
// Os traços vão como eventos (drainEvents) e quem chega no meio pede o desenho inteiro (fullState).

export const MAX_PLAYERS = 10;
export const CHOOSE_MS = 15_000;
export const DRAW_MS = 80_000;
export const REVEAL_MS = 5000;
export const GALLERY_MS = 25_000;
export const BEST_BONUS = 100;
const MAX_STROKES = 2500;
export const COLORS = ['#000000', '#ffffff', '#7f7f7f', '#e5484d', '#f76b15', '#f5c400', '#30a46c', '#0090ff', '#8e4ec6', '#a0522d', '#ffb3c6'];
export const SIZES = [3, 8, 16, 32];

import { THEMES, DIFFICULTIES, wordsFor } from './desenho-palavras.js';

// Opções da sala (aparecem para quem manda na sala antes de começar)
export const OPTIONS = {
  tema: { label: 'Tema', hint: 'De onde saem as palavras', default: 'todos',
    choices: [['todos', 'Todos'], ...Object.entries(THEMES).map(([k, t]) => [k, t.label]), ['galera', 'Só palavras da galera']] },
  dificuldade: { label: 'Dificuldade', hint: 'Médias valem 25% a mais; difíceis, 50%', default: 'misturado',
    choices: [['misturado', 'Misturada'], ...Object.entries(DIFFICULTIES).map(([k, d]) => [k, d.label])] },
  tempo: { label: 'Tempo para desenhar', hint: 'Segundos de cada desenho', default: 80, choices: [[60, '60 s'], [80, '80 s'], [120, '120 s']] },
  galera: { label: 'Palavras da galera', hint: 'Mistura as palavras cadastradas pelo dono do servidor', default: true },
};

// Lista antiga (continua exportada para quem usava); o jogo usa o banco por tema em desenho-palavras.js
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
  constructor(players, { random = Math.random, options = {}, customWords = [] } = {}) {
    this.random = random;
    this.drawMs = [60, 80, 120].includes(options.tempo) ? options.tempo * 1000 : DRAW_MS;
    // Palavras possíveis: tema + dificuldade escolhidos, mais as da galera (valem como "média")
    const galera = customWords.map((word) => ({ word, theme: 'galera', level: 'medio' }));
    const base = options.tema === 'galera' ? [] : wordsFor(options.tema ?? 'todos', options.dificuldade ?? 'misturado');
    this.galera = options.tema === 'galera' || options.galera !== false ? galera : [];
    this.pool = base.length || this.galera.length ? base : wordsFor();
    this.gallery = []; // desenhos da partida (para a galeria do fim)
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

  // 3 opções: com dificuldade misturada, tenta uma de cada nível; com palavras da galera, uma delas é da galera (metade das vezes)
  pickWords() {
    const free = (list) => list.filter((w) => !this.used.has(w.word));
    const take = (list) => (list.length ? list.splice(Math.floor(this.random() * list.length), 1)[0] : null);
    const out = [];
    const galera = free(this.galera);
    if (galera.length && (!this.pool.length || this.random() < 0.5)) out.push(take(galera));
    const pool = free(this.pool);
    for (const level of ['facil', 'medio', 'dificil']) {
      if (out.length >= 3) break;
      const w = take(pool.filter((x) => x.level === level));
      if (w) { pool.splice(pool.indexOf(w), 1); out.push(w); }
    }
    while (out.length < 3 && (pool.length || galera.length)) out.push(take(pool.length ? pool : galera));
    if (!out.length) { this.used.clear(); return this.pickWords(); } // acabaram as palavras: recomeça
    return out.filter(Boolean);
  }

  nextTurn() {
    // Pula quem saiu
    do { this.turnIndex++; } while (this.turnIndex < this.order.length * this.rounds && !this.drawer?.alive);
    if (this.turnIndex >= this.order.length * this.rounds || this.players.filter((p) => p.alive).length < 1) return this.startGallery();
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
    const pick = this.choices[index] ?? this.choices[0];
    this.word = pick.word;
    this.level = pick.level;
    this.used.add(this.word);
    this.phase = 'draw';
    this.timeLeft = this.drawMs;
    this.dirty = true;
  }

  clearCanvas() {
    this.strokes = [];
    this.events.push({ type: 'clear' });
  }

  input(id, { cell, stroke, act, target } = {}) {
    const p = this.player(id);
    if (!p || this.over) return;
    // Galeria: cada um vota no melhor desenho (não no próprio); pode trocar o voto
    if (this.phase === 'gallery') {
      const i = Number(target);
      if (act === 'vote' && Number.isInteger(i) && this.gallery[i] && this.gallery[i].drawer !== id) {
        this.votes.set(id, i);
        this.dirty = true;
        const voters = this.players.filter((x) => x.alive && this.gallery.some((g) => g.drawer !== x.id));
        if (voters.every((x) => this.votes.has(x.id))) this.finishGallery();
      }
      return;
    }
    if (p !== this.drawer) return;
    if (this.phase === 'choose' && Number.isInteger(cell)) return this.choose(cell);
    if (this.phase !== 'draw') return;
    if (stroke && stroke.p.length && this.strokes.length < MAX_STROKES) {
      // Tipos: traço livre (sem k), linha reta 'l' e círculo 'o' (2 pontos), balde de tinta 'f' (1 ponto)
      const k = ['l', 'o', 'f'].includes(stroke.k) ? stroke.k : undefined;
      const need = k === 'f' ? 1 : k ? 2 : 0;
      if (need && stroke.p.length < need) return;
      const s = { c: Math.max(0, Math.min(COLORS.length - 1, stroke.c)), w: Math.max(0, Math.min(SIZES.length - 1, stroke.w)),
        p: need ? stroke.p.slice(0, need) : stroke.p, ...(k ? { k } : {}) };
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
      const elapsed = this.drawMs - this.timeLeft;
      const bonus = DIFFICULTIES[this.level]?.bonus ?? 1; // palavras médias e difíceis valem mais
      const points = Math.round(Math.max(50, Math.round(300 * (1 - elapsed / this.drawMs)) + (this.guessed.size === 0 ? 50 : 0)) * bonus);
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
    // Guarda o desenho para a galeria do fim (se teve algum traço)
    if (this.strokes.length) this.gallery.push({ drawer: this.drawer.id, name: this.drawer.name, word: this.word, strokes: this.strokes.slice() });
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
      const shown = this.timeLeft < this.drawMs * 0.25 ? 2 : this.timeLeft < this.drawMs * 0.5 ? 1 : 0;
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
    else if (this.phase === 'gallery') this.finishGallery();
  }

  // Galeria do fim: precisa de pelo menos 2 desenhos e 2 pessoas (senão vai direto para o resultado)
  startGallery() {
    if (this.gallery.length < 2 || this.players.filter((p) => p.alive).length < 2) return this.finish();
    this.phase = 'gallery';
    this.timeLeft = GALLERY_MS;
    this.votes = new Map(); // quem votou -> índice do desenho
    this.events.push({ type: 'gallery', gallery: this.gallery }); // vai uma vez (é grande); quem chega pede no fullState
    this.line('🖼️ Galeria! Vote no melhor desenho da partida.');
    this.dirty = true;
  }

  finishGallery() {
    if (this.phase !== 'gallery') return;
    const count = this.gallery.map((_, i) => [...this.votes.values()].filter((v) => v === i).length);
    const top = Math.max(0, ...count);
    if (top > 0) {
      this.best = count.map((n, i) => (n === top ? i : -1)).filter((i) => i >= 0);
      for (const i of this.best) {
        const p = this.player(this.gallery[i].drawer);
        if (p) p.score += BEST_BONUS;
        this.line(`🏅 Melhor desenho: ${this.gallery[i].name} (${this.gallery[i].word}) +${BEST_BONUS}`, 'good');
      }
    }
    this.finish();
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
      choices: drawing && this.phase === 'choose' ? this.choices.map((c) => ({ word: c.word, level: c.level, galera: c.theme === 'galera' })) : null,
      word: this.word ? (knows ? this.word : this.mask()) : null,
      wordLength: this.word ? [...this.word].length : null,
      guessed: [...(this.guessed ?? [])],
      level: this.word && knows ? this.level : null,
      drawMs: this.drawMs,
      galleryCount: this.gallery.length,
      votes: this.phase === 'gallery' || this.over ? this.gallery.map((_, i) => [...(this.votes?.values() ?? [])].filter((v) => v === i).length) : null,
      myVote: this.votes?.get(viewer) ?? null,
      best: this.best ?? null,
      strokeCount: this.strokes.length,
      players: this.players.map((p) => ({ id: p.id, name: p.name, color: p.color, score: p.score, alive: p.alive })),
      colors: COLORS,
      sizes: SIZES,
      over: this.over,
      winner: this.winner,
    };
  }

  state() { return this.stateFor(null); }
  fullState() { return { strokes: this.strokes, ...(this.phase === 'gallery' || this.over ? { gallery: this.gallery } : {}) }; }
}
