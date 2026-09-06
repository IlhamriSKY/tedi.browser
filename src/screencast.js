// Painting the page into a pane, and sending the pane's input back.
//
// WHY A SCREENCAST. The page lives in a separate Chromium process; TEDI cannot
// composite another process's surface into its own window from JavaScript. CDP
// can stream the frames it already renders, so the pane draws them. This is the
// same mechanism Orca uses to put a browser on a phone, applied one process
// over instead of one machine over.
//
// WHY IT STAYS CHEAP. Three rules, all of them load-bearing:
//   1. ACK EVERY FRAME IMMEDIATELY. Chromium will not send frame N+1 until N is
//      acknowledged. That is the backpressure: acking on receipt keeps the
//      stream flowing, and acking BEFORE decoding means a slow decode throttles
//      the producer instead of queueing behind it.
//   2. KEEP ONLY THE NEWEST FRAME. Decoding is async, so frames can arrive
//      faster than they are drawn. Holding the latest and dropping the rest
//      turns a backlog into a dropped frame, which is invisible, rather than
//      into growing latency, which is not.
//   3. STOP WHEN NOBODY IS LOOKING. A hidden pane costs a full encode per frame
//      for pixels no one sees. Stopping the cast is the single biggest saving
//      here, and it is why switching tabs in TEDI costs nothing.
//
// WHY THE VIEWPORT IS OVERRIDDEN. `Emulation.setDeviceMetricsOverride` pins the
// page's CSS viewport to the pane's CSS size, which makes input mapping the
// identity function. Without it every coordinate would need scaling by a frame
// metadata factor that changes as the user zooms, and an off-by-one there is a
// click that lands on the wrong control.

import { park } from "./window.js";

/** CDP modifier bits. */
const ALT = 1;
const CTRL = 2;
const META = 4;
const SHIFT = 8;

/** @param {KeyboardEvent | MouseEvent | WheelEvent} e */
function modifiersOf(e) {
  return (e.altKey ? ALT : 0) | (e.ctrlKey ? CTRL : 0) | (e.metaKey ? META : 0) | (e.shiftKey ? SHIFT : 0);
}

/**
 * Ceiling on the render scale. A pane zoomed far in would otherwise ask for a
 * frame several times the size of the display, and the encode cost is quadratic.
 * 3 keeps a 2x display at 1.5x canvas zoom exact and clamps anything past that.
 */
const MAX_RENDER_SCALE = 3;

/** How often the page is asked what the cursor should be. One round trip per
 *  sample, and a pointer crossing a link is not a 16ms event. */
const CURSOR_POLL_MS = 90;

/** Below this the pointer has not really moved, so the answer cannot have
 *  changed. Keeps a jittery mouse from asking sixty times a second. */
const CURSOR_MIN_MOVE_PX = 4;

/** Which CDP button name a DOM button index means. */
const BUTTONS = ["left", "middle", "right", "back", "forward"];

/** base64 JPEG to an ImageBitmap, without a `fetch` on a data: URL. Decoding
 *  off the main thread is what keeps a 60fps stream from stuttering the whole
 *  TEDI window. */
async function decode(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
}

/**
 * Stream `tab` into `canvas` and route the canvas's input back to it.
 *
 * @param {import("./cdp.js").Cdp} cdp
 * @param {{ targetId: string, sessionId: string }} tab
 * @param {HTMLCanvasElement} canvas
 * @param {{ quality?: number }} [opts]
 * @returns {{ stop: () => void, resize: () => void, pause: () => void, resume: () => void, scale: () => number }}
 */
