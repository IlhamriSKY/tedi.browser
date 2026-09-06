// Showing a Chromium window on the pane that owns it.
//
// THE PAGE IS A REAL WINDOW, NOT A PICTURE OF ONE. Chromium composites it on the
// GPU, so it is as fast and as sharp as the browser it is, the cursor changes to
// a hand over a link because the real one does, text selection and popups are
// native, and the user agent is ordinary Chrome - which is what lets a Google
// sign-in through at all. None of that survives a frame stream.
//
// TWO WAYS TO PUT IT THERE, and `dock()` picks:
//
//   1. ADOPTED. TEDI asks the OS to make the window a child of its own, so it is
//      clipped to TEDI, minimised with TEDI, and gone from the taskbar and
//      Alt-Tab. This is the one that makes a browser pane feel like a pane
//      rather than a second application. Windows only - see `dock.rs`.
//   2. PLACED. The window stays top-level and is moved onto the pane rectangle
//      from outside. Works everywhere, and it is genuinely a separate window: it
//      keeps a title bar, so it also needs watching in case the user drags it.
//
// ON WINDOWS THERE IS NO PLACED PATH ANY MORE. Adoption is either going to
// happen or it is not, and while it is being retried the window stays PARKED -
// because what "placed" looks like on the platform that can adopt is a
// top-level Chrome with its own minimise, maximise and close buttons sitting
// inside an editor pane, first for the four seconds of retries and then for
// good if they fail. Both outcomes are wrong on a platform that has a better
// one. So: parked while trying, adopted if it takes, and otherwise the caller's
// fallback - which is the frame stream, softer but with no frame, no taskbar
// entry and no z-order to fight. `follow` remains for the platforms that never
// had a choice.
//
// EITHER WAY THE WINDOW COMPOSITES ABOVE WHAT TEDI PAINTS, so anything that
// hides the pane must hide the window too rather than draw over it. The hiding
// differs: an adopted window is simply hidden, a placed one is parked far
// off-screen, because a top-level window has nowhere else to be.
//
// CHROME DRAWS ITS OWN TITLE BAR AND NO WINDOW STYLE REMOVES IT. An `--app`
// window has no tab strip and no omnibox, but it still paints a bar carrying the
// page title and a minimise, maximise and close button - and it paints it INSIDE
// ITS CLIENT AREA, not as the OS caption. Measured on a real app window:
// stripping `WS_CAPTION`, `WS_THICKFRAME`, `WS_SYSMENU` and both size boxes
// moves `outerHeight - innerHeight` from 39px to 37px. Two pixels.
//
// So the adopted window is deliberately made BIGGER than the pane by the frame
// and shifted up and left, which puts the PAGE exactly on the pane, and the
// frame is then cut away with the same window region the occlusion clip uses.
// `frameInsets` measures it exactly rather than guessing, and a window whose
// frame cannot be measured is handed back rather than shown.
//
// TWO COORDINATE SYSTEMS, one per strategy, which is why there are two rect
// helpers. `Browser.setWindowBounds` speaks screen DIPs, so a placed window
// takes `screenRectOf`. `SetWindowPos` speaks device pixels relative to TEDI's
// client area, so an adopted one takes `clientRectOf`. Conflating them silently
// misplaces the window by the display scale, which on a 125% display is a
// quarter of the pane.

import { ctx } from "./runtime.js";

/** Where a window waits when its pane is not on screen. Far enough out that no
 *  real monitor arrangement reaches it, and cheaper than destroying the page. */
const PARKED = { left: -32000, top: -32000 };

/** The same spot in the CLIENT coordinates `dock_place_window` speaks, for the
 *  adopted path. A size is required and the page is about to have its viewport
 *  overridden anyway, so it only has to be big enough to lay out. */
const PARKED_CLIENT = { x: -32000, y: -32000, width: 1000, height: 700 };

/** Placements closer than this are treated as correct. Chromium rounds to whole
 *  device pixels, so an exact match is not always reachable. */
const TOLERANCE_PX = 2;

/** How often the window is re-placed even though the pane has not moved.
 *
 * The window keeps a native title bar, so the user can drag it off the pane or
 * maximise it - neither of which changes the pane rectangle, so a loop watching
 * only the rectangle would leave the window wrong for the rest of the session.
 * `place` reads the bounds back before correcting, so a window already in the
 * right spot costs one round trip a second and no movement at all.
 */
