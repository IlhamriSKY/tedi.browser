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
 * TWO WAYS TO GET AN EXTENSION, and this is the one that always works. A Web
 * Store install lands in the profile and is carried by it, but the Store itself
 * needs a visible window (see `openExtensionManager`). An unpacked folder needs
 * neither: `--load-extension` is honoured in headless, so dropping an ad
 * blocker's unpacked build in here makes it live on the next launch with no UI
 * at all.
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
 *     first launch, a modal the user cannot see when we run headless;
 *   - the disk cache cap is the storage budget.
 *
 * `--headless=new` is the real headless: a full Chromium, extensions included,
 * with no OS window. It is what makes the pane the only place the page appears.
 *
 * @param {boolean} headless
 */
async function args(headless) {
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
    `--disk-cache-size=${DISK_CACHE_BYTES}`,
  ];
  // Shared-memory in containers and some Linux desktops is too small for
  // Chromium's default, and the crash it causes looks like a GPU fault.
  if (ctx.os?.platform === "linux") list.push("--disable-dev-shm-usage");
  if (headless) list.push("--headless=new");
  const unpacked = await unpackedExtensions();
  if (unpacked.length) list.push(`--load-extension=${unpacked.join(",")}`);
  return list;
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
 * @param {boolean} [headless]
 * @returns {Promise<Cdp>}
 */
export function ensureBrowser(say, headless = true) {
  if (state.cdp && !state.cdp.closed) return Promise.resolve(state.cdp);
  if (state.starting) return state.starting;

  state.starting = (async () => {
    const existing = await adopt();
    if (existing) return bind(existing);

    const engine = await resolveEngine(say);
    say?.("Starting the browser...");
    state.proc = await ctx.invoke("shell_bg_spawn_direct", {
      program: engine,
      args: await args(headless),
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
 * Open a visible Chromium window on `chrome://extensions`.
 *
 * The Chrome Web Store cannot be used headlessly, and one process owns a
 * user-data-dir, so this stops the headless instance first. Whatever the user
 * installs lands in the profile and is there the next time a pane opens.
 */
export async function openExtensionManager() {
  await stopBrowser();
  const engine = await resolveEngine();
  state.proc = await ctx.invoke("shell_bg_spawn_direct", {
    program: engine,
    args: [...(await args(false)), "chrome://extensions"],
  });
}
