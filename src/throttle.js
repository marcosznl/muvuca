// Trava de velocidade para os arquivos que saem do Mac (anexos, instaladores do app, fotos, sons).
// A internet de casa tem upload limitado: um download grande (ou todo mundo baixando a atualização do app
// ao mesmo tempo) podia ocupar o upload inteiro e fazer a call e a live engasgarem.
//  - por arquivo: cada download vai no máximo a `perMbps`
//  - total: somando todos os downloads ao mesmo tempo, no máximo `totalMbps`
//  - esperta: com ninguém em call, a trava solta (velocidade máxima); aperta quando tem gente na voz
// Voz e live não passam por aqui (vão direto pelo LiveKit). Ajustável no painel (aba Internet).
import { db } from './store.js';

export const BANDWIDTH_DEFAULTS = { perMbps: 50, totalMbps: 120, smart: true };
const SMALL = 256 * 1024;      // arquivo pequeno (emoji, foto de perfil): sai direto
const PIECE = 16 * 1024;       // pedaços pequenos deixam a velocidade mais uniforme
const BURST_S = 0.25;          // folga do "balde" (em segundos de velocidade)

let settings = load();
let isBusy = () => false;      // alguém na voz? (o servidor informa; evita importar a voz aqui)
export const setBusyCheck = (fn) => { isBusy = fn; };

function load() {
  try { return { ...BANDWIDTH_DEFAULTS, ...JSON.parse(db.meta('bandwidth') ?? '{}') }; } catch { return { ...BANDWIDTH_DEFAULTS }; }
}
export const bandwidthSettings = () => ({ ...settings });
export function setBandwidth(b) {
  const clamp = (v, min, max, d) => (Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Math.round(Number(v)))) : d);
  settings = {
    perMbps: clamp(b.perMbps, 5, 1000, settings.perMbps),
    totalMbps: clamp(b.totalMbps, 10, 1000, settings.totalMbps),
    smart: b.smart === undefined ? settings.smart : !!b.smart,
  };
  if (settings.perMbps > settings.totalMbps) settings.perMbps = settings.totalMbps;
  db.setMeta('bandwidth', JSON.stringify(settings));
  return bandwidthSettings();
}

// Travado agora? (esperta: só com gente na voz)
export const limiting = () => !settings.smart || isBusy();

// "Balde" de fichas: enche na velocidade permitida; cada byte enviado gasta uma ficha
class Bucket {
  constructor(bps) { this.bps = bps; this.tokens = bps * BURST_S; this.at = Date.now(); }
  refill(bps) {
    const now = Date.now();
    this.bps = bps;
    this.tokens = Math.min(bps * BURST_S, this.tokens + ((now - this.at) / 1000) * bps);
    this.at = now;
  }
}
const globalBucket = new Bucket(BANDWIDTH_DEFAULTS.totalMbps * 125_000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Números para o painel
const stats = { streams: 0, bytes: 0, since: Date.now(), window: [] };
export function bandwidthStats() {
  const now = Date.now();
  stats.window = stats.window.filter((w) => now - w.at < 5000);
  const recent = stats.window.reduce((n, w) => n + w.bytes, 0);
  return { ...bandwidthSettings(), limiting: limiting(), streams: stats.streams, mbpsNow: Math.round((recent * 8) / 5 / 1e6 * 10) / 10, totalBytes: stats.bytes };
}

// Espera até poder mandar `n` bytes (no balde do arquivo e no total)
async function take(own, n) {
  for (;;) {
    if (!limiting()) return;
    own.refill(settings.perMbps * 125_000);
    globalBucket.refill(settings.totalMbps * 125_000);
    if (own.tokens >= n && globalBucket.tokens >= n) { own.tokens -= n; globalBucket.tokens -= n; return; }
    const need = Math.max((n - own.tokens) / own.bps, (n - globalBucket.tokens) / globalBucket.bps);
    await sleep(Math.min(250, Math.max(5, need * 1000)));
  }
}

async function write(res, buf) {
  if (res.destroyed) return false;
  if (!res.write(buf)) await new Promise((r) => { res.once('drain', r); res.once('close', r); });
  return !res.destroyed;
}

// Manda um arquivo que está sendo lido do disco (stream), respeitando a trava
export async function pipeThrottled(readable, res) {
  stats.streams++;
  const own = new Bucket(settings.perMbps * 125_000);
  try {
    for await (const chunk of readable) {
      for (let i = 0; i < chunk.length; i += PIECE) {
        const piece = chunk.subarray(i, i + PIECE);
        await take(own, piece.length);
        if (!(await write(res, piece))) { readable.destroy(); return; }
        stats.bytes += piece.length;
        stats.window.push({ at: Date.now(), bytes: piece.length });
        if (stats.window.length > 5000) stats.window.splice(0, 2500);
      }
    }
    res.end();
  } catch {
    readable.destroy();
    res.destroy();
  } finally {
    stats.streams--;
  }
}

// Manda um arquivo que já está na memória (foto, som): pequeno sai direto; grande passa pela trava
export async function sendThrottled(res, data) {
  if (data.length <= SMALL || !limiting()) { res.end(data); return; }
  const { Readable } = await import('node:stream');
  await pipeThrottled(Readable.from([data]), res);
}