const VERIFY_INTERVAL_MS = 1000;

/**
 * Below this, a rectangle is not a place to put a window.
 *
 * A detached or half-laid-out element still answers `getBoundingClientRect`, and
 * it answers with numbers - a pane caught mid-relayout measures something like
 * 69x0 at an off-screen origin. Sent to `Browser.setWindowBounds` those become a
 * real window: Chromium clamps it up to its minimum size and leaves a small
 * browser box sitting somewhere nobody put it. That is a stray window, not a
 * pane, so a rectangle this small means "not on screen" and never "move here".
 */
const MIN_USABLE_PX = 48;

/** How often the pane is re-tested for things the app draws over it.
 *  `elementFromPoint` forces layout, so this runs on its own slow clock rather
 *  than once per animation frame. */
const OCCLUSION_INTERVAL_MS = 150;

/** Sample points per axis. A GRID, not the four corners: a canvas window
 *  overlapping only the middle of the pane would sit in none of them. */
const OCCLUSION_SAMPLES = 6;

/**
 * The whole thing that is covering us, not the innermost piece of it.
 *
 * `elementFromPoint` answers with the DEEPEST element at that point - the body
 * of a canvas window, not the window. Cutting a hole that size leaves the
 * window's own border and padding uncovered, so a sliver of browser bleeds
 * through along every edge and the clip looks ragged rather than like one
 * window sitting in front of another.
 *
 * Climbing stops at the first ancestor that CONTAINS the pane, because that one
 * is a common parent of both and would cut away the pane itself. What is
 * returned is the last ancestor still entirely beside us: the window, with its
 * frame.
 *
 * @param {Element} hit
 * @param {HTMLElement} el
 */
function outermostOver(hit, el) {
  let node = hit;
  for (;;) {
    const up = node.parentElement;
    if (!up || up === document.body || up.contains(el)) return node;
    node = up;
  }
}

/**
 * Where something the app paints covers the pane, in the window's own device
 * pixels.
 *
 * WHY BY HIT-TESTING AND NOT BY ASKING TEDI. The pane is an extension panel; it
 * knows its own element and nothing about canvas windows, dialogs or menus, and
 * it should stay that way. `elementFromPoint` answers the only question that
 * actually matters - "is my pixel the top one here" - for every one of them at
 * once, with no coupling to how the app happens to lay them out.
 *
 * The known blind spot: an element with `pointer-events: none` is invisible to
 * hit-testing, so a tooltip drawn that way is not cut out. Canvas windows,
 * dialogs and menus all take pointer events, which is the case this exists for.
 *
 * @param {HTMLElement} el
 */
function occludersOf(el) {
  const b = el.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  /** @type {Set<Element>} */
  const found = new Set();
  for (let i = 0; i < OCCLUSION_SAMPLES; i++) {
    for (let j = 0; j < OCCLUSION_SAMPLES; j++) {
      const x = b.left + ((i + 0.5) * b.width) / OCCLUSION_SAMPLES;
      const y = b.top + ((j + 0.5) * b.height) / OCCLUSION_SAMPLES;
      const hit = document.elementFromPoint(x, y);
      // Our own element, or anything inside it, is not covering anything.
      if (!hit || hit === el || el.contains(hit)) continue;
      found.add(outermostOver(hit, el));
    }
  }
  return [...found].map((node) => {
    const r = node.getBoundingClientRect();
    return {
      x: Math.round((r.left - b.left) * scale),
      y: Math.round((r.top - b.top) * scale),
      width: Math.round(r.width * scale),
      height: Math.round(r.height * scale),
    };
  });
}

/**
 * The pane rectangle in screen DIPs.
 *
 * `screenX`/`screenY` are the host window's position in the same space, so the
 * sum is where the pane actually is. Read fresh every time: the user moves the
 * window, and a stale origin puts the page somewhere else on screen.
 *
 * @param {HTMLElement} el
 */
export function screenRectOf(el) {
  const r = el.getBoundingClientRect();
  return {
    left: Math.round(window.screenX + r.left),
    top: Math.round(window.screenY + r.top),
    width: Math.max(1, Math.round(r.width)),
    height: Math.max(1, Math.round(r.height)),
  };
}

