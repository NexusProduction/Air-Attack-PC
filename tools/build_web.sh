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
cp port/web/index.html dist/index.html
cp port/web/cover.png dist/cover.png
echo "built dist/game-bundle.js ($(wc -c < dist/game-bundle.js) bytes)"
