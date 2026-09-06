// The pane's own address bar, and why Chrome's is not used.
//
// THE PANE DRAWS THE CHROME, ALWAYS. Chromium is launched with `--app=`, so its
// windows have no tab strip, no omnibox and no menu of their own: a browser pane
// is the page and nothing else, and every control around it belongs to TEDI.
//
// That is a deliberate trade, and the reasons are worth keeping.
//   1. ONE PANE LOOKS LIKE ONE PANE. The pane holds a real window in the tabs
//      view and a frame stream on the canvas, and a screencast captures the page
//      viewport only - it cannot capture Chrome's own toolbar. So as long as
//      Chrome drew its own chrome, the two surfaces could never match. Now
//      neither of them shows any.
//   2. IT DELETES THE OMNIBOX BUG. An adopted window is a `WS_CHILD`, and
//      Chromium asks the OS whether its widget is active with
//      `GetActiveWindow() == hwnd()` - a live query a child can never satisfy.
//      The omnibox therefore drew no caret and appended what you typed, and no
//      message can fix it. There is no omnibox now.
//   3. Chrome's own accelerators stop leaking into the pane. `--app` has no tab
//      strip for Ctrl+T to add to and no tab for Ctrl+W to close.
//
// WHAT IT COSTS, stated plainly: no extensions button, no profile menu, and no
// route to the Chrome Web Store from inside a pane. Unpacked extensions dropped
// in `~/.tedi/browser/extensions/` still load, and that is now the only way in.
//
// WHY IT IS A SIBLING OF THE STAGE, NOT AN OVERLAY ON IT. In the tabs view the
// pane holds a real OS window, and a native window composites ABOVE everything
// the app paints - a toolbar drawn over it would simply be invisible. Placing it
// beside the stage instead means the window never covers it, on either surface,
// with no z-order to fight.
//
// THE ICONS ARE THE APP'S OWN, COPIED AS PATHS. TEDI draws with lucide, and this
// toolbar has to look like it belongs to the same program, so the glyphs below
// are the exact `arrow-left`, `arrow-right` and `refresh-cw` node data from the
// `lucide-react` version the app is built against, with lucide's own default
// attributes. Inlined rather than fetched through `ctx.ui.icon()` for a reason
// that is documented in `tedi.d.ts`: that helper mounts a React root PER CALL
// and the host only unmounts them when the extension deactivates, so three
// icons per pane would leak three roots every time a pane is opened. It also
// answers with an EMPTY span until its lazy chunk lands, which is a blank
// toolbar on first paint.

import { ensureBrowser } from "./launch.js";

/** lucide's own SVG attributes, verbatim from `defaultAttributes.mjs`. */
const SVG_ATTRS = {
  xmlns: "http://www.w3.org/2000/svg",
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  "stroke-width": "2",
  "stroke-linecap": "round",
  "stroke-linejoin": "round",
};

/** Path data copied from `lucide-react@1.24.0`. Same icons the app uses for the
 *  same meanings: `RefreshCw` is TEDI's reload glyph everywhere else. */
const ICONS = {
  "arrow-left": ["m12 19-7-7 7-7", "M19 12H5"],
  "arrow-right": ["M5 12h14", "m12 5 7 7-7 7"],
  "refresh-cw": [
    "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8",
    "M21 3v5h-5",
    "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16",
    "M8 16H3v5",
  ],
};

/** Build one lucide glyph as a real SVG element. */
function icon(name, size = 14) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [k, v] of Object.entries(SVG_ATTRS)) svg.setAttribute(k, v);
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  for (const d of ICONS[name]) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  return svg;
}

/** Buttons the page can reach for, in the order a browser puts them. */
const BUTTONS = [
  ["back", "arrow-left", "Back"],
  ["forward", "arrow-right", "Forward"],
  ["reload", "refresh-cw", "Reload"],
];

/**
 * How long the reload glyph may keep spinning with no answer.
 *
 * `Page.frameStartedLoading` and `frameStoppedLoading` are counted rather than
 * paired by frame id, because a page with subframes emits several of each and
 * the ids are not worth tracking for a spinner. A count can drift if a frame is
 * torn down mid-load, so the spin has a deadline: a stuck spinner reads as a
 * hung app, and stopping early only ever understates a load that is still going.
 */