/** Resolve (and remember) the window a target lives in. */
const windowIdCache = new Map();
async function windowIdFor(cdp, targetId) {
  const hit = windowIdCache.get(targetId);
  if (hit !== undefined) return hit;
  const { windowId } = await cdp.send("Browser.getWindowForTarget", { targetId });
  windowIdCache.set(targetId, windowId);
  return windowId;
}

/** Forget a closed target, so its id cannot be reused against a dead window. */
export function forgetWindow(targetId) {
  windowIdCache.delete(targetId);
}

/**
 * Is the window somewhere other than `rect`, or in a state that is not a plain
 * placed window?
 *
 * The state half matters as much as the numbers: a minimised or maximised window
 * reports the bounds it would be RESTORED to, which can match `rect` exactly
 * while nothing is visible on the pane at all.
 *
 * @param {import("./cdp.js").Cdp} cdp
 * @param {string} targetId
 * @param {{left:number, top:number, width:number, height:number}} rect
 */
async function isOff(cdp, targetId, rect) {
  const got = (await cdp.send("Browser.getWindowForTarget", { targetId })).bounds;
  if (!got) return false;
  return (
    got.windowState !== "normal" ||
    Math.abs(got.left - rect.left) > TOLERANCE_PX ||
    Math.abs(got.top - rect.top) > TOLERANCE_PX ||
    Math.abs(got.width - rect.width) > TOLERANCE_PX ||
    Math.abs(got.height - rect.height) > TOLERANCE_PX
  );
}

/**
 * Put `targetId`'s window on `rect`, and make sure it landed there.
 *
 * READ BEFORE WRITING. This runs once a second for the life of every visible
 * pane, and in the steady state the window is already correct: a blind write
 * would ask the compositor to move a window that has not moved, forever.
 *
 * The correct-once pass afterwards is not belt and braces: the first placement
 * after the window comes in from the parking spot is applied at the scale factor
 * of where it WAS, so it arrives up to 25% wrong on a scaled display. Repeating
 * once settles it, and costs nothing when the window was already in the right
 * DPI context.
 *
 * @param {import("./cdp.js").Cdp} cdp
 * @param {string} targetId
 * @param {{left:number, top:number, width:number, height:number}} rect
 */
export async function place(cdp, targetId, rect) {
  if (!(await isOff(cdp, targetId, rect))) return;
  const windowId = await windowIdFor(cdp, targetId);
  const bounds = { ...rect, windowState: "normal" };
  await cdp.send("Browser.setWindowBounds", { windowId, bounds });
  if (await isOff(cdp, targetId, rect)) {
    await cdp.send("Browser.setWindowBounds", { windowId, bounds });
  }
}

/**
 * Move the window out of sight without closing the page.
 *
 * Parked rather than minimised: a minimised window animates, shows in the
 * taskbar and steals a restore, none of which a pane switching tabs should do.
 * The page keeps running, so coming back is instant.
 */
export async function park(cdp, targetId) {
  const windowId = await windowIdFor(cdp, targetId);
  await cdp
    .send("Browser.setWindowBounds", {
      windowId,
      bounds: { ...PARKED, width: 800, height: 600, windowState: "normal" },
    })
    .catch(() => {
      // The window is already gone; nothing to hide.
    });
}

/**
 * The pane rectangle in PHYSICAL pixels, relative to TEDI's client area.
 *
 * What `SetWindowPos` wants for a child window, and the reason it is a separate
 * function from `screenRectOf`: that one answers in screen DIPs for the DevTools
 * Protocol, this one in device pixels for Win32. TEDI draws with no OS title bar
 * and the webview fills the client area, so a CSS coordinate and a client
 * coordinate share an origin - only the scale differs.
 *
 * @param {HTMLElement} el
 */
function clientRectOf(el) {
  const r = el.getBoundingClientRect();
  const s = window.devicePixelRatio || 1;
  return {
    x: Math.round(r.left * s),
    y: Math.round(r.top * s),
    width: Math.max(1, Math.round(r.width * s)),
    height: Math.max(1, Math.round(r.height * s)),
  };
}

