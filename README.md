# TEDI Browser

A real Chromium in a [TEDI](https://tedi.ilhamriski.com/) pane, driven over the
Chrome DevTools Protocol: address bar, tab strip, and Chrome Web Store
extensions that persist in its own profile. The AI agent drives the same tabs
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
| While a pane is hidden | no frames encoded — the screencast stops |

Windows practically always lands in the free row, because Edge ships with the OS.

## How it works

- **Engine** - looks for an installed Chrome, Edge, Brave or Chromium and only
  downloads Chrome for Testing when there is none.
- **Process** - started headless with its own profile and
  `--remote-debugging-port=0`; the real port is read back out of
  `DevToolsActivePort`. A Chromium left running from an earlier session is
  adopted rather than duplicated.
- **Transport** - one WebSocket with flat CDP sessions, so every tab is
  multiplexed down a single connection. The HTTP side of CDP is unreachable from
  TEDI's origin (it sends no CORS headers), which is why the socket address
  comes off disk.
- **Rendering** - `Page.startScreencast` frames are drawn into a `<canvas>` and
  the pane's mouse and keyboard go back as *trusted* input events. The emulated
  viewport is pinned to the pane's CSS size, so coordinates map one to one.
- **Agent view** - the browser's own accessibility tree, returned as numbered
  controls. Clicks and fills address a `[N]` from that snapshot; there are no CSS
  selectors, so a model cannot invent a target.

## Chrome extensions

Two ways in, and an ad blocker is the obvious first one.

**Unpacked - always works.** Drop the extension's unpacked folder (the one with
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
- **Screencast quality** - 1..100 JPEG quality. 70 reads well and stays cheap.
- **Stop Chromium after idle minutes** - 0 keeps it warm.

## Permissions

| Permission | Why |
| --- | --- |
| `panels:register`, `tabs:open` | Own the browser pane and open it. |
| `ui:toast`, `statusbar:write` | First-run progress, and the status-bar globe. |
| `settings:read` / `settings:write` | The four settings above. |
| `invoke:shell_bg_spawn_direct` / `shell_bg_kill` / `shell_bg_list` | Start and stop Chromium, and the one-shot `curl` / archiver used on first run. |
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
