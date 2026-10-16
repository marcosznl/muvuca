// O site de verdade no navegador: mensagens, temas, aparelhos conectados, erros no painel e calls
// (câmera, janela flutuante, voltar depois do F5, chat ao lado). Roteiros que antes eram conferidos à mão.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startStack, launchBrowser, openAs, site, until, wait } from './helpers.js';
import { startPainel, PAINEL_USER, PAINEL_PASS } from '../test/helpers.js';

let stack;
let browser;
let ana;
let bia;
let ids;

before(async () => {
  stack = await startStack();
  browser = await launchBrowser();
  ana = await openAs(browser, stack, 'ana');
  bia = await openAs(browser, stack, 'bia');
  // bia entra no servidor da ana pelo convite
  const st = await site.state(ana);
  const home = st.servers[0];
  const { code } = await site.request(ana, { t: 'invite:create', serverId: home.id });
  await site.request(bia, { t: 'invite:accept', code });
  ids = {
    server: home.id,
    text: home.channels.find((c) => c.type === 'text').id,
    text2: home.channels.filter((c) => c.type === 'text')[1]?.id,
    voice: home.channels.find((c) => c.type === 'voice').id,
  };
  await until(async () => (await site.state(bia)).servers.some((s) => s.id === ids.server), { what: 'bia no servidor' });
});

after(async () => {
  await browser?.close();
  await stack?.stop();
});

test('mensagem escrita no campo do chat aparece para a outra pessoa', async () => {
  await site.select(ana, ids.text);
  await site.select(bia, ids.text);
  await ana.fill('#chat-input', 'oi bia, tudo certo?');
  await ana.keyboard.press('Enter');
  await bia.waitForSelector('.msg:has-text("oi bia, tudo certo?")', { timeout: 10000 });
  assert.deepEqual(ana.errors, []);
});

test('tema colorido: aplica na hora e vale no outro aparelho da mesma conta', async () => {
  const ana2 = await openAs(browser, stack, 'ana', { token: ana.token });
  await ana.click('#btn-settings');
  await ana.click('.theme-swatch[data-theme="color:oceano"]');
  assert.equal(await ana.evaluate(() => document.documentElement.dataset.color), 'oceano');
  await until(() => ana2.evaluate(() => document.documentElement.dataset.color === 'oceano'), { what: 'tema no outro aparelho' });
  await ana.click('.theme-swatch[data-theme="dark"]');
  await ana.keyboard.press('Escape');
  await ana2.context().close();
});

test('aparelhos conectados: lista e "Sair" derruba o outro aparelho', async () => {
  const outro = await openAs(browser, stack, 'bia', { token: bia.token });
  // um segundo login (outra sessão) para poder tirar
  const r = await fetch(`${stack.base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'bia', password: 'senha-123' }) });
  const celular = await openAs(browser, stack, 'bia', { token: (await r.json()).token });
  await bia.click('#btn-settings');
  await bia.click('button:text("Aparelhos conectados")');
  await bia.waitForSelector('.session-row');
  assert.equal(await bia.$$eval('.session-row', (x) => x.length), 2);
  assert.equal(await bia.$$eval('.session-here', (x) => x.length), 1);
  await bia.click('.session-row:not(:has(.session-here)) button:text("Sair")');
  await until(() => celular.evaluate(() => !document.querySelector('#auth')?.hidden), { what: 'o celular voltar para a tela de entrar' });
  await bia.keyboard.press('Escape');
  await outro.context().close();
  await celular.context().close();
});

test('erro no site de alguém aparece no painel (Logs → Erros do site)', async () => {
  await ana.evaluate(() => setTimeout(() => { throw new Error('erro de teste do e2e'); }, 0));
  const painel = await startPainel({ base: stack.base, dir: stack.dir });
  try {
    const g = await until(async () => (await painel.get('/api/client-errors?days=1')).body.groups.find((x) => /erro de teste do e2e/.test(x.message)), { what: 'erro no painel' });
    assert.deepEqual(g.people, ['ana']);
    // A tela do painel abre todas as abas sem erro de JavaScript
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.goto(painel.base);
    await page.fill('#login-user', PAINEL_USER);
    await page.fill('#login-pass', PAINEL_PASS);
    await page.click('#login-form button[type=submit]');
    await page.waitForSelector('.attention');
    for (const p of await page.$$eval('.side button[data-page]', (b) => b.map((x) => x.dataset.page))) {
      await page.click(`button[data-page="${p}"]`);
      for (const sub of await page.$$eval('#subtabs button', (b) => b.map((x) => x.textContent))) {
        await page.click(`#subtabs button:text-is("${sub}")`);
        await wait(300);
      }
    }
    await page.click('button[data-page="logs"]');
    await page.click('#subtabs button:text-is("Erros do site")');
    await page.waitForSelector('.err-card:has-text("erro de teste do e2e")');
    assert.deepEqual(errs, []);
    await page.context().close();
  } finally {
    await painel.stop();
  }
});

