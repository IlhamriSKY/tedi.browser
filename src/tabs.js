// Tabs: creating them, attaching to them, and remembering what they said.
//
// A tab here is a CDP *page target* plus the flat session attached to it. The
// session id is the only thing every other module needs, so this is the one
// place that maps `targetId -> sessionId` and the only place that opens or
// closes a target.
//
// CONSOLE CAPTURE STARTS AT ATTACH, NOT AT ASK. The single most useful question
// an agent asks a browser is "why is this dev-server page blank", and the answer
// is almost always an error thrown before anyone thought to look. Buffering from
// attach means the answer is already there; asking later would only ever see
// what happened after the question.

import { state, emitTabsChanged } from "./runtime.js";
import { ensureBrowser } from "./launch.js";

/** Console entries kept per tab. Deep enough to hold a page load's worth of
 *  noise, shallow enough that a chatty page cannot grow the heap unbounded. */
const CONSOLE_LIMIT = 200;

/** @type {Map<string, { level: string, text: string }[]>} */
const consoleByTarget = new Map();

/** Push one diagnostic, dropping the oldest past the cap. */
function record(targetId, level, text) {
  if (!text) return;
  let list = consoleByTarget.get(targetId);
  if (!list) {
    list = [];
    consoleByTarget.set(targetId, list);
  }
  list.push({ level, text: text.slice(0, 2000) });
  if (list.length > CONSOLE_LIMIT) list.splice(0, list.length - CONSOLE_LIMIT);
}

/** Flatten a `Runtime.RemoteObject` argument to something readable. CDP gives a
 *  preview for objects and a value for primitives; neither alone covers both. */
function argText(arg) {
  if (arg == null) return "";
  if (arg.value !== undefined) return String(arg.value);
  if (arg.description) return arg.description;
  if (arg.preview?.properties) {
    return `{${arg.preview.properties.map((p) => `${p.name}: ${p.value}`).join(", ")}}`;
  }
  return arg.type ?? "";
}

/** Wire the per-session listeners once, on the browser socket. Events carry
 *  their `sessionId`, so one subscription serves every tab - N subscriptions
 *  would fire N times per event and cost the same information. */
/** The socket the listeners are attached to, NOT a boolean. Chromium can exit
 *  and be relaunched inside one session; a flag would then skip wiring the NEW
 *  socket and leave the strip permanently frozen with no error anywhere. */
/** @type {import("./cdp.js").Cdp | null} */
let wiredTo = null;
function wireOnce(cdp) {
  if (wiredTo === cdp) return;
  wiredTo = cdp;
  cdp.onClose(() => {
    if (wiredTo === cdp) wiredTo = null;
  });

  // Without discovery the browser sends `targetInfoChanged` and
  // `targetDestroyed` for nothing we are not already driving, so a title that
  // changed after load, a single-page route change, and a tab the USER closed
  // from inside the page would all go unnoticed - the strip would keep showing
  // a tab that no longer exists and a title from first paint.
  void cdp.send("Target.setDiscoverTargets", { discover: true }).catch(() => {});

  const targetOf = (sessionId) => {
    for (const [id, t] of state.tabs) if (t.sessionId === sessionId) return id;
    return null;
  };

  cdp.on("Runtime.consoleAPICalled", (p, sessionId) => {
    if (p.type !== "error" && p.type !== "warning") return;
    const id = targetOf(sessionId);
    if (id) record(id, p.type === "error" ? "error" : "warn", p.args.map(argText).join(" "));
  });
  cdp.on("Runtime.exceptionThrown", (p, sessionId) => {
    const id = targetOf(sessionId);
    const d = p.exceptionDetails;
    if (id) record(id, "error", d?.exception?.description ?? d?.text ?? "Uncaught exception");
  });
  cdp.on("Log.entryAdded", (p, sessionId) => {
    if (p.entry?.level !== "error" && p.entry?.level !== "warning") return;
    const id = targetOf(sessionId);
    if (id) record(id, p.entry.level === "error" ? "error" : "warn", p.entry.text);
  });

  // Title and url follow the page, not our navigate call: a single-page app
  // changes both without ever loading a document, and the address bar has to
  // track that or it lies within one click.
  cdp.on("Target.targetInfoChanged", (p) => {
    const t = state.tabs.get(p.targetInfo?.targetId);
    if (!t) return;
    let changed = false;
    if (p.targetInfo.url && p.targetInfo.url !== t.url) {
      t.url = p.targetInfo.url;
      changed = true;
    }
    if (p.targetInfo.title !== undefined && p.targetInfo.title !== t.title) {
      t.title = p.targetInfo.title;
      changed = true;
    }
    if (changed) emitTabsChanged();
  });

  cdp.on("Target.targetDestroyed", (p) => {
    if (!state.tabs.delete(p.targetId)) return;
    consoleByTarget.delete(p.targetId);
    if (state.activeTargetId === p.targetId) {
      state.activeTargetId = state.tabs.keys().next().value ?? null;
    }
    emitTabsChanged();
  });
}

