// Starting, adopting and stopping the Chromium process.
//
// HOW THE SOCKET ADDRESS IS FOUND. We ask for `--remote-debugging-port=0` and
// let Chromium pick a free port, then read the port AND the browser-target path
// out of `DevToolsActivePort`, a two-line file Chromium writes into its own
// profile directory. The alternative - pinning a fixed port - loses either way:
// a busy port makes Chromium exit silently, and a port we can reach is a port
// any other local process can reach too.
//
// WHY NO `fetch` TO `/json/version`. That endpoint would hand us the same URL
// and is blocked by CORS from this origin (see the header of `cdp.js`). The file
// is not a workaround for a missing API; it is the supported way.
//
// STALENESS TAKES CARE OF ITSELF. A `DevToolsActivePort` left behind by a dead
// Chromium names a port nothing is listening on, so the connect attempt fails
// and we launch. That is also what makes ADOPTION safe: if the file does
// connect, a Chromium with our profile is already running - reuse it instead of
// starting a second one, which Chromium would refuse anyway (one process owns a
// user-data-dir) and which would cost the user a whole extra process tree.

import { ctx, state, dataDir, join } from "./runtime.js";
import { Cdp } from "./cdp.js";
import { resolveEngine } from "./chromium.js";

/** How long to wait for a freshly spawned Chromium to publish its port. Cold
 *  starts on a slow disk genuinely take seconds; past this something is wrong
 *  and a clear error beats an indefinite spinner. */
const START_TIMEOUT_MS = 30_000;

/** Cap on the on-disk HTTP cache. The browser is a dev tool, not the user's
 *  daily driver, and an uncapped Chromium cache grows into the gigabytes -
 *  exactly the storage cost this extension exists to avoid. */
const DISK_CACHE_BYTES = 200 * 1024 * 1024;

function profileDir() {
  return join(dataDir(), "profile");
}

/** Where a user drops UNPACKED Chrome extensions to have them loaded. */
export function unpackedExtensionsDir() {
  return join(dataDir(), "extensions");
}

/**
 * Unpacked extension folders to load, newline-free and comma-joined for Chromium.
 *
 * THE ONLY WAY TO GET AN EXTENSION FROM INSIDE TEDI. A Web Store install lands
 * in the profile and is carried by it, but reaching the Store needs Chrome's own
 * toolbar, and a pane has none - the browser runs `--app=`. An unpacked folder
 * needs no UI at all: `--load-extension` is applied at startup, so dropping an
 * ad blocker's unpacked build in here makes it live on the next launch.
 *
 * A folder counts only if it holds a `manifest.json`, so a half-finished
 * download or a stray README cannot make Chromium refuse to start - it exits
 * outright on a bad `--load-extension` path rather than skipping it.
 */
