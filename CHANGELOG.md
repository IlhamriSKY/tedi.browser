# Changelog

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