/**
 * Is this a rectangle worth putting a window on, and is it actually on screen?
 *
 * A MEASUREMENT IS NOT ENOUGH, and this is the whole reason the window used to
 * float over everything. TEDI hides a surface it is not showing with
 * `visibility: hidden` (Tailwind `invisible`, see `WorkspaceArea`'s `Overlay`),
 * and `visibility` KEEPS THE LAYOUT BOX: the element still measures full size,
 * so a check on width and height alone says "visible" for a pane that is not on
 * screen at all. An `IntersectionObserver` is no help either - it does not
 * consider `visibility`, so it never fires on the change. The window therefore
 * stayed exactly where it was, above whatever the user switched to: another
 * tab, or the kanban board.
 *
 * `checkVisibility` is the one call that answers the real question. Both the
 * old option names and the renamed ones are passed, because Chromium accepted
 * `visibilityProperty` first and `checkVisibilityCSS` later; unknown keys are
 * ignored, so sending both is simply correct on either. Optional-chained with a
 * `true` fallback so an engine without it behaves exactly as before rather than
 * hiding every pane.
 *
 * @param {HTMLElement} el
 */
function laidOut(el) {
  const b = el.getBoundingClientRect();
  if (!el.isConnected || b.width < MIN_USABLE_PX || b.height < MIN_USABLE_PX) return false;
  return (
    el.checkVisibility?.({
      visibilityProperty: true,
      checkVisibilityCSS: true,
      contentVisibilityAuto: true,
    }) ?? true
  );
}

/**
 * The width of Chrome's own frame on each side of the page, in CSS pixels.
 *
 * MEASURED, BECAUSE IT CANNOT BE STRIPPED. An `--app` window has no tab strip
 * and no omnibox, but it still draws a title bar carrying the page title and a
 * minimise, maximise and close button - and Chrome draws that INSIDE ITS CLIENT
 * AREA, not as the OS caption. Verified directly: stripping `WS_CAPTION`,
 * `WS_THICKFRAME`, `WS_SYSMENU` and both size boxes off a real app window moves
 * `outerHeight - innerHeight` from 39px to 37px. Two pixels. So no amount of
 * window-style surgery removes it, and a pane that shows the window unmodified
 * shows another application's title bar and window buttons inside an editor.
 *
 * What DOES remove it is the window region the occlusion clip already uses: the
 * OS simply does not draw the window where the region is not. To use it the
 * frame has to be measured, and it can be exactly: `screenX`/`screenY` are the
 * PAGE's own position on screen, and `Browser.getWindowForTarget` gives the
 * WINDOW's - so the difference is the inset, with no guessing about which part
 * of `outerHeight - innerHeight` is title and which is border.
 *
 * Everything here is DIPs, because both sources are. The caller scales.
 *
 * @param {import("./cdp.js").Cdp} cdp
 * @param {string} sessionId
 * @param {string} targetId
 * @returns {Promise<{left:number, top:number, right:number, bottom:number} | null>}
 */
async function frameInsets(cdp, sessionId, targetId) {
  const [page, win] = await Promise.all([
    cdp
      .send(
        "Runtime.evaluate",
        {
          expression:
            "JSON.stringify({sx:screenX,sy:screenY,iw:innerWidth,ih:innerHeight,ow:outerWidth,oh:outerHeight})",
          returnByValue: true,
        },
        sessionId,
      )
      .catch(() => null),
    cdp.send("Browser.getWindowForTarget", { targetId }).catch(() => null),
  ]);
  const bounds = win?.bounds;
  const raw = page?.result?.value;
  if (!bounds || !raw) return null;
  let v;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v.ow || !v.oh) return null;
  const left = Math.max(0, Math.round(v.sx - bounds.left));
  const top = Math.max(0, Math.round(v.sy - bounds.top));
  const right = Math.max(0, Math.round(v.ow - v.iw - left));
  const bottom = Math.max(0, Math.round(v.oh - v.ih - top));
  // A frame taller than the pane would be a measurement gone wrong, and acting
  // on it would place the window somewhere absurd. Refusing sends the pane to
  // its fallback surface, which has no frame to hide in the first place.
  if (top > 200 || left > 100 || right > 100 || bottom > 200) return null;
  // A TITLE BAR IS ON TOP. A frame that measures as nothing above the page and
  // everything below it is not a frame, it is the sum being taken in two
  // coordinate spaces that have stopped agreeing - which is what happens if this
  // runs after `SetParent`. Refusing is right: acting on it clips the page
  // instead of the chrome.
  if (top === 0 && bottom > top + 8) return null;
  return { left, top, right, bottom };
}

