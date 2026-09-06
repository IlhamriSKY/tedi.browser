# Changelog

## 0.2.0

The pane stops being a picture of a browser and becomes a hole with one in it.

- **The Chromium window is placed on the pane that owns it.** A screencast is a
  video of a page: it costs an encode per frame, it upscales when the surface is
  scaled, the pointer is a synthesised one and the user agent is not Chrome's,
  which is enough for a Google sign-in to refuse. The window is adopted as a
  child of TEDI's own and held on the pane's rectangle instead, so the page is
  composited by the GPU at full resolution with the real pointer, native
  selection, native popups and an ordinary Chrome user agent. Windows only, and
  it is not a mode to handle: everywhere else, and whenever adoption fails, the
  pane falls back to the frame stream and behaves exactly as it did.
- **On the canvas it is a frame stream, deliberately.** That view puts every pane
  on one transformed layer where panes overlap, the whole surface zooms and
  anything off screen is culled - an OS window can do none of those, so a
  browser there sat at the right rectangle showing a 1:1 crop of a page you had
  asked to see at 40%, on top of every window stacked above it. The stream is an
  ordinary element, so the transform scales it, DOM order stacks it and
  `display:none` culls it. Same Chrome, same profile, same tab; only the painter
  changes, so a signed-in session survives switching views.
- **A floated pane gets the stream too.** An adopted window is sent clicks by
  position but never takes the keyboard on its own, and the host forwards focus
  to it from a window proc installed on the main window only - so a floated pane
  drew, scrolled, clicked and swallowed every keystroke.
- **Chromium runs `--app=`, so TEDI draws the only chrome.** No tab strip, no
  omnibox, no menu of its own; back, forward, reload and the address bar are the
  pane's. That is what lets the two surfaces match at all, since a screencast
  captures the page viewport and can never capture Chrome's own toolbar. It also
  deletes the omnibox caret bug outright and stops Chrome's Ctrl+T and Ctrl+W
  reaching into a pane. The price: no extensions button, no profile menu and no
  route to the Web Store from inside a pane, so unpacked extensions in
  `~/.tedi/browser/extensions/` are the way in. A Google sign-in is unaffected.
- **Chrome's title bar is cut out of the pane, because no window style removes
  it.** An `--app` window still paints a bar with the page title and three window
  buttons, inside its client area rather than as the OS caption: stripping
  `WS_CAPTION`, `WS_THICKFRAME`, `WS_SYSMENU` and both size boxes moves
  `outerHeight - innerHeight` from 39px to 37px. Two pixels. So the window is
  made larger than the pane by exactly the frame and shifted up and left, which
  puts the PAGE on the pane, and the frame is cut away with the same window
  region the occlusion clip already uses. The inset is measured, not guessed.
- **One pane is one page**, and the pane wears the page's title and favicon.
- **No status-bar item.** It duplicated what the pane header already says.
- **The frame stream renders at the size it is actually displayed at.** It sized
  its bitmap from the pane's layout box, which a CSS `transform` never touches,
  so the canvas rendered once at layout size and let the compositor upscale it.
  The scale now comes from `getBoundingClientRect()` over `clientWidth` times the
  display ratio, capped at 3x, with a quarter-second watcher because no observer
  fires for a transform. JPEG quality 70 to 90 in the same pass.
- **Fixed: scrolling on the canvas went the wrong way.** The wheel handler
  negated the deltas. `Input.dispatchMouseEvent` uses the DOM sign convention,
  not the legacy `WebMouseWheelEvent` one.
- **Fixed: a pane could never drop a favicon it had already shown.** `undefined`
  meant "unchanged" to the host and only a truthy icon was ever sent, so the
  previous site's mark stayed next to the new site's name, across restarts.
- **Fixed: no framed Chrome flashes on the way in.** The window stays parked
  while adoption is retried, instead of being placed on the pane meanwhile.

Requires TEDI 0.4.42, which adds the `dock_*` commands this uses.

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
