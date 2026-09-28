// Stop / Adedonha: sorteia a letra, todo mundo preenche as categorias; quem terminar grita STOP.
// Depois cada um pode recusar respostas dos outros (maioria recusou: não vale).
// Pontos: resposta válida e única 10, repetida 5, vazia ou recusada 0. 4 rodadas.

export const MAX_PLAYERS = 10;
export const ROUNDS = 4;
export const WRITE_MS = 90_000;
export const STOP_GRACE_MS = 5000;
export const VOTE_MS = 40_000;
export const SCORE_MS = 7000;
export const LETTERS = 'ABCDEFGHIJLMNOPRSTUV'.split('');
export const CATEGORIES = [
  'Nome', 'Animal', 'Cor', 'Fruta, legume ou verdura', 'Cidade, estado ou país', 'Objeto', 'Profissão', 'Marca',
  'Comida', 'Filme ou série', 'Parte do corpo', 'Esporte', 'Cantor(a) ou banda', 'Time de futebol', 'Coisa que tem na praia',
];
const PER_GAME = 6;

export const fold = (t) => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

export class Stop {
  constructor(players, { random = Math.random } = {}) {
    this.random = random;
    this.players = players.slice(0, MAX_PLAYERS).map((p, i) => ({ id: p.id, name: p.name, color: i, score: 0, alive: true }));
    const pool = [...CATEGORIES];
    this.categories = [];
    while (this.categories.length < PER_GAME) this.categories.push(pool.splice(Math.floor(this.random() * pool.length), 1)[0]);
    this.usedLetters = new Set();
    this.round = 0;
    this.events = [];
    this.over = false;
    this.winner = null;
    this.dirty = true;
    this.results = null;
    this.startRound();
  }

  player(id) { return this.players.find((p) => p.id === id); }
  line(text, kind = 'info') { this.events.push({ type: 'line', text, kind }); }
  drainEvents() { const e = this.events; this.events = []; return e; }
  get alive() { return this.players.filter((p) => p.alive); }

  startRound() {
    this.round += 1;
    const pool = LETTERS.filter((l) => !this.usedLetters.has(l));
    this.letter = pool[Math.floor(this.random() * pool.length)];
    this.usedLetters.add(this.letter);
    this.phase = 'write';
    this.timeLeft = WRITE_MS;
    this.stoppedBy = null;
    this.answers = new Map(this.players.map((p) => [p.id, Array(PER_GAME).fill('')]));
    this.rejects = new Map(); // "autor|categoria" -> Set(quem recusou)
    this.ready = new Set();
    this.line(`🔤 Rodada ${this.round}: letra ${this.letter}!`);
    this.dirty = true;
  }

  // Resposta começa com a letra? (sem acento: "Élida" vale para E)
  startsRight(text) { return fold(text).startsWith(this.letter.toLowerCase()); }

  input(id, { data, act } = {}) {
    const p = this.player(id);
    if (!p || !p.alive || this.over) return;
    if (this.phase === 'write' && data) {
      const mine = this.answers.get(id);
      for (const [k, v] of Object.entries(data)) {
        const i = Number(k.replace(/^a/, ''));
        if (Number.isInteger(i) && i >= 0 && i < PER_GAME && typeof v === 'string') mine[i] = v.replace(/\s+/g, ' ').slice(0, 40);
      }
    }
    if (this.phase === 'write' && act === 'stop' && !this.stoppedBy) {
      const mine = this.answers.get(id);
      if (!mine.every((a) => this.startsRight(a))) return; // só grita STOP com tudo preenchido com a letra
      this.stoppedBy = id;
      this.timeLeft = Math.min(this.timeLeft, STOP_GRACE_MS);
      this.line(`✋ ${p.name} gritou STOP! 5 segundos…`, 'good');
      this.dirty = true;
    }
    if (this.phase === 'vote' && data?.reject) {
      // data.reject = "autorId|categoria", data.on = true/false
      const [author, cat] = String(data.reject).split('|');
      if (author === id || !this.player(author) || !(Number(cat) >= 0 && Number(cat) < PER_GAME)) return;
      const key = `${author}|${Number(cat)}`;
      if (!this.rejects.has(key)) this.rejects.set(key, new Set());
      if (data.on === false) this.rejects.get(key).delete(id); else this.rejects.get(key).add(id);
      this.dirty = true;
    }
    if (this.phase === 'vote' && act === 'ready') {
      this.ready.add(id);
      if (this.alive.every((x) => this.ready.has(x.id))) this.timeLeft = 0;
      this.dirty = true;
    }
  }

