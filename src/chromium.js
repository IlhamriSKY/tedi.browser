// Finding a Chromium to drive, and fetching one only when there is none.
//
// THE STORAGE RULE THIS FILE EXISTS FOR. TEDI installs at ~19 MB. Bundling a
// browser would put it past 190 MB for every user, including the ones who never
// open a browser pane. So: look for a Chromium the machine already has - Chrome,
// Edge, Brave or Chromium itself, any of which speaks the same CDP - and only
// fall back to downloading Chrome for Testing when the search comes up empty.
// On Windows that search practically always succeeds, because Edge ships with
// the OS. macOS and Linux may genuinely have none, which is the case the
// download exists for.
//
// WHY THE PROCESS SPAWNER AND NOT THE SHELL. Every external call here goes
// through `shell_bg_spawn_direct` (program + argv, no shell). `curl` on Windows
// PowerShell 5.1 is an ALIAS for `Invoke-WebRequest`, which takes different
// flags and would fail in a way that reads as a network error; `tar` and paths
// with spaces bring their own quoting rules per shell. Passing argv directly has
// none of those failure modes, and gives progress polling for free.

import { ctx, state, dataDir, join, isWindows } from "./runtime.js";

/** Where Chrome for Testing lists its current builds. Reachable only through
 *  `curl`: this webview cannot `fetch` a cross-origin URL that sends no CORS
 *  headers, and this endpoint sends none. */
const CFT_VERSIONS_URL =
  "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json";

/**
 * Where each platform keeps a Chromium-family browser, best first.
 *
 * Ordered by how likely the binary is to be a full, current Chromium the user
 * already keeps updated. Chrome first, then Edge (always present on Windows, so
 * it is the guaranteed floor there), then Brave, then a bare Chromium.
 *
 * Windows entries are absolute because the install locations are fixed by the
 * installers. POSIX entries for Linux are bare names resolved through `PATH`,
 * because distributions disagree about the prefix.
 */
