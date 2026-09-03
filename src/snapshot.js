// The page as an agent sees it: an accessibility snapshot, and acting on it.
//
// WHY THE ACCESSIBILITY TREE AND NOT THE DOM. A DOM scrape has to guess what is
// interactive from tag names and inline handlers, and it guesses wrong on every
// component library that builds a button out of a div. The accessibility tree is
// the browser's OWN answer to "what is this, and what is it called", computed
// from ARIA, labels, alt text and shadow DOM alike. It is what a screen reader
// reads, so a control that a human can reach is in it by construction.
//
// WHY REFS AND NOT SELECTORS. Handing a model a CSS selector invites it to
// invent one. A `[N]` ref can only come from a snapshot it was given, so a click
// either addresses something that was really on the page or fails loudly.
//
// WHY REAL MOUSE EVENTS. Acting resolves the ref to a box and dispatches
// `Input.dispatchMouseEvent` at its centre - a TRUSTED event, the same class the
// user produces. `element.click()` is not: it skips hover state, it does not
// move focus the same way, and any handler gated on `event.isTrusted` ignores
// it. That gate is common in exactly the flows worth automating.

import { ensureBrowser } from "./launch.js";

/** Roles worth numbering. Everything a user can operate, and nothing that only
 *  exists to group things - a snapshot full of `generic` and `none` costs
 *  tokens and hides the controls among them. */
const INTERACTIVE = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "checkbox",
  "radio",
  "combobox",
  "listbox",
  "option",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "switch",
  "slider",
  "spinbutton",
  "colorwell",
  "file",
]);

/** Structural roles kept unnumbered for orientation. A model reading a wall of
 *  buttons with no headings cannot tell which form it is looking at. */
const LANDMARK = new Set([
  "heading",
  "navigation",
  "main",
  "form",
  "dialog",
  "alert",
  "status",
  "table",
  "row",
]);

/** Per-target ref tables. Rebuilt on every snapshot, because a navigation or a
 *  re-render invalidates every backend node id in the previous one. */
/** @type {Map<string, number[]>} */
const refsByTarget = new Map();

/** Trim an accessible name to something a model can read without paying for a
 *  paragraph of it. */
function short(text) {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  return t.length > 120 ? `${t.slice(0, 117)}...` : t;
}

/**
 * Snapshot the page as numbered, actionable lines.
 *
 * @param {{ targetId: string, sessionId: string }} tab
 * @returns {Promise<string>}
 */
export async function snapshot(tab) {
  const cdp = await ensureBrowser();
  const { nodes } = await cdp.send("Accessibility.getFullAXTree", {}, tab.sessionId);

  /** @type {number[]} */
  const refs = [];
  const lines = [];
  for (const node of nodes) {
    if (node.ignored) continue;
    const role = node.role?.value ?? "";
    const name = short(node.name?.value);
    const interactive = INTERACTIVE.has(role);
    if (!interactive && !(LANDMARK.has(role) && name)) continue;

    if (interactive && node.backendDOMNodeId != null) {
      refs.push(node.backendDOMNodeId);
      // Value and checked state matter for deciding what to DO next: an agent
      // must be able to tell a filled field from an empty one, and a checked box
      // from one it still has to click.
      const value = short(
        node.properties?.find((p) => p.name === "valuetext")?.value?.value ??
          node.value?.value ??
          "",
      );
      const checked = node.properties?.find((p) => p.name === "checked")?.value?.value;
      const extra = [
        value ? `= ${JSON.stringify(value)}` : "",
        checked !== undefined ? `(${checked})` : "",
      ]
        .filter(Boolean)
        .join(" ");
      lines.push(`[${refs.length}] ${role} ${JSON.stringify(name)}${extra ? ` ${extra}` : ""}`);
    } else if (name) {
      lines.push(`    ${role} ${JSON.stringify(name)}`);
    }
  }
  refsByTarget.set(tab.targetId, refs);
  return lines.join("\n") || "(no accessible controls on this page)";
}

/** Resolve a `[N]` ref to its backend node id, with an error that says what to
 *  do rather than just what failed. */
function backendNodeFor(targetId, index) {
  const refs = refsByTarget.get(targetId);
  if (!refs?.length) {
    throw new Error("No snapshot for this tab yet. Run the snapshot action first.");
  }
  const id = refs[index - 1];
  if (id == null) {
    throw new Error(`No element [${index}] - the last snapshot had ${refs.length}.`);
  }
  return id;
}