/**
 * Hand the window to TEDI, which adopts it as a child of its own.
 *
 * FOUND BY TITLE. The host needs some way to pick this window out of every
 * window on the desktop, and a title we set for the length of one call is the
 * only key that is exact at any display scale - a rectangle is not, because this
 * side places in DIPs and the host reads device pixels. The page's own title is
 * put back immediately, so nothing the user sees ever shows the marker.
 *
 * Returns null when the host cannot do it - anything but Windows - and the
 * caller then falls back to placing the window from outside.
 *
 * @param {import("./cdp.js").Cdp} cdp
 * @param {string} targetId
 * @param {string} sessionId
 * @param {HTMLElement} el
 */
async function embed(cdp, targetId, sessionId, el) {
  if (!laidOut(el)) {
    // Chosen ONCE per pane, so losing here is losing for the life of the pane:
    // the window stays top-level, keeps its title bar, and sits ON the pane
    // instead of in it. That is what "the browser came loose from the pane"
    // is, and a pane measured before its first layout hits it every time.
    ctx.logger?.info?.("dock: not adopting, the pane has no rectangle yet");
    return null;
  }
  // MEASURED BEFORE ADOPTION, AND THAT ORDER IS THE WHOLE POINT. Both halves of
  // the sum only mean what they say while the window is still TOP-LEVEL:
  // `screenX`/`screenY` are the page's position on the desktop and
  // `Browser.getWindowForTarget` is the window's, so the difference is the
  // frame. Once `SetParent` has made it a `WS_CHILD` the two stop agreeing -
  // measured after adoption the answer came back left=0, top=0, right=14,
  // bottom=37, i.e. the entire frame on the wrong two sides, and the clip then
  // cut the bottom-right corner off the page while leaving Chrome's title bar
  // exactly where it was.
  const insets = await frameInsets(cdp, sessionId, targetId);
  if (!insets) {
    ctx.logger?.info?.("dock: not adopting, the window frame could not be measured");
    return null;
  }

  const marker = `tedi-dock-${Math.random().toString(36).slice(2)}`;
  const titled = await cdp
    .send(
      "Runtime.evaluate",
      {
        expression: `(() => { const was = document.title; document.title = ${JSON.stringify(marker)}; return was; })()`,
        returnByValue: true,
      },
      sessionId,
    )
    .catch(() => null);
  if (!titled) {
    ctx.logger?.info?.("dock: not adopting, the page would not take a marker title");
    return null;
  }
  const was = titled.result?.value ?? "";

  /** Put the page's own title back, whatever happened to the adoption. */
  const untitle = () =>
    cdp
      .send(
        "Runtime.evaluate",
        { expression: `document.title = ${JSON.stringify(was)}` },
        sessionId,
      )
      .catch(() => {});

  let handle;
  try {
    handle = await ctx.invoke("dock_adopt_window", { title: marker, client: clientRectOf(el) });
  } catch (err) {
    // Not Windows, where this is the expected answer and the outside placement
    // path is the real one. Anywhere else it is a failure worth naming: the
    // pane still works, but it holds a framed top-level window instead of a
    // child, and nothing on screen says why.
    if (ctx.os?.platform === "windows") {
      ctx.logger?.info?.(`dock: adoption refused, placing from outside instead - ${err}`);
    }
    await untitle();
    return null;
  }
  await untitle();
  if (!handle) {
    ctx.logger?.info?.("dock: not adopting, the host returned no window handle");
    return null;
  }
  ctx.logger?.info?.("dock: adopted the browser window as a child of TEDI");

  /** The window rectangle that puts the PAGE on the pane, plus the frame bands
   *  to cut away, all in the device pixels `dock_*` speaks. */
  const framed = () => {
    const pane = clientRectOf(el);
    const k = window.devicePixelRatio || 1;
    const l = Math.round(insets.left * k);
    const t = Math.round(insets.top * k);
    const r = Math.round(insets.right * k);
    const b = Math.round(insets.bottom * k);
    const width = pane.width + l + r;
    const height = pane.height + t + b;
    return {
      client: { x: pane.x - l, y: pane.y - t, width, height },
      // Window-relative, which is what `dock_clip_window` subtracts from.
      bands: [
        { x: 0, y: 0, width, height: t },
        { x: 0, y: height - b, width, height: b },
        { x: 0, y: 0, width: l, height },
        { x: width - r, y: 0, width: r, height },
      ].filter((c) => c.width > 0 && c.height > 0),
      offset: { x: l, y: t },
    };
  };

  let stopped = false;
  let wanted = true;
  let last = "";
  let inFlight = false;

  // Cut holes where the app draws over the pane. Its own clock, and only sent
  // when the shape actually changes - the steady state is one hit-test sweep
  // every 150ms and no IPC at all.
  let clipKey = "";
  const clipTimer = setInterval(() => {
    if (stopped) return;
    const f = framed();
    // The frame bands are cut UNCONDITIONALLY - they are not an occlusion, they
    // are the part of the window that must never be seen. The app's own
    // overlays are relative to the pane, and the window now starts above and
    // left of it, so they shift by the inset before they mean anything here.
    const occ = wanted && laidOut(el) ? occludersOf(el) : [];
    const covers = [
      ...f.bands,
      ...occ.map((c) => ({ ...c, x: c.x + f.offset.x, y: c.y + f.offset.y })),
    ];
    // THE SIZE IS PART OF THE KEY. A window region is fixed in the window's own
    // coordinates and does NOT follow it when it is resized - so a pane that
    // grows while nothing about the occluders changed would keep the region cut
    // for its old, smaller self, and the browser would be clipped to a
    // rectangle that no longer means anything. Keying on the size makes a
    // resize recompute it.
    const key = [
      `${f.client.width}x${f.client.height}`,
      ...covers.map((c) => `${c.x},${c.y},${c.width},${c.height}`),
    ].join("|");
    if (key === clipKey) return;
    clipKey = key;
    void ctx.invoke("dock_clip_window", { handle, covers }).catch(() => {
      // An older host without the command, or a window already gone. The pane
      // still works; it just cannot cut holes in itself.
    });
  }, OCCLUSION_INTERVAL_MS);

  const tick = () => {
    if (stopped) return;
    requestAnimationFrame(tick);
    if (inFlight) return;
    const visible = wanted && laidOut(el);
    const { client } = framed();
    // NO periodic re-check here, unlike the outside path: a child window has no
    // title bar and no system menu, so there is nobody who can move it.
    const key = visible
      ? `${client.x},${client.y},${client.width},${client.height}`
      : "hidden";
    if (key === last) return;
    last = key;
    inFlight = true;
    ctx
      .invoke("dock_place_window", { handle, client, visible })
      .catch(() => {
        // The window is gone; the pane's own teardown follows.
      })
      .finally(() => (inFlight = false));
  };
  requestAnimationFrame(tick);

  return {
    setVisible(next) {
      if (!stopped) wanted = next;
    },
    invalidate() {
      last = "";
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(clipTimer);
      // MOVED OUT OF SIGHT FIRST, THEN HANDED BACK VISIBLE. Never hidden.
      //
      // Two things have to be true at once here and they pull in opposite
      // directions. The handover must not FLASH - switching the workspace view
      // remounts the panel, so every switch between tabs and canvas passes
      // through this line, and a release that shows the window on the pane puts
      // a framed Chrome on screen for the length of it. But the window must not
      // end up HIDDEN either: the surface that takes over on the canvas streams
      // frames out of it, and `SWP_HIDEWINDOW` clears `WS_VISIBLE`, which stops
      // Chromium compositing the page entirely. Nothing on the screencast path
      // can undo that - `park` is `Browser.setWindowBounds`, a move, and CDP has
      // no "show a hidden window" at all - so the pane would paint an empty
      // canvas with no error anywhere. Only `adopt` re-applies `WS_VISIBLE`.
      //
      // Moving it off-screen satisfies both: nothing to see, and still a visible
      // window as far as the OS and the compositor are concerned. The
      // coordinates survive the handover because a child that becomes top-level
      // keeps its numbers, they simply mean screen space afterwards.
      void (async () => {
        await ctx
          .invoke("dock_place_window", { handle, client: PARKED_CLIENT, visible: true })
          .catch(() => {});
        await ctx.invoke("dock_release_window", { handle, visible: true }).catch(() => {});
      })();
    },
  };
}

