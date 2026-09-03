# Browser

A real Chromium inside TEDI, driven over the Chrome DevTools Protocol.

TEDI renders its own UI in the webview the OS already provides, which is
Chromium only on Windows. A browser built on that webview could therefore offer
CDP and Chrome extensions on one platform out of three. This one drives a real
Chromium, so both work everywhere — and because it ships as an extension, none
of that cost lands on anyone who never opens a browser pane.

## What it costs

| | |
|---|---|
| Added to the TEDI installer | **0 MB** |
| Extension bundle | ~54 KB (plus a 1.2 MB icon, like every TEDI extension) |
| Chromium, when the machine already has Chrome, Edge, Brave or Chromium | **0 MB** |
| Chromium, when it has none | ~170 MB, downloaded once into `~/.tedi/browser/engine` |
| While no pane is open | no process at all — Chromium stops after the idle timeout |
| While a pane is hidden | no frames encoded — the screencast stops |

Windows practically always lands in the free row, because Edge ships with the OS.

## How it works

- **Engine** — `chromium.js` looks for an installed Chrome, Edge, Brave or
  Chromium and only downloads Chrome for Testing when there is none.
- **Process** — `launch.js` starts it headless with its own profile, asks for
  `--remote-debugging-port=0`, and reads the real port back out of
  `DevToolsActivePort`. A Chromium left running from an earlier session is
  adopted rather than duplicated.
- **Transport** — `cdp.js` is one WebSocket with flat sessions, so every tab is
  multiplexed down a single connection. The HTTP side of CDP is unreachable from
  TEDI's origin (no CORS headers), which is why the socket address comes off
  disk.
- **Rendering** — `screencast.js` streams `Page.startScreencast` frames into a
  `<canvas>` and dispatches the pane's mouse and keyboard back as *trusted*
  input events. The emulated viewport is pinned to the pane's CSS size, so
  coordinates map one to one.
- **Agent view** — `snapshot.js` returns the browser's own accessibility tree as
  numbered controls. Clicks and fills address a `[N]` from that snapshot; there
  are no CSS selectors, so a model cannot invent a target.

## Chrome extensions

Two ways in, and an ad blocker is the obvious first one.

**Unpacked — always works.** Drop the extension's unpacked folder (the one with
its `manifest.json`) into `~/.tedi/browser/extensions/`, one folder per
extension, and it is passed to Chromium as `--load-extension` on the next
launch. This route is honoured in headless, so it needs no window and no clicks.
The exact path is shown in the extension's settings card.

```
~/.tedi/browser/extensions/
  ublock-origin-lite/
    manifest.json
    ...
```

**Chrome Web Store.** The profile is a real Chromium profile, so a Store install
persists in it. The Store itself needs a visible window, so **Browser: manage
Chrome extensions** stops the headless instance and opens Chromium on
`chrome://extensions`. Close it when you are done; the next pane goes back to
headless with whatever you installed.

## For agents

One `browser` tool, published to TEDI's own agent and re-advertised to outside
CLIs over MCP as `ext_browser` with the same schema — so Claude Code and TEDI's
agent drive the same tabs with the same call.

| | |
|---|---|
| Read | `list`, `url`, `read`, `snapshot`, `console`, `screenshot`, `scroll`, `hover`, `back`, `forward`, `reload` |
| Act | `open`, `navigate`, `click`, `fill`, `type`, `key`, `eval`, `wait`, `viewport`, `close`, `activate` |

Not split into a read tool and a write tool: TEDI forces an approval card on
every extension tool regardless of what the manifest asks for, so a second
schema would cost a second standing tool bill on every request and change
nothing.

`snapshot` returns the page's accessibility tree as numbered controls, and
`click` / `fill` / `hover` take those `[N]` refs — there are no CSS selectors,
so a model cannot invent a target. `console` drains JavaScript errors buffered
since attach, which is the fastest way to find out why a dev-server page is
blank.

`screenshot` returns a real image on both routes, not base64 buried in a JSON
string: TEDI unpacks the `{ mimeType, data }` shape into a proper image part for
its own agent and into an MCP image block for an outside CLI. It is still the
last resort — the accessibility snapshot answers most questions for a fraction
of the context.

## Settings

- **Screencast quality** — 1..100 JPEG quality. 70 reads well and stays cheap.
- **Stop Chromium after idle minutes** — 0 keeps it warm.

## Building

```
npm install
npm run build      # bundles src/ into extension.js
npm run typecheck
```

`extension.js` is a build artifact and is gitignored; CI builds it into the
release zip.