async function unpackedExtensions() {
  try {
    const res = await ctx.invoke("fs_glob", {
      pattern: "*/manifest.json",
      root: unpackedExtensionsDir(),
      maxResults: 50,
    });
    // Drop the trailing `manifest.json` segment to get the folder. Done by
    // index rather than by regex because the separator differs per platform and
    // a Windows path is full of backslashes a pattern would have to escape.
    const dirs = (res?.hits ?? [])
      .map((h) => String(h.path))
      .map((p) => p.slice(0, Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"))))
      .filter(Boolean);
    return [...new Set(dirs)];
  } catch {
    // No such directory yet: the common case, and not worth reporting.
    return [];
  }
}

/**
 * Flags for a Chromium we own.
 *
 * Every entry past the first four is there to make the process cheaper or
 * quieter, not to change how pages render:
 *   - component update and background networking are pure background traffic
 *     and disk growth for a browser that lives minutes at a time;
 *   - the mock keychain stops macOS and Linux prompting for keychain access on
 *     first launch, a modal that would appear over a pane and belong to nothing;
 *   - the disk cache cap is the storage budget.
 *
 * `parked` is how a window stays out of the way until a pane claims it: born far
 * off-screen at a fixed size, rather than not drawn at all. See the note on
 * PARK_ARGS below for why not-drawn is not an option.
 *
 * @param {boolean} parked Start the first window off-screen.
 */
async function args(parked) {
  const list = [
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir()}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--metrics-recording-only",
    "--disable-breakpad",
    "--password-store=basic",
    "--use-mock-keychain",
    // A pane is not where anyone wants to answer "Restore pages?". The browser
    // is stopped whenever the last pane closes and on the idle timeout, so
    // Chromium sees an unclean exit as a matter of course and would offer to
    // restore on every single launch.
    "--hide-crash-restore-bubble",
    "--disable-session-crashed-bubble",
    // KEEP PAINTING WHILE NOBODY CAN SEE THE WINDOW. These four are what make
    // the screencast surface possible at all. A pane on the canvas parks its
    // window at -32000 and streams frames out of it, and a window that
    // intersects no display is exactly what native occlusion tracking calls
    // occluded: Chromium then hides the WebContents, the compositor stops
    // submitting frames, and `Page.startScreencast` goes silent. The pane paints
    // one frame and freezes, while clicks still land - a dead-looking browser
    // that is in fact perfectly alive.
    //
    // It never came up before because the previous streaming design ran
    // `--headless=new`, where there is no native window to occlude. Headless is
    // gone (Google refuses a sign-in to `HeadlessChrome`), so the opt-out has to
    // be explicit. Same four flags, for the same reason, as the ones the
    // built-in browser used to pass.
    "--disable-features=CalculateNativeWinOcclusion",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-background-timer-throttling",
    // WHY THIS IS NOT COSMETIC. --remote-debugging-port on its own, with no
    // --enable-automation anywhere, is enough to make Chrome report
    // navigator.webdriver === true, and that one boolean is what Google refuses
    // a sign-in over ("This browser or app may not be secure"). It made Gmail,
    // Docs and every OAuth consent screen unreachable from a pane, while the
    // engine was in fact branded Chrome the whole time. This flag turns off the
    // Blink feature that publishes the boolean and touches nothing else: the
    // port, the socket and every tool here behave exactly as before.
    "--disable-blink-features=AutomationControlled",
    // AND THE PRICE OF THE FLAG ABOVE. Chrome answers an unsupported switch with
    // a yellow bar under the toolbar - "You are using an unsupported
    // command-line flag ... Stability and security will suffer" - which in a
    // pane is a permanent strip of Chrome UI the user cannot do anything about.
    // This is the supported way to silence exactly that warning.
    //
    // MEASURED, not assumed, because it must not undo the sign-in fix: with and
    // without it, navigator.webdriver stays false and userAgentData.brands stays
    // "Chromium | Not?A_Brand | Google Chrome". It hides the bar and nothing
    // else that a page can see.
    "--test-type",
    `--disk-cache-size=${DISK_CACHE_BYTES}`,
  ];
  // Shared-memory in containers and some Linux desktops is too small for
  // Chromium's default, and the crash it causes looks like a GPU fault.
  if (ctx.os?.platform === "linux") list.push("--disable-dev-shm-usage");
  // NEVER `--headless`. A headless Chromium reports `HeadlessChrome` in its user
  // agent and Google refuses a sign-in from it outright - so the one thing a
  // browser must be able to do would not work. It also produces no window for
  // the GPU to composite, and a window is precisely what a pane displays. The
  // first one is hidden by PLACEMENT instead: born off-screen, then moved onto
  // the pane rectangle that claims it.
  if (parked) list.push(...PARK_ARGS);
  list.push(`--remote-allow-origins=${allowedOrigin()}`);
  const unpacked = await unpackedExtensions();
  if (unpacked.length) list.push(`--load-extension=${unpacked.join(",")}`);
  return list;
}

/**
 * The page a new window starts on.
 *
 * NOT `about:blank`, AND THAT IS NOT A PREFERENCE. Chrome applies `--app=` only
 * to an http(s) or data: URL and silently ignores it for anything else, so
 * `--app=about:blank` opens an ORDINARY window with a tab strip and an omnibox.
 * Measured on Chrome 152: a normal window and `--app=about:blank` both report
 * 95px of browser UI (outerHeight - innerHeight), `--app=chrome://version` the
 * same 95px, while `--app=https://...` and `--app=data:text/html,...` both
 * report 39px, i.e. the thin frame and nothing else.
 *
 * So the blank page has to be a data: URL. It also costs no network round trip,
 * unlike the default new-tab page, which would fill the pane with Google's
 * shortcuts before the user has asked for anything. Percent-encoded so the whole
 * thing is one argv element with no quoting anywhere.
 */
const START_PAGE = "data:text/html,%3Ctitle%3ENew%20tab%3C%2Ftitle%3E";

/** Where a window is born, so it never flashes on screen before the pane has
 *  told it where to be. */
const PARK_ARGS = ["--window-position=-32000,-32000", "--window-size=1000,700"];

/**
 * The origin Chromium must accept a DevTools WebSocket from.
 *
 * WITHOUT THIS NOTHING CONNECTS. Chrome refuses any WebSocket upgrade to its
 * debugging endpoint that carries an `Origin` header, answering 403 with
 * "Rejected an incoming WebSocket connection from the <origin> origin". Every
 * socket opened from a web page carries one, so the extension - which lives in
 * TEDI's webview - is refused on every attempt, while a plain CLI client (which
 * sends no Origin) connects fine. That asymmetry is what makes it look like a
 * hang rather than a rejection.
 *
 * Read from `location.origin` rather than hardcoded, because it differs by build
 * and platform: `http://localhost:1420` in dev, `http://tauri.localhost` on
 * Windows, `tauri://localhost` elsewhere. Exactly one origin is allowed - `*`
 * would let any page that can guess the port drive this browser, and CDP has no
 * authentication of its own to fall back on.
 */
function allowedOrigin() {
  try {
    const o = globalThis.location?.origin;
    if (typeof o === "string" && o && o !== "null") return o;
  } catch {
    // No `location` (a non-DOM host); fall through to the Tauri default.
  }
  return "http://tauri.localhost";
}

/** Read `DevToolsActivePort` and build the browser-target socket URL, or `null`
 *  when the file is absent or half-written (Chromium writes it in one go, but a
 *  read racing the write still sees one line). */
async function readSocketUrl() {
  try {
    const file = await ctx.invoke("fs_read_file", {
      path: join(profileDir(), "DevToolsActivePort"),
    });
    if (file.kind !== "text") return null;
    const [port, path] = file.content.split(/\r?\n/);
    if (!port || !path) return null;
    return `ws://127.0.0.1:${port.trim()}${path.trim()}`;
  } catch {
    return null;
  }
}

/** Connect to a Chromium that is already running with our profile, or `null`. */
async function adopt() {
  const url = await readSocketUrl();
  if (!url) return null;
  try {
    return await Cdp.connect(url);
  } catch {
    // A stale file. Not worth reporting: the caller launches next.
    return null;
  }
}

/**
 * Bring up Chromium and return a live CDP client.
 *
 * Concurrency-safe by construction: the in-flight promise is stored, so five
 * panes mounting at once share ONE launch instead of racing to start five
 * browsers against the same profile directory.
 *
 * @param {(msg: string) => void} [say] Progress for first-run engine setup.
 * @param {boolean} [parked] Start the first window off-screen; a pane moves it
 *   onto itself once it has claimed it.
 * @returns {Promise<Cdp>}
 */
export function ensureBrowser(say, parked = true) {
  if (state.cdp && !state.cdp.closed) return Promise.resolve(state.cdp);
  if (state.starting) return state.starting;

  state.starting = (async () => {
    const existing = await adopt();
    if (existing) return bind(existing);

    const engine = await resolveEngine(say);
    say?.("Starting the browser...");
    state.proc = await ctx.invoke("shell_bg_spawn_direct", {
      program: engine,
      // `--app=` rather than a bare url: an app window has no tab strip, no
      // omnibox and no menu, which is what lets the pane's own toolbar be the
      // only chrome on both surfaces. See the header of `toolbar.js`.
      args: [...(await args(parked)), `--app=${START_PAGE}`],
    });

    const deadline = Date.now() + START_TIMEOUT_MS;
    for (;;) {
      const url = await readSocketUrl();
      if (url) {
        try {
          return bind(await Cdp.connect(url));
        } catch {
          // Written but not listening yet; keep polling.
        }
      }
      if (Date.now() > deadline) {
        await stopBrowser();
        throw new Error("Chromium started but never opened its DevTools port.");
      }
      await new Promise((r) => setTimeout(r, 150));
    }
  })();

  // Clear the latch whichever way it settles, so a failed launch can be retried
  // rather than handing every later caller the same rejected promise forever.
  state.starting.catch(() => {}).finally(() => (state.starting = null));
  return state.starting;
}

/** @param {Cdp} cdp */
function bind(cdp) {
  state.cdp = cdp;
  cdp.onClose(() => {
    // Chromium exited, or was killed by us. Drop every derived handle so the
    // next pane starts clean instead of sending into a dead socket.
    state.cdp = null;
    state.tabs.clear();
    state.activeTargetId = null;
  });
  return cdp;
}

/** Stop the browser and forget it. Safe to call when nothing is running. */
export async function stopBrowser() {
  state.cdp?.close();
  state.cdp = null;
  state.tabs.clear();
  state.activeTargetId = null;
  if (state.proc != null) {
    await ctx.invoke("shell_bg_kill", { handle: state.proc }).catch(() => {});
    state.proc = null;
  }
}

/**
 * Re-arm the idle shutdown.
 *
 * Called whenever a pane mounts or unmounts. A browser nobody is looking at is
 * a few hundred MB of resident memory doing nothing, so the last pane closing
 * starts a clock. Zero minutes means the user asked to keep it warm.
 */
export async function armIdleShutdown() {
  if (state.idleTimer) {
    clearTimeout(state.idleTimer);
    state.idleTimer = null;
  }
  if (state.panes > 0) return;
  let minutes = 10;
  try {
    const v = await ctx.settings.get("idleShutdownMinutes");
    if (typeof v === "number" && v >= 0) minutes = v;
  } catch {
    // Settings unreadable; the default is the safe, cheap answer.
  }
  if (minutes === 0) return;
  state.idleTimer = setTimeout(() => {
    if (state.panes === 0) void stopBrowser();
  }, minutes * 60_000);
}



/**
 * Open one more browser window, for a second pane.
 *
 * Asked of the RUNNING browser over CDP rather than by starting another
 * process. Spawning relies on Chromium noticing that the profile is already
 * open and relaying the command line to the instance that owns it - which works,
 * but costs a process launch, and hands back nothing: the new target then has to
 * be found by diffing the target list against a snapshot. `Target.createTarget`
 * simply answers with the id.
 *
 * @param {string} url
 * @returns {Promise<string>} the new window's target id
 */
export async function openPaneWindow(url) {
  const cdp = await ensureBrowser();
  const engine = await resolveEngine();
  const before = await pageTargetIds(cdp);
  // Relayed, not created. Chromium notices the profile is already open and hands
  // the command line to the instance that owns it, which opens the window - so
  // this costs a process launch that exits immediately, and the new target has
  // to be found by diffing. `Target.createTarget` would answer with the id
  // directly and is what this used to do, but it cannot make an APP window, and
  // an app window is the whole point: no tab strip, no omnibox, no menu.
  //
  // `PARK_ARGS` rides along so the window is born off-screen. Without it every
  // second pane, and every agent `open` with `newTab`, flashed a real Chrome
  // window at the OS default position before the pane could place it.
  await ctx
    .invoke("shell_bg_spawn_direct", {
      program: engine,
      args: [`--user-data-dir=${profileDir()}`, ...PARK_ARGS, `--app=${url || START_PAGE}`],
    })
    .catch(() => {
      // The spawn itself failing is reported by the wait below timing out, with
      // a message about the window rather than about a process the caller never
      // asked for.
    });

  const deadline = Date.now() + NEW_WINDOW_TIMEOUT_MS;
  for (;;) {
    const now = await pageTargetIds(cdp);
    for (const id of now) if (!before.has(id)) return id;
    if (Date.now() > deadline) throw new Error("Chromium did not open a new window.");
    await new Promise((r) => setTimeout(r, 60));
  }
}

/** How long to wait for a relayed command line to become a window. Generous:
 *  the relay is a whole process start, and the alternative to waiting is a pane
 *  that reports failure while the window is still on its way. */
const NEW_WINDOW_TIMEOUT_MS = 10_000;

/** Page targets, devtools excluded, as a set of ids. The diff `openPaneWindow`
 *  compares against. */
async function pageTargetIds(cdp) {
  const { targetInfos } = await cdp.send("Target.getTargets").catch(() => ({ targetInfos: [] }));
  const out = new Set();
  for (const t of targetInfos ?? []) {
    if (t.type === "page" && !t.url.startsWith("devtools://")) out.add(t.targetId);
  }
  return out;
}
