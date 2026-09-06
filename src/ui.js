// The browser pane: TEDI's own chrome around a real Chrome page.
//
// THE PANE DRAWS THE CHROME. Chromium runs `--app=`, so its windows have no tab
// strip, no omnibox and no menu of their own, and the toolbar above the stage is
// TEDI's - the same four controls on every surface and in every workspace view.
//
// THAT IS THE WHOLE REASON THE TWO SURFACES CAN MATCH. A screencast captures the
// page viewport and cannot capture Chrome's own toolbar, so for as long as
// Chrome drew its own chrome the canvas could never look like the tabs view. Now
// neither shows any, and the pane looks the same wherever it is.
//
// It also deletes a bug that had no other fix: an adopted window is a `WS_CHILD`,
// Chromium asks the OS whether its widget is active with
// `GetActiveWindow() == hwnd()`, and a child can never satisfy that - so the
// omnibox drew no caret and appended what you typed. There is no omnibox now.
//
// THE PRICE, stated plainly: no extensions button, no profile menu, no route to
// the Chrome Web Store from inside a pane. Unpacked extensions dropped in
// `~/.tedi/browser/extensions/` still load and are now the only way in. A Google
// sign-in still works, because none of that depends on Chrome's UI - it is the
// same real Chrome, the same profile and the same user agent.
//
// TEDI ADOPTS THE WINDOW where the OS allows it, so it is a child of TEDI's own
// window: clipped to it, minimised with it, gone from the taskbar and Alt-Tab,
// and typing reaches it because the input queues are joined. Where it cannot -
// macOS, Wayland - the window stays top-level and is placed on the pane from
// outside. `window.js` picks; this file cannot tell which it got.
//
// EITHER WAY IT COMPOSITES ABOVE WHAT TEDI PAINTS, so anything that hides the
// pane hides the window rather than trying to draw over it.
//
// EXCEPT ON THE CANVAS AND IN A FLOAT, WHERE THERE IS NO WINDOW AT ALL. The canvas
// view puts every pane on one `transform: translate() scale()` layer, where
// panes overlap, the whole surface zooms, and anything off screen is culled.
// An OS window can do none of those: it cannot be scaled by a transform, cannot
// be stacked between two DOM elements, and would sit at the right rectangle
// showing a 1:1 CROP of a page the user asked to see at 40%, on top of every
// window above it. So on the canvas the pane paints a `Page.startScreencast`
// stream into a `<canvas>` and parks the window instead: an ordinary element,
// which the transform scales, DOM order stacks and `display:none` culls, all
// for free and all exactly right. A FLOAT WINDOW gets frames for a different
// reason: placing works there, but the host forwards keyboard focus to an
// adopted window from its own window proc, and that proc is installed on the
// main window only - so a floated pane would take clicks and swallow every
// keystroke.
//
// THE ENGINE NEVER CHANGES. Both surfaces drive the same real Chrome, the same
// profile and the same target, so a signed-in session, an installed extension
// and an open page all survive a view switch - none of them ever learns it
// happened. What changes is only who paints. See `wantsScreencast` below and
// the header of `screencast.js`.
//
// WHAT THE PANE STILL OWNS is its identity: the page's title and favicon go on
// the pane header through `ctx.tabs.setExtensionTabState`, where every other
// pane already shows what it is holding.

import { ctx, state } from "./runtime.js";
import { ensureBrowser, armIdleShutdown, openPaneWindow } from "./launch.js";
import { attachTarget, closeWindowTargets, adoptablePageTargets, visibleTargetIn } from "./tabs.js";
import { dock, forgetWindow } from "./window.js";
import { screencastSurface } from "./screencast.js";
import { createToolbar } from "./toolbar.js";

