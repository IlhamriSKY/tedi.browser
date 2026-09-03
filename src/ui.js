// The browser pane: a tab strip, an address bar, and the page.
//
// The host hands the renderer a bare `<div>` and takes back a cleanup function.
// Everything below is plain DOM on purpose - the pane has one canvas and a dozen
// controls, and pulling a framework across the extension boundary to manage that
// would be more machinery than the thing it manages.
//
// COLOURS COME FROM THE HOST'S TOKENS, never from literals, so the pane follows
// whatever theme the user picked without this extension knowing which one. Only
// the neutral surface tokens are read; the button-border token is deliberately
// avoided because it carries the user's SAVED theme rather than the active one.
//
// THE PANE IS A VIEWER, NOT THE OWNER. Tabs live in `tabs.js` and are shared
// with the agent, so a second pane, or a tool call, shows the same tabs. What is
// per-pane is only the screencast: two panes on one tab are two streams, and a
// hidden pane has none.

import { ctx, state, emitTabsChanged } from "./runtime.js";
import { ensureBrowser, armIdleShutdown, openExtensionManager } from "./launch.js";
import { syncTabs, newTab, closeTab, setActive } from "./tabs.js";
import { attachScreencast } from "./screencast.js";
import { invalidate } from "./snapshot.js";

const css = String.raw`
.tb-root { display:flex; flex-direction:column; height:100%; min-height:0; background:var(--background); color:var(--foreground); font-size:12px; }
.tb-strip { display:flex; align-items:stretch; gap:2px; padding:4px 4px 0; overflow-x:auto; scrollbar-width:none; }
.tb-strip::-webkit-scrollbar { display:none; }
.tb-tab { display:flex; align-items:center; gap:6px; max-width:200px; padding:4px 8px; border-radius:6px 6px 0 0; background:var(--muted); color:var(--muted-foreground); cursor:default; white-space:nowrap; }
.tb-tab[data-active="true"] { background:var(--card); color:var(--foreground); }
.tb-tab span { overflow:hidden; text-overflow:ellipsis; }
.tb-x, .tb-btn { display:inline-flex; align-items:center; justify-content:center; border:0; background:transparent; color:inherit; cursor:pointer; border-radius:4px; padding:3px; }
.tb-x:hover, .tb-btn:hover:not(:disabled) { background:var(--accent); color:var(--accent-foreground); }
.tb-btn:disabled { opacity:.4; cursor:default; }
.tb-bar { display:flex; align-items:center; gap:4px; padding:4px 6px; border-bottom:1px solid var(--border); background:var(--card); }
.tb-url { flex:1; min-width:0; height:26px; padding:0 10px; border-radius:13px; border:1px solid var(--border); background:var(--background); color:var(--foreground); outline:none; font:inherit; }
.tb-url:focus { border-color:var(--ring); }
.tb-stage { position:relative; flex:1; min-height:0; background:var(--background); }
.tb-canvas { display:block; width:100%; height:100%; outline:none; }
.tb-note { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; text-align:center; padding:24px; color:var(--muted-foreground); background:var(--background); }
`;

/** One `<style>` for every pane. Injected once and left in place: it is under a
 *  kilobyte, and re-adding it per mount would be a leak the host cannot see. */
function ensureStyles() {
  if (document.getElementById("tedi-browser-style")) return;
  const el = document.createElement("style");
  el.id = "tedi-browser-style";
  el.textContent = css;
  document.head.appendChild(el);
}

/**
 * One React root per icon, cloned thereafter.
 *
 * `ctx.ui.icon()` mounts a React root on every call and the host only unmounts
 * them on deactivate. The tab strip is rebuilt on every title and url change -
 * which a single-page app emits on every route - so calling it per tab per
 * repaint would leak a root per icon per keystroke-worth of navigation. The
 * host's own docs say to cache one and `cloneNode(true)` it; this is that cache.
 *
 * @param {string} name
 * @param {number} size
 * @returns {HTMLElement}
 */
