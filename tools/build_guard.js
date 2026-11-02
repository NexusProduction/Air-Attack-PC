#!/usr/bin/env node
// Builds build/guard.js from port/web/guard.src.js
//   node tools/build_guard.js                        -> reads port/web/ads.config.json (if it names at least one ad unit the config is BAKED in = locked build)
//   node tools/build_guard.js --config my.json       -> bake another config file
//   node tools/build_guard.js --plain                -> no obfuscation (debugging)
// ads.config.json:  { "left600": "<invoke.js url or 32-char key>", "right600": "...", "left300": "...", "right300": "...", "refresh": 30, "enforce": true }
const fs = require("fs"), path = require("path"), cp = require("child_process");
const root = path.join(__dirname, "..");
const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const cfgPath = opt("--config") || path.join(root, "port/web/ads.config.json");
const plain = args.includes("--plain");

let src = fs.readFileSync(path.join(root, "port/web/guard.src.js"), "utf8");
let cfg = null;
if (fs.existsSync(cfgPath)) {
  const raw = fs.readFileSync(cfgPath, "utf8").trim();
  if (raw) {
    const c = JSON.parse(raw);
    const has = ["left600", "right600", "left300", "right300", "left"].some((k) => c[k] && String(c[k]).trim());
    if (has) {
      cfg = {};
      for (const k of ["left600", "right600", "left300", "right300"]) if (c[k] && String(c[k]).trim()) cfg[k] = String(c[k]).trim();
      if (!cfg.left600 && c.left) cfg.left600 = String(c.left).trim();
      cfg.refresh = Math.max(30, +c.refresh || 30);
      cfg.enforce = c.enforce !== false;
    }
  }
}
if (!/\/\*@BAKED@\*\/ null/.test(src)) throw new Error("placeholder missing in guard.src.js");
// '<' and '/' are escaped so the config can never close a <script> tag or a comment
const baked = cfg ? JSON.stringify(cfg).replace(/</g, "\\u003c").replace(/\//g, "\\/") : "null";
src = src.replace("/*@BAKED@*/ null", () => baked);

fs.mkdirSync(path.join(root, "build"), { recursive: true });
const out = path.join(root, "build/guard.js");
if (plain) { fs.writeFileSync(out, src); }
else {
  const tmp = path.join(root, "build/guard.in.js");
  fs.writeFileSync(tmp, src);
  const bin = process.env.JSO || "/tmp/aa-pkg/obf/node_modules/.bin/javascript-obfuscator";
  const r = cp.spawnSync(bin, [tmp, "--output", out,
    "--target", "browser", "--compact", "true", "--simplify", "true",
    "--identifier-names-generator", "hexadecimal", "--rename-globals", "false", "--rename-properties", "false",
    "--string-array", "true", "--string-array-threshold", "1", "--string-array-encoding", "rc4",
    "--string-array-rotate", "true", "--string-array-shuffle", "true", "--string-array-wrappers-count", "2", "--string-array-wrappers-type", "function",
    "--split-strings", "true", "--split-strings-chunk-length", "6",
    "--control-flow-flattening", "true", "--control-flow-flattening-threshold", "0.6",
    "--dead-code-injection", "true", "--dead-code-injection-threshold", "0.25",
    "--transform-object-keys", "true", "--numbers-to-expressions", "true",
    "--self-defending", "true", "--unicode-escape-sequence", "false",
    "--seed", String(Math.floor(Math.random() * 1e9)),
  ], { encoding: "utf8" });
  if (r.status !== 0) { console.error(r.stdout, r.stderr); process.exit(1); }
  fs.unlinkSync(tmp);
}
fs.writeFileSync(path.join(root, "build/guard.mode"), cfg ? "locked" : "setup");
console.log("guard.js: " + (cfg ? "LOCKED (config baked in: " + Object.keys(cfg).join(", ") + ")" : "setup mode (reads site-config.js)") + (plain ? ", not obfuscated" : ", obfuscated") + ", " + fs.statSync(out).size + " bytes");