const css = String.raw`
.tb-root { display:flex; flex-direction:column; height:100%; min-height:0; background:var(--background); color:var(--foreground); font-size:12px; }
.tb-stage { position:relative; flex:1; min-height:0; background:var(--background); }
/* z-index because the note is appended BEFORE the screencast canvas and both
   are inset:0, so without it a later sibling paints over the very message the
   pane is trying to show. Pausing the cast is not enough: a paused cast still
   holds its last frame. */
.tb-note { position:absolute; inset:0; z-index:1; display:flex; align-items:center; justify-content:center; text-align:center; white-space:pre-line; padding:24px; color:var(--muted-foreground); background:var(--background); }
/* The screencast surface. display:block because an inline canvas sits on the
   text baseline and leaves a few pixels of background under every pane, and
   outline:none because it is focusable only so it can take the keyboard.

   THE EXPLICIT SIZE IS LOAD-BEARING. A canvas is a REPLACED element, so with
   width/height auto the used size comes from its INTRINSIC RATIO and the insets
   are ignored entirely - an 800x600 stage lays a default 300x150 canvas out at
   800x400, applyMetrics writes those numbers back into canvas.width/height, and
   the 2:1 ratio then perpetuates itself through every resize. The pane shows a
   letterboxed stream and the page renders in the wrong viewport. */
.tb-cast { position:absolute; inset:0; display:block; width:100%; height:100%; outline:none; }
/* The pane's own chrome. A SIBLING of the stage, never an overlay on it: in the
   tabs view the stage holds a real OS window, which composites above everything
   the app paints, so a toolbar drawn over it would simply be invisible. Beside
   it, the window never reaches it. Sized to disappear, because the canvas is
   where panes are smallest. */
.tb-bar { flex:none; height:28px; display:flex; align-items:center; gap:2px; padding:0 4px; border-bottom:1px solid var(--border); background:var(--card); }
.tb-btn { flex:none; width:22px; height:20px; display:flex; align-items:center; justify-content:center; border:0; border-radius:4px; background:transparent; color:var(--muted-foreground); cursor:pointer; }
.tb-btn:hover { background:var(--muted); color:var(--foreground); }
.tb-btn svg { display:block; }
/* The reload glyph turns while the page is loading. Own keyframes rather than
   Tailwind's animate-spin: a utility class reaching into an extension's DOM is
   a dependency on the host's stylesheet that nothing guarantees, and the timing
   here (1s linear infinite) is the same one the app uses anyway. */
@keyframes tb-spin { to { transform: rotate(360deg); } }
.tb-btn.tb-spinning svg { animation: tb-spin 1s linear infinite; }
@media (prefers-reduced-motion: reduce) { .tb-btn.tb-spinning svg { animation: none; opacity: 0.6; } }
.tb-url { flex:1; min-width:0; height:20px; padding:0 6px; border:1px solid transparent; border-radius:4px; background:var(--muted); color:var(--foreground); font:inherit; font-size:11px; outline:none; }
.tb-url:focus { border-color:var(--ring); background:var(--background); }
`;

/**
 * Should this pane paint frames instead of holding the window?
 *
 * WHY IT IS ASKED OF THE DOM. The host tells a panel its `surface` ("tab" or
 * "pane") and nothing about which view, or which WINDOW, is presenting it. That
 * is the right contract for every other extension, and widening it would make
 * every panel care about distinctions only this one has to. Both answers below
 * are already in the DOM, so one function reads them with no new API and no host
 * change.
 *
 * TWO REASONS TO PAINT RATHER THAN PLACE.
 *
 * 1. THE CANVAS. Everything inside `[data-canvas]` lives on one
 *    `transform: translate() scale()` layer where panes overlap and off-screen
 *    ones are culled. A real OS window cannot be scaled by a transform, cannot
 *    be stacked between two DOM elements, and cannot be culled - so there it
 *    would sit at the right rectangle showing a 1:1 CROP, over the top of every
 *    window above it. A `<canvas>` gets all three for free.
 *
 * 2. A FLOAT WINDOW. Placing works there, but TYPING does not. An adopted window
 *    is sent clicks by position and never takes the keyboard on its own; the
 *    host forwards focus from `WM_PARENTNOTIFY` in its window proc, and that
 *    proc is installed on the MAIN window only (`apply_windows_frame_fixes` is
 *    called for `get_webview_window("main")`). So a floated browser pane would
 *    draw, scroll and click, and swallow every keystroke. Frames have no such
 *    problem: the `<canvas>` is an ordinary focusable element in the float's own
 *    document.
 *
 * Read ONCE per mount, which is enough: switching the workspace view REMOUNTS
 * the panel, and a float is a different document entirely.
 *
 * @param {HTMLElement} el
 */
