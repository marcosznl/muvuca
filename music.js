// Canais de música (estilo plug.dj): cabine de DJs, fila pessoal de cada DJ e música sincronizada.
// Ninguém transmite áudio: cada navegador toca o vídeo oficial do YouTube e o servidor só diz
// qual vídeo e desde quando (startedAt, no relógio do servidor).

const ID_RE = /^[a-zA-Z0-9_-]{11}$/;
const MAX_QUEUE = 20;
const SAFETY_GRACE_MS = 15_000;          // folga depois da duração antes de avançar sozinho
const UNKNOWN_DURATION_MS = 15 * 60_000; // sem duração conhecida, avança depois disso
const LEAVE_GRACE_MS = 20_000;           // queda de conexão rápida não tira ninguém da cabine
const REACTIONS = ['up', 'down', 'heart'];

// Extrai o id do vídeo de links do YouTube (watch?v=, youtu.be/, shorts/, embed/) ou de um id puro
export function extractYoutubeId(input) {
  const trimmed = String(input ?? '').trim();
  if (ID_RE.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    const host = url.hostname.replace(/^www\.|^m\.|^music\./, '');
    if (host === 'youtu.be') {
      const id = url.pathname.slice(1, 12);
      return ID_RE.test(id) ? id : null;
    }
    if (host === 'youtube.com') {
      const v = url.searchParams.get('v');
      if (v && ID_RE.test(v)) return v;
      const m = url.pathname.match(/\/(embed|shorts|live)\/([a-zA-Z0-9_-]{11})/);
      if (m) return m[2];
    }
  } catch {}
  return null;
}

// ---------- YouTube (busca, título e duração) ----------

function parseIsoDuration(iso) {
  const m = String(iso ?? '').match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  return m ? Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0) : null;
}

export function createYoutube(apiKey) {
  return {
    hasSearch: !!apiKey,

    async search(query) {
      if (!apiKey) throw new Error('A busca do YouTube não está configurada. Cole o link do vídeo no campo.');
      const params = new URLSearchParams({ part: 'snippet', type: 'video', maxResults: '8', q: query, key: apiKey });
      const res = await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`);
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        if (res.status === 403) throw new Error('A cota diária de buscas do YouTube acabou. Cole o link do vídeo no campo.');
        throw new Error(`A busca do YouTube falhou (${body?.error?.message ?? res.status}).`);
      }
      const data = await res.json();
      return (data.items ?? []).filter((i) => i.id?.videoId).map((i) => ({
        videoId: i.id.videoId,
        title: decodeEntities(i.snippet.title),
        channel: decodeEntities(i.snippet.channelTitle),
        thumbnail: i.snippet.thumbnails?.default?.url ?? null,
      }));
    },

    // Título pelo oEmbed público (não gasta cota)
    async title(videoId) {
      try {
        const url = `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`;
        const res = await fetch(url);
        if (!res.ok) return null;
        return (await res.json()).title ?? null;
      } catch { return null; }
    },

    // Duração em segundos (1 unidade de cota); null se não der para saber
    async duration(videoId) {
      if (!apiKey) return null;
      try {
        const params = new URLSearchParams({ part: 'contentDetails', id: videoId, key: apiKey });
        const res = await fetch(`https://www.googleapis.com/youtube/v3/videos?${params}`);
        if (!res.ok) return null;
        return parseIsoDuration((await res.json()).items?.[0]?.contentDetails?.duration);
      } catch { return null; }
    },
  };
}

const decodeEntities = (s) => String(s ?? '').replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e]);

// ---------- Salas de música ----------

export class MusicRooms {
  // hooks: { broadcast(channelId, state), sendQueue(userId, channelId, queue), presence(channelId),
  //          system(channelId, text), userName(userId), recordPlay(play) }
  constructor({ youtube, hooks }) {
    this.youtube = youtube;
    this.hooks = hooks;
    this.rooms = new Map();        // channelId -> sala
    this.listening = new Map();    // userId -> channelId (cada pessoa ouve uma sala por vez)
    this.leaveTimers = new Map();  // userId -> timeout
  }

  room(channelId) {
    let r = this.rooms.get(channelId);
    if (!r) {
      r = { id: channelId, listeners: new Set(), booth: [], djIndex: -1, track: null, queues: new Map(), timer: null };
      this.rooms.set(channelId, r);
    }
    return r;
  }

  currentDj(r) {
    return r.djIndex >= 0 && r.djIndex < r.booth.length ? r.booth[r.djIndex] : null;
  }

  // O que todo mundo na sala precisa saber
  snapshot(channelId) {
    const r = this.room(channelId);
    return {
      listeners: [...r.listeners],
      booth: [...r.booth],
      djId: this.currentDj(r),
      track: r.track && {
        videoId: r.track.videoId,
        title: r.track.title,
        duration: r.track.duration,
        startedAt: r.track.startedAt,
        djId: r.track.djId,
        reactions: Object.fromEntries(REACTIONS.map((k) => [k, [...r.track.reactions[k]]])),
      },
    };
  }

