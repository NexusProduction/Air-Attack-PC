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
  function sendMotion(action, ev) {
    if (!state.running || state.modal > 0) return;
    const [x, y] = canvasPos(ev);
    state.view.onTouchEvent$MotionEvent(android_view_MotionEvent.$obtain(action, x, y, performance.now()));
  }
  function installInput() {
    const cv = $("screen");
    cv.addEventListener("mousedown", (e) => { if (e.button !== 0) return; mouseDown = true; sendMotion(0, e); e.preventDefault(); });
    window.addEventListener("mousemove", (e) => { if (mouseDown) sendMotion(2, e); });
    window.addEventListener("mouseup", (e) => { if (mouseDown && e.button === 0) { mouseDown = false; sendMotion(1, e); } });
    cv.addEventListener("contextmenu", (e) => e.preventDefault());
    // touch screens work too: same events, first finger only
    cv.addEventListener("touchstart", (e) => { sendMotion(0, e.changedTouches[0]); e.preventDefault(); }, { passive: false });
    cv.addEventListener("touchmove", (e) => { sendMotion(2, e.changedTouches[0]); e.preventDefault(); }, { passive: false });
    cv.addEventListener("touchend", (e) => { sendMotion(1, e.changedTouches[0]); e.preventDefault(); }, { passive: false });

    const held = new Set();
    const ev = (a, c) => android_view_KeyEvent.$obtain(a, c, 0);
    window.addEventListener("keydown", (e) => {
      if (e.code === "KeyF" && state.running && !e.repeat) { const el = $("fps"); if (el) el.style.display = el.style.display === "none" ? "block" : "none"; return; }
      if (JUMPKEYS[e.code] && state.running) { e.preventDefault(); if (!e.repeat && state.modal === 0) doJump(); return; }
      const code = KEYMAP[e.code]; if (code === undefined || !state.running) return;
      e.preventDefault();
      if (e.repeat) return;
      if (code === 4) { // Escape == Android BACK: the view gets it first, if it declines the activity handles it (pause)
        if (state.modal > 0) { if (state.pauseOpen) state.activity.onBackPressed$(); return; }
        if (state.view.onKeyDown$I$KeyEvent(4, ev(0, 4))) held.add(e.code); else state.activity.onBackPressed$();
        return;
      }
      if (state.modal > 0) return;
      if (code === 21) dirHeld.left = true; else if (code === 22) dirHeld.right = true;
      held.add(e.code);
      state.view.onKeyDown$I$KeyEvent(code, ev(0, code));
    });
    window.addEventListener("keyup", (e) => {
      const code = KEYMAP[e.code]; if (code === undefined || !state.running) return;
      e.preventDefault();
      if (code === 21) dirHeld.left = false; else if (code === 22) dirHeld.right = false;
      if (!held.has(e.code)) return;
      held.delete(e.code);
      state.view.onKeyUp$I$KeyEvent(code, ev(1, code));
    });
    // Activity lifecycle: tab hidden == onPause (the game pauses), visible again == onResume
    document.addEventListener("visibilitychange", () => {
      if (!state.running) return;
      if (document.hidden) { state.activity.onPause$(); state.view.onWindowFocusChanged$Z(false); }
      else { state.view.onWindowFocusChanged$Z(true); state.activity.onResume$(); }
    });
  }

  // ------------------------------------------------------------------ frame loop
  function frame() {
    state.timer = 0;
    state.sleepMs = 0;
    try {
      state.view.getThread$().step$();
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

  // ------------------------------------------------------------------ boot
  async function start() {
    $("start").disabled = true;
    const ac = G.$audioCtx(); if (ac && ac.state !== "running") { try { await ac.resume(); } catch (e) { } }
    $("title").style.display = "none";
    const act = new dk_logisoft_airattack_AirAttackActivity().$init$();
    state.activity = act;
    state.view = act.boot$();
    state.view.getThread$().c$();            // surfaceCreated
    state.view.onWindowFocusChanged$Z(true); // window focus gained
    state.running = true;
    installInput();
    G.$game = state;
    frame();
  }

  async function main() {
    const bar = $("bar");
    try {
      await loadAll((f) => { bar.style.width = Math.round(f * 100) + "%"; });
    } catch (e) { $("status").textContent = "Loading failed: " + e.message; console.error(e); return; }
    $("status").textContent = "";
    $("loading").style.display = "none";
    $("start").style.display = "inline-block";
    $("start").onclick = start;
    if (location.hash === "#autostart") start();
  }
  G.addEventListener("DOMContentLoaded", main);
  G.$host = { state, start };
})(globalThis);