/** Centre of an element's border box, in CSS pixels of the layout viewport. */
async function centerOf(tab, backendNodeId) {
  const cdp = await ensureBrowser();
  // Scroll first: a box outside the viewport has real coordinates that no mouse
  // event can reach, and the click would land on whatever is at that point now.
  await cdp
    .send("DOM.scrollIntoViewIfNeeded", { backendNodeId }, tab.sessionId)
    .catch(() => {}); // Not fatal - a fixed-position element is already in view.
  const { model } = await cdp.send("DOM.getBoxModel", { backendNodeId }, tab.sessionId);
  const q = model.border;
  return { x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4 };
}

/** Move, press and release at a point. Split out because click, hover and the
 *  focus half of fill all need the same trusted sequence. */
async function mouseAt(tab, x, y, { press = true, clickCount = 1 } = {}) {
  const cdp = await ensureBrowser();
  const base = { x, y, button: "left", clickCount };
  await cdp.send("Input.dispatchMouseEvent", { ...base, type: "mouseMoved" }, tab.sessionId);
  if (!press) return;
  await cdp.send("Input.dispatchMouseEvent", { ...base, type: "mousePressed" }, tab.sessionId);
  await cdp.send("Input.dispatchMouseEvent", { ...base, type: "mouseReleased" }, tab.sessionId);
}

export async function clickRef(tab, index, clickCount = 1) {
  const { x, y } = await centerOf(tab, backendNodeFor(tab.targetId, index));
  await mouseAt(tab, x, y, { clickCount });
}

export async function hoverRef(tab, index) {
  const { x, y } = await centerOf(tab, backendNodeFor(tab.targetId, index));
  await mouseAt(tab, x, y, { press: false });
}

/**
 * Replace an input's contents.
 *
 * Click to focus, select all, then `Input.insertText`. Insert rather than
 * per-key events because a long value would otherwise be N round trips and N
 * chances for a debounced handler to fire mid-word; select-all first because
 * insert appends, and "fill" that appends is a data bug the caller cannot see.
 */
export async function fillRef(tab, index, value) {
  const cdp = await ensureBrowser();
  const { x, y } = await centerOf(tab, backendNodeFor(tab.targetId, index));
  await mouseAt(tab, x, y);
  // `commands` hands Chromium the EDITING command by name, so this is one call
  // that means "select all" on every platform. Synthesising the chord instead
  // would need Meta on macOS and Control elsewhere, and would be wrong for any
  // user who has remapped it.
  await cdp.send(
    "Input.dispatchKeyEvent",
    { type: "rawKeyDown", key: "a", code: "KeyA", commands: ["selectAll"] },
    tab.sessionId,
  );
  await cdp.send("Input.insertText", { text: String(value ?? "") }, tab.sessionId);
}

/** Press one named key, with the virtual key code Chromium needs to route it.
 *  Only the keys an agent actually reaches for; anything else is typed text. */
const KEYS = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Tab: { code: "Tab", keyCode: 9 },
  Escape: { code: "Escape", keyCode: 27 },
  Backspace: { code: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", keyCode: 46 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
  PageUp: { code: "PageUp", keyCode: 33 },
  PageDown: { code: "PageDown", keyCode: 34 },
};

export async function pressKey(tab, key) {
  const spec = KEYS[key];
  if (!spec) throw new Error(`Unknown key "${key}". Have: ${Object.keys(KEYS).join(", ")}.`);
  const cdp = await ensureBrowser();
  const common = { key, code: spec.code, windowsVirtualKeyCode: spec.keyCode, nativeVirtualKeyCode: spec.keyCode };
  await cdp.send(
    "Input.dispatchKeyEvent",
    { ...common, type: spec.text ? "keyDown" : "rawKeyDown", ...(spec.text ? { text: spec.text } : {}) },
    tab.sessionId,
  );
  await cdp.send("Input.dispatchKeyEvent", { ...common, type: "keyUp" }, tab.sessionId);
}

/** The page's rendered text, capped. What a fetch cannot see, because it is
 *  what the JavaScript actually produced. */
export async function readText(tab, limit = 12_000) {
  const cdp = await ensureBrowser();
  const { result } = await cdp.send(
    "Runtime.evaluate",
    {
      expression: `(() => { const t = document.body ? document.body.innerText : ""; return t.slice(0, ${limit}); })()`,
      returnByValue: true,
    },
    tab.sessionId,
  );
  return String(result?.value ?? "");
}

/** Forget a tab's refs. Called on navigation: the numbers in the old snapshot
 *  point at nodes that no longer exist, and a click on a stale ref is worse than
 *  a refusal because it may hit something else. */
export function invalidate(targetId) {
  refsByTarget.delete(targetId);
}