  listenersOf(channelId) { return [...(this.rooms.get(channelId)?.listeners ?? [])]; }
  nowPlaying(channelId) { return this.rooms.get(channelId)?.track?.title ?? null; }
  queueOf(channelId, userId) { return this.room(channelId).queues.get(userId) ?? []; }

  emit(channelId) {
    this.hooks.broadcast(channelId, this.snapshot(channelId));
  }

  // ---------- Entrar e sair ----------

  join(channelId, userId) {
    this.cancelLeave(userId);
    const previous = this.listening.get(userId);
    if (previous && previous !== channelId) this.leave(previous, userId);
    const r = this.room(channelId);
    r.listeners.add(userId);
    this.listening.set(userId, channelId);
    this.emit(channelId);
    this.hooks.presence(channelId);
  }

  leave(channelId, userId) {
    const r = this.rooms.get(channelId);
    if (!r) return;
    if (this.listening.get(userId) === channelId) this.listening.delete(userId);
    r.listeners.delete(userId);
    this.removeFromBooth(r, userId, { quiet: false });
    this.emit(channelId);
    this.hooks.presence(channelId);
  }

  // Última aba da pessoa fechou: espera um pouco (pode ser só uma queda de conexão)
  disconnected(userId) {
    const channelId = this.listening.get(userId);
    if (!channelId) return;
    this.cancelLeave(userId);
    this.leaveTimers.set(userId, setTimeout(() => {
      this.leaveTimers.delete(userId);
      this.leave(channelId, userId);
    }, LEAVE_GRACE_MS));
  }

  cancelLeave(userId) {
    clearTimeout(this.leaveTimers.get(userId));
    this.leaveTimers.delete(userId);
  }

  // Canal excluído ou pessoa removida do servidor
  dropChannel(channelId) {
    const r = this.rooms.get(channelId);
    if (!r) return;
    clearTimeout(r.timer);
    for (const u of r.listeners) if (this.listening.get(u) === channelId) this.listening.delete(u);
    this.rooms.delete(channelId);
  }

  // ---------- Cabine ----------

  joinBooth(channelId, userId) {
    const r = this.room(channelId);
    if (!r.listeners.has(userId)) throw new Error('Entre no canal antes de entrar na cabine.');
    if (r.booth.includes(userId)) return;
    r.booth.push(userId);
    this.hooks.system(channelId, `${this.hooks.userName(userId)} entrou na cabine.`);
    if (!r.track) this.startFrom(r, Math.max(r.djIndex, 0));
    else this.emit(channelId);
  }

  leaveBooth(channelId, userId) {
    const r = this.room(channelId);
    this.removeFromBooth(r, userId, { quiet: false });
    this.emit(channelId);
  }

  removeFromBooth(r, userId, { quiet }) {
    const i = r.booth.indexOf(userId);
    if (i === -1) return;
    const wasDj = i === r.djIndex;
    r.booth.splice(i, 1);
    r.queues.delete(userId);
    this.hooks.sendQueue(userId, r.id, []);
    if (i <= r.djIndex) r.djIndex -= 1; // o próximo avanço cai na pessoa certa
    if (!quiet) this.hooks.system(r.id, `${this.hooks.userName(userId)} saiu da cabine.`);
    if (wasDj) this.nextDj(r);
  }

  // ---------- Fila pessoal ----------

  async add(channelId, userId, { videoId, url, title }) {
    const r = this.room(channelId);
    if (!r.booth.includes(userId)) throw new Error('Entre na cabine para adicionar músicas.');
    const id = extractYoutubeId(videoId || url);
    if (!id) throw new Error('Não reconheci esse link do YouTube.');
    const queue = r.queues.get(userId) ?? [];
    if (queue.length >= MAX_QUEUE) throw new Error(`Sua fila já tem ${MAX_QUEUE} músicas.`);
    const finalTitle = String(title || (await this.youtube.title(id)) || id).slice(0, 200);
    queue.push({ videoId: id, title: finalTitle });
    r.queues.set(userId, queue);
    this.hooks.sendQueue(userId, channelId, queue);
    // Nada tocando: começa já (a partir de quem é a vez)
    if (!r.track) this.startFrom(r, Math.max(r.djIndex, 0));
  }

  removeFromQueue(channelId, userId, index) {
    const queue = this.room(channelId).queues.get(userId) ?? [];
    if (index >= 0 && index < queue.length) queue.splice(index, 1);
    this.hooks.sendQueue(userId, channelId, queue);
  }

  moveInQueue(channelId, userId, from, to) {
    const queue = this.room(channelId).queues.get(userId) ?? [];
    if ([from, to].every((n) => Number.isInteger(n) && n >= 0 && n < queue.length) && from !== to) {
      queue.splice(to, 0, ...queue.splice(from, 1));
    }
    this.hooks.sendQueue(userId, channelId, queue);
  }

  // ---------- Tocar e avançar ----------

  // Passa a vez para o próximo DJ da cabine que tiver música na fila
  nextDj(r) {
    clearTimeout(r.timer);
    r.track = null;
    this.startFrom(r, r.djIndex + 1);
  }

