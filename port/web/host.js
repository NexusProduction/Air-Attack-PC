// Air Attack web port - browser host: asset loading, d.WebHost (the platform glue the translated game calls),
// input mapping (mouse -> MotionEvent, keyboard -> KeyEvent), the step-based frame loop and the HTML overlays
// (pause / help / highscores / settings) that replace the Android dialogs and activities.
(function (G) {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const RES = G.$RES;
  const S = (id) => RES.string[id];

  // ------------------------------------------------------------------ asset loading
  G.$assets = { images: {}, audio: {}, music: {} };

  function loadImage(name) {
    return new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => rej(new Error("image failed: " + name));
      img.src = "assets/drawable/" + name + ".png";
    });
  }

  async function loadAll(progress) {
    const names = Array.from(new Set(Object.values(RES.drawable)));
    const raws = Array.from(new Set(Object.values(RES.raw))).filter((n) => /\.ogg$/.test(n));
    const total = names.length + raws.length + 1;
    let done = 0;
    const tick = () => { done++; progress(done / total); };

    // font first (the game measures text with it)
    try {
      const ff = new FontFace("Joystix", "url(assets/joystix.otf)");
      await ff.load(); document.fonts.add(ff);
    } catch (e) { console.warn("font load failed", e); }
    tick();

    const ac = G.$audioCtx();
    const jobs = [];
    for (const n of names) {
      jobs.push(loadImage(n).then((img) => { G.$assets.images[n] = img; tick(); }));
    }
    for (const f of raws) {
      const key = f.replace(/\.ogg$/, "");
      if (key === "titlesong" || key === "gameover") { // MediaPlayer sounds in the original: streamed elements
        const a = new Audio("assets/raw/" + f); a.preload = "auto"; G.$assets.music[key] = a; tick(); continue;
      }
      jobs.push(fetch("assets/raw/" + f).then((r) => r.arrayBuffer()).then((buf) => {
        if (!ac) return;
        return new Promise((ok) => ac.decodeAudioData(buf, (b) => { G.$assets.audio[key] = b; ok(); }, () => ok()));
      }).catch((e) => console.warn("audio load failed", f, e)).then(tick));
    }
    await Promise.all(jobs);
  }

  // ------------------------------------------------------------------ local highscores (replaces the online/cloud lists)
  const HS_KEY = "aa:highscores";
  function hsLoad() { try { return JSON.parse(localStorage.getItem(HS_KEY) || "[]"); } catch (e) { return []; } }
  function hsSave(a) { try { localStorage.setItem(HS_KEY, JSON.stringify(a)); } catch (e) { } }
  function playerName() { try { return localStorage.getItem("aa:playerName") || "Player"; } catch (e) { return "Player"; } }

  // ------------------------------------------------------------------ overlays
  function overlay(html, cls) {
    const o = $("overlay");
    o.className = "show " + (cls || "");
    o.innerHTML = html;
    return o;
  }
  function closeOverlay() { const o = $("overlay"); o.className = ""; o.innerHTML = ""; }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  const state = { running: false, view: null, activity: null, sleepMs: 0, helpOpen: false, pauseOpen: false, modal: 0, timer: 0, paused: false, pausedFrames: 0 };

  // ------------------------------------------------------------------ ad guard (guard.js -> window.$sg)
  // The guard shows its full-screen message (ad blocker / window too small) and calls lock(): from then on the game neither steps nor
  // reacts to any input. guardOk() is asked before the game starts, on every frame and for every input event.
  let locked = false, allowStep = false, releaseAllFn = null;
  const guardOk = () => { const g = G.$sg; return !!g && !locked && g.ok(); };   // no guard object at all = fail closed
  function lock(on) {
    on = !!on; if (on === locked) return;
    locked = on;
    if (on) {
      if (state.timer) { clearTimeout(state.timer); state.timer = 0; }
      if (releaseAllFn) releaseAllFn();
      if (state.running && !document.hidden) {
        // pause the game properly (the pause screen opens inside a game step), so that it does not run on by itself when the message goes away
        allowStep = true;
        try { state.activity.onPause$(); state.view.onWindowFocusChanged$Z(false); const th = state.view.getThread$(); for (let i = 0; i < 4 && !state.pauseOpen; i++) th.step$(); } catch (e) { console.warn(e); }
        allowStep = false;
      }
    } else if (state.running) {
      if (!document.hidden) { try { state.view.onWindowFocusChanged$Z(true); state.activity.onResume$(); } catch (e) { console.warn(e); } }
      kick();
    }
  }
  try { if (G.$sg) G.$sg.reg(lock); } catch (e) { }

  // ------------------------------------------------------------------ d.WebHost (called from translated code)
  class d_WebHost extends java_lang_Object {
    static createScreenCanvas$I$I(w, h) {
      const cv = $("screen"); cv.width = w; cv.height = h;
      const ctx = cv.getContext("2d", { alpha: false });
      return android_graphics_Canvas.$forContext(ctx, w, h);
    }
    static logError$Throwable(th) { console.error("[game error]", th && th.toString$ ? th.toString$() : th, th && th.$jsStack || ""); }
    static requestSleep$J(ms) { state.sleepMs = Number(ms); }

    static showPause$Object$Z(buw, show) {
      // idempotent: Esc-pause followed by a tab switch (Activity.onPause) used to open the pause screen twice, so the
      // modal counter stayed at 1 after "Resume" and every click / key was ignored for the rest of the session
      if (show === state.pauseOpen) return;
      state.pauseOpen = show; state.modal += show ? 1 : -1;
      state.paused = show; state.pausedFrames = 0;
      if (!show) { closeOverlay(); kick(); return; }
      overlay(
        '<div class="panel"><h2>' + esc(S(2131492999)) + "</h2><p>" + esc(S(2131493000).replace(/^Resume using menu$/, "Press Esc or choose Continue")) + "</p>" +
        '<div class="row"><button id="b-resume">' + esc(S(2131492884)) + '</button><button id="b-main">' + esc(S(2131492886)) + "</button></div></div>");
      $("b-resume").onclick = () => buw.n$();
      $("b-main").onclick = () => { saveCurrentScore(); buw.f$(); };
    }

    static showHelp$Object(bym) {
      const pages = [
        [2131492962, 2131492957, "move"], [2131492961, 2131492956, "jump"], [2131492959, 2131492954, "fire"],
        [2131492958, 2131492953, "dig"], [2131492960, 2131492955, "hints"],
      ];
      const pc = {
        move: "PC: hold the LEFT mouse button left or right of the soldier, or use the A / D (or arrow) keys.",
        jump: "PC: press SPACE (or W / Up arrow), or drag (swipe) the mouse quickly in the direction you want to jump. Hold A / D while pressing Space to jump sideways.",
        fire: "PC: click anywhere to launch a rocket towards the mouse pointer (a quick click - holding the button longer makes the soldier walk). Z also fires.",
        dig: "PC: press and hold the mouse ON THE SOLDIER, then drag through the terrain.",
        hints: "",
      };
      let p = 0;
      state.helpOpen = true;
      const render = () => {
        const [t, x, k] = pages[p];
        overlay('<div class="panel wide"><h2>' + esc(S(t)) + "</h2><p>" + esc(S(x)).replace(/\n/g, "<br>") + '</p><p class="pc">' + esc(pc[k]) + "</p>" +
          '<div class="row"><button id="h-prev"' + (p === 0 ? " disabled" : "") + '>' + esc(S(2131492892)) + '</button><span class="pg">' + (p + 1) + " / " + pages.length +
          '</span><button id="h-next"' + (p === pages.length - 1 ? " disabled" : "") + '>' + esc(S(2131492890)) + '</button><button id="h-ok">' + esc(S(2131492891)) + "</button></div></div>");
        $("h-prev").onclick = () => { if (p > 0) { p--; render(); } };
        $("h-next").onclick = () => { if (p < pages.length - 1) { p++; render(); } };
        $("h-ok").onclick = () => { state.helpOpen = false; closeOverlay(); state.modal--; bym.h$(); };
      };
      state.modal++;
      render();
    }

    static showHighscores$I$String(id, title) {
      const list = hsLoad().slice(0, 20);
      const rows = list.map((e, i) => "<tr><td>" + (i + 1) + "</td><td>" + esc(e.name) + "</td><td>" + e.score + "</td><td>" + e.waves + "</td><td>" + esc(e.diff) + "</td></tr>").join("");
      state.modal++;
      overlay('<div class="panel wide"><h2>' + esc(S(2131492964).replace(/ -$/, "")) + "</h2>" +
        '<table><tr><th>#</th><th>Name</th><th>Score</th><th>Waves</th><th>Mode</th></tr>' + (rows || '<tr><td colspan="5">No scores yet</td></tr>') + "</table>" +
        '<div class="row"><label>Name <input id="hs-name" maxlength="16" value="' + esc(playerName()) + '"></label><button id="hs-ok">' + esc(S(2131492891)) + "</button></div></div>");
      $("hs-ok").onclick = () => {
        try { localStorage.setItem("aa:playerName", $("hs-name").value || "Player"); } catch (e) { }
        closeOverlay(); state.modal--;
        // the Android highscore screen was a separate activity: returning from it ran Activity.onResume, which re-enables
        // the menu buttons (GameUiController.h). Do the same here, otherwise the menu comes back without its buttons.
        try { state.view.getMasterViewSwitcher$().h$(); } catch (e) { console.warn("resume failed", e); }
      };
    }

    static submitScoreQuiet(score, waves, difficulty) {
      const names = ["Easy", "Hard", "Bottomless", "Classic"];
      const a = hsLoad();
      const entry = { name: playerName(), score: score | 0, waves: waves | 0, diff: names[difficulty] || String(difficulty), t: Date.now() };
      a.push(entry);
      a.sort((x, y) => y.score - x.score);
      hsSave(a.slice(0, 50));
      return { a, entry };
    }

    static submitScore$I$I$I(score, waves, difficulty) {
      const { a, entry } = d_WebHost.submitScoreQuiet(score, waves, difficulty);
      // end-of-game screen (the original opened its highscore activity here); OK returns to the main menu
      const rank = a.indexOf(entry) + 1;
      state.modal++;
      overlay('<div class="panel"><h2>' + esc(S(2131493033)) + "</h2>" +
        "<p>" + esc(S(2131493054)) + " <b>" + entry.score + "</b><br>Waves: " + entry.waves + (rank > 0 && rank <= 50 ? "<br>Local rank: #" + rank : "") + "</p>" +
        '<label>Name <input id="go-name" maxlength="16" value="' + esc(entry.name) + '"></label>' +
        '<div class="row"><button id="go-ok">' + esc(S(2131492891)) + "</button></div></div>");
      $("go-ok").onclick = () => {
        const nm = ($("go-name").value || "Player").slice(0, 16);
        entry.name = nm; hsSave(a.slice(0, 50));
        try { localStorage.setItem("aa:playerName", nm); } catch (e) { }
        closeOverlay(); state.modal--;
        state.view.getThread$().l$(); // GameUiController.l(): go to the main menu
      };
    }

    static showSettings$() {
      const prefs = ccj_b();
      const soundId = dk_logisoft_airattackfull_R$string.S$prefKeySound, partId = dk_logisoft_airattackfull_R$string.S$prefKeyParticles;
      const vals = RES.stringArray[2130837510], labels = RES.stringArray[2130837511];
      const curSound = prefs.d$I(soundId), curPart = prefs.b$I(partId);
      state.modal++;
      overlay('<div class="panel"><h2>' + esc(S(2131492995)) + '</h2>' +
        '<label class="chk"><input type="checkbox" id="s-sound"' + (curSound ? " checked" : "") + "> " + esc(S(2131492996)) + "</label>" +
        '<label>Particles <select id="s-part">' + vals.map((v, i) => '<option value="' + esc(v) + '"' + (v === curPart ? " selected" : "") + ">" + esc(labels[i]) + "</option>").join("") + "</select></label>" +
        '<div class="row"><button id="s-ok">' + esc(S(2131492891)) + "</button></div></div>");
      $("s-ok").onclick = () => {
        prefs.b$I$Z(soundId, $("s-sound").checked);
        prefs.a$String$String(RES.string[2131493009], $("s-part").value);
        state.activity.r$();
        closeOverlay(); state.modal--;
      };
    }
  }
  G.$defClass(d_WebHost, "d.WebHost");
  const ccj_b = () => d_ccj.b$();

  // ------------------------------------------------------------------ input
  // android.view.MotionEvent actions: 0 down, 1 up, 2 move.  KeyEvent actions: 0 down, 1 up.
  const KEYMAP = {
    ArrowLeft: 21, KeyA: 21, ArrowRight: 22, KeyD: 22, ArrowDown: 20, KeyS: 20,
    KeyZ: 96, KeyX: 96, ControlLeft: 96, Enter: 23, NumpadEnter: 23, Escape: 4, Backspace: 4,
  };
  let mouseDown = false;
  const JUMPKEYS = { Space: 1, KeyW: 1, ArrowUp: 1 };
  const dirHeld = { left: false, right: false };
  // keyboard jump = the same call the swipe gesture makes (GameStateController.a(float,float)); direction keys give a diagonal jump
  function doJump() {
    const thread = state.view.getThread$();
    if (!thread.n$()) return; // only while a game is running
    const dx = (dirHeld.left ? -1 : 0) + (dirHeld.right ? 1 : 0);
    thread.a.a$F$F(dx * 0.6, -1.0);
  }

  function canvasPos(ev) {
    const cv = $("screen"), r = cv.getBoundingClientRect();
    return [(ev.clientX - r.left) * cv.width / r.width, (ev.clientY - r.top) * cv.height / r.height];
  }
  let downSent = false, lastPos = [0, 0], touchId = null;
  function deliver(action, x, y) {
    lastPos = [x, y];
    state.view.onTouchEvent$MotionEvent(android_view_MotionEvent.$obtain(action, x, y, performance.now()));
  }
  function sendMotion(action, ev) {
    if (!state.running || state.modal > 0 || !guardOk()) return false;
    const [x, y] = canvasPos(ev);
    deliver(action, x, y);
    return true;
  }
  // a touch/click that was delivered as "down" must always be finished with an "up" (even if an overlay opened meanwhile)
  function finishTouch(ev) {
    if (!downSent) return;
    downSent = false;
    if (!state.running) return;
    const [x, y] = ev ? canvasPos(ev) : lastPos;
    deliver(1, x, y);
  }
  const isTyping = (t) => !!t && (t.tagName === "TEXTAREA" || t.tagName === "SELECT" || (t.tagName === "INPUT" && t.type !== "checkbox" && t.type !== "button"));
  const findTouch = (e) => { for (const t of e.changedTouches) if (t.identifier === touchId) return t; return null; };

  function installInput() {
    const cv = $("screen");
    cv.addEventListener("mousedown", (e) => { if (e.button !== 0) return; mouseDown = true; downSent = sendMotion(0, e); e.preventDefault(); });
    window.addEventListener("mousemove", (e) => { if (mouseDown && downSent) sendMotion(2, e); });
    window.addEventListener("mouseup", (e) => { if (mouseDown && e.button === 0) { mouseDown = false; finishTouch(e); } });
    cv.addEventListener("contextmenu", (e) => e.preventDefault());
    // touch screens work too: same events, first finger only (a second finger lifting must not end the first one's touch)
    cv.addEventListener("touchstart", (e) => {
      if (touchId === null) { const t = e.changedTouches[0]; touchId = t.identifier; downSent = sendMotion(0, t); }
      e.preventDefault();
    }, { passive: false });
    cv.addEventListener("touchmove", (e) => { const t = findTouch(e); if (t && downSent) sendMotion(2, t); e.preventDefault(); }, { passive: false });
    const touchEnd = (e) => { const t = findTouch(e); if (t) { touchId = null; finishTouch(t); } e.preventDefault(); };
    cv.addEventListener("touchend", touchEnd, { passive: false });
    cv.addEventListener("touchcancel", touchEnd, { passive: false });

    const held = new Set();
    const ev = (a, c) => android_view_KeyEvent.$obtain(a, c, 0);
    const clickFirst = (...ids) => { for (const id of ids) { const b = $(id); if (b) { b.click(); return true; } } return false; };
    window.addEventListener("keydown", (e) => {
      if (!state.running || !guardOk()) return;
      // Esc: pause screen -> resume, any other overlay (help / highscores / settings / game over) -> its OK button
      if (e.code === "Escape" && state.modal > 0) {
        e.preventDefault(); if (e.repeat) return;
        if (state.pauseOpen) state.activity.onBackPressed$(); else clickFirst("h-ok", "hs-ok", "s-ok", "go-ok");
        return;
      }
      // typing in the name field / settings: the game must not see (or swallow) the keys; Enter confirms
      if (isTyping(e.target)) {
        if ((e.code === "Enter" || e.code === "NumpadEnter") && e.target.tagName === "INPUT") { e.preventDefault(); clickFirst("go-ok", "hs-ok"); }
        return;
      }
      if (e.metaKey || e.altKey) return; // browser shortcuts (Alt+Left = back, Cmd+D ...)
      // Space / Enter on a focused overlay button must activate it
      if (state.modal > 0 && e.target && e.target.tagName === "BUTTON" && (e.code === "Space" || e.code === "Enter" || e.code === "NumpadEnter")) return;
      if (e.code === "KeyF" && !e.repeat) { const el = $("fps"); if (el) el.style.display = el.style.display === "none" ? "block" : "none"; return; }
      if (JUMPKEYS[e.code]) { e.preventDefault(); if (!e.repeat && state.modal === 0) doJump(); return; }
      const code = KEYMAP[e.code]; if (code === undefined) return;
      e.preventDefault();
      if (e.repeat) return;
      if (code === 4) { // Escape / Backspace == Android BACK: the view gets it first, if it declines the activity handles it (pause)
        if (state.modal > 0) return;
        if (state.view.onKeyDown$I$KeyEvent(4, ev(0, 4))) held.add(e.code); else state.activity.onBackPressed$();
        return;
      }
      if (state.modal > 0) return;
      if (code === 21) dirHeld.left = true; else if (code === 22) dirHeld.right = true;
      held.add(e.code);
      state.view.onKeyDown$I$KeyEvent(code, ev(0, code));
    });
    window.addEventListener("keyup", (e) => {
      if (!state.running || !guardOk()) return;
      const code = KEYMAP[e.code]; if (code === undefined) return;
      if (isTyping(e.target) && !held.has(e.code)) return;
      e.preventDefault();
      if (code === 21) dirHeld.left = false; else if (code === 22) dirHeld.right = false;
      if (!held.has(e.code)) return;
      held.delete(e.code);
      state.view.onKeyUp$I$KeyEvent(code, ev(1, code));
    });
    // focus lost (alt-tab, click into another window): release everything, otherwise a key / button released elsewhere
    // never reaches us and the soldier keeps walking on its own
    const releaseAll = () => {
      if (!state.running) return;
      dirHeld.left = dirHeld.right = false;
      for (const c of Array.from(held)) { held.delete(c); try { state.view.onKeyUp$I$KeyEvent(KEYMAP[c], ev(1, KEYMAP[c])); } catch (e) { console.warn(e); } }
      if (mouseDown) { mouseDown = false; finishTouch(null); }
      if (touchId !== null) { touchId = null; finishTouch(null); }
    };
    releaseAllFn = releaseAll;
    window.addEventListener("blur", releaseAll);
    // Activity lifecycle: tab hidden == onPause (the game pauses), visible again == onResume
    document.addEventListener("visibilitychange", () => {
      if (!state.running) return;
      if (document.hidden) { releaseAll(); state.activity.onPause$(); state.view.onWindowFocusChanged$Z(false); }
      else {
        const ac = G.$audioCtx(); if (ac && ac.state !== "running") { try { ac.resume(); } catch (e) { } } // iOS/Safari suspend audio in the background
        if (locked) return; // the guard message is up: lock(false) resumes the game when it goes away
        state.view.onWindowFocusChanged$Z(true); state.activity.onResume$();
      }
    });
  }

  // ------------------------------------------------------------------ frame loop
  function frame() {
    state.timer = 0;
    if (!guardOk()) return; // frozen by the ad guard (kick() restarts the loop when the guard lets go)
    state.sleepMs = 0;
    try {
      state.view.getThread$().step$();
      state.errors = 0; // only a run of failing frames is fatal, not a few rare errors spread over a long session
    } catch (e) {
      console.error("step failed:", e && e.stack || (e && e.toString$ ? e.toString$() : e), e && e.$jsStack || "");
      state.errors = (state.errors || 0) + 1;
      if (state.errors > 20) { state.running = false; $("fatal").textContent = "Fatal error - see console: " + (e && e.message || e); $("fatal").style.display = "block"; return; }
    }
    state.frames = (state.frames || 0) + 1;
    fpsCount++;
    // paused: the original game thread wait()s. Draw the paused frame a few times, then stop stepping completely.
    if (state.paused && ++state.pausedFrames > 3) { state.timer = 0; return; }
    state.timer = setTimeout(frame, Math.max(0, state.sleepMs - 1));
  }
  let fpsCount = 0, fpsLast = performance.now();
  setInterval(() => {
    const el = $("fps"), now = performance.now();
    if (el && el.style.display !== "none") el.textContent = Math.round(fpsCount * 1000 / (now - fpsLast)) + " fps (game target 25)";
    fpsCount = 0; fpsLast = now;
  }, 1000);
  function kick() { if (state.running && !state.timer) frame(); }

  // "Exit to main" from the pause screen: keep the score reached so far in the local highscore list
  function saveCurrentScore() {
    try {
      const g = state.view.getThread$().a.a;
      const score = g.j$(), waves = g.k$().a$() - 1;
      if (score > 0) d_WebHost.submitScoreQuiet(score, waves, g.q$().ordinal$());
    } catch (e) { console.warn("score save failed", e); }
  }

  // the game's own step function asks the guard as well, so stepping the game from the console / a second loop does not get around it
  let stepGated = false;
  function gateStep(thread) {
    if (stepGated) return;
    stepGated = true;
    const P = Object.getPrototypeOf(thread), orig = P.step$;
    Object.defineProperty(P, "step$", { value: function () { if (!allowStep && !guardOk()) return; return orig.call(this); }, writable: false, configurable: false });
  }

  // ------------------------------------------------------------------ boot
  let starting = false;
  async function start() {
    if (starting) return; // click + Enter at the same time used to boot the game twice
    if (!guardOk()) return; // ad blocker message / window-too-small message is showing
    starting = true;
    // the game lays itself out for the screen size it sees at start: 720 high and as wide as the window needs (page: window.$gw)
    const gw = Math.max(960, Math.min(2000, Math.round(G.$gw) || 1280));
    G.$DEVICE.w = gw; G.$DEVICE.h = 720;
    try { if (G.fitLock) G.fitLock(); } catch (e) { }
    try { const k = "aa:dk.logisoft.airattack_preferences", o = JSON.parse(localStorage.getItem(k) || "null"); if (o && (o.DisplayWidth || o.DisplayHeight)) { delete o.DisplayWidth; delete o.DisplayHeight; localStorage.setItem(k, JSON.stringify(o)); } } catch (e) { }
    $("start").disabled = true;
    const ac = G.$audioCtx(); if (ac && ac.state !== "running") { try { await ac.resume(); } catch (e) { } }
    try {
      const act = new dk_logisoft_airattack_AirAttackActivity().$init$();
      state.activity = act;
      state.view = act.boot$();
      gateStep(state.view.getThread$());
      state.view.getThread$().c$();            // surfaceCreated
      state.view.onWindowFocusChanged$Z(true); // window focus gained
      $("title").style.display = "none";
      state.running = true;
      installInput();
      G.$game = state;
      frame();
    } catch (e) {
      console.error("start failed", e);
      $("title").style.display = "none";
      $("fatal").textContent = "Could not start the game - see console: " + (e && e.message || e); $("fatal").style.display = "block";
    }
  }

  async function main() {
    const bar = $("bar");
    try {
      await loadAll((f) => { bar.style.width = Math.round(f * 100) + "%"; });
    } catch (e) { $("status").textContent = "Loading failed: " + e.message; console.error(e); return; }
    $("status").textContent = "";
    $("loading").style.display = "none";
    $("start").classList.add("ready");
    $("start").onclick = start;
    // Enter / Space also starts (the first user gesture is needed by the browser to allow sound)
    const startKey = (e) => { if ((e.code === "Enter" || e.code === "NumpadEnter" || e.code === "Space") && !state.running) { e.preventDefault(); if (!guardOk()) return; removeEventListener("keydown", startKey); start(); } };
    G.addEventListener("keydown", startKey);
    if (location.hash === "#autostart") start();
  }
  // the page injects this script after the DOM is parsed, so DOMContentLoaded may already have fired
  let booted = false;
  const boot = () => { if (booted) return; booted = true; if (/(^|\s)phone(\s|$)/.test(document.documentElement.className)) return; main(); };
  if (document.readyState === "loading") G.addEventListener("DOMContentLoaded", boot); else boot();
  G.$host = { state, start };   // (lock() is deliberately NOT reachable from here: the guard got it through $sg.reg)
})(globalThis);
