// App do Mac: o som da live chega do muvuca-audio (ScreenCaptureKit) em pedaços de float32 estéreo a 48 kHz.
// Aqui ele vira uma faixa de áudio normal (AudioWorklet → MediaStream) para publicar na call como "som da live".

const WORKLET = `
class MuvucaFeed extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(48000 * 2 * 2); // 2 s de folga (estéreo intercalado)
    this.r = 0; this.w = 0; this.n = 0;         // leitura, escrita e amostras guardadas
    this.port.onmessage = (e) => {
      const d = e.data;
      for (let i = 0; i < d.length; i++) { this.buf[this.w] = d[i]; this.w = (this.w + 1) % this.buf.length; }
      this.n = Math.min(this.buf.length, this.n + d.length);
      // Atrasou demais (mais de 150 ms guardados): pula para perto do fim, mantendo a live em tempo real
      const max = 48000 * 2 * 0.15;
      if (this.n > max) { const skip = this.n - 48000 * 2 * 0.04; this.r = (this.r + skip) % this.buf.length; this.n -= skip; }
    };
  }
  process(_inputs, outputs) {
    const [l, r] = outputs[0];
    for (let i = 0; i < l.length; i++) {
      if (this.n >= 2) {
        l[i] = this.buf[this.r]; r[i] = this.buf[(this.r + 1) % this.buf.length];
        this.r = (this.r + 2) % this.buf.length; this.n -= 2;
      } else { l[i] = 0; r[i] = 0; } // faltou som: silêncio (sem estalo)
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
