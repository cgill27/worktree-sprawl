// Sorting for the worktree list. Pure: no host calls, so it can be tested with plain node.
//
// Every column sorts by the value it shows:
//   name     the label (flat list: "repo / worktree")
//   size     disk use in KB
//   changes  modified + untracked files
//   state    waiting > done > working > idle (agents) > terminal only > orphan
//   age      how long ago the last commit was (so ▲ = newest first, like "1d ago" < "3d ago")
// A missing value (size not measured yet, no commit) always sorts last, in both directions.

const STATUS_RANK = { blocked: 4, done: 3, working: 2, idle: 1 };

export function stateRank(x) {
  if (x.state === "agent") return 10 + (STATUS_RANK[x.status] ?? 0);
  return x.state === "terminal" ? 5 : 0;
}

/** The value a worktree row shows for `key`, or null when unknown. */
export function tileSortValue(x, key, { now, flat }) {
  switch (key) {
    case "name": return (flat ? `${x.repo} / ${x.name}` : x.name).toLowerCase();
    case "size": return Number.isFinite(x.size) ? x.size : null;
    case "changes": return (x.changed ?? 0) + (x.untracked ?? 0);
    case "state": return stateRank(x);
    case "age": return x.lastCommit ? Math.max(0, now - x.lastCommit) : null;
    default: return null;
  }
}

/** A repository row's totals over its worktrees, as the row shows them. */
export function groupTotals(tiles) {
  const sizes = tiles.map((x) => x.size).filter((s) => Number.isFinite(s));
  const commits = tiles.map((x) => x.lastCommit).filter(Boolean);
  return {
    size: sizes.length ? sizes.reduce((s, v) => s + v, 0) : null,
    changes: tiles.reduce((s, x) => s + (x.changed ?? 0) + (x.untracked ?? 0), 0),
    rank: tiles.length ? Math.max(...tiles.map(stateRank)) : 0,
    newest: commits.length ? Math.max(...commits) : null,
  };
}

/** The value a repository row shows for `key` (age: its newest commit), or null when unknown. */
export function groupSortValue(g, key, { now }) {
  switch (key) {
    case "name": return g.repo.toLowerCase();
    case "size": return g.size;
    case "changes": return g.changes;
    case "state": return g.rank;
    case "age": return g.newest ? Math.max(0, now - g.newest) : null;
    default: return null;
  }
}

/**
 * A comparator: `value(item, key)` gives the sort value, `label(item)` breaks ties (A→Z).
 * Unknown (null) values go last whichever way the column is sorted.
 */
export function comparator(value, label, key, dir) {
  return (a, b) => {
    const va = value(a, key), vb = value(b, key);
    if (va == null || vb == null) {
      if (va == null && vb != null) return 1;
      if (vb == null && va != null) return -1;
    } else {
      const r = typeof va === "string" ? va.localeCompare(vb) : va < vb ? -1 : va > vb ? 1 : 0;
      if (r) return dir === "asc" ? r : -r;
    }
    return label(a).localeCompare(label(b));
  };
}

// ---------------------------------------------------------------- list mode + sort state
//
// By repository is grouped and always sorted by name. Sorting by any other column needs one
// top-to-bottom order, so it switches to the flat list; switching back to By repository
// sorts by name again. State: { listMode: "tree" | "flat", sort: { key, dir } }.

const NAME_ASC = { key: "name", dir: "asc" };

/** A saved state made consistent: the tree only sorts by name. */
export function normalizeListState(state) {
  const listMode = state?.listMode === "flat" ? "flat" : "tree";
  const sort = state?.sort && typeof state.sort.key === "string" && ["asc", "desc"].includes(state.sort.dir) ? state.sort : NAME_ASC;
  return listMode === "tree" && sort.key !== "name" ? { listMode, sort: NAME_ASC } : { listMode, sort };
}

/** Clicking a column heading: same column reverses; another starts A→Z for name, largest/most first otherwise. */
export function clickColumn(state, key) {
  const sort = state.sort.key === key
    ? { key, dir: state.sort.dir === "asc" ? "desc" : "asc" }
    : { key, dir: key === "name" ? "asc" : "desc" };
  const listMode = state.listMode === "tree" && key !== "name" ? "flat" : state.listMode;
  return { listMode, sort };
}

/** The By repository / Flat list toggle. */
export function setListMode(state, listMode) {
  if (listMode === "tree") return { listMode, sort: state.sort.key === "name" ? state.sort : NAME_ASC };
  return { listMode: "flat", sort: state.sort };
}