  // Procura, a partir da posição `from` da cabine, o primeiro DJ com música na fila e toca
  startFrom(r, from) {
    const n = r.booth.length;
    for (let k = 0; k < n; k++) {
      r.djIndex = (from + k) % n;
      if (this.playFromCurrentDj(r)) return true;
    }
    // Ninguém tem música: a vez fica com quem estava em `from`, esperando alguém adicionar
    r.djIndex = n ? from % n : -1;
    this.emit(r.id);
    return false;
  }

  playFromCurrentDj(r) {
    const djId = this.currentDj(r);
    const next = djId && r.queues.get(djId)?.shift();
    if (!next) return false;
    this.hooks.sendQueue(djId, r.id, r.queues.get(djId));
    const track = {
      ...next,
      djId,
      startedAt: Date.now() + 1500, // pequena folga para todos carregarem o vídeo ao mesmo tempo
      duration: null,
      reactions: { up: new Set(), down: new Set(), heart: new Set() },
    };
    r.track = track;
    this.hooks.system(r.id, `${this.hooks.userName(djId)} está tocando: ${track.title}`);
    this.hooks.recordPlay({ channelId: r.id, videoId: track.videoId, title: track.title, djId, startedAt: track.startedAt });
    this.emit(r.id);
    this.armTimer(r, track, UNKNOWN_DURATION_MS);
    // Busca a duração real para o cronômetro de fim e a barra de progresso
    this.youtube.duration(track.videoId).then((d) => { if (d) this.setDuration(r, track, d); });
    return true;
  }

  armTimer(r, track, ms) {
    clearTimeout(r.timer);
    r.timer = setTimeout(() => { if (r.track === track) this.nextDj(r); }, ms);
  }

  setDuration(r, track, seconds) {
    if (r.track !== track || track.duration || !(seconds > 0)) return;
    track.duration = Math.round(seconds);
    const remaining = track.startedAt + track.duration * 1000 - Date.now();
    this.armTimer(r, track, Math.max(0, remaining) + SAFETY_GRACE_MS);
    this.emit(r.id);
  }

  // O player do DJ informa a duração quando não deu para buscar pela API
  reportDuration(channelId, userId, videoId, seconds) {
    const r = this.room(channelId);
    if (r.track?.videoId === videoId && r.track.djId === userId) this.setDuration(r, r.track, Number(seconds));
  }

  // O player do DJ avisou que o vídeo terminou (mais rápido que esperar o cronômetro)
  ended(channelId, userId, videoId) {
    const r = this.room(channelId);
    const t = r.track;
    if (!t || t.videoId !== videoId || t.djId !== userId) return;
    const elapsed = (Date.now() - t.startedAt) / 1000;
    // Evita pular por engano (ex.: o DJ recarregou a página e o player disparou "fim")
    if (t.duration ? elapsed < t.duration - 10 : elapsed < 20) return;
    this.nextDj(r);
  }

  // Vídeo que não pode tocar fora do YouTube, removido etc.: pula se o DJ tiver o erro, ou se
  // mais da metade da sala (e pelo menos 2 pessoas) reclamar — um erro local de uma pessoa não pula para todos
  playerError(channelId, userId, videoId, code) {
    const r = this.room(channelId);
    const t = r.track;
    if (!t || t.videoId !== videoId) return;
    console.warn(`[música] erro ${code} no player de ${this.hooks.userName(userId)} (${videoId})`);
    t.errors ??= new Set();
    t.errors.add(userId);
    if (userId === t.djId || (t.errors.size >= 2 && t.errors.size * 2 > r.listeners.size)) {
      this.hooks.system(channelId, `"${t.title}" não pode ser tocada aqui (bloqueada pelo dono ou indisponível). Pulando…`);
      this.nextDj(r);
    }
  }

  skip(channelId, userId, canManage) {
    const r = this.room(channelId);
    if (!r.track) return;
    if (r.track.djId !== userId && !canManage) throw new Error('Só o DJ da vez ou quem gerencia a música pode pular.');
    const who = this.hooks.userName(userId);
    this.hooks.system(channelId, r.track.djId === userId ? `${who} pulou a própria música.` : `${who} pulou "${r.track.title}".`);
    this.nextDj(r);
  }

  kickFromBooth(channelId, targetId) {
    const r = this.room(channelId);
    if (!r.booth.includes(targetId)) return;
    this.removeFromBooth(r, targetId, { quiet: true });
    this.hooks.system(channelId, `${this.hooks.userName(targetId)} foi tirado da cabine.`);
    this.emit(channelId);
  }

  react(channelId, userId, kind) {
    const r = this.room(channelId);
    if (!r.track || !REACTIONS.includes(kind) || !r.listeners.has(userId)) return;
    const set = r.track.reactions[kind];
    if (set.has(userId)) set.delete(userId);
    else {
      set.add(userId);
      if (kind === 'up') r.track.reactions.down.delete(userId);
      if (kind === 'down') r.track.reactions.up.delete(userId);
    }
    this.emit(channelId);
  }
}
