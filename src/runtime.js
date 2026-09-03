// Shared context and process-wide state.
//
// The host hands `ctx` to `activate()` once. Every other module needs it, and
// threading it through eight call chains would be noise, so it lives here and is
// set exactly once. Everything else in this file is state that must be a
// SINGLETON per extension load: one Chromium, one CDP socket, one tab table. A
// second copy of any of them would mean a second browser process the user never
// asked for.

/** @type {import("../tedi").ExtensionContext} */
export let ctx;

/** @param {import("../tedi").ExtensionContext} value */
export function setCtx(value) {
  ctx = value;
}

/**
 * Live singletons.
 *
 * `engine` is the resolved browser binary, `proc` its background handle, `cdp`
 * the open socket, `tabs` the targets we own. `panes` counts mounted browser
 * panes: it drives the idle shutdown, so a user who closes the last pane stops
 * paying for a Chromium they cannot see.
 */
export const state = {
  /** @type {string | null} Absolute path of the resolved Chromium binary. */
  engine: null,
  /** @type {"chrome" | "edge" | "brave" | "chromium" | "downloaded" | null} */
  engineKind: null,
  /** @type {number | null} `shell_bg_spawn_direct` handle for our Chromium. */
  proc: null,
  /** @type {import("./cdp.js").Cdp | null} */
  cdp: null,
  /** @type {Map<string, { targetId: string, sessionId: string, url: string, title: string }>} */
  tabs: new Map(),
  /** @type {string | null} targetId the panes currently show. */
  activeTargetId: null,
  /** Mounted browser panes. Zero means nothing is watching. */
  panes: 0,
  /** @type {ReturnType<typeof setTimeout> | null} */
  idleTimer: null,
  /** Set while `ensureBrowser()` is in flight, so five callers share one launch. */
  /** @type {Promise<import("./cdp.js").Cdp> | null} */
  starting: null,
  /** Listeners notified when the tab table or active tab changes. */
  /** @type {Set<() => void>} */
  listeners: new Set(),
};

/** Tell every mounted pane that the tab table moved. */
export function emitTabsChanged() {
  for (const fn of state.listeners) {
    try {
      fn();
    } catch {
      // A broken renderer must not stop the others from repainting.
    }
  }
}

/** Home directory with no trailing separator, or `""` when unresolvable. */
export function home() {
  return ctx.paths?.home ?? "";
}

/** Where this extension keeps its Chromium profile and any downloaded engine.
 *  Outside the install folder on purpose: an extension update replaces that
 *  folder, and a 170 MB engine plus a logged-in profile must survive one. */
export function dataDir() {
  return `${home()}/.tedi/browser`;
}

/** `true` on Windows, where paths are backslashed and binaries end in `.exe`. */
export function isWindows() {
  return ctx.os?.platform === "windows";
}

/**
 * Join with the separator the OS shell will accept.
 *
 * Forward slashes work in Win32 APIs, but a path handed to `cmd`-quoting rules
 * does not always survive, so normalise once here rather than at nine call
 * sites. Falsy parts are dropped, which is what makes `join(home, ...)` safe
 * when the host could not resolve a home directory.
 *
 * @param {...(string | undefined)} parts
 * @returns {string}
 */
export function join(...parts) {
  const sep = isWindows() ? "\\" : "/";
  return parts
    .filter(Boolean)
    .map((p) => String(p).replace(/[/\\]+$/, ""))
    .join(sep);
}
