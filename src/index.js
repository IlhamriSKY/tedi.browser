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

import { ctx, setCtx } from "./runtime.js";
import { resolveEngine, engineLabel } from "./chromium.js";
import { stopBrowser, unpackedExtensionsDir } from "./launch.js";
import { renderPane } from "./ui.js";
import { TOOLS, runTool } from "./tools.js";

/** Open (or focus) a browser pane. Split-pane rather than a standalone tab so it
 *  sits beside a terminal, which is where a dev browser is actually useful. */
function openPane() {
  ctx.tabs.openExtensionPane({ panelId: "browser", title: "Browser", icon: "lucide:Globe" });
}

/** @param {import("../tedi").ExtensionContext} context */
export async function activate(context) {
  setCtx(context);

  // The second argument carries `reuseKey`, which `setExtensionTabState` needs
  // to address THIS pane's header rather than every browser pane at once.
  ctx.registerPanelRenderer("browser", (container, paneCtx) => renderPane(container, paneCtx));

  // Declared from `activate()` rather than the manifest so a tool is never
  // advertised without the handler that answers it - the host reads the registry
  // for both the in-app agent and the MCP surface, and a published-but-unbound
  // tool would fail at call time instead of simply not existing.
  ctx.contribute.aiTools(TOOLS);
  for (const tool of TOOLS) ctx.registerAiToolHandler(tool.name, runTool);

  ctx.registerCommandHandler("tedi.browser.open", openPane);
  ctx.registerCommandHandler("tedi.browser.shutdown", async () => {
    await stopBrowser();
    ctx.ui.toast("Browser stopped.", { variant: "success" });
  });

  // No status-bar item. It carried a tab count and a running flag, and repainted
  // every four seconds to say "idle" almost always - a permanent readout for
  // something that is not running most of the time. The pane is still one
  // Mod+Alt+P away, or `Open Browser` in the command palette; this extension's
  // panel is `surface: "tab"`, so it never had a status-bar toggle to lose.

  // Resolve the engine in the background and write it into the settings card, so
  // a user can see WHICH browser will be driven before they ever open a pane.
  // Failure here is not an activation failure: the pane reports it properly, and
  // a machine with no Chromium yet is a normal state, not a broken install.
  void resolveEngine()
    .then(() => ctx.settings.set("enginePath", engineLabel()))
    .catch((err) => ctx.logger.info("engine not resolved yet", err));

  // Show the drop folder in the settings card. A path the user cannot see is a
  // feature they cannot use, and it is the route that needs no clicks at all.
  void ctx.settings.set("unpackedDir", unpackedExtensionsDir()).catch(() => {});

  // The Chromium we spawned is our child. Leaving it running after the extension
  // is disabled or uninstalled would strand a process the user has no UI to stop.
  ctx.addDisposer(() => void stopBrowser());
}

export async function deactivate() {
  await stopBrowser();
}
