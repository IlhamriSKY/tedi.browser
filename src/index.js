// Browser - a real Chromium inside TEDI, driven over CDP.
//
// WHAT THIS EXTENSION IS FOR. TEDI renders its own UI in the webview the OS
// already provides, which is Chromium only on Windows. A browser built on that
// webview could therefore offer the DevTools Protocol and Chrome extensions on
// one platform out of three. Driving a real Chromium makes both work everywhere,
// and shipping it as an extension keeps the cost off everyone who never opens a
// browser pane.
//
// WHAT ACTIVATION COSTS. Nothing but this file. No process starts, no engine is
// resolved, and no network call is made until something actually asks for a
// browser - the first pane, or the first tool call. That is deliberate: an
// installed extension that idles at zero is one the user has no reason to
// uninstall.

import { ctx, setCtx, state } from "./runtime.js";
import { resolveEngine, engineLabel } from "./chromium.js";
import { stopBrowser, openExtensionManager, unpackedExtensionsDir } from "./launch.js";
import { renderPane } from "./ui.js";
import { TOOLS, runTool } from "./tools.js";

/** Reflect the engine and process state in the status bar, so "is a browser
 *  running, and which one" is answerable without opening a pane. */
function renderStatus() {
  const running = state.cdp != null && !state.cdp.closed;
  ctx.statusBar.setItem({
    id: "browser",
    icon: "lucide:Globe",
    label: running ? String(state.tabs.size) : undefined,
    // A running browser with tabs is a state to read, not a button to press,
    // even though clicking it opens a pane - the inference would call it an
    // action and file it with the buttons.
    kind: "status",
    tooltip: running
      ? `Browser running - ${state.tabs.size} tab(s). ${engineLabel()}`
      : "Browser idle. Opens on demand.",
    onClick: () => openPane(),
  });
}

/** Open (or focus) a browser pane. Split-pane rather than a standalone tab so it
 *  sits beside a terminal, which is where a dev browser is actually useful. */
function openPane() {
  ctx.tabs.openExtensionPane({ panelId: "browser", title: "Browser", icon: "lucide:Globe" });
}

/** @param {import("../tedi").ExtensionContext} context */
export async function activate(context) {
  setCtx(context);

  ctx.registerPanelRenderer("browser", (container) => renderPane(container));

  // Declared from `activate()` rather than the manifest so a tool is never
  // advertised without the handler that answers it - the host reads the registry
  // for both the in-app agent and the MCP surface, and a published-but-unbound
  // tool would fail at call time instead of simply not existing.
  ctx.contribute.aiTools(TOOLS);
  for (const tool of TOOLS) ctx.registerAiToolHandler(tool.name, runTool);

  ctx.registerCommandHandler("tedi.browser.open", openPane);
  ctx.registerCommandHandler("tedi.browser.manageExtensions", async () => {
    try {
      await openExtensionManager();
      ctx.ui.toast("Chromium opened in its own window. Install from the Web Store, then close it.", {
        variant: "info",
      });
    } catch (err) {
      ctx.ui.toast(err instanceof Error ? err.message : String(err), { variant: "error" });
    }
  });
  ctx.registerCommandHandler("tedi.browser.shutdown", async () => {
    await stopBrowser();
    renderStatus();
    ctx.ui.toast("Browser stopped.", { variant: "success" });
  });

  renderStatus();
  // Repaint on a slow tick rather than wiring an event into every mutation
  // site: the only things shown are a tab count and a running flag, neither
  // worth threading a listener through five modules for.
  const tick = setInterval(renderStatus, 4000);
  ctx.addDisposer(() => clearInterval(tick));

  // Resolve the engine in the background and write it into the settings card, so
  // a user can see WHICH browser will be driven before they ever open a pane.
  // Failure here is not an activation failure: the pane reports it properly, and
  // a machine with no Chromium yet is a normal state, not a broken install.
  void resolveEngine()
    .then(() => ctx.settings.set("enginePath", engineLabel()))
    .catch((err) => ctx.logger.info("engine not resolved yet", err));

  // Show the drop folder in the settings card. A path the user cannot see is a
  // feature they cannot use, and this is the route that works headless.
  void ctx.settings.set("unpackedDir", unpackedExtensionsDir()).catch(() => {});

  // The Chromium we spawned is our child. Leaving it running after the extension
  // is disabled or uninstalled would strand a process the user has no UI to stop.
  ctx.addDisposer(() => void stopBrowser());
}

export async function deactivate() {
  await stopBrowser();
}