/**
 * Attach to a page target and turn on the domains every feature needs.
 *
 * `Page` drives navigation and the screencast, `Runtime` and `Log` feed the
 * console buffer, `DOM` and `Accessibility` back the snapshot. They are enabled
 * here rather than lazily because enabling mid-flight loses the events that were
 * the reason to enable at all.
 *
 * @param {import("./cdp.js").Cdp} cdp
 * @param {string} targetId
 */
async function attach(cdp, targetId) {
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await Promise.all([
    cdp.send("Page.enable", {}, sessionId),
    cdp.send("Runtime.enable", {}, sessionId),
    cdp.send("Log.enable", {}, sessionId),
    cdp.send("DOM.enable", {}, sessionId),
    // Not optional: `Accessibility.getFullAXTree` returns an empty tree until
    // the domain is on, which would read as "this page has no controls" rather
    // than as a missing enable.
    cdp.send("Accessibility.enable", {}, sessionId),
  ]);
  return sessionId;
}

/** Adopt every page target the browser already has, so a Chromium we inherited
 *  from an earlier TEDI session shows its real tabs instead of an empty strip. */
export async function syncTabs() {
  const cdp = await ensureBrowser();
  wireOnce(cdp);
  const { targetInfos } = await cdp.send("Target.getTargets");
  for (const info of targetInfos) {
    if (info.type !== "page") continue;
    if (info.url.startsWith("devtools://")) continue;
    if (state.tabs.has(info.targetId)) continue;
    const sessionId = await attach(cdp, info.targetId);
    state.tabs.set(info.targetId, {
      targetId: info.targetId,
      sessionId,
      url: info.url,
      title: info.title ?? "",
    });
  }
  if (!state.activeTargetId && state.tabs.size) {
    state.activeTargetId = state.tabs.keys().next().value ?? null;
  }
  emitTabsChanged();
  return [...state.tabs.values()];
}

/**
 * Open a tab and make it active.
 *
 * @param {string} [url]
 * @param {(msg: string) => void} [say] First-run engine progress.
 */
export async function newTab(url = "about:blank", say) {
  const cdp = await ensureBrowser(say);
  wireOnce(cdp);
  const { targetId } = await cdp.send("Target.createTarget", { url });
  const sessionId = await attach(cdp, targetId);
  state.tabs.set(targetId, { targetId, sessionId, url, title: "" });
  state.activeTargetId = targetId;
  emitTabsChanged();
  return targetId;
}

/** The active tab, opening one if there is none. */
export async function activeTab(say) {
  if (state.activeTargetId && state.tabs.has(state.activeTargetId)) {
    return state.tabs.get(state.activeTargetId);
  }
  await syncTabs().catch(() => {});
  if (state.activeTargetId && state.tabs.has(state.activeTargetId)) {
    return state.tabs.get(state.activeTargetId);
  }
  const id = await newTab("about:blank", say);
  return state.tabs.get(id);
}

/** Resolve a tab by target id, or the active one when `targetId` is omitted. */
export async function tabOf(targetId, say) {
  if (!targetId) return activeTab(say);
  const t = state.tabs.get(targetId);
  if (!t) throw new Error(`No browser tab "${targetId}". Call list first.`);
  return t;
}

export async function closeTab(targetId) {
  const cdp = await ensureBrowser();
  await cdp.send("Target.closeTarget", { targetId });
  // `Target.targetDestroyed` also removes it; doing it here too keeps the UI
  // honest when the event is slower than the user's next click.
  state.tabs.delete(targetId);
  consoleByTarget.delete(targetId);
  if (state.activeTargetId === targetId) {
    state.activeTargetId = state.tabs.keys().next().value ?? null;
  }
  emitTabsChanged();
}

export function setActive(targetId) {
  if (!state.tabs.has(targetId)) return;
  state.activeTargetId = targetId;
  emitTabsChanged();
}

/** Drain a tab's diagnostics. Draining, not peeking: an agent that reads the
 *  same twenty errors on every call cannot tell a new failure from an old one. */
export function drainConsole(targetId) {
  const list = consoleByTarget.get(targetId) ?? [];
  consoleByTarget.set(targetId, []);
  return list;
}
