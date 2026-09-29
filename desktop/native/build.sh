#!/bin/zsh
# Compila o muvuca-audio para Mac com chip Apple e Intel (um binário só), macOS 13+
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
