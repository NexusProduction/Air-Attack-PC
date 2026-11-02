#!/usr/bin/env bash
# Assembles dist/game-bundle.js (resources + JVM/Android runtime + translated game + browser host) and dist/index.html
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p dist
node tools/build_guard.js ${GUARD_ARGS:-}            # ad rails + AdBlock guard (obfuscated, config baked in when port/web/ads.config.json names ad units)
{
  cat dist/res.js
  cat port/runtime/jvm-core.js
  cat port/runtime/jvm-util.js
  cat port/runtime/android.js
  cat build/game.js
  echo
  cat build/guard.js
  echo
  cat port/web/host.js
} > dist/game-bundle.js
BUILD=$(md5sum dist/game-bundle.js | cut -c1-10)   # cache-buster so a re-uploaded bundle is never served stale
# setup mode (no ad units baked in): the page reads the readable config file site-config.js; the locked build has the units inside the obfuscated guard
if [ "$(cat build/guard.mode)" = "setup" ]; then SITECFG='<script src="site-config.js?v=__BUILD__"></script>'; cp port/web/site-config.js dist/site-config.js; else SITECFG=''; rm -f dist/site-config.js; fi
sed -e "s|<!--@SITECFG@-->|$SITECFG|" -e "s/__BUILD__/$BUILD/g" port/web/index.html > dist/index.html
cp port/web/cover.png port/web/favicon.png port/web/favicon.ico port/web/apple-touch-icon.png dist/
echo "built dist/game-bundle.js ($(wc -c < dist/game-bundle.js) bytes)"
