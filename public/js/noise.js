// Supressão de ruído por IA (RNNoise, roda no próprio navegador): tira ventilador, teclado, cachorro latindo…
// Entra como "processador" no microfone da call (LiveKit), junto com o volume de entrada. Precisa de áudio a 48 kHz.
import { RnnoiseWorkletNode, loadRnnoise } from '/vendor/noise/index.js';

let wasm = null;
const readyContexts = new WeakSet();

// noise: passa pelo RNNoise; onGain recebe o nó de volume (para mudar o volume de entrada na hora)
export function voiceProcessor({ noise = true, onGain = () => {} } = {}) {
  let source = null;
  let node = null;
  let gain = null;
  const proc = {
    name: noise ? 'rnnoise' : 'gain',
    processedTrack: undefined,
    async init({ track, audioContext }) {
      source = audioContext.createMediaStreamSource(new MediaStream([track]));
      gain = audioContext.createGain();
      onGain(gain);
      const dest = audioContext.createMediaStreamDestination();
      if (noise) {
        wasm ??= await loadRnnoise({ url: '/vendor/noise/rnnoise.wasm', simdUrl: '/vendor/noise/rnnoise_simd.wasm' });
        if (!readyContexts.has(audioContext)) {
          await audioContext.audioWorklet.addModule('/vendor/noise/rnnoise/workletProcessor.js');
          readyContexts.add(audioContext);
        }
        node = new RnnoiseWorkletNode(audioContext, { wasmBinary: wasm, maxChannels: 1 });
        source.connect(node).connect(gain).connect(dest);
      } else source.connect(gain).connect(dest);
      proc.processedTrack = dest.stream.getAudioTracks()[0];
    },
    async restart(opts) { await proc.destroy(); await proc.init(opts); },
    async destroy() {
      source?.disconnect();
      node?.disconnect();
      gain?.disconnect();
      gain = null;
      node?.destroy?.();
      source = null;
      node = null;
    },
  };
  return proc;
}