export function attachScreencast(cdp, tab, canvas, opts = {}) {
  const ctx2d = canvas.getContext("2d", { alpha: false });
  // 70 was chosen when this was the only surface and nobody had a sharp one to
  // compare against. Beside a real window it reads as soft on text, and a JPEG
  // artefact on a glyph is exactly what "the canvas looks blurry" is. The frames
  // travel over a local socket, so the extra bytes cost latency nobody can feel.
  const quality = Math.min(100, Math.max(1, opts.quality ?? 90));

  let running = false;
  let disposed = false;
  /** @type {ImageBitmap | null} Newest decoded frame awaiting a paint. */
  let pendingBitmap = null;
  let painting = false;
  let decoding = false;

  /**
   * How many DEVICE pixels one CSS pixel of the page actually occupies.
   *
   * THIS IS THE WHOLE ANSWER TO "WHY IS THE CANVAS BLURRY". A real window is
   * composited by the GPU at the resolution it is displayed at, whatever the
   * pane is doing. A stream is a bitmap, and this used to size that bitmap from
   * `clientWidth` times `devicePixelRatio` - the LAYOUT size. The canvas
   * workspace view scales its whole window layer with a CSS `transform`, and a
   * transform does not touch layout: `clientWidth` is identical at 40% and at
   * 200% zoom. So the page was rendered once at layout size and then stretched
   * by the compositor, which is exactly an upscale, which is exactly blur.
   *
   * `getBoundingClientRect()` DOES see the transform, so its width over
   * `clientWidth` is the real on-screen scale. Multiply by the display's own
   * ratio and the page renders at the resolution it is being shown at, which is
   * the same thing the window surface gets for free.
   *
   * Capped, because the cost is quadratic: a 900x600 pane at 3x is a 2700x1800
   * JPEG per frame. Floored at 1 so a zoomed-OUT pane still renders a page a
   * human could read if they zoom back in.
   */
  function renderScale() {
    const css = canvas.clientWidth || 1;
    const onScreen = canvas.getBoundingClientRect().width || css;
    return Math.min(
      MAX_RENDER_SCALE,
      Math.max(1, (onScreen / css) * (window.devicePixelRatio || 1)),
    );
  }

  /** Match the emulated viewport and the canvas bitmap to what is on screen. */
  async function applyMetrics() {
    const w = Math.max(1, Math.round(canvas.clientWidth));
    const h = Math.max(1, Math.round(canvas.clientHeight));
    const scale = renderScale();
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    await cdp
      .send(
        "Emulation.setDeviceMetricsOverride",
        { width: w, height: h, deviceScaleFactor: scale, mobile: false },
        tab.sessionId,
      )
      .catch(() => {
        // A tab that closed mid-resize. The stream stops on its own.
      });
  }

  function paint() {
    if (painting || !pendingBitmap || disposed) return;
    painting = true;
    requestAnimationFrame(() => {
      painting = false;
      const bmp = pendingBitmap;
      pendingBitmap = null;
      if (!bmp || disposed) return;
      try {
        ctx2d?.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      } finally {
        bmp.close();
      }
    });
  }

  const offFrame = cdp.on("Page.screencastFrame", (p, sessionId) => {
    if (sessionId !== tab.sessionId) return;
    // Rule 1: ack first, unconditionally. An un-acked frame stops the stream
    // dead, and every early return below is a reason not to draw, never a
    // reason to stall the producer.
    void cdp.send("Page.screencastFrameAck", { sessionId: p.sessionId }, tab.sessionId).catch(() => {});
    if (disposed || decoding) return; // Rule 2: newest wins, the rest are dropped.
    decoding = true;
    decode(p.data)
      .then((bmp) => {
        if (disposed) {
          bmp.close();
          return;
        }
        pendingBitmap?.close();
        pendingBitmap = bmp;
        paint();
      })
      .catch(() => {
        // A truncated frame; the next one repaints the whole viewport anyway.
      })
      .finally(() => (decoding = false));
  });

  async function start() {
    if (running || disposed) return;
    running = true;
    await applyMetrics();
    await cdp
      .send(
        "Page.startScreencast",
        {
          format: "jpeg",
          quality,
          maxWidth: canvas.width,
          maxHeight: canvas.height,
          everyNthFrame: 1,
        },
        tab.sessionId,
      )
      .catch(() => (running = false));
  }

  function stopCast() {
    if (!running) return;
    running = false;
    void cdp.send("Page.stopScreencast", {}, tab.sessionId).catch(() => {});
  }

  // --- input -------------------------------------------------------------
  //
  // Coordinates are the identity mapping thanks to the metrics override, so
  // `offsetX/offsetY` are page CSS pixels as they stand.

  const send = (method, params) => void cdp.send(method, params, tab.sessionId).catch(() => {});

  // --- the cursor ---------------------------------------------------------
  //
  // A REAL WINDOW CHANGES THE POINTER BY ITSELF; A BITMAP CANNOT. In the tabs
  // view the pane holds Chromium's own window, so the cursor turns into a hand
  // over a link because the real browser is under the mouse. Here the pane is a
  // `<canvas>`, and nothing about a JPEG says "this pixel is a link" - the page
  // stays visibly dead under the pointer, which is most of what makes a stream
  // feel like a picture rather than a browser.
  //
  // CDP streams no cursor, so it is asked for: the page resolves the element
  // under the point and answers with its computed `cursor`, which is then put on
  // the canvas. Throttled and movement-gated, because this is a round trip per
  // sample and the answer only changes when the pointer crosses into something
  // else.
  let cursorAt = 0;
  let cursorX = -999;
  let cursorY = -999;
  function trackCursor(x, y) {
    const now = performance.now();
    if (now - cursorAt < CURSOR_POLL_MS) return;
    if (Math.abs(x - cursorX) < CURSOR_MIN_MOVE_PX && Math.abs(y - cursorY) < CURSOR_MIN_MOVE_PX) {
      return;
    }
    cursorAt = now;
    cursorX = x;
    cursorY = y;
    cdp
      .send(
        "Runtime.evaluate",
        {
          expression: `(()=>{const e=document.elementFromPoint(${Math.round(x)},${Math.round(y)});return e?getComputedStyle(e).cursor:"auto"})()`,
          returnByValue: true,
        },
        tab.sessionId,
      )
      .then((r) => {
        if (disposed) return;
        const c = r?.result?.value;
        // `url(...)` cursors name an image this document cannot load, so they
        // would resolve to nothing and leave no cursor at all.
        if (typeof c === "string" && c && !c.includes("url(")) canvas.style.cursor = c;
      })
      .catch(() => {
        // A closed tab; the pane is about to go away with it.
      });
  }

  const onMouse = (e) => {
    if (e.type === "mousemove") trackCursor(e.offsetX, e.offsetY);
    const type =
      e.type === "mousedown" ? "mousePressed" : e.type === "mouseup" ? "mouseReleased" : "mouseMoved";
    send("Input.dispatchMouseEvent", {
      type,
      x: e.offsetX,
      y: e.offsetY,
      button: BUTTONS[e.button] ?? "none",
      buttons: e.buttons,
      clickCount: type === "mouseMoved" ? 0 : e.detail || 1,
      modifiers: modifiersOf(e),
    });
  };

  const onWheel = (e) => {
    e.preventDefault();
    send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: e.offsetX,
      y: e.offsetY,
      // PASSED THROUGH, NOT NEGATED. `Input.dispatchMouseEvent` uses the same
      // sign convention as a DOM wheel event - positive `deltaY` scrolls DOWN,
      // which is why `mouse.wheel({deltaY: -100})` is how every CDP client
      // scrolls up. Negating them, as this did, inverted the page against the
      // user's own wheel and against the physical scroll direction they had
      // configured. The legacy `WebMouseWheelEvent` convention is the opposite,
      // which is where the confusion comes from, but that is not this API.
      deltaX: e.deltaX,
      deltaY: e.deltaY,
      modifiers: modifiersOf(e),
    });
  };

  const onContextMenu = (e) => e.preventDefault();

  const onKey = (e) => {
    // The pane owns the keyboard while focused, but not the app's own chords:
    // swallowing Ctrl+Shift+P would take the command palette away from a user
    // who is looking at a web page, which is never what they meant.
    if ((e.ctrlKey || e.metaKey) && e.shiftKey) return;
    e.preventDefault();
    const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey;
    send("Input.dispatchKeyEvent", {
      type: e.type === "keyup" ? "keyUp" : printable ? "keyDown" : "rawKeyDown",
      key: e.key,
      code: e.code,
      windowsVirtualKeyCode: e.keyCode,
      nativeVirtualKeyCode: e.keyCode,
      modifiers: modifiersOf(e),
      ...(printable && e.type === "keydown" ? { text: e.key } : {}),
    });
  };

  // Composed text (IME, dead keys, dictation) never arrives as a keystroke, so
  // it needs its own route or it is silently lost for every non-Latin input.
  const onBeforeInput = (e) => {
    if (e.inputType !== "insertCompositionText" && e.inputType !== "insertFromComposition") return;
    if (e.data) send("Input.insertText", { text: e.data });
  };

  const onLeave = () => (canvas.style.cursor = "");
  canvas.addEventListener("mouseleave", onLeave);
  canvas.addEventListener("mousedown", onMouse);
  canvas.addEventListener("mouseup", onMouse);
  canvas.addEventListener("mousemove", onMouse);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("contextmenu", onContextMenu);
  canvas.addEventListener("keydown", onKey);
  canvas.addEventListener("keyup", onKey);
  canvas.addEventListener("beforeinput", onBeforeInput);

  void start();

  return {
    /** The scale the stream is currently rendered at. The surface watches this
     *  because a canvas ZOOM changes it without changing the layout box, so no
     *  ResizeObserver will ever fire for it. */
    scale: renderScale,
    stop() {
      if (disposed) return;
      disposed = true;
      offFrame();
      stopCast();
      pendingBitmap?.close();
      pendingBitmap = null;
      canvas.removeEventListener("mouseleave", onLeave);
      canvas.removeEventListener("mousedown", onMouse);
      canvas.removeEventListener("mouseup", onMouse);
      canvas.removeEventListener("mousemove", onMouse);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("contextmenu", onContextMenu);
      canvas.removeEventListener("keydown", onKey);
      canvas.removeEventListener("keyup", onKey);
      canvas.removeEventListener("beforeinput", onBeforeInput);
      // Leave the page at its real size rather than pinned to a pane that no
      // longer exists, or an agent screenshotting later gets the stale box.
      void cdp.send("Emulation.clearDeviceMetricsOverride", {}, tab.sessionId).catch(() => {});
    },
    resize() {
      if (disposed) return;
      // Restart rather than resize in place: `startScreencast` fixes maxWidth
      // and maxHeight at call time, so a grown pane would keep receiving the old
      // frame size and upscale it into a blur.
      stopCast();
      void start();
    },
    pause: stopCast,
    resume: () => void start(),
  };
}