function candidates() {
  const os = ctx.os?.platform;
  const home = ctx.paths?.home ?? "";
  if (os === "windows") {
    const pf = "C:\\Program Files";
    const pf86 = "C:\\Program Files (x86)";
    const local = join(home, "AppData", "Local");
    return [
      { kind: "chrome", path: `${pf}\\Google\\Chrome\\Application\\chrome.exe` },
      { kind: "chrome", path: `${pf86}\\Google\\Chrome\\Application\\chrome.exe` },
      { kind: "chrome", path: `${local}\\Google\\Chrome\\Application\\chrome.exe` },
      { kind: "edge", path: `${pf86}\\Microsoft\\Edge\\Application\\msedge.exe` },
      { kind: "edge", path: `${pf}\\Microsoft\\Edge\\Application\\msedge.exe` },
      { kind: "brave", path: `${pf}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe` },
      { kind: "chromium", path: `${local}\\Chromium\\Application\\chrome.exe` },
    ];
  }
  if (os === "macos") {
    return [
      { kind: "chrome", path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
      {
        kind: "edge",
        path: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      },
      {
        kind: "brave",
        path: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      },
      { kind: "chromium", path: "/Applications/Chromium.app/Contents/MacOS/Chromium" },
    ];
  }
  return [
    { kind: "chrome", name: "google-chrome-stable" },
    { kind: "chrome", name: "google-chrome" },
    { kind: "chromium", name: "chromium" },
    { kind: "chromium", name: "chromium-browser" },
    { kind: "edge", name: "microsoft-edge" },
    { kind: "brave", name: "brave-browser" },
  ];
}

/** Does an absolute file exist? `fs_glob` is the only existence check in the
 *  permission set, and globbing the basename inside its own directory is the
 *  cheapest question it answers. */
async function fileExists(absPath) {
  const sep = absPath.includes("\\") ? "\\" : "/";
  const cut = absPath.lastIndexOf(sep);
  if (cut < 1) return false;
  try {
    const res = await ctx.invoke("fs_glob", {
      pattern: absPath.slice(cut + 1),
      root: absPath.slice(0, cut),
      maxResults: 1,
    });
    return (res?.hits?.length ?? 0) > 0;
  } catch {
    // A root that does not exist is a normal miss, not a failure to report.
    return false;
  }
}

/**
 * Run a program to completion and return its stdout.
 *
 * `shell_bg_*` is the only spawner in the permission set that takes argv rather
 * than a command line, which is exactly why it is used for a one-shot call: see
 * the note at the top of this file about `curl` being a PowerShell alias.
 *
 * @param {string} program
 * @param {string[]} args
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<{ out: string, code: number }>}
 */
async function run(program, args, { timeoutMs = 120_000 } = {}) {
  const handle = await ctx.invoke("shell_bg_spawn_direct", { program, args });
  let offset = 0;
  let out = "";
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const log = await ctx.invoke("shell_bg_logs", { handle, sinceOffset: offset });
    offset = log.next_offset;
    if (log.bytes) out += log.bytes;
    if (log.exited) return { out, code: log.exit_code ?? 0 };
    if (Date.now() > deadline) {
      await ctx.invoke("shell_bg_kill", { handle }).catch(() => {});
      throw new Error(`${program} did not finish within ${Math.round(timeoutMs / 1000)}s.`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * The Chromium this machine already has, or `null`.
 *
 * Windows and macOS test fixed paths. Linux asks the shell resolver, because
 * `/usr/bin`, `/usr/local/bin`, `/snap/bin` and Flatpak exports all hold real
 * installs and hardcoding that list would be wrong on the next distribution.
 */
async function findInstalled() {
  for (const c of candidates()) {
    if (c.path) {
      if (await fileExists(c.path)) return { kind: c.kind, path: c.path };
      continue;
    }
    try {
      const { out, code } = await run("command", ["-v", c.name], { timeoutMs: 5_000 });
      const hit = out.trim().split(/\r?\n/)[0];
      if (code === 0 && hit) return { kind: c.kind, path: hit };
    } catch {
      // `command` is a shell builtin on some systems and not spawnable. `which`
      // is the portable external, so fall through to it rather than giving up
      // on the whole platform.
      try {
        const { out, code } = await run("which", [c.name], { timeoutMs: 5_000 });
        const hit = out.trim().split(/\r?\n/)[0];
        if (code === 0 && hit) return { kind: c.kind, path: hit };
      } catch {
        // Neither resolver is available; the next candidate may still hit.
      }
    }
  }
  return null;
}

/** Chrome for Testing platform key, and where the binary sits inside its zip.
 *  `null` for a platform Chrome for Testing does not build, so the caller can
 *  say so plainly instead of downloading a zip that cannot contain an engine. */
function cftTarget() {
  const os = ctx.os?.platform;
  const arm = ctx.os?.arch === "aarch64";
  if (os === "windows") return { key: "win64", rel: ["chrome-win64", "chrome.exe"] };
  if (os === "macos") {
    return arm
      ? {
          key: "mac-arm64",
          rel: [
            "chrome-mac-arm64",
            "Google Chrome for Testing.app",
            "Contents",
            "MacOS",
            "Google Chrome for Testing",
          ],
        }
      : {
          key: "mac-x64",
          rel: [
            "chrome-mac-x64",
            "Google Chrome for Testing.app",
            "Contents",
            "MacOS",
            "Google Chrome for Testing",
          ],
        };
  }
  if (os === "linux" && !arm) return { key: "linux64", rel: ["chrome-linux64", "chrome"] };
  return null;
}

/** Unpack a zip with whatever the platform actually ships.
 *  Windows and macOS both have bsdtar as `tar`, which reads zip. GNU tar on
 *  Linux does not, so `unzip` leads there, with Python as the last resort
 *  because a headless server may have neither archiver. */
async function unzip(zipPath, destDir) {
  /** @type {[string, string[]][]} */
  const attempts = isWindows()
    ? [["tar", ["-xf", zipPath, "-C", destDir]]]
    : [
        ["unzip", ["-q", "-o", zipPath, "-d", destDir]],
        ["tar", ["-xf", zipPath, "-C", destDir]],
        ["python3", ["-m", "zipfile", "-e", zipPath, destDir]],
      ];
  let lastErr = null;
  for (const [program, args] of attempts) {
    try {
      const { code } = await run(program, args, { timeoutMs: 300_000 });
      if (code === 0) return;
      lastErr = new Error(`${program} exited ${code}`);
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw new Error(
    `Could not unpack the Chromium download. Install unzip, or put Chrome or Chromium on this machine. (${lastErr?.message ?? "no archiver"})`,
  );
}

/**
 * Download Chrome for Testing into the extension data directory.
 *
 * `--create-dirs` is what makes the destination exist: there is no mkdir in the
 * permission set, and every other step here needs the directory already there.
 *
 * @param {(msg: string) => void} [say] Progress, surfaced to the user.
 */
async function download(say) {
  const target = cftTarget();
  if (!target) {
    throw new Error(
      "Chrome for Testing has no build for this platform. Install Chrome, Chromium or Brave and reopen the browser pane.",
    );
  }
  const engineDir = join(dataDir(), "engine");
  const metaPath = join(engineDir, "versions.json");
  const zipPath = join(engineDir, "chrome.zip");

  say?.("Looking up the current Chrome for Testing build...");
  const meta = await run("curl", [
    "-L",
    "--fail",
    "--silent",
    "--show-error",
    "--create-dirs",
    "-o",
    metaPath,
    CFT_VERSIONS_URL,
  ]);
  if (meta.code !== 0) throw new Error("Could not reach the Chrome for Testing index.");

  const file = await ctx.invoke("fs_read_file", { path: metaPath });
  if (file.kind !== "text") throw new Error("The Chrome for Testing index was not readable.");
  const parsed = JSON.parse(file.content);
  const stable = parsed?.channels?.Stable;
  const url = (stable?.downloads?.chrome ?? []).find((d) => d.platform === target.key)?.url;
  if (!url) throw new Error(`No Chrome for Testing build for ${target.key}.`);

  say?.(`Downloading Chromium ${stable.version} (about 170 MB, once)...`);
  const dl = await run(
    "curl",
    ["-L", "--fail", "--silent", "--show-error", "--create-dirs", "-o", zipPath, url],
    { timeoutMs: 900_000 },
  );
  if (dl.code !== 0) throw new Error("The Chromium download failed.");

  say?.("Unpacking...");
  await unzip(zipPath, engineDir);

  const binary = join(engineDir, ...target.rel);
  if (!(await fileExists(binary))) {
    throw new Error("The Chromium download unpacked without the expected binary.");
  }
  // Archive tools do not always restore the executable bit; Chromium then fails
  // to spawn with a permission error that reads like a sandbox problem.
  if (!isWindows()) await run("chmod", ["+x", binary], { timeoutMs: 10_000 }).catch(() => {});
  return binary;
}

/**
 * Resolve the browser binary once per session and remember it.
 *
 * Order: a previously downloaded engine, then whatever is installed, then a
 * download. The downloaded copy is checked FIRST so a machine that once had no
 * Chromium does not re-search - and, more importantly, so the engine the user
 * actually paid 170 MB for is the one that keeps being used.
 *
 * @param {(msg: string) => void} [say]
 */
export async function resolveEngine(say) {
  if (state.engine) return state.engine;

  const target = cftTarget();
  if (target) {
    const downloaded = join(dataDir(), "engine", ...target.rel);
    if (await fileExists(downloaded)) {
      state.engine = downloaded;
      state.engineKind = "downloaded";
      return downloaded;
    }
  }

  const found = await findInstalled();
  if (found) {
    state.engine = found.path;
    state.engineKind = /** @type {any} */ (found.kind);
    return found.path;
  }

  state.engine = await download(say);
  state.engineKind = "downloaded";
  return state.engine;
}

/** Human label for the settings card, so a user can see WHICH browser is being
 *  driven without opening a log. */
export function engineLabel() {
  if (!state.engine) return "Not resolved yet";
  const name =
    { chrome: "Chrome", edge: "Edge", brave: "Brave", chromium: "Chromium" }[
      state.engineKind ?? ""
    ] ?? "Chrome for Testing (downloaded)";
  return `${name} - ${state.engine}`;
}
