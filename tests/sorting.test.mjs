// Unit tests for mods/worktree-sprawl/sorting.js. Run from the package root: node tests/sorting.test.mjs
// (Loads the module from source as a data: URL, so it works without a package.json "type": "module".)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const src = readFileSync(new URL("../mods/worktree-sprawl/sorting.js", import.meta.url), "utf8");
const { tileSortValue, groupSortValue, groupTotals, comparator, normalizeListState, clickColumn, setListMode } = await import(`data:text/javascript,${encodeURIComponent(src)}`);

const now = 1_000_000;
const day = 86400;
const W = (name, repo, o) => ({ name, repo, changed: 0, untracked: 0, state: "orphan", status: null, size: 100, lastCommit: now - day, ...o });
const tiles = [
  W("b-mid", "zeta", { lastCommit: now - 3 * day, size: 500, changed: 2, state: "agent", status: "working" }),
  W("a-new", "alpha", { lastCommit: now - 1 * day, size: 50, untracked: 5, state: "agent", status: "blocked" }),
  W("c-old", "alpha", { lastCommit: now - 27 * day, size: 9000, state: "terminal" }),
  W("d-nocommit", "beta", { lastCommit: null, size: null }),
  W("e-same", "beta", { lastCommit: now - 3 * day, size: 500 }),
];
const flat = (key, dir) => [...tiles].sort(comparator((x, k) => tileSortValue(x, k, { now, flat: true }), (x) => `${x.repo} / ${x.name}`.toLowerCase(), key, dir)).map((x) => x.name);
const tree = (key, dir) => [...tiles].sort(comparator((x, k) => tileSortValue(x, k, { now, flat: false }), (x) => x.name, key, dir)).map((x) => x.name);

// Last commit: ascending = smallest age first (newest), unknown last both ways.
assert.deepEqual(tree("age", "asc"), ["a-new", "b-mid", "e-same", "c-old", "d-nocommit"]);
assert.deepEqual(tree("age", "desc"), ["c-old", "b-mid", "e-same", "a-new", "d-nocommit"]);
// Size: unknown last both ways; ties by name.
assert.deepEqual(tree("size", "desc"), ["c-old", "b-mid", "e-same", "a-new", "d-nocommit"]);
assert.deepEqual(tree("size", "asc"), ["a-new", "b-mid", "e-same", "c-old", "d-nocommit"]);
// Changes = changed + untracked.
assert.deepEqual(tree("changes", "desc"), ["a-new", "b-mid", "c-old", "d-nocommit", "e-same"]);
// State: waiting agent > working agent > terminal only > orphans.
assert.deepEqual(tree("state", "desc"), ["a-new", "b-mid", "c-old", "d-nocommit", "e-same"]);
assert.deepEqual(tree("state", "asc"), ["d-nocommit", "e-same", "c-old", "b-mid", "a-new"]);
// Name: the flat list sorts by the shown "repo / worktree" label.
assert.deepEqual(flat("name", "asc"), ["a-new", "c-old", "d-nocommit", "e-same", "b-mid"]);
assert.deepEqual(tree("name", "desc"), ["e-same", "d-nocommit", "c-old", "b-mid", "a-new"]);

// Repository rows: totals as shown, age = newest commit, unknown sizes not counted as 0.
const groups = ["alpha", "beta", "zeta"].map((repo) => ({ repo, ...groupTotals(tiles.filter((x) => x.repo === repo)) }));
assert.deepEqual(groups.map((g) => g.size), [9050, 500, 500]);
const gsort = (key, dir) => [...groups].sort(comparator((g, k) => groupSortValue(g, k, { now }), (g) => g.repo, key, dir)).map((g) => g.repo);
assert.deepEqual(gsort("age", "asc"), ["alpha", "beta", "zeta"]);
assert.deepEqual(gsort("size", "desc"), ["alpha", "beta", "zeta"]);
assert.deepEqual(gsort("state", "desc"), ["alpha", "zeta", "beta"]);
assert.deepEqual(gsort("changes", "desc"), ["alpha", "zeta", "beta"]);
const none = groupTotals([W("x", "q", { size: null, lastCommit: null })]);
assert.equal(none.size, null);
assert.equal(none.newest, null);

// List mode rules: By repository sorts by name only; other headings switch to the flat list.
const T = (key, dir) => ({ listMode: "tree", sort: { key, dir } });
const F = (key, dir) => ({ listMode: "flat", sort: { key, dir } });
assert.deepEqual(normalizeListState(T("age", "desc")), T("name", "asc"));      // saved tree+age (the reported bug) → tree by name
assert.deepEqual(normalizeListState(F("age", "desc")), F("age", "desc"));
assert.deepEqual(normalizeListState(undefined), T("name", "asc"));
assert.deepEqual(normalizeListState({ listMode: "flat", sort: { key: "size", dir: "sideways" } }), F("name", "asc"));
assert.deepEqual(clickColumn(T("name", "asc"), "age"), F("age", "desc"));       // heading in tree → flat, oldest first
assert.deepEqual(clickColumn(F("age", "desc"), "age"), F("age", "asc"));        // again → reverse
assert.deepEqual(clickColumn(T("name", "asc"), "name"), T("name", "desc"));     // Name keeps the tree
assert.deepEqual(clickColumn(F("size", "desc"), "name"), F("name", "asc"));
assert.deepEqual(setListMode(F("age", "asc"), "tree"), T("name", "asc"));       // back to tree → by name
assert.deepEqual(setListMode(F("name", "desc"), "tree"), T("name", "desc"));
assert.deepEqual(setListMode(T("name", "asc"), "flat"), F("name", "asc"));

console.log("all sorting tests passed");
