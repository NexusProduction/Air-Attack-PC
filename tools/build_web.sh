#!/usr/bin/env bash
# Assembles dist/game-bundle.js (resources + JVM/Android runtime + translated game + browser host) and dist/index.html
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p dist
{
  cat dist/res.js
  cat port/runtime/jvm-core.js
  cat port/runtime/jvm-util.js
  cat port/runtime/android.js
  cat build/game.js
  cat port/web/host.js
} > dist/game-bundle.js
BUILD=$(md5sum dist/game-bundle.js | cut -c1-10)   # cache-buster so a re-uploaded bundle is never served stale
sed "s/__BUILD__/$BUILD/g" port/web/index.html > dist/index.html
cp port/web/cover.png port/web/favicon.png port/web/favicon.ico port/web/apple-touch-icon.png dist/
echo "built dist/game-bundle.js ($(wc -c < dist/game-bundle.js) bytes)"