const SPIN_CEILING_MS = 20_000;

/**
 * Build the pane's toolbar.
 *
 * `getTab` is a function rather than a value because the pane can re-bind to a
 * different target under it (`followActiveTab`), and a toolbar holding the old
 * session would drive a page nobody is looking at.
 *
 * @param {() => ({ targetId: string, sessionId: string } | null)} getTab
 */
export function createToolbar(getTab) {
  const el = document.createElement("div");
  el.className = "tb-bar";

  /** @type {Array<() => void>} */
  const offs = [];
  let disposed = false;
  /** @type {HTMLButtonElement | null} */
  let reloadBtn = null;

  // --- the spinner -------------------------------------------------------
  let loading = 0;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let ceiling = null;

  function paintSpin() {
    reloadBtn?.classList.toggle("tb-spinning", loading > 0);
  }
  function spin(delta) {
    loading = Math.max(0, loading + delta);
    if (ceiling) clearTimeout(ceiling);
    ceiling = loading > 0 ? setTimeout(() => ((loading = 0), paintSpin()), SPIN_CEILING_MS) : null;
    paintSpin();
  }

  /**
   * Subscribe to the page's own load events.
   *
   * Called by the pane once it has a browser, rather than reaching for
   * `ensureBrowser()` here: the toolbar is built before the pane starts, and a
   * toolbar that launched Chromium on construction would start a browser for a
   * pane that may still fail to open.
   *
   * @param {import("./cdp.js").Cdp} cdp
   */
  function attach(cdp) {
    if (disposed) return;
    for (const off of offs.splice(0)) off();
    const mine = (sid) => sid === getTab()?.sessionId;
    offs.push(
      cdp.on("Page.frameStartedLoading", (_p, sid) => mine(sid) && spin(1)),
      cdp.on("Page.frameStoppedLoading", (_p, sid) => mine(sid) && spin(-1)),
    );
  }

  const call = async (method, params) => {
    const tab = getTab();
    if (!tab) return null;
    const cdp = await ensureBrowser();
    return cdp.send(method, params ?? {}, tab.sessionId).catch(() => null);
  };

  /** Step the page's own history. `Page.navigate` would push a NEW entry rather
   *  than move within it, which is what makes Back mean Back. */
  async function step(delta) {
    const h = await call("Page.getNavigationHistory");
    const entry = h?.entries?.[h.currentIndex + delta];
    if (!entry) return;
    // Spun optimistically: the load event is the truth, but it arrives a round
    // trip later and a button that does nothing for 200ms reads as broken.
    spin(1);
    await call("Page.navigateToHistoryEntry", { entryId: entry.id });
  }

  for (const [name, glyph, title] of BUTTONS) {
    const b = document.createElement("button");
    b.className = "tb-btn";
    b.title = title;
    b.setAttribute("aria-label", title);
    // Out of the tab order: the page is what a user tabs into, not the chrome.
    b.tabIndex = -1;
    b.appendChild(icon(glyph));
    if (name === "reload") {
      reloadBtn = b;
      b.onclick = () => {
        spin(1);
        void call("Page.reload");
      };
    } else {
      b.onclick = () => void step(name === "back" ? -1 : 1);
    }
    el.appendChild(b);
  }

  const url = document.createElement("input");
  url.className = "tb-url";
  url.spellcheck = false;
  url.placeholder = "Enter a URL";
  url.onkeydown = (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const raw = url.value.trim();
    if (!raw) return;
    // A bare host is what people type. Anything carrying a scheme is left alone,
    // so this can never rewrite an address the user was explicit about.
    spin(1);
    void call("Page.navigate", {
      url: /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`,
    });
    url.blur();
  };
  el.appendChild(url);

  return {
    el,
    attach,
    /** Show the page's current address. Driven by the pane's identity poll,
     *  which already reads `location.href` once a second, rather than a second
     *  subscription. Skipped while the field has focus, or it would overwrite an
     *  address the user is halfway through typing. */
    setUrl(next) {
      if (document.activeElement === url) return;
      const v = next ?? "";
      if (url.value !== v) url.value = v;
    },
    dispose() {
      disposed = true;
      if (ceiling) clearTimeout(ceiling);
      for (const off of offs.splice(0)) off();
      el.remove();
    },
  };
}
