#!/bin/zsh
# Gera o app do Mac e do Windows e coloca os instaladores em ../downloads (servidos em /baixar e /downloads/…).
# Uso: ./publicar.sh            (usa a versão do package.json)
#      ./publicar.sh 1.1.0      (muda a versão antes)
set -e
cd "$(dirname "$0")"
[[ -n "$1" ]] && npm version "$1" --no-git-tag-version >/dev/null
version=$(node -p "require('./package.json').version")
echo "Gerando o Muvuca $version…"
rm -rf dist
native/build.sh >/dev/null
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac --win >/dev/null
codesign --verify --deep --strict dist/mac-arm64/Muvuca.app
codesign --verify --deep --strict dist/mac/Muvuca.app

out=../downloads
mkdir -p "$out"
for arch in arm64 x64; do
  cp "dist/Muvuca-$version-$arch.dmg" "$out/"
  cp "dist/Muvuca-$version-$arch-mac.zip" "$out/" # pacote da atualização automática (o app baixa sozinho)
  cp "dist/Muvuca-$version-$arch-windows.exe" "$out/" # Windows: o mesmo instalador serve para baixar e atualizar
done

# Lista que a página /baixar e o próprio app leem para saber a versão mais nova
node -e "
const fs = require('fs');
const crypto = require('crypto');
const f = (arch) => {
  const file = 'Muvuca-$version-' + arch + '.dmg';
  const zip = 'Muvuca-$version-' + arch + '-mac.zip';
  const data = fs.readFileSync('$out/' + zip);
  return { file, size: fs.statSync('$out/' + file).size,
    update: { file: zip, size: data.length, sha512: crypto.createHash('sha512').update(data).digest('hex') } };
};
const w = (arch) => {
  const file = 'Muvuca-$version-' + arch + '-windows.exe';
  const data = fs.readFileSync('$out/' + file);
  return { file, size: data.length, sha512: crypto.createHash('sha512').update(data).digest('hex') };
};
fs.writeFileSync('$out/latest.json', JSON.stringify({ version: '$version', date: new Date().toISOString(),
  mac: { arm64: f('arm64'), x64: f('x64') }, win: { x64: w('x64'), arm64: w('arm64') } }, null, 2));
"

# Mantém só os instaladores desta versão (apaga os antigos pelo nome exato, nunca por lista vazia)
for old in "$out"/Muvuca-*.dmg(N) "$out"/Muvuca-*-mac.zip(N) "$out"/Muvuca-*-windows.exe(N); do
  [[ "$old" == *"-$version-"* ]] || rm -f -- "$old"
done
echo "Pronto: $out"
ls -la "$out"