test('call: câmera chega na outra pessoa, janela flutuante fora da call e F5 volta para a call', { skip: !process.env.LIVEKIT_BIN && !(await import('./helpers.js')).livekitBin() && 'sem LiveKit' }, async () => {
  await site.join(bia, ids.voice);
  await site.join(ana, ids.voice);
  await site.select(ana, ids.voice);
  await ana.click('#btn-cam');
  // bia vê o vídeo da ana na call
  await site.select(bia, ids.voice);
  await until(() => bia.evaluate(() => [...document.querySelectorAll('#stage .tile video')].some((v) => !v.hidden && v.videoWidth > 0)), { what: 'vídeo da ana na tela da bia' });
  // bia vai para o chat: a câmera continua numa janelinha
  await site.select(bia, ids.text);
  await until(() => bia.evaluate(() => { const m = document.querySelector('.mini-player'); return m && !m.hidden && m.querySelector('video').videoWidth > 0; }), { what: 'janela flutuante' });
  // bia recarrega a página: volta sozinha para a call
  await bia.reload();
  await bia.waitForSelector('#app:not([hidden])');
  assert.equal(await until(() => site.voiceChannel(bia), { what: 'voltar para a call depois do F5' }), ids.voice);
  assert.equal(await bia.$('.modal'), null); // sem perguntar de "2 aparelhos"
});

test('chat ao lado da call: a mensagem vai para o canal escolhido', { skip: !(await import('./helpers.js')).livekitBin() && 'sem LiveKit' }, async () => {
  await site.select(ana, ids.voice);
  await ana.click('#btn-call-chat');
  await ana.waitForSelector('#call-chat:not([hidden]) #chat-input');
  if (ids.text2) await ana.selectOption('#call-chat-select', ids.text2);
  await ana.fill('#chat-input', 'mensagem de dentro da call');
  await ana.keyboard.press('Enter');
  await site.select(bia, ids.text2 ?? ids.text);
  await bia.waitForSelector('.msg:has-text("mensagem de dentro da call")', { timeout: 10000 });
  assert.deepEqual(ana.errors.filter((e) => !/erro de teste do e2e/.test(e)), []);
  assert.deepEqual(bia.errors, []);
});

test('cara de app do Mac: no site e no app do Mac (só o app tem a coluna translúcida, que segue o tema)', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(() => {
    window.__appearance = [];
    window.muvucaDesktop = {
      isDesktop: true, opensFiles: true, platform: 'darwin', macLook: true,
      setAppearance: (mode, glass) => window.__appearance.push([mode, glass]),
      info: async () => ({ version: '1.4.7', platform: 'darwin' }), setPushToTalk: async () => ({ ok: true }), onPushToTalk: () => () => {},
      notify() {}, onOpenChannel: () => () => {}, setVoiceState() {}, onToggleMute: () => () => {},
      appAudioSupported: async () => false, wantAppAudio() {}, stopAppAudio() {}, onAppAudioData: () => () => {}, onAppAudioState: () => () => {},
    };
  });
  const page = await context.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(stack.base);
  await page.evaluate((t) => localStorage.setItem('calldireta:session', t), ana.token);
  await page.goto(stack.base);
  await page.waitForSelector('#app:not([hidden])');
  const look = () => page.evaluate(() => ({
    mac: document.documentElement.classList.contains('mac-app'),
    body: getComputedStyle(document.body).backgroundColor,
    bodyImage: getComputedStyle(document.body).backgroundImage,
    main: getComputedStyle(document.querySelector('.main')).backgroundColor,
    bar: getComputedStyle(document.body, '::before').display,
    category: getComputedStyle(document.querySelector('.category') ?? document.body).textTransform,
    last: window.__appearance.at(-1),
  }));
  const a = await look();
  assert.ok(a.mac);
  assert.equal(a.body, 'rgba(0, 0, 0, 0)'); // transparente: o macOS desenha o vidro por trás
  assert.notEqual(a.main, 'rgba(0, 0, 0, 0)'); // a conversa continua opaca
  assert.equal(a.bar, 'none'); // sem a faixa "Muvuca" do topo
  assert.equal(a.category, 'none');
  assert.deepEqual(a.last, ['dark', true]);
  // Tema colorido: sem vidro (fica o degradê)
  await page.evaluate(async () => (await import('/js/theme.js')).setTheme('color:oceano'));
  const b = await look();
  assert.deepEqual(b.last, ['dark', false]);
  assert.match(b.bodyImage, /gradient/);
  await page.evaluate(async () => (await import('/js/theme.js')).setTheme('dark'));
  // No navegador: o mesmo visual, mas sem o vidro (que só o macOS desenha) e com a faixa de cima normal
  const web = await ana.evaluate(() => ({
    look: document.documentElement.classList.contains('mac-look'), app: document.documentElement.classList.contains('mac-app'),
    body: getComputedStyle(document.body).backgroundColor, category: getComputedStyle(document.querySelector('.category') ?? document.body).textTransform,
  }));
  assert.deepEqual([web.look, web.app, web.category], [true, false, 'none']);
  assert.notEqual(web.body, 'rgba(0, 0, 0, 0)');
  assert.deepEqual(errs, []);
  await context.close();
});
