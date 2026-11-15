// Documentation screenshots: `~/.config/herdr-app/data/worktree-sprawl.demo` (JSON) fills the mod with
// made-up worktrees and opens it in a given state, so each screen can be captured the same way every
// time without showing real repositories. Absent by default. While a demo is shown nothing is scanned,
// cached, removed or pruned. The file is read when the mod loads: save main.js (or reopen the tab) to apply it.
//   { "roots": ["~/.herdr/worktrees", "~/code/worktrees"],
//     "worktrees": [{ "repo": "storefront", "name": "checkout-redesign", "root": "~/code/worktrees", "mb": 1840,
//                     "branch"?, "changed"?, "untracked"?, "ahead"?, "behind"?, "unpushed"?, "ageHours"?, "subject"?,
//                     "locked"?, "localFiles"?: [".env"],
//                     "users"?: [{ "name": "Claude Code", "status": "working|blocked|done|idle", "space"?, "tab"? }
//                                | { "name": "Shell" }] }],
//     "stale"?: [{ "repo": "storefront", "name": "old-spike" }],
//     "view"?: { "layoutMode": "both|list|map", "sizeMode": "disk|equal", "colorMode": "status|repo",
//                "listMode": "tree|flat", "sort": { "key", "dir" } },
//     "pinned"?: "repo/name", "selected"?: ["repo/name"], "collapsed"?: ["repo"],
//     "confirm"?: "orphans|selected", "settings"?: true, "loading"?: { "label", "done", "total" } }
import * as fs from "fs/promises";
import { appHome } from "herdr";

export async function readDemo() {
  const path = `${appHome()}/data/worktree-sprawl.demo`;
  try {
    if (!(await fs.exists(path))) return null;
    const demo = JSON.parse(await fs.readFile(path, "utf8"));
    return demo && Array.isArray(demo.worktrees) ? demo : null;
  } catch { return null; }
}

/**
 * The demo file as the view's own data: worktree items, sizes in KB and the terminals "inside" each.
 * `expand` turns "~/x" into an absolute path. Pure apart from that.
 */
export function demoData(demo, expand, nowMs) {
  const items = [];
  const sizes = {};
  const users = new Map();
  const key = (w) => `${w.repo}/${w.name}`;
  const paths = new Map();
  let n = 0;
  for (const w of demo.worktrees) {
    const root = expand(w.root ?? "~/.herdr/worktrees");
    const path = `${root}/${w.repo}/${w.name}`;
    const local = Array.isArray(w.localFiles) ? w.localFiles : [];
    paths.set(key(w), path);
    items.push({
      path, real: path, name: w.name, repo: w.repo, repoRoot: expand(`~/code/${w.repo}`),
      branch: w.branch ?? w.name, upstream: w.upstream ?? `origin/${w.branch ?? w.name}`,
      ahead: w.ahead ?? 0, behind: w.behind ?? 0, changed: w.changed ?? 0, untracked: w.untracked ?? 0,
      unpushed: w.unpushed ?? 0,
      lastCommit: Math.floor(nowMs / 1000 - (w.ageHours ?? 24) * 3600), subject: w.subject ?? "Update",
      locked: Boolean(w.locked), lockUnknown: false,
      localFiles: local.length, localSample: local.slice(0, 4), localUnknown: false,
    });
    if (Number.isFinite(w.mb)) sizes[path] = Math.round(w.mb * 1024);
    users.set(path, (w.users ?? []).map((u) => {
      const agent = Boolean(u.status);
      n += 1;
      return { address: `t${n}`, cwd: path, agent, status: agent ? u.status : null, name: u.name ?? (agent ? "Claude Code" : "Shell"),
        title: "", space: u.space ?? w.repo, tab: u.tab ?? null, shown: true };
    }));
  }
  const stale = (demo.stale ?? []).map((s) => ({
    repoRoot: expand(`~/code/${s.repo}`), path: `${expand(s.root ?? "~/.herdr/worktrees")}/${s.repo}/${s.name}`,
    reason: "gitdir file points to non-existent location",
  }));
  const pathOf = (k) => paths.get(k) ?? null;
  return { items, sizes, users, stale, pathOf, repoRootOf: (repo) => expand(`~/code/${repo}`) };
}
