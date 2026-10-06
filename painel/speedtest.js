// Teste de velocidade da internet (aba Internet do painel), só quando alguém aperta o botão.
// Usa o networkQuality que já vem no macOS (servidores da Apple, sem nada de terceiros). O teste ocupa a
// internet inteira por uns 20 s: se tiver gente em call, em live ou jogando, o painel avisa antes.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const BIN = '/usr/bin/networkQuality';
const KEEP = 300;
const MODES = {
  upload: { label: 'Só upload', args: ['-d', '-c'] },  // sem download (menos dados); o que importa para o servidor
  full: { label: 'Completo', args: ['-s', '-c'] },     // download e depois upload (um de cada vez: números certos)
};

let FILE;
let running = null; // { mode, startedAt }
let lastError = null;

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return []; }
}
function save(list) {
  fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(list.slice(-KEEP)), { mode: 0o600 });
  fs.renameSync(`${FILE}.tmp`, FILE);
}

// Quanto cabe com o upload medido (deixando 20% de folga): valores por pessoa assistindo/ouvindo
export function capacity(up) {
  if (!up) return null;
  const usable = up * 0.8;
  return {
    live1080: Math.floor(usable / 5e6),  // live 1080p ~5 Mbps por pessoa assistindo
    live720: Math.floor(usable / 2.5e6), // live 720p ~2,5 Mbps
    camera: Math.floor(usable / 1.5e6),  // câmera ~1,5 Mbps por pessoa vendo
    voice: Math.floor(usable / 0.1e6),   // voz ~100 kbps por pessoa ouvindo
  };
}

function runTest(mode, audit, ip) {
  running = { mode, startedAt: Date.now() };
  lastError = null;
  execFile(BIN, MODES[mode].args, { timeout: 120_000, maxBuffer: 20 * 1024 * 1024 }, (err, stdout) => {
    let result;
    try {
      if (err && !stdout) throw err;
      const j = JSON.parse(stdout);
      result = {
        at: Date.now(), mode, ok: true,
        down: mode === 'upload' ? null : Math.round(j.dl_throughput ?? 0),
        up: Math.round(j.ul_throughput ?? 0),
        rpm: j.responsiveness != null ? Math.round(j.responsiveness) : null, // "rodadas por minuto": quanto maior, menos a conexão engasga
        rtt: j.base_rtt != null ? Math.round(j.base_rtt) : null,             // latência sem carga (ms)
        iface: j.interface_name ?? null, server: j.test_endpoint ?? null,
        bytes: (j.dl_bytes_transferred ?? 0) + (j.ul_bytes_transferred ?? 0),
      };
    } catch (e) {
      lastError = e.killed ? 'o teste passou de 2 minutos e foi interrompido' : 'o teste não conseguiu terminar (internet fora ou sem resposta dos servidores da Apple)';
      result = { at: Date.now(), mode, ok: false, error: lastError };
    }
    const list = load();
    list.push(result);
    save(list);
    audit('painel:speedtest', { ip, ok: result.ok, detail: result.ok
      ? { modo: MODES[mode].label, upload: `${(result.up / 1e6).toFixed(0)} Mbps`, ...(result.down != null ? { download: `${(result.down / 1e6).toFixed(0)} Mbps` } : {}), responsividade: result.rpm }
      : { modo: MODES[mode].label, erro: result.error } });
    running = null;
  });
}

export function speedRoutes({ json, readBody, clientIp, audit, activity, dataDir }) {
  FILE = path.join(dataDir, 'speedtests.json');
  return {
    'GET /api/speedtest': (req, res) => {
      const list = load();
      const lastOk = [...list].reverse().find((r) => r.ok);
      const lastUp = [...list].reverse().find((r) => r.ok && r.up);
      json(res, 200, {
        running, lastError, history: list.slice(-100), last: list.at(-1) ?? null,
        capacity: capacity(lastUp?.up), capacityFrom: lastUp?.at ?? null, lastOk: lastOk ?? null,
        modes: Object.fromEntries(Object.entries(MODES).map(([k, v]) => [k, v.label])),
        activity: activity(),
      });
    },
    'POST /api/speedtest': async (req, res) => {
      const body = await readBody(req);
      const mode = MODES[body.mode] ? body.mode : 'upload';
      if (running) return json(res, 409, { error: 'Já tem um teste rodando. Aguarde terminar.' });
      if (!fs.existsSync(BIN)) return json(res, 500, { error: 'Este Mac não tem o networkQuality (precisa do macOS 12 ou mais novo).' });
      // Tem gente usando: o teste deixaria a call, a live ou o jogo travando por uns 20 s
      const a = activity();
      const busy = [a.voice && `${a.voice} em call`, a.lives && `${a.lives} em live`].filter(Boolean);
      if (busy.length && !body.force) return json(res, 200, { ok: false, needsForce: true, message: `Tem gente usando agora (${busy.join(', ')}). O teste ocupa a internet inteira por uns 20 s e vai travar para eles.` });
      runTest(mode, audit, clientIp(req));
      json(res, 200, { ok: true, message: 'Testando… leva uns 20 a 40 segundos.' });
    },
  };
}
