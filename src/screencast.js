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

/** CDP modifier bits. */
const ALT = 1;
const CTRL = 2;
const META = 4;
const SHIFT = 8;

/** @param {KeyboardEvent | MouseEvent | WheelEvent} e */
function modifiersOf(e) {
  return (e.altKey ? ALT : 0) | (e.ctrlKey ? CTRL : 0) | (e.metaKey ? META : 0) | (e.shiftKey ? SHIFT : 0);
}

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
 * @returns {{ stop: () => void, resize: () => void, pause: () => void, resume: () => void }}
 */
export function attachScreencast(cdp, tab, canvas, opts = {}) {
  const ctx2d = canvas.getContext("2d", { alpha: false });
  const quality = Math.min(100, Math.max(1, opts.quality ?? 70));

  let running = false;
  let disposed = false;
  /** @type {ImageBitmap | null} Newest decoded frame awaiting a paint. */
  let pendingBitmap = null;
  let painting = false;
  let decoding = false;

  const dpr = () => Math.min(2, window.devicePixelRatio || 1);

  /** Match the emulated viewport and the canvas bitmap to the pane's CSS box.
   *  Capped at 2x: beyond that the extra pixels cost encode time the user
   *  cannot see on a page of text. */
  async function applyMetrics() {
    const w = Math.max(1, Math.round(canvas.clientWidth));
    const h = Math.max(1, Math.round(canvas.clientHeight));
    const scale = dpr();
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

  const onMouse = (e) => {
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
      deltaX: -e.deltaX,
      deltaY: -e.deltaY,
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
    stop() {
      if (disposed) return;
      disposed = true;
      offFrame();
      stopCast();
      pendingBitmap?.close();
      pendingBitmap = null;
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
