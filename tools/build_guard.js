// Builds build/guard.js (the readable, non-blocking side-ad helper) and build/guard.mode.
// "setup" mode = the ad links are read from site-config.js at run time (build_web.sh copies it into dist/).
const fs = require("fs"), path = require("path");
const root = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(root, "port/web/guard.src.js"), "utf8");
fs.mkdirSync(path.join(root, "build"), { recursive: true });
fs.writeFileSync(path.join(root, "build/guard.js"), src);
fs.writeFileSync(path.join(root, "build/guard.mode"), "setup");
console.log("built build/guard.js (" + src.length + " bytes), mode=setup");
