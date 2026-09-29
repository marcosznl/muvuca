// Atualização automática do app (Mac e Windows), sem depender de assinatura paga:
// Windows: baixa o instalador novo, confere e roda em silêncio (ele fecha o app, instala e reabre).
// Mac:
// 1. lê downloads/latest.json no servidor do Muvuca;  2. baixa o pacote (.zip) em segundo plano;
// 3. confere tamanho, impressão digital (SHA-512), versão e assinatura do app novo;
// 4. pergunta se reinicia agora (ou troca ao fechar);  5. um script pequeno espera o app fechar,
//    troca o Muvuca.app pelo novo e abre de novo. O antigo fica guardado até o novo abrir.
const { app, dialog, shell } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');

const run = promisify(execFile);
const IS_WIN = process.platform === 'win32';
const newer = (a, b) => {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};

const updatesDir = () => path.join(app.getPath('userData'), 'atualizacoes');
const backupPath = () => path.join(updatesDir(), 'Muvuca-anterior.app');

// Onde o app está instalado (…/Muvuca.app); só atualiza se estiver num lugar gravável e fixo
function bundlePath() {
  const exe = app.getPath('exe'); // …/Muvuca.app/Contents/MacOS/Muvuca
  const bundle = path.resolve(exe, '..', '..', '..');
  return bundle.endsWith('.app') ? bundle : null;
}
function whyCannotUpdate() {
  if (!app.isPackaged) return 'modo de desenvolvimento';
  if (IS_WIN) return null; // o instalador cuida de tudo (instala na pasta do usuário, sem pedir administrador)
  const b = bundlePath();
  if (!b) return 'não achei o app';
  if (b.includes('/AppTranslocation/') || b.startsWith('/Volumes/')) return 'fora da pasta Aplicativos';
  try { fs.accessSync(path.dirname(b), fs.constants.W_OK); } catch { return 'sem permissão para gravar na pasta do app'; }
  return null;
}

let state = { busy: false, ready: null, offered: null }; // ready = { version, appPath }
let getWindow = () => null;
let getOrigin = () => '';
// Com a janela escondida (só na barra de menus), o aviso aparece solto na tela
const parentWindow = () => { const w = getWindow(); return w && !w.isDestroyed() && w.isVisible() ? w : undefined; };

// Depois de atualizar: apaga a cópia guardada da versão anterior (caminho exato, dentro da pasta do app)
function cleanupBackup() {
  const dir = updatesDir();
  if (!dir.startsWith(app.getPath('userData')) || !fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    // Só nomes conhecidos: a cópia anterior, cópias "velhas" e pastas de versões já instaladas
    if (name === 'Muvuca-anterior.app' || /^Muvuca-anterior\.app\.velho\.\d+$/.test(name) || /^\d+\.\d+\.\d+$/.test(name)) {
      fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    }
  }
}

async function download(url, file, size, sha512, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`o servidor respondeu ${res.status}`);
  const hash = crypto.createHash('sha512');
  const out = fs.createWriteStream(file);
  let got = 0;
  for await (const chunk of res.body) {
    got += chunk.length;
    hash.update(chunk);
    if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
    onProgress?.(got / size);
  }
  await new Promise((r, j) => out.end((err) => (err ? j(err) : r())));
  if (got !== size) throw new Error('o arquivo chegou incompleto');
  if (hash.digest('hex') !== sha512) throw new Error('o arquivo chegou diferente do publicado');
}

// Baixa, confere e deixa pronto para trocar
async function prepareWindows(info) {
  const pkg = info.win?.[process.arch === 'arm64' ? 'arm64' : 'x64'] ?? info.win?.x64;
  if (!pkg?.sha512) throw new Error('não tem instalador para este Windows');
  const dir = path.join(updatesDir(), info.version);
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });
  const exe = path.join(dir, pkg.file);
  await download(`${getOrigin()}/downloads/${pkg.file}`, exe, pkg.size, pkg.sha512);
  return exe;
}

async function prepare(info) {
  if (IS_WIN) return prepareWindows(info);
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const pkg = info.mac?.[arch]?.update;
  if (!pkg) throw new Error('não tem pacote de atualização para este Mac');
  const dir = path.join(updatesDir(), info.version);
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });
  const zip = path.join(dir, pkg.file);
  await download(`${getOrigin()}/downloads/${pkg.file}`, zip, pkg.size, pkg.sha512);
  await run('/usr/bin/ditto', ['-x', '-k', zip, dir]);
  await fsp.rm(zip, { force: true });
  const appPath = path.join(dir, 'Muvuca.app');
  const plist = path.join(appPath, 'Contents', 'Info.plist');
  const { stdout } = await run('/usr/libexec/PlistBuddy', ['-c', 'Print CFBundleShortVersionString', plist]);
  if (stdout.trim() !== info.version) throw new Error('a versão do pacote não confere');
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath]); // app íntegro
  return appPath;
}

