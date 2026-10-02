// Testes de navegador (e2e): sobe o Muvuca de verdade (banco temporário), o LiveKit (se tiver) e o
// Chromium, e usa o site como as pessoas usam. Rodam com: npm run test:e2e
//   LIVEKIT_BIN   caminho do livekit-server (padrão: o do PATH); sem ele, os testes de call são pulados
//   PW_CHROMIUM   caminho do Chromium (padrão: o que o Playwright instalou)
// Precisa da porta 7880 livre (o LiveKit de teste usa a mesma porta do de verdade).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
export { wait };

async function waitHttp(url, proc, label) {
  for (let i = 0; i < 150; i++) {
    try { await fetch(url); return; } catch { await wait(100); }
    if (proc && proc.exitCode !== null) throw new Error(`${label} não subiu`);
  }
  throw new Error(`${label} não respondeu`);
}

export function livekitBin() {
  const bin = process.env.LIVEKIT_BIN || 'livekit-server';
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8' });
  return r.status === 0 ? bin : null;
}

// Muvuca (+ LiveKit, se tiver): { base, dir, voice, stop() }
export async function startStack() {
  const bin = livekitBin();
  let lk = null;
  if (bin) {
    lk = spawn(bin, ['--dev', '--bind', '127.0.0.1'], { stdio: 'ignore' });
    await waitHttp('http://127.0.0.1:7880', lk, 'LiveKit');
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muvuca-e2e-'));
  const port = 43000 + Math.floor(Math.random() * 5000);
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, PORT: String(port), DB_FILE: path.join(dir, 'teste.db'), ACCESS_PASSWORD: 'codigo-e2e',
      LIVEKIT_API_KEY: 'devkey', LIVEKIT_API_SECRET: 'secret', LIVEKIT_HTTP_URL: 'http://127.0.0.1:7880' },
  });
  let output = '';
  srv.stdout.on('data', (d) => { output += d; });
  srv.stderr.on('data', (d) => { output += d; });
  // 127.0.0.1 (e não localhost): o LiveKit local é ws://127.0.0.1:7880
  const base = `http://127.0.0.1:${port}`;
  await waitHttp(base, srv, 'Muvuca');
  return {
    base, dir, voice: !!bin, output: () => output,
    async register(username) {
      const r = await fetch(`${base}/api/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'senha-123', invite: 'codigo-e2e' }) });
      const body = await r.json();
      if (!r.ok) throw new Error(`cadastro: ${body.error}`);
      return body.token;
    },
    async stop() {
      srv.kill(); lk?.kill();
      await Promise.all([srv, lk].filter(Boolean).map((p) => new Promise((r) => (p.exitCode !== null ? r() : p.once('exit', r)))));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function launchBrowser() {
  let pw;
  try { pw = await import('playwright'); } catch { pw = await import('playwright-core'); }
  return pw.chromium.launch({
    executablePath: process.env.PW_CHROMIUM || undefined,
    args: ['--no-proxy-server', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
}

// Uma pessoa no site (aba própria): já cadastrada e com o Muvuca aberto. page.errors guarda erros de JavaScript.
export async function openAs(browser, stack, username, { token = null, viewport = { width: 1280, height: 800 } } = {}) {
  token ??= await stack.register(username);
  const context = await browser.newContext({ viewport, permissions: ['camera', 'microphone'] });
  const page = await context.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.token = token;
  await page.goto(stack.base);
  await page.evaluate((t) => localStorage.setItem('calldireta:session', t), token);
  await page.goto(stack.base);
  await page.waitForSelector('#app:not([hidden])', { timeout: 15000 });
  await page.evaluate(() => { const b = document.querySelector('#banner'); if (b) b.hidden = true; });
  return page;
}

// Atalhos para os módulos do próprio site (mesma instância que a página usa)
export const site = {
  state: (page) => page.evaluate(async () => {
    const { state } = await import('/js/state.js');
    return { me: state.me, servers: state.servers.map((s) => ({ id: s.id, name: s.name, channels: s.channels })) };
  }),
  select: (page, channelId) => page.evaluate(async (id) => (await import('/js/app.js')).selectChannel(id), channelId),
  join: (page, channelId) => page.evaluate(async (id) => (await import('/js/voice.js')).joinVoice(id), channelId),
  voiceChannel: (page) => page.evaluate(async () => (await import('/js/voice.js')).voiceChannelId()),
  request: (page, msg) => page.evaluate(async (m) => (await import('/js/net.js')).request(m), msg),
};

// Espera uma condição (função assíncrona) ficar verdadeira
export async function until(fn, { timeout = 15000, every = 250, what = 'condição' } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`Esperou ${timeout} ms por: ${what}`);
    await wait(every);
  }
}