/**
 * The screencast dressed as a window surface, so the pane can hold either.
 *
 * WHY THE PANE NEEDS TWO SURFACES AT ALL. A real Chromium window is the better
 * pane by every measure that matters at 1:1 - GPU-sharp text, the real pointer,
 * native `<select>` and autofill popups, and a real Chrome that Google will let
 * you sign in to. It is also an OS window, and an OS window cannot be scaled by
 * a CSS transform, cannot be stacked between two DOM elements, and cannot be
 * culled by a viewport. The canvas workspace view does all three: it puts every
 * pane on one `transform: translate() scale()` layer where windows overlap and
 * the whole surface zooms. So on the canvas the window is not merely awkward,
 * it is wrong - it would sit at the right rectangle showing a 1:1 CROP of a page
 * the user asked to see at 40%, over the top of every window stacked above it.
 *
 * A float window takes this surface for a different reason: an adopted window is
 * sent clicks by position but never takes the keyboard on its own, and the host
 * forwards focus to it from a window proc installed on the MAIN window only.
 *
 * Frames are an ordinary `<canvas>`, so everything above is free and exact: the
 * transform scales it, DOM order stacks it, `display:none` culls it, and it
 * takes the keyboard like any other element.
 *
 * THE ENGINE DOES NOT CHANGE. Both surfaces are the same real Chrome, the same
 * profile, the same target, and neither shows any Chrome UI - the browser runs
 * `--app=`, so the pane's toolbar is TEDI's on both. Switching views changes who
 * paints, never what is running, so a signed-in session and an open tab survive
 * one because none of them knew it happened.
 *
 * THE WINDOW IS PARKED, NOT HIDDEN, for as long as this surface lives. Hiding it
 * would clear `WS_VISIBLE`, and Chromium stops compositing a hidden window - the
 * stream would go silent and the pane would paint nothing. Parking keeps it
 * visible to the OS and out of sight, which is the state the cast needs. The
 * launch flags that stop an off-screen window being treated as occluded are in
 * `launch.js` and are part of the same contract.
 *
 * @param {import("./cdp.js").Cdp} cdp
 * @param {{ targetId: string, sessionId: string }} tab
 * @param {HTMLElement} stage
 * @returns {{ setVisible: (v: boolean) => void, invalidate: () => void, stop: () => void }}
 */
