// Mac: o app não tem assinatura paga da Apple (assinatura "ad-hoc"). Sem isto, a identidade dele é a impressão
// digital do código, que muda a cada versão, e o macOS passa a entregar silêncio no microfone depois de toda
// atualização (a permissão dada antes deixa de valer, sem avisar). Aqui o selo de fora do app passa a dizer
// "sou o br.malegna.muvuca": a permissão de microfone/tela continua valendo nas próximas versões.
// Só o selo de fora: as partes internas (Electron, helpers) mantêm a assinatura própria delas.
const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const id = context.packager.appInfo.id;
  execFileSync('codesign', ['--force', '--sign', '-', '--preserve-metadata=entitlements,flags', '-r=designated => identifier "' + id + '"', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
};
