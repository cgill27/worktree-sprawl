// The tab bar button (props { mode: "toolbar" }) draws, and opens the Worktrees tab when clicked.
// Run from the package root: node tests/toolbar.test.mjs
//
// `herdr-app check` only draws the tab itself, so a mistake in the button's copy of the mod shows
// up in the tab bar and nowhere else. This loads main.js in Node with stand-ins for Herdr's own
// modules ("gpui-kit", "gpui-base", "herdr"): every element builder records the calls made on it,
// which is enough to render the button and look at what it would show.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { registerHooks } from "node:module";

const MOD_DIR = new URL("../mods/worktree-sprawl/", import.meta.url);

// The names the mod imports from each host module, read from its source so a new import needs no change here.
const wanted = { "gpui-kit": new Set(), "gpui-base": new Set(), herdr: new Set() };
for (const file of readdirSync(MOD_DIR).filter((f) => f.endsWith(".js"))) {
  const src = readFileSync(new URL(file, MOD_DIR), "utf8");
  for (const [, names, from] of src.matchAll(/^import\s*\{([^}]*)\}\s*from\s*"([^"]+)";/gm)) {
    if (wanted[from]) for (const name of names.split(",")) wanted[from].add(name.trim().split(/\s+as\s+/)[0]);
  }
}

// An element builder: `div()`, `Thing.new(id)` and `Thing.method()` give a new element; every
// chained call is recorded on it and returns it. `.when(cond, fn)` behaves as Herdr's does.
globalThis.__wt = { herdr: {}, node: Symbol("node") };
globalThis.__wt.element = function element(tag, factory = false) {
  const node = { tag, calls: [] };
  const proxy = new Proxy(function () {}, {
    get(_target, key) {
      if (key === globalThis.__wt.node) return node;
      if (typeof key === "symbol" || key === "then") return undefined;
      if (factory) return (...args) => { const made = element(`${tag}.${key}`); made[globalThis.__wt.node].calls.push(["()", args]); return made; };
      if (key === "when") return (cond, fn) => (cond ? fn(proxy) : proxy);
      return (...args) => { node.calls.push([key, args]); return proxy; };
    },
    apply(_target, _this, args) { const made = element(tag); made[globalThis.__wt.node].calls.push(["()", args]); return made; },
  });
  return proxy;
};

const gpui = (names) => [...names].map((name) => (name === "View"
  ? "export class View {}"
  : `export const ${name} = globalThis.__wt.element(${JSON.stringify(name)}, true);`)).join("\n");
// A herdr function answers from globalThis.__wt.herdr when the test set one, else with nothing.
const herdr = (names) => [...names].map((name) =>
  `export function ${name}(...args) { return globalThis.__wt.herdr[${JSON.stringify(name)}]?.(...args); }`).join("\n");
const stubs = {
  "gpui-kit": gpui(wanted["gpui-kit"]),
  "gpui-base": gpui(wanted["gpui-base"]),
  herdr: herdr(wanted.herdr),
};
registerHooks({
  resolve(specifier, context, next) {
    if (stubs[specifier]) return { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true };
    return next(specifier, context);
  },
});

const NODE = globalThis.__wt.node;
/** Every string an element tree would show, and every handler registered under `name`. */
function walk(value, out = { text: [], handlers: {} }) {
  if (Array.isArray(value)) { for (const v of value) walk(v, out); return out; }
  const node = value?.[NODE];
  if (!node) return out;
  for (const [name, args] of node.calls) {
    for (const arg of args) {
      if (typeof arg === "string" && (name === "child" || name === "children")) out.text.push(arg);
      else if (typeof arg === "function" && name.startsWith("on_")) (out.handlers[name] ??= []).push(arg);
      else walk(arg, out);
    }
  }
  return out;
}

const colors = new Proxy({}, { get: () => "#202020" });
const ran = [];
Object.assign(globalThis.__wt.herdr, {
  props: () => ({ mode: "toolbar" }),
  theme: () => colors,
  spaces: () => [{ active: true, tabs: [{ id: "tab-1" }] }],
  panes: () => [],
  run: (name, args) => { ran.push([name, args]); },
});

const { default: WorktreeSprawl } = await import(new URL("main.js", MOD_DIR).href);
const cx = { notify() {}, spawn() {}, stop_propagation() {} };

// The button's copy of the mod: init() returns before the tab's state exists, and render() must not need it.
const view = new WorktreeSprawl();
view.init({}, cx);
assert.equal(view.toolbarMode, true, "props { mode: \"toolbar\" } selects the button");
let tree;
assert.doesNotThrow(() => { tree = view.render(cx); }, "the tab bar button renders");
const shown = walk(tree);
assert.deepEqual(shown.text, ["Worktrees"], "the button is labelled Worktrees and shows nothing else");
assert.equal(shown.handlers.on_click?.length, 1, "the button has one click handler");

// A second render is the same: nothing was left half-set by the first.
assert.deepEqual(walk(view.render(cx)).text, ["Worktrees"]);

// Clicking it opens the Worktrees tab when this space has none.
shown.handlers.on_click[0]({}, cx);
assert.deepEqual(ran, [["tab.new", { name: "Worktrees", mod: "worktree-sprawl" }]]);

// With the tab already open in this space, it is focused instead.
ran.length = 0;
globalThis.__wt.herdr.panes = () => [{ pane: "pane-1", tab: "tab-1", mod: "worktree-sprawl" }];
shown.handlers.on_click[0]({}, cx);
assert.deepEqual(ran, [["pane.focus", { pane: "pane-1" }]]);

console.log("all toolbar tests passed");