const iconCache = new Map();
function icon(name, size) {
  const key = `${name}@${size}`;
  let master = iconCache.get(key);
  if (!master) {
    master = ctx.ui.icon(name, { size });
    iconCache.set(key, master);
  }
  return /** @type {HTMLElement} */ (master.cloneNode(true));
}

function button(name, title, onClick) {
  const b = document.createElement("button");
  b.className = "tb-btn";
  b.title = title;
  b.type = "button";
  b.appendChild(icon(name, 14));
  b.addEventListener("click", onClick);
  return b;
}

/**
 * Paint one browser pane into `container`.
 *
 * @param {HTMLElement} container
 * @returns {() => void} cleanup
 */
export function renderPane(container) {
  ensureStyles();
  state.panes += 1;
  void armIdleShutdown();

  const root = document.createElement("div");
  root.className = "tb-root";

  const strip = document.createElement("div");
  strip.className = "tb-strip";

  const bar = document.createElement("div");
  bar.className = "tb-bar";
  const back = button("ArrowLeft", "Back", () => history(-1));
  const fwd = button("ArrowRight", "Forward", () => history(1));
  const reload = button("RotateCw", "Reload", () => void doReload());
  const url = document.createElement("input");
  url.className = "tb-url";
  url.spellcheck = false;
  url.placeholder = "Search or enter address";
  const exts = button("Puzzle", "Manage Chrome extensions", () => void openExtensions());
  bar.append(back, fwd, reload, url, exts);

  const stage = document.createElement("div");
  stage.className = "tb-stage";
  const canvas = document.createElement("canvas");
  canvas.className = "tb-canvas";
  canvas.tabIndex = 0; // Keyboard events only reach a focusable element.
  const note = document.createElement("div");
  note.className = "tb-note";
  note.textContent = "Starting the browser...";
  stage.append(canvas, note);

  root.append(strip, bar, stage);
  container.appendChild(root);

  /** @type {ReturnType<typeof attachScreencast> | null} */
  let cast = null;
  let castTargetId = null;
  let disposed = false;

  const setNote = (text) => {
    note.textContent = text ?? "";
    note.style.display = text ? "flex" : "none";
  };

  function renderStrip() {
    strip.textContent = "";
    for (const tab of state.tabs.values()) {
      const el = document.createElement("div");
      el.className = "tb-tab";
      el.dataset.active = String(tab.targetId === state.activeTargetId);
      const label = document.createElement("span");
      label.textContent = tab.title || tab.url || "New tab";
      label.title = tab.url;
      label.addEventListener("click", () => {
        setActive(tab.targetId);
        void bindActive();
      });
      const x = document.createElement("button");
      x.className = "tb-x";
      x.type = "button";
      x.title = "Close tab";
      x.appendChild(icon("X", 11));
      x.addEventListener("click", (e) => {
        e.stopPropagation();
        void closeTab(tab.targetId).then(bindActive);
      });
      el.append(label, x);
      strip.appendChild(el);
    }
    const add = document.createElement("button");
    add.className = "tb-btn";
    add.type = "button";
    add.title = "New tab";
    add.appendChild(icon("Plus", 14));
    add.addEventListener("click", () => void newTab("about:blank").then(bindActive));
    strip.appendChild(add);

    const active = state.tabs.get(state.activeTargetId ?? "");
    if (active && document.activeElement !== url) url.value = active.url ?? "";
  }

  /** Point the screencast at whatever tab is active now. Restarted rather than
   *  retargeted: a stream is bound to one session, and swapping the session
   *  under it would keep painting the old page. */
  async function bindActive() {
    if (disposed) return;
    const active = state.tabs.get(state.activeTargetId ?? "");
    if (!active) {
      cast?.stop();
      cast = null;
      castTargetId = null;
      renderStrip();
      setNote("No tab open.");
      return;
    }
    if (castTargetId === active.targetId && cast) {
      renderStrip();
      return;
    }
    cast?.stop();
    const cdp = await ensureBrowser();
    let quality = 70;
    try {
      const q = await ctx.settings.get("quality");
      if (typeof q === "number") quality = q;
    } catch {
      // Unreadable settings must not stop the pane from painting.
    }
    if (disposed) return;
    cast = attachScreencast(cdp, active, canvas, { quality });
    castTargetId = active.targetId;
    renderStrip();
    setNote(null);
  }

  async function go(input) {
    const raw = input.trim();
    if (!raw) return;
    // A bare word is a search, anything with a dot or scheme is an address. The
    // same rule every browser uses, and the reason typing "localhost:5173" does
    // the right thing.
    const target = /^[a-z]+:\/\//i.test(raw)
      ? raw
      : /^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/|$)/i.test(raw) || /^[^\s/]+\.[^\s/]{2,}/.test(raw)
        ? `https://${raw}`
        : `https://duckduckgo.com/?q=${encodeURIComponent(raw)}`;
    const cdp = await ensureBrowser();
    const active = state.tabs.get(state.activeTargetId ?? "");
    if (!active) return;
    await cdp.send("Page.navigate", { url: target }, active.sessionId);
    active.url = target;
    invalidate(active.targetId);
    emitTabsChanged();
  }

  async function history(delta) {
    const active = state.tabs.get(state.activeTargetId ?? "");
    if (!active) return;
    const cdp = await ensureBrowser();
    const h = await cdp.send("Page.getNavigationHistory", {}, active.sessionId);
    const entry = h.entries[h.currentIndex + delta];
    if (!entry) return;
    await cdp.send("Page.navigateToHistoryEntry", { entryId: entry.id }, active.sessionId);
    invalidate(active.targetId);
  }

  async function doReload() {
    const active = state.tabs.get(state.activeTargetId ?? "");
    if (!active) return;
    const cdp = await ensureBrowser();
    await cdp.send("Page.reload", {}, active.sessionId);
    invalidate(active.targetId);
  }

  async function openExtensions() {
    cast?.stop();
    cast = null;
    castTargetId = null;
    setNote("Chromium opened in its own window so you can use the Chrome Web Store. Close it, then reopen this pane.");
    await openExtensionManager();
  }

  url.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void go(url.value);
    if (e.key === "Escape") canvas.focus();
  });

  // The pane's box drives the emulated viewport, so a drag on the splitter has
  // to reach the browser or the page keeps rendering at the old width.
  const ro = new ResizeObserver(() => cast?.resize());
  ro.observe(canvas);

  // A pane scrolled out of view, or in a hidden workspace tab, still has a live
  // stream unless something stops it. This is the whole idle saving.
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) (e.isIntersecting ? cast?.resume : cast?.pause)?.();
    },
    { threshold: 0.01 },
  );
  io.observe(canvas);

  // Coalesced to one paint per frame. A single navigation emits
  // `Target.targetInfoChanged` for the url and again for the title, and a
  // multi-tab page load emits one per tab - each of which was a full strip
  // rebuild against the DOM.
  let stripQueued = false;
  const onTabsChanged = () => {
    if (stripQueued || disposed) return;
    stripQueued = true;
    requestAnimationFrame(() => {
      stripQueued = false;
      if (!disposed) renderStrip();
    });
  };
  state.listeners.add(onTabsChanged);

  void (async () => {
    try {
      setNote("Starting the browser...");
      await ensureBrowser((m) => setNote(m));
      await syncTabs();
      if (!state.tabs.size) await newTab("about:blank");
      await bindActive();
      canvas.focus();
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    }
  })();

  return () => {
    disposed = true;
    state.listeners.delete(onTabsChanged);
    ro.disconnect();
    io.disconnect();
    cast?.stop();
    cast = null;
    state.panes = Math.max(0, state.panes - 1);
    void armIdleShutdown();
    root.remove();
  };
}