export function screencastSurface(cdp, tab, stage) {
  const canvas = document.createElement("canvas");
  canvas.className = "tb-cast";
  // Focusable, or the key handlers never fire: a `<canvas>` is not a control and
  // takes no focus on its own.
  canvas.tabIndex = 0;
  stage.appendChild(canvas);

  void park(cdp, tab.targetId).catch(() => {
    // Already gone; there is nothing on screen to move out of the way.
  });

  const cast = attachScreencast(cdp, tab, canvas);

  // The pane resizes for reasons it never hears about: a splitter drag, a canvas
  // window resize, a workspace relayout. `startScreencast` fixes its frame size
  // at call time, so a grown pane keeps receiving the old size and upscales it
  // into a blur until something restarts the stream.
  const ro = new ResizeObserver(() => cast.resize());
  ro.observe(canvas);

  // A ZOOM IS NOT A RESIZE, and no observer exists for it. The canvas view
  // scales its window layer with a CSS `transform`, which leaves the layout box
  // untouched - so `ResizeObserver` is silent while the pane goes from 40% to
  // 200% on screen and the stream stays at its old resolution, stretched. This
  // is the only way to notice. Compared at one decimal so a pinch does not
  // restart the stream on every frame, and it costs one `getBoundingClientRect`
  // a quarter second.
  let lastScale = cast.scale();
  const scaleTimer = setInterval(() => {
    const now = cast.scale();
    if (Math.abs(now - lastScale) < 0.1) return;
    lastScale = now;
    cast.resize();
  }, 250);

  let wanted = true;
  return {
    setVisible(next) {
      if (next === wanted) return;
      wanted = next;
      // Stopping the cast is the whole saving: a hidden pane otherwise costs a
      // full JPEG encode per frame for pixels nobody is looking at.
      if (next) cast.resume();
      else cast.pause();
    },
    invalidate() {
      cast.resize();
    },
    stop() {
      ro.disconnect();
      clearInterval(scaleTimer);
      cast.stop();
      canvas.remove();
    },
  };
}