  // Maioria das outras pessoas recusou?
  rejected(author, cat) {
    const voters = this.alive.filter((x) => x.id !== author).length;
    const n = this.rejects.get(`${author}|${cat}`)?.size ?? 0;
    return voters > 0 && n * 2 > voters;
  }

  score() {
    const results = new Map(this.players.map((p) => [p.id, Array(PER_GAME).fill(0)]));
    for (let c = 0; c < PER_GAME; c++) {
      const valid = this.alive.filter((p) => {
        const a = this.answers.get(p.id)[c];
        return a.trim() && this.startsRight(a) && !this.rejected(p.id, c);
      });
      const count = new Map();
      for (const p of valid) { const k = fold(this.answers.get(p.id)[c]); count.set(k, (count.get(k) ?? 0) + 1); }
      for (const p of valid) {
        const pts = count.get(fold(this.answers.get(p.id)[c])) > 1 ? 5 : 10;
        results.get(p.id)[c] = pts;
        p.score += pts;
      }
    }
    this.results = Object.fromEntries(results);
  }

  eliminate(id) {
    const p = this.player(id);
    if (p) p.alive = false;
    if (!this.alive.length) this.finish();
    this.dirty = true;
  }

  tick(ms) {
    if (this.over) return;
    const before = Math.ceil(this.timeLeft / 1000);
    this.timeLeft -= ms;
    if (Math.ceil(this.timeLeft / 1000) !== before) this.dirty = true;
    if (this.timeLeft > 0) return;
    if (this.phase === 'write') {
      this.phase = 'vote';
      this.timeLeft = VOTE_MS;
      this.line('🗳️ Hora de conferir: recuse as respostas que não valem.');
    } else if (this.phase === 'vote') {
      this.score();
      this.phase = 'score';
      this.timeLeft = SCORE_MS;
    } else if (this.phase === 'score') {
      if (this.round >= ROUNDS) return this.finish();
      this.startRound();
    }
    this.dirty = true;
  }

  finish() {
    this.over = true;
    const best = [...this.players].sort((a, b) => b.score - a.score)[0];
    this.winner = best && best.score > 0 ? best.id : null;
    this.dirty = true;
  }

  stateFor(viewer) {
    const showAll = this.phase !== 'write' || this.over;
    return {
      phase: this.phase,
      round: this.round,
      rounds: ROUNDS,
      letter: this.letter,
      categories: this.categories,
      timeLeft: Math.max(0, this.timeLeft),
      stoppedBy: this.stoppedBy,
      mine: this.answers.get(viewer) ?? null,
      // Escrevendo: dos outros só se sabe quantas já preencheram; depois, tudo aparece
      answers: showAll ? Object.fromEntries(this.answers) : null,
      filled: Object.fromEntries(this.players.map((p) => [p.id, this.answers.get(p.id).filter((a) => a.trim()).length])),
      rejects: showAll ? Object.fromEntries([...this.rejects].map(([k, set]) => [k, [...set]])) : {},
      ready: [...this.ready],
      results: this.phase === 'score' || this.over ? this.results : null,
      players: this.players.map((p) => ({ id: p.id, name: p.name, color: p.color, score: p.score, alive: p.alive })),
      over: this.over,
      winner: this.winner,
    };
  }

  state() { return this.stateFor(null); }
}
