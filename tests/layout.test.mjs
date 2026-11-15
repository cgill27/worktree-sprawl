// Unit tests for mods/worktree-sprawl/layout.js. Run from the package root: node tests/layout.test.mjs
// (Loads the module from source as a data: URL, so it works without a package.json "type": "module".)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const src = readFileSync(new URL("../mods/worktree-sprawl/layout.js", import.meta.url), "utf8");
const { BUTTON_ID, hasToolbarButton, withToolbarButton, copyName, isShippedLayout } = await import(`data:text/javascript,${encodeURIComponent(src)}`);

const MOD = "worktree-sprawl";
const button = { id: BUTTON_ID, type: "block", size: { px: 112 }, content: { mod: MOD, props: { mode: "toolbar" } } };
const tabs = { id: "tabs", type: "block", size: { px: 42 }, window_drag: true, content: { mod: "tabs" } };
const main = { id: "main", type: "block", content: { tab: "active" } };

// Herdr's main layout: the tab bar sits in a column, so it is wrapped in a row that takes its size.
const shipped = { id: "root", type: "row", children: [{ id: "sidebar", type: "column", children: [] }, { id: "work", type: "column", children: [tabs, main] }] };
let r = withToolbarButton(shipped, MOD);
assert.equal(r.added, true);
assert.deepEqual(r.tree.children[1].children[0], {
  id: "tabs-row", type: "row", size: { px: 42 }, window_drag: true,
  children: [{ ...tabs, size: { weight: 1 } }, button],
});
assert.deepEqual(r.tree.children[1].children[1], main);
assert.equal(shipped.children[1].children[0], tabs); // the tree given is not changed
assert.equal(hasToolbarButton(shipped, MOD), false);
assert.equal(hasToolbarButton(r.tree, MOD), true);

// Never twice: a layout that has the button comes back as it was.
const again = withToolbarButton(r.tree, MOD);
assert.equal(again.added, false);
assert.deepEqual(again.tree, r.tree);
// Also when the button was added by hand under another id, or floats.
const byHand = { id: "root", type: "row", children: [tabs, { id: "my-button", type: "block", content: { mod: MOD, props: { mode: "toolbar" } } }] };
assert.equal(hasToolbarButton(byHand, MOD), true);
assert.equal(withToolbarButton(byHand, MOD).added, false);
assert.equal(hasToolbarButton({ id: "root", type: "row", children: [], floating: [button] }, MOD), true);
// The mod as a pane or panel (no toolbar mode) is not the button.
assert.equal(hasToolbarButton({ id: "root", type: "row", children: [{ id: "x", type: "block", content: { mod: MOD } }] }, MOD), false);

// A tab bar already in a row (another mod's button beside it): the button goes right after the tab bar.
const other = { id: "pp-launch-tabs", type: "block", size: { px: 36 }, content: { mod: "project-presets-launcher" } };
const inRow = { id: "root", type: "column", children: [{ id: "tabs-row", type: "row", size: { px: 42 }, children: [{ ...tabs, size: { weight: 1 } }, other] }, main] };
r = withToolbarButton(inRow, MOD);
assert.equal(r.added, true);
assert.deepEqual(r.tree.children[0].children.map((c) => c.id), ["tabs", BUTTON_ID, "pp-launch-tabs"]);

// The tab bar found by its mod when its id differs; a wrapper id already in use is not reused.
const odd = { id: "root", type: "column", children: [{ id: "tabs-row", type: "block", content: { mod: "x" } }, { id: "bar", type: "block", size: { px: 30 }, min: 20, content: { mod: "tabs" } }] };
r = withToolbarButton(odd, MOD);
assert.equal(r.added, true);
assert.equal(r.tree.children[1].id, "worktree-sprawl-tabs-row");
assert.equal(r.tree.children[1].min, 20);
assert.equal(r.tree.children[1].children[0].min, undefined);

// No tab bar: nothing is added.
assert.equal(withToolbarButton({ id: "root", type: "row", children: [main] }, MOD).added, false);
assert.deepEqual(withToolbarButton(null, MOD), { tree: null, added: false });

// Copy names.
assert.equal(copyName("main", ["main", "terminals"]), "main-worktrees");
assert.equal(copyName("main", ["main", "main-worktrees", "main-worktrees-2"]), "main-worktrees-3");

// Shipped layouts are the ones Herdr lists; a clone is not. Without the list, the known names.
const installed = JSON.stringify({ agents: {}, "layout:main": {}, "layout:terminals": {} });
assert.equal(isShippedLayout("main", installed), true);
assert.equal(isShippedLayout("main-launcher", installed), false);
assert.equal(isShippedLayout("win98", installed), false);
assert.equal(isShippedLayout("win98", null), true);
assert.equal(isShippedLayout("main", "not json"), true);
assert.equal(isShippedLayout("my-layout", "not json"), false);

console.log("all layout tests passed");
