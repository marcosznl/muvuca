// App do Mac: o som da live chega do muvuca-audio (ScreenCaptureKit) em pedaços de float32 estéreo a 48 kHz.
// Aqui ele vira uma faixa de áudio normal (AudioWorklet → MediaStream) para publicar na call como "som da live".

const WORKLET = `
// Toca o som que chega do app com ~60 ms de folga. Os relógios do Mac (captura) e do navegador (reprodução)
// nunca batem exatamente: em vez de pular pedaços (estalo), ajusta a velocidade em até 0,5% (inaudível)
// para a folga voltar ao alvo. Só se atrasar muito (pausa longa) é que pula direto.
class MuvucaFeed extends AudioWorkletProcessor {
  constructor() {
    super();
    this.cap = 48000 * 2;                   // 2 s em quadros (cada quadro = esquerda + direita)
    this.buf = new Float32Array(this.cap * 2);
    this.w = 0;                             // próximo quadro a escrever (inteiro, cresce sempre)
    this.r = 0;                             // posição de leitura (fracionária, cresce sempre)
    this.target = 2880;                     // folga ideal: 60 ms
    this.playing = false;                   // espera juntar a folga antes de tocar (e depois de faltar som)
    this.port.onmessage = (e) => {
      const d = e.data;
      for (let i = 0; i + 1 < d.length; i += 2) {
        const k = (this.w % this.cap) * 2;
        this.buf[k] = d[i]; this.buf[k + 1] = d[i + 1];
        this.w++;
      }
      if (this.w - this.r > this.cap - 256) this.r = this.w - this.target; // estourou a folga: descarta o velho
    };
  }
  process(_inputs, outputs) {
    const [l, r] = outputs[0];
    let level = this.w - this.r;
    if (!this.playing && level >= this.target) this.playing = true;
    if (this.playing && level > 48000 * 0.25) { this.r = this.w - this.target; level = this.target; } // pausa longa
    // Velocidade: acima do alvo toca um tiquinho mais rápido; abaixo, mais devagar (no máximo ±0,5%)
    const excess = (level - this.target) / 48000;
    const rate = 1 + Math.max(-0.005, Math.min(0.005, excess * 0.25));
    for (let i = 0; i < l.length; i++) {
      if (!this.playing || this.w - this.r < 2) { l[i] = 0; r[i] = 0; this.playing = false; continue; }
      const i0 = Math.floor(this.r);
      const frac = this.r - i0;
      const a = (i0 % this.cap) * 2;
      const b = ((i0 + 1) % this.cap) * 2;
      l[i] = this.buf[a] + (this.buf[b] - this.buf[a]) * frac;
      r[i] = this.buf[a + 1] + (this.buf[b + 1] - this.buf[a + 1]) * frac;
      this.r += rate;
    }
    return true;
  }
}
registerProcessor('muvuca-feed', MuvucaFeed);
`;

// Cria a faixa; devolve { track, stop }
export async function createAppAudioTrack(desktop) {
  const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
  await ctx.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);
  const node = new AudioWorkletNode(ctx, 'muvuca-feed', { numberOfInputs: 0, outputChannelCount: [2] });
  const dest = ctx.createMediaStreamDestination();
  node.connect(dest);
  await ctx.resume().catch(() => {});
  const off = desktop.onAppAudioData((bytes) => {
    // Chega como bytes; copia para alinhar em float32 e manda para o worklet (sem copiar de novo)
    const copy = new Uint8Array(bytes).slice().buffer;
    const f = new Float32Array(copy);
    node.port.postMessage(f, [f.buffer]);
  });
  const track = dest.stream.getAudioTracks()[0];
  return {
    track,
    stop() {
      off();
      track.stop();
      node.disconnect();
      ctx.close().catch(() => {});
    },
  };
}