/**
 * Show `targetId`'s window on `el`, by whichever means this platform allows.
 *
 * Two strategies behind one handle: TEDI adopts the window as a child of its own
 * where the OS supports that, and otherwise the window stays top-level and is
 * placed on the pane from outside. The caller cannot tell them apart, which is
 * the point - the fallback is not a degraded mode to handle, it is the same pane.
 *
 * @param {import("./cdp.js").Cdp} cdp
 * @param {string} targetId
 * @param {string} sessionId
 * @param {HTMLElement} el
 * @param {() => { setVisible: (v: boolean) => void, invalidate: () => void, stop: () => void }} makeFallback
 *   What to show if this platform cannot adopt and retries are exhausted. The
 *   caller supplies it rather than this module choosing, because the answer is
 *   the pane's other surface and only the pane knows how to build one.
 */
export async function dock(cdp, targetId, sessionId, el, makeFallback) {
  await laidOutSoon(el);
  return (
    (await embed(cdp, targetId, sessionId, el)) ?? upgrading(cdp, targetId, sessionId, el, makeFallback)
  );
}

/** Adoption attempts before settling for the outside path. Bounded so a host
 *  that will never adopt does not retry for the life of the pane. */
const ADOPT_RETRIES = 10;

/** Gap between attempts. Slow: this only runs while the pane is NOT adopted. */
const ADOPT_RETRY_MS = 400;

