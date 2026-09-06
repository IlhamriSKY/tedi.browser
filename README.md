# TEDI Browser

A real Chromium in a [TEDI](https://tedi.ilhamriski.com/) pane, driven over the
Chrome DevTools Protocol. The browser runs in app mode and TEDI draws the chrome,
so a pane looks the same in the tabs view and on the canvas: one toolbar, one
page, no second browser UI inside your editor. The AI agent drives the same tabs
you do, reading the page's accessibility tree rather than scraping the DOM.

It reuses the Chrome, Edge, Brave or Chromium already on your machine and only
downloads one when there is none, so installing this adds nothing to the TEDI
download.

<p align="center">
  <img src="logo.png" alt="Browser" width="128" />
</p>

## Install

1. Open **Settings → Extensions** in TEDI.
2. Switch to the **From GitHub** tab.
3. Paste `IlhamriSKY/tedi.browser` and click **Review → Install**.

Then open a pane with `Mod+Alt+P`, the `+` menu, or the globe in the status bar.

## Update

In **Settings → Extensions**, click **Check updates** on this extension's card.
If a new release exists, click **Update** to reinstall in place.

## What it costs

| | |
|---|---|
| Added to the TEDI download | **0 MB** |
| Extension bundle | ~54 KB (plus a 1.2 MB icon, like every TEDI extension) |
| Chromium, when the machine already has Chrome, Edge, Brave or Chromium | **0 MB** |
| Chromium, when it has none | ~170 MB, downloaded once into `~/.tedi/browser/engine` |
| While no pane is open | no process at all — Chromium stops after the idle timeout |
| While a pane is hidden | its window is parked off-screen; nothing is drawn |

Windows practically always lands in the free row, because Edge ships with the OS.

## How it works

- **Engine** - looks for an installed Chrome, Edge, Brave or Chromium and only
  downloads Chrome for Testing when there is none.
- **Process** - an ordinary, non-headless Chromium with its own profile and
  `--remote-debugging-port=0`; the real port is read back out of
  `DevToolsActivePort`. A Chromium left running from an earlier session is
  adopted rather than duplicated.
- **Transport** - one WebSocket with flat CDP sessions, so every tab is
  multiplexed down a single connection. The HTTP side of CDP is unreachable from
  TEDI's origin (it sends no CORS headers), which is why the socket address
  comes off disk.
- **Rendering** - the pane is an empty rectangle and the real Chromium window is
  put on it, so the page you see is the browser itself, composited by the GPU:
  full resolution, the real pointer over a link, native selection and popups, and
  an ordinary Chrome user agent, which is what lets a Google sign-in through. On
  Windows TEDI adopts that window as a child of its own, so it is clipped to
  TEDI, minimises with it, and is gone from the taskbar and Alt-Tab; elsewhere it
  stays top-level and is tracked to the pane from outside. Either way it is
  parked out of sight the moment the pane is not visible.
- **Rendering on the canvas** - a frame stream instead, and the window is parked
  for as long as the pane lives there. The canvas workspace view puts every pane
  on one transformed layer where panes overlap, the whole surface zooms and
  anything off screen is culled. An OS window can do none of those: it would sit
  at the right rectangle showing a 1:1 crop of a page you asked to see at 40%, on
  top of every window above it. So there the pane paints a `Page.startScreencast`
  stream into a `<canvas>`, which the transform scales, DOM order stacks and
  `display:none` culls, all for free. Same Chrome, same profile, same tab: only
  the painter changes, so a signed-in session survives switching views.
- **One pane, one page** - the pane owns exactly one window, so splitting TEDI is
  how you open a second. The page's title and favicon go on the pane header.
- **Agent view** - the browser's own accessibility tree, returned as numbered
  controls. Clicks and fills address a `[N]` from that snapshot; there are no CSS
  selectors, so a model cannot invent a target.

## Chrome extensions

Two ways in, and an ad blocker is the obvious first one.

**Unpacked - always works.** Drop the extension's unpacked folder (the one with
its `manifest.json`) into `~/.tedi/browser/extensions/`, one folder per
extension, and it is passed to Chromium as `--load-extension` on the next
launch. It needs no window and no clicks. The exact path is shown in the
extension's settings card.

```
~/.tedi/browser/extensions/
  ublock-origin-lite/
    manifest.json
    ...
```

**Chrome Web Store: not from inside a pane.** Chromium runs `--app=`, so a pane
has no tab strip, no omnibox and no extensions button - that is what lets TEDI
draw the same toolbar on every surface, and it is the trade the design makes. The
Store needs Chrome's own UI to drive it, and there is none here.

The profile itself is an ordinary Chromium profile at `~/.tedi/browser/profile`,
outside the extension's install folder, so anything installed into it survives an
update. If you want a Store extension, install it into that profile once with a
normal Chrome:

```
chrome.exe --user-data-dir="%USERPROFILE%/.tedi/browser/profile"
```

Stop the TEDI browser first (**Browser: stop the Chromium process**): one process
owns a user-data-dir.

## For agents

One `browser` tool, published to TEDI's own agent and re-advertised to outside
CLIs over MCP as `ext_browser` with the same schema - so Claude Code and TEDI's
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
`click` / `fill` / `hover` take those `[N]` refs. `console` drains JavaScript
errors buffered since attach, which is the fastest way to find out why a
dev-server page is blank. `screenshot` comes back as a real image part on either
route, not base64 buried in a JSON string - it is still the last resort, since
the snapshot answers most questions for a fraction of the context.

The agent is refused `file://` and cloud-metadata addresses outright, so it
cannot read your disk or an instance credential endpoint through a browser. A
url you type yourself is not gated.

## Settings

- **Chromium** - which engine was resolved, and where it lives.
- **Unpacked extensions** - the folder above, so you can find it.
- **Stop Chromium after idle minutes** - 0 keeps it warm.

## Permissions

| Permission | Why |
| --- | --- |
| `panels:register`, `tabs:open` | Own the browser pane and open it. |
| `ui:toast`, `statusbar:write` | First-run progress, and the status-bar globe. |
| `settings:read` / `settings:write` | The four settings above. |
| `invoke:shell_bg_spawn_direct` / `shell_bg_kill` / `shell_bg_list` / `shell_bg_logs` | Start and stop Chromium, notice when it exits, and read the output of the one-shot `curl` / archiver used on first run. |
| `invoke:shell_run_command` | Resolve a browser on `PATH` (Linux). |
| `invoke:fs_read_file` | Read `DevToolsActivePort` and the Chrome for Testing index. |
| `invoke:fs_glob` | Find an installed browser, and the unpacked extension folders. |

Nothing is sent anywhere. The only network calls are the ones the page you open
makes, plus the one-time Chrome for Testing download when your machine has no
Chromium.

## Development

```bash
# Build extension.js from src/ (generated by esbuild, not committed).
npm install
npm run build

# Package, then install via Settings → Extensions → From file:
zip -r dev.zip manifest.json extension.js logo.png README.md CHANGELOG.md LICENSE
```

To cut a release, tag `vX.Y.Z` and push. CI in
[`.github/workflows/release.yml`](.github/workflows/release.yml) builds
`extension.js` from `src/` and uploads the zip to the GitHub release.

## License

[Apache-2.0](LICENSE) © IlhamRiski, [tedi.ilhamriski.com](https://tedi.ilhamriski.com/)