function wantsScreencast(el) {
  if (el.closest?.("[data-canvas]")) return true;
  // `float-root` is the float webview's React root (`src/float/main.tsx`); it
  // exists in no other document.
  return !!document.getElementById("float-root");
}

function ensureStyles() {
  if (document.getElementById("tedi-browser-style")) return;
  const el = document.createElement("style");
  el.id = "tedi-browser-style";
  el.textContent = css;
  document.head.appendChild(el);
}

/**
 * Read the page's own favicon as a `data:` URL.
 *
 * Fetched INSIDE the page, so it is same-origin and needs no network permission
 * on this side. Capped, and empty on any failure: a pane wearing the default
 * globe is fine, a pane that failed because an icon 404'd is not.
 */
const FAVICON_JS = `(async () => {
  try {
    const l = document.querySelector('link[rel~="icon"],link[rel="shortcut icon"],link[rel="apple-touch-icon"]');
    const href = l ? l.href : new URL('/favicon.ico', location.href).href;
    const r = await fetch(href);
    if (!r.ok) return '';
    const b = await r.blob();
    if (!b.type.startsWith('image/') || b.size > 65536) return '';
    return await new Promise((res) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result));
      fr.onerror = () => res('');
      fr.readAsDataURL(b);
    });
  } catch { return ''; }
})()`;

/** Browser windows a pane has taken, by window id. Keyed on the WINDOW rather
 *  than the tab, because one window holds as many tabs as the user opens and
 *  none of them is a second pane's to take. */
const claimed = new Set();

/**
 * How long a pane's window waits before it is really closed.
 *
 * A TEARDOWN IS NOT ALWAYS A CLOSE. Switching the workspace to canvas or back
 * re-lays the same leaves out, and React remounts the panel: the old pane tears
 * down and a new one starts, one after the other, for a browser the user never
 * asked to close. Closing the window then and there took the page with it and
 * handed back a fresh `about:blank` a second later - every view switch a lost
 * session.
 *
 * So the close is deferred, and skipped entirely if a pane has claimed the
 * window again by the time it fires. Long enough to cover a remount, which
 * reclaims within a couple of CDP round trips; short enough that a real close
 * is over before anyone looks for the window.
 */
const CLOSE_GRACE_MS = 750;

/** Reads of a page's favicon before giving up on it until the page changes.
 *  Small on purpose - see the note on `iconFor` in `renderPane`. */
const ICON_READ_TRIES = 3;

/**
 * Paint one browser pane into `container`.
 *
 * @param {HTMLElement} container
 * @param {{ surface: "tab" | "pane", reuseKey?: string } | undefined} paneCtx
 * @returns {() => void} cleanup
 */