/**
 * Place the window from outside now, and keep trying to adopt it.
 *
 * WHY THE CHOICE CANNOT BE FINAL. `embed` refuses a pane that has no rectangle
 * yet, and a pane genuinely has none for a moment - a workspace view switch
 * REMOUNTS the panel, and the new one is measured while the surface it lives on
 * is still being laid out. Deciding once meant that moment cost the pane its
 * adoption for the rest of its life: a top-level window, with a title bar,
 * floating over the canvas instead of sitting in it. That is the whole of "the
 * browser came loose" and "the browser is always on top", and it looked random
 * because it depended on which side of a layout the mount landed.
 *
 * So the outside path starts immediately - it works everywhere and needs no
 * rectangle - and adoption is retried behind it until it takes. The swap is
 * invisible to the caller: same handle, same methods.
 */
/**
 * A handle that holds the window PARKED and shows nothing.
 *
 * What the pane uses on Windows while adoption is still being retried. Placing
 * the window on the pane in the meantime works, but it is a framed top-level
 * Chrome with a title bar and window buttons, and it sits there for as long as
 * the retries take before being replaced by a frameless child - a visible jump,
 * and the single most "this is a second application" thing the pane can do. An
 * empty pane for the same fraction of a second says nothing at all, which is the
 * better of the two.
 */
function parked(cdp, targetId) {
  void park(cdp, targetId).catch(() => {});
  return {
    setVisible() {},
    invalidate() {},
    stop() {},
  };
}

function upgrading(cdp, targetId, sessionId, el, makeFallback) {
  // Nothing to upgrade to where the OS cannot reparent at all; the outside path
  // is the real one there, not a fallback.
  const canAdopt = ctx.os?.platform === "windows";
  let current = canAdopt ? parked(cdp, targetId) : follow(cdp, targetId, el);
  let stopped = false;
  let wanted = true;
  let left = ADOPT_RETRIES;

  const timer = canAdopt
    ? setInterval(async () => {
        if (stopped || !laidOut(el)) return;
        if (left-- <= 0) {
          clearInterval(timer);
          // ADOPTION IS NOT GOING TO HAPPEN. Fall back to frames, not to a
          // placed window. Placing works, but what it puts on the pane is a
          // top-level Chrome carrying its own title bar and its own minimise,
          // maximise and close buttons - another application's chrome sitting
          // inside an editor pane, which is the exact thing this whole design
          // is trying not to be. A stream is softer and correct: no frame, no
          // taskbar entry, no z-order to fight. Same page, same session; only
          // the painter changes.
          current.stop();
          current = makeFallback();
          current.setVisible(wanted);
          return;
        }
        const next = await embed(cdp, targetId, sessionId, el);
        if (!next) return;
        if (stopped) {
          next.stop();
          return;
        }
        clearInterval(timer);
        current.stop();
        current = next;
        current.setVisible(wanted);
      }, ADOPT_RETRY_MS)
    : null;

  return {
    setVisible(next) {
      wanted = next;
      current.setVisible(next);
    },
    invalidate() {
      current.invalidate();
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      current.stop();
    },
  };
}

