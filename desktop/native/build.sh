#!/bin/zsh
# Compila o muvuca-audio: Mac (chip Apple e Intel num binário só, macOS 13+) e Windows (muvuca-audio.exe,
# compilado aqui mesmo com o mingw-w64: brew install mingw-w64)
set -e
cd "$(dirname "$0")"
mkdir -p ../build/bin
for arch in arm64 x86_64; do
  swiftc -O -target $arch-apple-macos13.0 -o /tmp/muvuca-audio-$arch muvuca-audio.swift -framework ScreenCaptureKit -framework CoreMedia -framework AVFoundation
done
lipo -create -output ../build/bin/muvuca-audio /tmp/muvuca-audio-arm64 /tmp/muvuca-audio-x86_64
rm -f /tmp/muvuca-audio-arm64 /tmp/muvuca-audio-x86_64
codesign --force -s - ../build/bin/muvuca-audio
echo "ok: $(lipo -archs ../build/bin/muvuca-audio)"
# Windows: um .exe x64 serve também para Windows ARM (roda emulado); sem DLLs além das do próprio Windows
x86_64-w64-mingw32-g++ -O2 -s -std=c++17 -static -static-libgcc -static-libstdc++ -o ../build/bin/muvuca-audio.exe muvuca-audio-win.cpp -lole32 -luuid
echo "ok: muvuca-audio.exe (Windows)"