// Troca e reabre: um script espera este app fechar, move o antigo para o lado, põe o novo e abre
function applyAndRelaunch(reopen = true) {
  const ready = state.ready;
  if (IS_WIN && ready) {
    // Instalador em silêncio; "--force-run" reabre o app no fim
    spawn(ready.appPath, ['/S', ...(reopen ? ['--force-run'] : [])], { detached: true, stdio: 'ignore' }).unref();
    state.ready = null;
    return true;
  }
  const target = bundlePath();
  if (!ready || !target) return false;
  const script = path.join(updatesDir(), 'trocar.sh');
  fs.writeFileSync(script, `#!/bin/zsh
# Troca o Muvuca.app pelo novo (feito pelo próprio Muvuca). Sem apagar nada: o antigo vai para o lado.
set -u
pid="$1"; old="$2"; new="$3"; backup="$4"; reopen="$5"
for i in {1..100}; do kill -0 "$pid" 2>/dev/null || break; sleep 0.2; done
[[ -d "$new" && "$old" == *.app && -d "$old" && "$backup" == *.app ]] || exit 1
[[ -e "$backup" ]] && mv "$backup" "$backup.velho.$$"
if mv "$old" "$backup"; then
  if mv "$new" "$old"; then [[ "$reopen" == 1 ]] && open "$old"; else mv "$backup" "$old"; [[ "$reopen" == 1 ]] && open "$old"; fi
fi
`, { mode: 0o755 });
  spawn('/bin/zsh', [script, String(process.pid), target, ready.appPath, backupPath(), reopen ? '1' : '0'], { detached: true, stdio: 'ignore' }).unref();
  state.ready = null; // já está trocando
  return true;
}

async function check({ manual = false } = {}) {
  if (state.busy) return;
  const why = whyCannotUpdate();
  let info;
  try {
    const res = await fetch(`${getOrigin()}/downloads/latest.json`, { cache: 'no-cache' });
    if (!res.ok) throw new Error();
    info = await res.json();
  } catch {
    if (manual) dialog.showMessageBox(parentWindow(), { type: 'warning', message: 'Não deu para procurar atualizações', detail: 'O servidor do Muvuca não respondeu.' });
    return;
  }
  if (!info?.version || !newer(info.version, app.getVersion())) {
    if (manual) dialog.showMessageBox(parentWindow(), { type: 'info', message: 'Você já está com a versão mais nova', detail: `Muvuca ${app.getVersion()}` });
    return;
  }
  if (state.ready?.version === info.version) return askRestart();
  if (why) {
    // Não dá para trocar sozinho (ex.: aberto direto do .dmg): oferece baixar pela página
    if (state.offered === info.version && !manual) return;
    state.offered = info.version;
    const r = await dialog.showMessageBox(parentWindow(), {
      type: 'info', message: `Tem versão nova do Muvuca (${info.version})`,
      detail: `A atualização automática não funciona aqui (${why}). Baixe a nova e arraste para Aplicativos.`,
      buttons: ['Baixar', 'Depois'], defaultId: 0, cancelId: 1,
    });
    if (r.response === 0) shell.openExternal(`${getOrigin()}/baixar`);
    return;
  }
  state.busy = true;
  try {
    const appPath = await prepare(info);
    state.ready = { version: info.version, appPath };
    await askRestart();
  } catch (err) {
    console.error('atualização', err);
    if (manual) dialog.showMessageBox(parentWindow(), { type: 'warning', message: 'A atualização não deu certo', detail: String(err.message ?? err) });
  } finally {
    state.busy = false;
  }
}

async function askRestart() {
  if (process.env.MUVUCA_UPDATE_TEST === '1') { if (applyAndRelaunch()) app.emit('muvuca-quit'); return; } // só em teste
  const r = await dialog.showMessageBox(parentWindow(), {
    type: 'info',
    message: `Muvuca ${state.ready.version} pronto para instalar`,
    detail: 'O app reinicia em poucos segundos. Se estiver numa call, você sai e volta depois.',
    buttons: ['Reiniciar agora', 'Na próxima vez que fechar'],
    defaultId: 0,
    cancelId: 1,
  });
  if (r.response === 0 && applyAndRelaunch()) app.emit('muvuca-quit');
}

// Fechou o app com uma atualização pronta: troca ao sair (sem reabrir; da próxima vez já abre na nova)
function onQuit() {
  if (state.ready) applyAndRelaunch(false);
}

function init({ window, origin }) {
  getWindow = window;
  getOrigin = origin;
  // Abriu depois de atualizar: some com a cópia da versão anterior
  try { cleanupBackup(); } catch (err) { console.error('limpeza da atualização', err); }
}

module.exports = { init, check, onQuit, hasPendingUpdate: () => !!state.ready };
