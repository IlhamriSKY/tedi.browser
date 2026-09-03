# Changelog

## 0.1.1

Fixes a browser that could never connect on any machine.

- **Chromium refused every DevTools socket the extension opened.** Chrome answers
  403 to a WebSocket upgrade that carries an `Origin` header - "Rejected an
  incoming WebSocket connection from the <origin> origin" - and every socket
  opened from a web page carries one. The extension lives in TEDI's webview, so
  it was refused on every attempt while a plain CLI client (which sends no
  Origin) connected fine, which is why it read as a hang rather than a
  rejection. Chromium is now launched with `--remote-allow-origins` set to the
  webview's own origin, read at runtime so it is right in dev and in a release
  build alike. One origin, not `*`: the debugging port has no authentication of
  its own.
- **Toolbar icons were invisible.** The host returns an empty span from
  `ctx.ui.icon()` and fills it when its lazily-loaded icon chunk lands, so the
  cache cloned an empty master and every button stayed blank for the session.
  It now clones only once the master has rendered.
- **The pane could sit on a message forever.** `Cdp.connect` had no timeout, so
  a socket that neither opened nor failed stalled a loop that believed it was
  bounded; and re-binding a tab that was already streaming returned without
  clearing the note. Both fixed, and every message that leaves the pane without
  a page is now a button that retries.
- **"Manage Chrome extensions" left the pane dead.** It stops the headless
  instance to hand the profile to a visible window, and nothing brought it back.
  It now waits for that window to close, then restarts and re-attaches.
- A fresh browser opens on `about:blank` rather than Chrome's `chrome://newtab`,
  and `invoke:shell_bg_logs` - needed by the first-run engine download - is
  declared. **Reinstall rather than update in place** to grant it.

## 0.1.0

First release. A real Chromium inside TEDI, driven over the DevTools Protocol.

- Resolves an installed Chrome, Edge, Brave or Chromium before downloading
  anything; Chrome for Testing is fetched once, and only when the machine has
  none. Nothing is added to the TEDI installer.
- Renders into a pane over a CDP screencast, with trusted mouse and keyboard
  input and the emulated viewport pinned to the pane so coordinates map exactly.
- Stops encoding frames when the pane is hidden, and stops the process entirely
  after an idle timeout.
- Chrome Web Store extensions work and persist, on all three platforms, because
  the profile is a real Chromium profile.
- Gives agents the browser's own accessibility tree instead of a DOM scrape.
  One `browser` tool covering twenty-two actions, published to TEDI's own agent
  and re-advertised over MCP as `ext_browser` so an outside CLI drives the same
  tabs with the same call. `screenshot` comes back as a real image part on
  either route.