/**
 * Wait until the pane has a rectangle worth measuring.
 *
 * THE STRATEGY IS PICKED ONCE AND KEPT FOR LIFE, and `embed` refuses an element
 * that is not laid out yet. So a pane measured one frame too early is placed
 * from outside for as long as it exists: a top-level window, with a title bar,
 * sitting ON the pane instead of a child sitting IN it. That is the
 * intermittent "the browser came loose from the pane" - a race against first
 * layout, not a platform difference, which is why the same build adopts on one
 * open and not the next.
 *
 * `setTimeout` rather than `requestAnimationFrame`: rAF does not fire at all
 * while the window is hidden, and this is awaited on the path that clears the
 * pane's "Starting the browser..." note - a minimised app would hang there
 * instead of simply taking the outside path.
 *
 * Bounded, because an element that never gets a rectangle is a pane nobody is
 * showing, and placing from outside is the right answer for that one.
 */
function laidOutSoon(el, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (laidOut(el) || Date.now() >= deadline) return resolve(laidOut(el));
      setTimeout(tick, 16);
    };
    tick();
  });
}

/**
 * Keep a window glued to an element for as long as the returned handle lives.
 *
 * A polling loop rather than an observer, because none of the three things that
 * move the rectangle raise an event this side can see: dragging the TEDI window
 * changes `screenX`, another pane resizing changes the layout, and the OS can
 * move the window itself. A rect comparison is a handful of numbers, so the poll
 * is cheap enough to run at animation rate while the pane is visible.
 *
 * @param {import("./cdp.js").Cdp} cdp
 * @param {string} targetId
 * @param {HTMLElement} el
 */
export function follow(cdp, targetId, el) {
  let stopped = false;
  /** What the pane asked for. */
  let wanted = true;
  /** What the window currently is, so it is parked once rather than per frame. */
  let parked = false;
  let last = "";
  let inFlight = false;
  let verifiedAt = 0;

  const hide = () => {
    if (parked) return;
    parked = true;
    last = "";
    void park(cdp, targetId).catch(() => {
      // Already gone; nothing to hide.
    });
  };

  const tick = () => {
    if (stopped) return;
    requestAnimationFrame(tick);
    if (inFlight) return;
    if (!wanted) {
      hide();
      return;
    }
    // Measure before deciding: an element that is detached, collapsed or still
    // being laid out has no rectangle worth honouring, and putting a window on
    // one is how a stray browser box ends up somewhere nobody asked for.
    // Through `laidOut`, not an inline box test: a pane hidden with
    // `visibility` measures full size, and the placed path has to refuse it for
    // the same reason the adopted one does.
    if (!laidOut(el)) {
      hide();
      return;
    }
    // Periodically forget where the window was put, so a window the USER moved
    // - dragged by its title bar, maximised - is pulled back even though the
    // pane it belongs to never moved.
    const now = performance.now();
    if (now - verifiedAt >= VERIFY_INTERVAL_MS) {
      verifiedAt = now;
      last = "";
    }
    const r = screenRectOf(el);
    const key = `${r.left},${r.top},${r.width},${r.height}`;
    if (key === last) return;
    last = key;
    inFlight = true;
    parked = false;
    place(cdp, targetId, r)
      .catch(() => {
        // A closed window; the pane's own teardown will follow.
      })
      .finally(() => (inFlight = false));
  };
  requestAnimationFrame(tick);

  return {
    /** Show or hide without tearing the page down. */
    setVisible(next) {
      if (stopped || next === wanted) return;
      wanted = next;
      if (next) {
        parked = false;
        last = "";
      }
    },
    /** Force the next tick to re-place, after something that invalidates the
     *  cached rectangle without changing it - a DPI change, a monitor swap. */
    invalidate() {
      last = "";
    },
    stop() {
      if (stopped) return;
      stopped = true;
      // PARK ON THE WAY OUT. This path leaves a top-level window sitting exactly
      // where the pane was, and the tick that would have moved it is now dead.
      // Whoever takes the page next places it again; a pane that is really
      // closing has its window closed a moment later. Not parking here is what
      // leaves a framed Chrome on screen across a workspace view switch, which
      // is the same artefact the adopted path avoids by releasing hidden.
      void park(cdp, targetId).catch(() => {
        // Already gone; there is nothing on screen to move out of the way.
      });
    },
  };
}
