// Air Attack web port - side-ad rails + AdBlock guard.
// READABLE SOURCE. The file that ships (inside dist/game-bundle.js) is the obfuscated build of this (tools/build_guard.js).
//
// What it does
//   * puts one Adsterra banner (160x600, or 160x300 on short windows) on EACH side of the game; the game is scaled to fit between them
//   * every refresh seconds (default 30) both banners are reloaded - only while the tab is visible and focused
//   * detects ad blockers / tampering (network probe, bait element, ad frame missing / hidden / covered / resized / removed)
//     and then shows a full-screen message "please turn off AdBlock and reload" and freezes the game
//   * the game (host.js) asks window.$sg before it starts, on every frame and for every input event
//
// Honest limit: this is client-side code running in the player's own browser. It makes removing the ads much more work
// (blockers, console one-liners, hiding / deleting elements all end in the message), it cannot make it impossible for
// someone who edits their local copy of the files.
(function (G) {
  "use strict";
  var D = G.document;
  var BAKED = /*@BAKED@*/ null;                   // locked config written by tools/build_guard.js (or null = "setup mode": read window.AA_CFG)

  // ------------------------------------------------------------------ configuration
  var RAIL_W = 160, GAP = 12, MIN_SCALE = 0.5;

  function parseUnit(v) {
    if (!v) return null;
    v = String(v);
    var m = v.match(/(?:https?:)?\/\/[A-Za-z0-9.\-]+(?::\d+)?\/(?:[A-Za-z0-9_.\-]+\/)*?([0-9a-f]{32})\/invoke\.js/i);
    if (m) {
      var u = m[0]; if (u.indexOf("//") === 0) u = "https:" + u;
      if (/^http:/i.test(u) && G.location.protocol === "https:" && !/^http:\/\/(localhost|127\.0\.0\.1)/i.test(u)) u = u.replace(/^http:/i, "https:");
      return { key: m[1].toLowerCase(), src: u };
    }
    m = v.match(/\b([0-9a-f]{32})\b/i);
    if (m) return { key: m[1].toLowerCase(), src: "https://www.highperformanceformat.com/" + m[1].toLowerCase() + "/invoke.js" };
    return null;
  }

  var C = BAKED || G.AA_CFG || {};
  var isBaked = !!BAKED;
  var U = {
    l6: parseUnit(C.left600 || C.left), r6: parseUnit(C.right600), l3: parseUnit(C.left300), r3: parseUnit(C.right300)
  };
  U.r6 = U.r6 || U.l6; U.r3 = U.r3 || U.l3;
  var active = !!((U.l6 && U.r6) || (U.l3 && U.r3));
  var enforce = isBaked ? C.enforce !== false : C.enforce === true;                    // setup mode only warns unless enforce:true
  var refreshMs = Math.max(isBaked ? 30 : 3, +C.refresh || 30) * 1000;                 // never faster than 30 s in the locked build

  // ------------------------------------------------------------------ state
  var blocked = false, small = false, smallShown = false;
  var slots = [], bait = null, wall = null, domReady = false;
  var lastTickAt = now(), initAt = now(), lastBeat = now(), lastOk = now(), visAt = now(), tampers = 0, baitTicks = 0, probeFailed = false, netFails = 0, lastProbe = 0, warned = {}, tickQueued = false;

  function rnd() { return "x" + Math.random().toString(36).slice(2, 10); }
  function now() { return Date.now(); }
  function vp() { var e = D.documentElement; return [e.clientWidth || G.innerWidth || 0, e.clientHeight || G.innerHeight || 0]; }
  function log() { if (C.debug && G.console) { try { G.console.info.apply(G.console, ["[sg]"].concat([].slice.call(arguments))); } catch (e) { } } }

  function railHeight(vh) {
    if (U.l6 && U.r6 && vh >= 612) return 600;
    if (U.l3 && U.r3 && vh >= 312) return 300;
    return 0;
  }
  function unitFor(side, h) { return side === "l" ? (h === 600 ? U.l6 : U.l3) : (h === 600 ? U.r6 : U.r3); }

  // ------------------------------------------------------------------ messages (closed shadow root, re-attached if someone removes it)
  var CSS = ".w{position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:rgba(8,16,32,.97);color:#fff;" +
    "font-family:system-ui,-apple-system,'Segoe UI',Roboto,'Noto Sans','Noto Sans Devanagari',Arial,sans-serif;text-align:center;padding:24px;box-sizing:border-box;overflow:auto}" +
    ".c{max-width:560px;margin:auto}h1{margin:0 0 14px;font-size:30px;color:#ffd84a;letter-spacing:1px}p{margin:0 0 12px;line-height:1.5;font-size:18px}" +
    ".hi{font-size:17px;opacity:.9;border-top:1px solid rgba(255,255,255,.25);padding-top:14px;margin-top:18px}" +
    "button{margin-top:14px;font:inherit;font-size:18px;font-weight:700;padding:12px 26px;background:#ffd84a;color:#111;border:0;border-radius:6px;cursor:pointer}";
  var HTML = {
    wall: "<div class=w role=alertdialog aria-modal=true><div class=c><h1>AdBlock detected</h1>" +
      "<p><b>Please turn off AdBlock and reload this website to play this game.</b></p>" +
      "<p>This game is free because of the ads. Turn off your ad blocker for this site (or pause it), then reload the page.</p>" +
      "<button id=r>I turned it off - Reload</button>" +
      "<p class=hi lang=hi>कृपया AdBlock बंद करें और गेम खेलने के लिए इस वेबसाइट को रीलोड करें।</p></div></div>",
    small: "<div class=w role=alertdialog aria-modal=true><div class=c><h1>Window too small</h1>" +
      "<p><b>Please make your browser window bigger (or press Ctrl + 0 to reset zoom).</b></p>" +
      "<p>The game and the ads need at least about 980 x 360 pixels.</p>" +
      "<p class=hi lang=hi>कृपया ब्राउज़र विंडो बड़ी करें या ज़ूम कम करें (Ctrl + 0)।</p></div></div>"
  };
  function mkMsg(kind) {
    var host = D.createElement("div");
    host.style.cssText = "position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483647;display:block;visibility:visible;opacity:1;margin:0;padding:0;border:0;background:transparent;transform:none;filter:none";
    var root = host.attachShadow ? host.attachShadow({ mode: "closed" }) : host;
    root.innerHTML = "<style>" + CSS + "</style>" + HTML[kind];
    var b = root.querySelector("#r"); if (b) b.addEventListener("click", function () { G.location.reload(); });
    return host;
  }
  function attach(h) { if (!h.isConnected) (D.documentElement || D.body).appendChild(h); }

  // host.js hands its lock() over exactly once (first caller wins), so nothing on the page can call it later
  var lockFn = null;
  function lockGame(on) { try { if (lockFn) lockFn(on); } catch (e) { } }

  function showWall(why) {
    if (blocked) return;
    log("blocked:", why);
    if (!enforce) { if (G.console && !warned[why]) { warned[why] = 1; try { G.console.warn("[sg] ad problem (" + why + ") - not enforced in setup mode"); } catch (e) { } } return; }
    blocked = true;
    hideSmall();
    wall = mkMsg("wall"); attach(wall);
    lockGame(true);
    var css = wall.style.cssText;
    // whatever happens to the message (deleted, hidden, restyled in the inspector) it is put back
    G.setInterval(function () { if (wall.style.cssText !== css) wall.style.cssText = css; attach(wall); lockGame(true); }, 500);
    try {
      new G.MutationObserver(function () { attach(wall); if (wall.style.cssText !== css) wall.style.cssText = css; }).observe(D.documentElement, { childList: true });
      new G.MutationObserver(function () { if (wall.style.cssText !== css) wall.style.cssText = css; }).observe(wall, { attributes: true });
    } catch (e) { }
    try { D.documentElement.style.overflow = "hidden"; } catch (e) { }
  }

  var smallHost = null;
  function showSmall() { if (blocked || smallShown) return; smallShown = true; smallHost = mkMsg("small"); attach(smallHost); lockGame(true); }
  function hideSmall() { if (!smallShown) return; smallShown = false; try { smallHost.remove(); } catch (e) { } smallHost = null; if (!blocked) lockGame(false); }

  // ------------------------------------------------------------------ ad frames
  function adDoc(unit, h) {
    return "<!doctype html><html><head><meta charset=utf-8><style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}</style></head><body>" +
      "<script>var atOptions={'key':'" + unit.key + "','format':'iframe','height':" + h + ",'width':" + RAIL_W + ",'params':{}};<\/script>" +
      "<script src=\"" + unit.src + "\" onerror=\"this.setAttribute('data-x','1')\"><\/script></body></html>";
  }
  function mkFrame(unit, h) {
    var f = D.createElement("iframe");
    f.setAttribute("width", String(RAIL_W)); f.setAttribute("height", String(h)); f.setAttribute("scrolling", "no"); f.setAttribute("frameborder", "0");
    f.style.cssText = "border:0;margin:0;padding:0;display:block;width:" + RAIL_W + "px;height:" + h + "px;background:transparent";
    f.born = now(); f.loaded = false;
    f.addEventListener("load", function () { f.loaded = true; f.loadedAt = now(); });
    f.srcdoc = adDoc(unit, h);
    return f;
  }
  function innerDoc(f) { try { return f.contentDocument || null; } catch (e) { return null; } }
  // the element Adsterra's loader created inside our frame: normally an <iframe>; any other big visible element counts as well
  function adIframe(f) {
    var d = innerDoc(f); if (!d || !d.getElementsByTagName || !d.body) return null;
    var a = d.getElementsByTagName("iframe"); if (a.length) return a[0];
    var k = d.body.children;
    for (var i = 0; i < k.length; i++) {
      var t = k[i].tagName;
      if (t === "SCRIPT" || t === "STYLE" || t === "NOSCRIPT") continue;
      var r = k[i].getBoundingClientRect();
      if (r.width >= RAIL_W * 0.8 && r.height >= 90) return k[i];
    }
    return null;
  }
  function scriptFailed(f) { var d = innerDoc(f); return !!(d && d.querySelector && d.querySelector("script[data-x]")); }

  function ensureDom() {
    if (!active || slots.length || !(D.body || D.documentElement)) return;
    ["l", "r"].forEach(function (side) {
      var rail = D.createElement("div");
      rail.id = rnd();
      rail.style.cssText = "position:fixed;z-index:5;width:" + RAIL_W + "px;height:300px;margin:0;padding:0;border:0;overflow:hidden;background:#000;display:none;opacity:1;visibility:visible";
      (D.documentElement).appendChild(rail);
      slots.push({ side: side, rail: rail, frame: null, h: 0, unit: null, pending: null, bad: 0 });
    });
    bait = D.createElement("div");
    bait.className = "adsbox ad-banner ad-placement pub_300x250 textads banner_ad sponsor ads";
    bait.style.cssText = "position:absolute;left:-9999px;top:-9999px;width:3px;height:3px;pointer-events:none";
    bait.innerHTML = "&nbsp;";
    (D.body || D.documentElement).appendChild(bait);
  }

  function fillSlot(s, h) {
    var unit = unitFor(s.side, h);
    if (s.frame) { try { s.frame.remove(); } catch (e) { } }
    if (s.pending) { try { s.pending.remove(); } catch (e) { } s.pending = null; }
    s.h = h; s.unit = unit; s.bad = 0;
    s.rail.style.height = h + "px";
    s.frame = mkFrame(unit, h);
    s.rail.appendChild(s.frame);
  }

  // ------------------------------------------------------------------ layout (called by fit() in index.html)
  function lay(vw, vh) {
    if (!active) return { rail: 0, small: false };
    var rail = RAIL_W + GAP, h = railHeight(vh), s = Math.min((vw - 2 * rail) / 1280, vh / 720);
    small = !h || s < MIN_SCALE;
    return { rail: rail, small: small };
  }
  function plc(x, y, w, h, vw, vh) {
    if (!active) return;
    ensureDom();
    if (!slots.length) return;
    var rh = railHeight(vh);
    if (small || !rh) {
      slots.forEach(function (s) { s.rail.style.display = "none"; });
      showSmall();
      return;
    }
    hideSmall();
    var top = Math.max(0, Math.min(vh - rh, Math.round(y + h / 2 - rh / 2)));
    slots.forEach(function (s) {
      s.rail.style.display = "block";
      s.rail.style.top = top + "px";
      s.rail.style.left = Math.round(s.side === "l" ? x - GAP - RAIL_W : x + w + GAP) + "px";
      if (s.h !== rh || !s.frame) fillSlot(s, rh);
    });
  }

  // ------------------------------------------------------------------ checks
  function shown(el, strict) {
    var cs = G.getComputedStyle(el);
    if (cs.display === "none" || cs.visibility !== "visible" || +cs.opacity < 0.9) return false;
    if (strict && ((cs.clipPath && cs.clipPath !== "none") || (cs.filter && cs.filter !== "none"))) return false;
    return true;
  }
  // returns null (fine), "wait" (not judged yet) or a reason
  function inspect(s) {
    var f = s.frame, r = s.rail;
    if (!f || !r.isConnected || !f.isConnected || f.parentNode !== r) return "removed";
    var n = f;
    while (n && n.nodeType === 1) { if (!shown(n, n === f || n === r)) return "hidden"; n = n.parentNode; }
    var b = f.getBoundingClientRect(), v = vp();
    if (Math.abs(b.width - RAIL_W) > 1.5 || Math.abs(b.height - s.h) > 1.5) return "size";
    if (b.left < -1 || b.top < -1 || b.right > v[0] + 1 || b.bottom > v[1] + 1) return "clipped";
    var free = 0, pts = [[.5, .5], [.1, .05], [.9, .05], [.1, .95], [.9, .95]];
    for (var i = 0; i < pts.length; i++) { if (D.elementFromPoint(b.left + b.width * pts[i][0], b.top + b.height * pts[i][1]) === f) free++; }
    if (free < 3) return "covered";
    if (!f.loaded) return (now() - f.born > 30000) ? "noload" : "wait";
    if (scriptFailed(f)) return "script";
    var a = adIframe(f);
    if (!a) return (now() - f.loadedAt > 8000) ? "noframe" : "wait";
    var w = innerDoc(f).defaultView;
    if (!shown(a, false) || (w && !(function () { var q = w.getComputedStyle(a); return q.display !== "none" && q.visibility === "visible" && +q.opacity >= 0.9; })())) return "innerhidden";
    var ab = a.getBoundingClientRect();
    if (ab.width < RAIL_W * 0.9 || ab.height < s.h * 0.9) return "innersize";
    return null;
  }
  function baitBad() {
    if (!bait) return false;
    if (!bait.isConnected) return true;
    var cs = G.getComputedStyle(bait);
    return bait.offsetHeight === 0 || bait.offsetWidth === 0 || cs.display === "none" || cs.visibility === "hidden";
  }
  function probe(u) {
    try {
      var p = G.fetch(u, { method: "GET", mode: "no-cors", cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" });
      return p.then(function () { return true; }, function () { return G.navigator.onLine === false; });
    } catch (e) { return Promise.resolve(true); }
  }
  function runProbe() {
    var u = (U.l6 || U.l3 || U.r6 || U.r3);
    if (!u) return;
    lastProbe = now();
    probe(u.src).then(function (ok) { if (!ok) { probeFailed = true; tick(); } });
  }

    function tick() {
    lastTickAt = now();
    if (blocked || !active || !slots.length) return;
    if (D.hidden || small || smallShown) return;                                   // nothing is painted in a background tab / while the size message is up
    if (probeFailed) return showWall("network");
    if (baitBad()) { if (++baitTicks >= 2) return showWall("bait"); } else baitTicks = 0;
    var removedNow = false;
    for (var i = 0; i < slots.length; i++) {
      var s = slots[i];
      if (!s.frame) { if (now() - initAt > 8000) return showWall("layout"); continue; }          // fit() / plc() never put the ads on the page
      var why = inspect(s);
      if (why === "wait") continue;
      if (!why) { s.bad = 0; continue; }
      if (!s.bad) s.badSince = now();
      s.bad++;
      log(s.side, why, s.bad);
      if (why === "removed") {                                                    // deleted in the inspector / by a blocker: put it back once, then it counts
        if (!removedNow) { tampers++; removedNow = true; }                         // both rails deleted in one go = one incident
        try { if (!s.rail.isConnected) D.documentElement.appendChild(s.rail); } catch (e) { }
        fillSlot(s, s.h || railHeight(vp()[1]) || 300);
        if (tampers >= 2) return showWall("removed");
        continue;
      }
      if (s.bad >= 2 && now() - s.badSince >= 1000) return showWall(why);               // must persist for 2 checks and >= 1 s (a resize in progress is not tampering)
      if (why === "script") return showWall(why);
    }
  }

  // ------------------------------------------------------------------ rotation every refreshMs (only while the tab is visible + focused)
  // style tampering that a fresh frame would wipe out (display / visibility / opacity / size) must not be "cleaned up" by the rotation
  function styleTamper(s) { var w = inspect(s); return w === "hidden" || w === "size" || w === "innerhidden" || w === "innersize" ? w : null; }
  function refreshSlot(s) {
    if (blocked || small || smallShown || !s.frame || s.pending) return;
    var tw = styleTamper(s); if (tw) { showWall(tw); return; }
    var nf = mkFrame(s.unit, s.h), t0 = now();
    nf.style.position = "absolute"; nf.style.left = "0"; nf.style.top = "0"; nf.style.visibility = "hidden";
    s.pending = nf; s.rail.appendChild(nf);
    (function wait() {
      if (s.pending !== nf) { try { nf.remove(); } catch (e) { } return; }
      var done = nf.loaded && (adIframe(nf) || scriptFailed(nf));
      if (!done && now() - t0 < 9000) { G.setTimeout(wait, 400); return; }
      s.pending = null;
      var tw2 = (blocked || small || smallShown || D.hidden) ? null : styleTamper(s);                  // (the rails are hidden on purpose while the "window too small" message is up) if (tw2) { try { nf.remove(); } catch (e) { } showWall(tw2); return; }
      if (adIframe(nf)) {                                                          // new ad is ready: swap
        netFails = 0;
        nf.style.cssText = "border:0;margin:0;padding:0;display:block;width:" + RAIL_W + "px;height:" + s.h + "px;background:transparent";
        var old = s.frame; s.frame = nf; try { old.remove(); } catch (e) { }
      } else {                                                                     // keep the old ad, try again next time; repeated failures = blocker switched on mid-game
        try { nf.remove(); } catch (e) { }
        if ((scriptFailed(nf) || nf.loaded) && G.navigator.onLine !== false) { if (++netFails >= 2) showWall("refresh"); }          // (no verdict while the computer is simply offline)
      }
    })();
  }
  var acc = 0, last = now(), cycles = 0;
  function rotor() {
    var t = now(), dt = t - last; last = t; if (dt > 5000) dt = 0;                   // laptop was asleep
    if (!active || blocked || small || !slots.length || D.hidden || (D.hasFocus && !D.hasFocus())) return;
    acc += dt;
    if (acc < refreshMs) return;
    acc = 0; cycles++;
    slots.forEach(refreshSlot);
    if (cycles % 2 === 0 || now() - lastProbe > 60000) runProbe();
  }

  // ------------------------------------------------------------------ boot
  function init() {
    if (!active || domReady) return;
    domReady = true; initAt = lastBeat = visAt = now();
    ensureDom();
    runProbe();
    G.setInterval(function () { lastBeat = now(); tick(); }, 1500 + Math.floor(Math.random() * 400));
    G.setInterval(rotor, 1000);
    try {
      new G.MutationObserver(function () { if (tickQueued) return; tickQueued = true; G.setTimeout(function () { tickQueued = false; tick(); G.setTimeout(tick, 1100); }, 200); }).observe(D.documentElement, { childList: true, attributes: true, subtree: true, attributeFilter: ["style", "class", "hidden", "id"] });
    } catch (e) { }
    D.addEventListener("visibilitychange", function () { visAt = now(); if (!D.hidden) G.setTimeout(tick, 600); });
    if (G.fit) G.fit();
  }

  // asked by host.js before the game starts, on every frame and for every input event
  function ok() {
    var t = now();
    if (active && domReady && !blocked) {
      if (t - lastTickAt > 2500) tick();                                           // the game itself keeps the checks running even if somebody cleared every timer of the page
      if (t - lastOk > 5000) lastBeat = t;                                         // the game itself was idle (pause / laptop asleep): not the timers' fault
      // the checking timer must keep beating while the game runs; someone who clears every interval to freeze the checks gets the message
      if (!D.hidden && t - lastBeat > 9000 && t - visAt > 9000) showWall("beat");
    }
    lastOk = t;
    return !blocked && !small;
  }
  var api = {
    ok: ok,
    lay: lay,
    plc: plc,
    reg: function (fn) { if (!lockFn && typeof fn === "function") { lockFn = fn; if (blocked || smallShown) lockGame(true); } }
  };
  try { Object.defineProperty(G, "$sg", { value: Object.freeze(api), writable: false, configurable: false, enumerable: false }); } catch (e) { }

  if (active) { if (D.readyState === "loading") D.addEventListener("DOMContentLoaded", init); else init(); }
})(globalThis);