export function renderPane(container, paneCtx) {
  ensureStyles();
  state.panes += 1;
  void armIdleShutdown();

  const root = document.createElement("div");
  root.className = "tb-root";
  const stage = document.createElement("div");
  stage.className = "tb-stage";
  const note = document.createElement("div");
  note.className = "tb-note";
  stage.append(note);
  // The toolbar is the pane's ONLY chrome on either surface, because Chromium
  // runs `--app=` and draws none of its own. It goes above the stage rather than
  // inside it: the stage is where a real OS window lands in the tabs view, and
  // that window composites above the DOM, so anything drawn inside would be
  // covered. See `toolbar.js`.
  const toolbar = createToolbar(() => tab);
  root.append(toolbar.el, stage);
  container.appendChild(root);

  /** @type {{ targetId: string, sessionId: string } | null} */
  let tab = null;
  /** The browser window this pane holds. Claimed, and released on teardown. */
  let windowId = null;
  /** @type {Awaited<ReturnType<typeof dock>> | ReturnType<typeof screencastSurface> | null} */
  let glue = null;
  /** The target the screencast is bound to, or null when this pane is showing a
   *  real window instead. Only the cast cares which tab is in front; a window
   *  shows whichever one Chrome has raised, on its own. */
  /** @type {string | null} */
  let castTargetId = null;
  let disposed = false;
  let identityTimer = null;
  /** The page the current favicon was read for, the icon itself, and how many
   *  reads have been spent on it.
   *
   *  WHY THIS IS CACHED AND THE TITLE IS NOT. Reading the title is one
   *  `Runtime.evaluate` returning a short string. Reading the favicon fetches an
   *  image inside the page, reads it through a `FileReader` and ships up to 64 KB
   *  of base64 back over the socket - and the identity tick runs once a SECOND,
   *  for the life of every open pane. A page changes its icon when it changes
   *  page, so keying the read on the URL turns a permanent per-second image
   *  fetch into a handful per navigation.
   *
   *  The retry budget is what keeps that honest: a `<link rel=icon>` can be
   *  written by script after load, so the first read can legitimately come up
   *  empty. Ceiling worth knowing: an icon that only appears more than three
   *  ticks after a navigation is not picked up until the page changes again. */
  let iconFor = null;
  let iconData = "";
  let iconTries = 0;
  /** Subscriptions that must not outlive the page they describe. */
  /** @type {Array<() => void>} */
  let watchers = [];

  /** Drop the current page's timers, window glue and subscriptions, without
   *  touching the note - the caller says what the pane shows next. */
  const release = () => {
    for (const off of watchers) off();
    watchers = [];
    if (identityTimer) clearInterval(identityTimer);
    identityTimer = null;
    glue?.stop();
    glue = null;
    // Cleared with the surface it describes. A pane that came back on the other
    // surface would otherwise inherit a stale binding and try to rebuild a
    // screencast over a real window on the next tab switch.
    castTargetId = null;
    if (windowId !== null) {
      claimed.delete(windowId);
      windowId = null;
    }
    if (tab) {
      forgetWindow(tab.targetId);
      tab = null;
    }
  };

  const setNote = (text, retry) => {
    note.textContent = text ?? "";
    note.style.display = text ? "flex" : "none";
    note.onclick = retry ?? null;
    note.style.cursor = retry ? "pointer" : "default";
    // The window must never sit over a message the user is meant to read.
    glue?.setVisible(!text);
  };

  /** Every dead end in this pane is the same offer: say what happened, and let a
   *  click start over. */
  const fail = (err) =>
    setNote(`${err instanceof Error ? err.message : String(err)}\n\nClick to try again.`, () =>
      void start(),
    );

  /**
   * The page died without the pane - the window was closed from inside Chrome,
   * or Chromium exited.
   *
   * Deliberately NOT auto-reopened: springing a new window back up is a pane
   * fighting whoever just closed one. The pane offers, the user decides.
   */
  const pageGone = (reason) => {
    if (disposed || !tab) return;
    release();
    setNote(`${reason}\n\nClick to open a new one.`, () => void start());
  };

  /** What was last sent to the header, so an unchanged tick sends nothing. */
  let sentTitle;
  let sentIcon;

  /**
   * Publish the page's identity to the pane header, where every other pane
   * already shows one.
   *
   * SILENT WHEN NOTHING MOVED. This runs once a second for the life of the pane
   * and a page's title and favicon change perhaps twice a session, so almost
   * every call is a no-op - but it lands on a host setter that re-renders the
   * tab strip and re-serializes the workspace, and the payload carries a base64
   * favicon. The host now bails on an unchanged patch too; this stops the call
   * before it is made.
   *
   * THE ICON IS ALWAYS SENT, INCLUDING EMPTY. `undefined` means "unchanged" to
   * the host, so omitting it when a page has no favicon left the pane wearing
   * the PREVIOUS site's mark - GitHub's octocat next to a header reading
   * example.com, and it survived a restart because the leaf persists the icon.
   * An empty string is the only way to say "this page has none", and the host's
   * icon resolution already falls back correctly for it.
   */
  const publish = (title, iconUrl) => {
    const icon = iconUrl || "";
    if (title === sentTitle && icon === sentIcon) return;
    sentTitle = title;
    sentIcon = icon;
    try {
      ctx.tabs.setExtensionTabState({
        panelId: "browser",
        reuseKey: paneCtx?.reuseKey,
        state: null,
        ...(title !== undefined ? { title } : {}),
        icon,
      });
    } catch {
      // No `tabs:open`, or the host has not wired the bridge yet. The pane still
      // works; it just keeps its default name. Forget what we recorded, so the
      // next tick tries again rather than believing it already published.
      sentTitle = undefined;
      sentIcon = undefined;
    }
  };

  /**
   * Make sure the pane is describing the tab the user is actually looking at.
   *
   * The window has a tab strip, so the tab this pane attached to may now be in
   * the background - and a header naming a page nobody can see is worse than no
   * header at all. Cheap in the common case: one evaluate says the current tab
   * is still in front, and only a switch costs the search.
   */
  async function followActiveTab(c) {
    if (!tab || windowId === null) return;
    const vis = await c
      .send("Runtime.evaluate", { expression: "document.visibilityState", returnByValue: true }, tab.sessionId)
      .catch(() => null);
    if (vis?.result?.value === "visible") return;
    const front = await visibleTargetIn(c, windowId).catch(() => null);
    if (!front || front === tab.targetId || disposed) return;
    tab = await attachTarget(c, front);
    // A SCREENCAST IS BOUND TO ONE SESSION; A WINDOW IS NOT. The placed and
    // adopted surfaces show whatever tab the window has in front, because they
    // show the window itself - so a tab switch needs nothing from them. The cast
    // subscribes to one `sessionId` and would go on painting the tab that just
    // went to the background, which reads as a pane frozen on the wrong page.
    if (castTargetId !== null && castTargetId !== tab.targetId) {
      glue?.stop();
      if (disposed) return;
      glue = screencastSurface(c, tab, stage);
      castTargetId = tab.targetId;
      glue.setVisible(!note.textContent);
    }
  }

  async function refreshIdentity() {
    if (disposed || !tab) return;
    const c = await ensureBrowser();
    await followActiveTab(c);
    if (disposed || !tab) return;
    const info = await c
      .send(
        "Runtime.evaluate",
        { expression: "JSON.stringify({u: location.href, t: document.title})", returnByValue: true },
        tab.sessionId,
      )
      .catch(() => null);
    if (!info?.result?.value || disposed) return;
    const { u, t } = JSON.parse(info.result.value);
    // The toolbar rides this poll rather than opening a subscription of its
    // own: the URL is already in hand, once a second, on both surfaces. A blank
    // pane shows an empty field rather than the data: URL that is standing in
    // for `about:blank` (see START_PAGE): it is an implementation detail, and a
    // wall of percent-encoding is not an address anyone wants to read.
    toolbar.setUrl(u.startsWith("data:") ? "" : u);
    let name = t;
    if (!name) {
      try {
        name = new URL(u).hostname;
      } catch {
        name = "";
      }
    }
    if (u !== iconFor) {
      iconFor = u;
      iconData = "";
      iconTries = 0;
    }
    if (!iconData && iconTries < ICON_READ_TRIES) {
      iconTries += 1;
      const fav = await c
        .send(
          "Runtime.evaluate",
          { expression: FAVICON_JS, returnByValue: true, awaitPromise: true },
          tab.sessionId,
        )
        .catch(() => null);
      if (disposed) return;
      iconData = fav?.result?.value || "";
    }
    publish(name || "Browser", iconData || undefined);
  }

  // A window that composites above TEDI has to disappear the instant the pane is
  // not on screen, or it covers whatever the user switched to.
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) glue?.setVisible(e.isIntersecting && !note.textContent);
    },
    { threshold: 0.01 },
  );
  io.observe(stage);
  const onVisibility = () => glue?.setVisible(!document.hidden && !note.textContent);
  document.addEventListener("visibilitychange", onVisibility);

  async function start() {
    try {
      setNote("Starting the browser...");
      const c = await ensureBrowser((m) => setNote(m));
      if (disposed) return;
      // The toolbar spins its reload glyph off the page's own load events, and
      // it is built before there is a browser to subscribe to.
      toolbar.attach(c);

      // Starting Chromium leaves exactly one window open; the first pane takes
      // it and every later pane asks for its own.
      const free = (await adoptablePageTargets(c)).find((w) => !claimed.has(w.windowId));
      const targetId = free?.targetId ?? (await openPaneWindow(""));
      if (disposed) return;
      tab = await attachTarget(c, targetId);
      windowId = free?.windowId ?? (await c.send("Browser.getWindowForTarget", { targetId })).windowId;
      claimed.add(windowId);

      // One pane, two ways to show it. The engine, the profile and the target
      // are identical either way, so a view switch changes only who paints -
      // never what is running, which is why a signed-in session survives one.
      // The stream is the baseline the pane can always fall back to, on any
      // platform and whatever the OS refuses: it needs no window, no reparenting
      // and no z-order. `dock` calls this if adoption is not going to happen,
      // rather than putting another application's title bar inside the pane.
      const makeCast = () => {
        castTargetId = tab.targetId;
        return screencastSurface(c, tab, stage);
      };
      if (wantsScreencast(stage)) {
        glue = makeCast();
      } else {
        // Explicit, not merely left over from `release`: a failed start retries
        // through `fail` -> `start` without passing through `release` at all.
        // `makeCast` sets it again if the fallback is taken.
        castTargetId = null;
        glue = await dock(c, targetId, tab.sessionId, stage, makeCast);
      }
      if (disposed) {
        glue.stop();
        return;
      }
      watchers.push(
        c.on("Target.targetDestroyed", (p) => {
          if (p?.targetId === targetId) pageGone("This window was closed.");
        }),
        c.onClose(() => pageGone("The browser stopped.")),
      );
      setNote(null);
      await refreshIdentity();
      // Polled rather than subscribed: title and favicon move at different times
      // and no single event covers both. A 1s tick is invisible next to the page
      // it describes.
      identityTimer = setInterval(() => void refreshIdentity(), 1000);
    } catch (err) {
      if (disposed) return;
      fail(err);
    }
  }
  void start();

  return () => {
    disposed = true;
    io.disconnect();
    document.removeEventListener("visibilitychange", onVisibility);
    // One pane, one window: it goes with the pane rather than being left
    // floating with nothing to place it. The WHOLE window - `release` is about
    // to hand it back to the desktop as an ordinary top-level window, so any
    // tab left open in it becomes a browser window the pane no longer owns and
    // nothing on screen explains.
    //
    // Read before `release`, which clears it. Deferred, and abandoned if the
    // window has been claimed again by then: see `CLOSE_GRACE_MS` for why a
    // teardown is not always a close.
    const orphan = windowId;
    release();
    if (orphan !== null) {
      setTimeout(() => {
        if (claimed.has(orphan)) return;
        void closeWindowTargets(orphan).catch(() => {});
      }, CLOSE_GRACE_MS);
    }
    state.panes = Math.max(0, state.panes - 1);
    void armIdleShutdown();
    toolbar.dispose();
    root.remove();
  };
}
