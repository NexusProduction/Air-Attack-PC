// Air Attack - side-ad helper (itch.io build).
// Rules this file follows:
//   * Ads load ONE time. They never refresh (no 15 s / 30 s timer).
//   * No ad-blocker polling and no "turn off AdBlock" message.
//   * If an ad fails or is blocked, nothing happens: the game still starts and plays.
//   * No ad is shown before or during play as a pop-up. Only two small side banners next to the game.
// host.js talks to this object through window.$sg: ok(), reg(), lay(), plc().
(function (G) {
  "use strict";
  var RAIL = 160;                       // width of one banner column (px)
  var cfg = function () { return G.AA_CFG || {}; };
  var loaded = false, failed = false, box = null, cols = [], adH = 0;

  function urlOk(u) { return typeof u === "string" && /^https:\/\/[^\s"'<>]+\/[0-9a-f]{32}\/invoke\.js$/i.test(u); }
  function adsOn() { var c = cfg(); return c.ads !== false && !failed && (urlOk(c.left600) || urlOk(c.left300)); }

  // one banner = one small iframe, so the left and right banner never fight over the ad network's global settings
  function makeCol(url, h) {
    var key = (url.match(/\/([0-9a-f]{32})\/invoke\.js$/i) || [])[1];
    var f = document.createElement("iframe");
    f.setAttribute("scrolling", "no");
    f.setAttribute("title", "Advertisement");
    f.style.cssText = "border:0;width:" + RAIL + "px;height:" + h + "px;display:block;background:transparent;overflow:hidden";
    f.srcdoc = "<!doctype html><html><body style=\"margin:0;background:transparent;overflow:hidden\">" +
      "<script>atOptions={'key':'" + key + "','format':'iframe','height':" + h + ",'width':" + RAIL + ",'params':{}};<\/script>" +
      "<script src=\"" + url + "\"><\/script></body></html>";
    var d = document.createElement("div");
    d.style.cssText = "position:fixed;left:0;top:0;width:" + RAIL + "px;height:" + h + "px;overflow:hidden;z-index:5;display:none";
    d.appendChild(f);
    box.appendChild(d);
    return { d: d, f: f };
  }

  // runs one single time, the first time the page lays itself out with room for the banners
  function loadOnce(vh) {
    if (loaded) return;
    loaded = true;
    try {
      var c = cfg(), tall = vh >= 640 && urlOk(c.left600);
      var L = tall ? c.left600 : (urlOk(c.left300) ? c.left300 : c.left600);
      var R = tall ? (urlOk(c.right600) ? c.right600 : L) : (urlOk(c.right300) ? c.right300 : L);
      adH = (L === c.left300 || L === c.right300) && !tall ? 300 : 600;
      box = document.createElement("div");
      box.id = "aa-ads";
      document.body.appendChild(box);
      cols = [makeCol(L, adH), makeCol(R, adH)];
      // ONE check (not a loop): if nothing was drawn after a few seconds the ad was blocked / failed -> give the space back to the game
      setTimeout(function () {
        var empty = true;
        try {
          cols.forEach(function (x) {
            var dd = x.f.contentDocument, k = dd && dd.body ? dd.body.children : [];
            for (var i = 0; i < k.length; i++) if (k[i].tagName !== "SCRIPT") empty = false;   // the ad network drew something
          });
        } catch (e) { empty = false; }
        if (empty) { failed = true; if (box) box.style.display = "none"; try { if (G.fit) G.fit(); } catch (e) { } }
      }, 6000);
    } catch (e) { failed = true; }
  }

  var sg = {
    ok: function () { return true; },                 // the game is never blocked
    reg: function () { },                             // nothing will ever lock the game
    lay: function (vw, vh) {                          // how many px the page keeps free on each side
      try {
        if (!adsOn()) return { rail: 0 };
        if ((vw - 2 * RAIL) / vh < 1.3) return { rail: 0 };   // window too narrow: no banners, bigger game
        loadOnce(vh);
        return { rail: adsOn() ? RAIL : 0 };
      } catch (e) { return { rail: 0 }; }
    },
    plc: function (x, y, w, h, vw, vh) {              // put the banners next to the game
      try {
        if (!box) return;
        var show = adsOn() && (vw - 2 * RAIL) / vh >= 1.3;
        box.style.display = show ? "block" : "none";
        if (!show) return;
        var ch = Math.min(adH, vh), top = Math.max(0, Math.round((vh - ch) / 2));
        var xs = [Math.max(0, Math.round(x - RAIL)), Math.round(x + w)];      // left banner hugs the game's left edge, right banner its right edge
        for (var i = 0; i < 2; i++) {
          var st = cols[i].d.style;
          st.left = xs[i] + "px"; st.top = top + "px"; st.height = ch + "px"; st.display = "block";
        }
      } catch (e) { }
    }
  };
  G.$sg = sg;
})(globalThis);
