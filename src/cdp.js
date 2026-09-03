// A minimal Chrome DevTools Protocol client over one WebSocket.
//
// WHY A SOCKET AND NOT `fetch`. CDP has an HTTP side (`/json/version`,
// `/json/list`) which would be the obvious way to discover targets - and it is
// unreachable from here. TEDI runs on the `tauri.localhost` origin, Chrome sends
// no `Access-Control-Allow-Origin` on those endpoints, so every such request
// dies in CORS preflight. WebSockets are not subject to CORS, so the socket is
// not merely the nicer transport: it is the only one. The one URL we cannot ask
// for over the socket - the socket's own address - comes off disk instead, from
// `DevToolsActivePort` (see `launch.js`).
//
// FLAT SESSIONS. `Target.attachToTarget({ flatten: true })` multiplexes every
// tab down this one socket, tagged with `sessionId`. The alternative - a socket
// per tab - means N sockets, N reconnect paths and N failure modes for no gain.

/** Rejects a command that never came back, so one wedged tab cannot hang a tool
 *  call forever. Chosen well above a slow page load, because `Page.navigate`
 *  legitimately takes seconds; anything past this is a lost message. */
const COMMAND_TIMEOUT_MS = 30_000;

export class Cdp {
  /** @param {WebSocket} ws */
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    /** @type {Map<number, { resolve: (v: any) => void, reject: (e: Error) => void, timer: any }>} */
    this.pending = new Map();
    /** @type {Map<string, Set<(params: any, sessionId?: string) => void>>} */
    this.handlers = new Map();
    /** @type {Set<() => void>} */
    this.closeHandlers = new Set();
    this.closed = false;

    ws.addEventListener("message", (ev) => this.#onMessage(String(ev.data)));
    ws.addEventListener("close", () => this.#onClose());
    ws.addEventListener("error", () => this.#onClose());
  }

  /**
   * Open a socket and resolve once it is ready.
   *
   * Rejects on close-before-open rather than hanging: a Chromium that died
   * during startup closes the socket without ever opening it, and a caller
   * awaiting a promise that settles neither way is the worst of the three
   * outcomes.
   *
   * @param {string} url
   * @returns {Promise<Cdp>}
   */
  static connect(url) {
    return new Promise((resolve, reject) => {
      let ws;
      try {
        ws = new WebSocket(url);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      const fail = () => reject(new Error(`CDP socket refused: ${url}`));
      ws.addEventListener("open", () => resolve(new Cdp(ws)), { once: true });
      ws.addEventListener("error", fail, { once: true });
      ws.addEventListener("close", fail, { once: true });
    });
  }

  /**
   * Send one command and await its result.
   *
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   * @param {string} [sessionId] Omit to address the browser itself.
   * @returns {Promise<any>}
   */
  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error("CDP socket is closed."));
    const id = this.nextId++;
    const msg = sessionId ? { id, method, params, sessionId } : { id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${COMMAND_TIMEOUT_MS}ms.`));
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify(msg));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Subscribe to a CDP event. Returns an unsubscribe function.
   *
   * Not filtered by `sessionId` here: a caller that cares gets it as the second
   * argument, and the common case (one active tab) would pay a lookup per event
   * for nothing. Screencast frames arrive at up to 60/s, so this path stays
   * allocation-free on purpose.
   *
   * @param {string} method
   * @param {(params: any, sessionId?: string) => void} cb
   */
  on(method, cb) {
    let set = this.handlers.get(method);
    if (!set) {
      set = new Set();
      this.handlers.set(method, set);
    }
    set.add(cb);
    return () => set.delete(cb);
  }

  /** Run `cb` when the socket drops, however it dropped. */
  onClose(cb) {
    this.closeHandlers.add(cb);
    return () => this.closeHandlers.delete(cb);
  }

  close() {
    if (this.closed) return;
    try {
      this.ws.close();
    } catch {
      // Already gone; `#onClose` still needs to run so callers unblock.
    }
    this.#onClose();
  }

  /** @param {string} data */
  #onMessage(data) {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return; // Not protocol; nothing useful to do with it.
    }
    if (msg.id !== undefined) {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) entry.reject(new Error(msg.error.message ?? "CDP error"));
      else entry.resolve(msg.result);
      return;
    }
    const set = this.handlers.get(msg.method);
    if (!set) return;
    for (const cb of set) {
      try {
        cb(msg.params, msg.sessionId);
      } catch {
        // One bad subscriber must not drop the frame for the others.
      }
    }
  }

  #onClose() {
    if (this.closed) return;
    this.closed = true;
    // Reject every in-flight command. Left pending they would hit the 30s
    // timeout one by one and report "timed out" for what is really "the browser
    // exited" - a materially misleading error to hand a user or a model.
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error("Chromium closed the DevTools connection."));
    }
    this.pending.clear();
    this.handlers.clear();
    for (const cb of this.closeHandlers) {
      try {
        cb();
      } catch {
        // Teardown must finish even if one listener throws.
      }
    }
    this.closeHandlers.clear();
  }
}
