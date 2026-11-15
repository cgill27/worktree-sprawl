// Worktree Sprawl: every git worktree under the configured folders as a treemap
// (sized by disk use, coloured by the agent working in it), with a detail panel
// on hover and removal of orphaned worktrees (no terminal or agent inside).
//
// Runs programs: find, git, du, and open / xdg-open / explorer (Reveal). Writes nothing itself except through
// `git worktree remove` / `git worktree prune`, and only after a confirmation.
import { View, div, svg, Background, PathBuilder } from "gpui-kit";
import { v_flex, h_flex, Input, InputState, Button, Popover, HoverCard } from "gpui-base";
import * as fs from "fs/promises";
import { exec, home, appHome, readTextFile, writeTextFile, window as appWindow, theme, settings, panes, terminals, agents, spaces, run, shared, setShared, props, pickFolder, notify } from "herdr";
import { squarify, snap } from "./treemap.js";
import { tileSortValue, groupSortValue, groupTotals, comparator, normalizeListState, clickColumn, setListMode } from "./sorting.js";
import { platformProblem, gitProblem } from "./checks.js";
import { readDemo, demoData } from "./demo.js";
import { G, H as HC, R, T, tokens, toggleSwitch, button, card, cardHeader, pageTitle, mutedText, metaLabel, segmented, notice, controlInput, statCell } from "./ui.js";

const MOD = "worktree-sprawl";
const ROOTS_KEY = "worktree-sprawl.roots";
const VIEW_KEY = "worktree-sprawl.view";
// Herdr's own worktree folder. Add your other worktree folders in Settings.
const DEFAULT_ROOTS = ["~/.herdr/worktrees"];
const SCAN_DEPTH = 5;
const REFRESH_MS = 60_000;
const TTL_CHOICES = [5, 15, 60, 360];   // minutes: on open, disk sizes older than this are measured again
const CACHE_VERSION = 2;
// Ignored entries that tools recreate; anything else ignored (.env, local config) is "local files".
const REGENERABLE = new Set(["node_modules", "dist", "build", "out", "target", ".next", ".nuxt", ".turbo", ".cache",
  "coverage", ".terraform", ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".gradle",
  "bin", "obj", ".DS_Store", ".idea", ".vscode", "tmp", ".parcel-cache", ".svelte-kit", ".angular", "vendor"]);
const SIDE_WIDTH = 330;
const REPO_HEADER = 20;
const SETTINGS_KEY = "worktree-sprawl.settings";
const SCALE_MIN = 0.8, SCALE_MAX = 1.75, SCALE_STEP = 0.05;
const SCALE_PRESETS = [0.9, 1, 1.15, 1.3, 1.5];
// The type and control scale as shipped; the live T / HC are these times the text scale.
const T0 = { ...T };
const HC0 = { ...HC };
const HEX = /^#[0-9a-f]{6}$/i;
const PRESET_COLORS = [
  "#ef4444", "#f97316", "#f59e0b", "#eab308", "#84cc16", "#22c55e", "#10b981", "#14b8a6",
  "#06b6d4", "#0ea5e9", "#3b82f6", "#6366f1", "#8b5cf6", "#a855f7", "#d946ef", "#ec4899",
  "#f43f5e", "#e2704f", "#b45309", "#9ca3af", "#6b7280", "#4b5563", "#374151", "#e5e7eb",
];
/** Every colour the person can change, in the order Settings lists them. */
const COLOR_SLOTS = [
  { group: "Agent status", key: "waiting", label: "Waiting on you" },
  { group: "Agent status", key: "working", label: "Working" },
  { group: "Agent status", key: "done", label: "Done" },
  { group: "Agent status", key: "idle", label: "Idle" },
  { group: "Agent status", key: "terminal", label: "Terminal only" },
  { group: "Orphans and selection", key: "orphan", label: "Orphan block" },
  { group: "Orphans and selection", key: "dirty", label: "Uncommitted-changes tint" },
  { group: "Orphans and selection", key: "selected", label: "Selected for deletion" },
  { group: "Orphans and selection", key: "pinned", label: "Pinned outline" },
];
const STATUS_SLOT = { blocked: "waiting", working: "working", done: "done", idle: "idle" };
const STATUS_RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
const STATUS_LABEL = { blocked: "Waiting on you", done: "Done", working: "Working", idle: "Idle" };
const REPO_COLORS = ["#5b8def", "#3fb27f", "#e0a23c", "#d96c92", "#8f6fe0", "#41b3ba", "#e2704f", "#9bbf4a", "#c77dd6", "#6aa2c8"];

// ---------------------------------------------------------------- help text

// Each entry: a title and paragraphs; a paragraph is a string or { term, text }.
const HELP = {
  stale: {
    title: "Stale worktree records",
    body: [
      "For every linked worktree, git keeps a small record inside the main repository (.git/worktrees/<name>) that points at the worktree's folder.",
      "When a worktree folder is deleted directly (rm -rf, a temp folder cleaned up, an agent's sandbox removed) instead of with git worktree remove, that record stays behind pointing at nothing. Git calls it prunable.",
      { term: "What Prune records does", text: "Runs git worktree prune in each affected repository. It deletes only those leftover records. It never touches files, branches or commits." },
      { term: "Why it helps", text: "A stale record still claims its branch and path, so git can refuse to check out that branch or create a new worktree there (\"already used by worktree at …\"). Pruning frees them and keeps git worktree list accurate." },
      "Hover the message to see the missing folders.",
    ],
  },
  orphans: {
    title: "Orphans and what's in use",
    body: [
      { term: "Orphan", text: "A worktree with no live terminal inside its folder: no agent and no shell is using it. Usually left over after an agent finished and its tab was closed." },
      { term: "Terminal only", text: "A shell is open in it but no agent. It's in use, so it's never offered for deletion." },
      { term: "Locked", text: "Locked with git worktree lock, or git's lock state couldn't be read. Never offered for deletion." },
      { term: "With agent", text: "An agent (Claude Code, Codex, …) has its folder inside this worktree." },
      "Which terminals are where is read live from Herdr, so this updates as agents start and stop. Only terminals on this computer count.",
    ],
  },
  map: {
    title: "Reading the map",
    body: [
      { term: "Regions", text: "Each outlined region is one repository; the blocks inside are its worktrees. The header shows the repo, its worktree count and total size." },
      { term: "Block size", text: "Disk use of the worktree's folder (du), including node_modules and build output, so one big block is where the space goes. Very small worktrees are drawn a little larger so you can still hover them. Switch Size to Equal to give every worktree the same area." },
      { term: "Colour", text: "The most urgent agent in the worktree: Waiting on you > Done > Working > Idle. Blue means a shell is open but no agent." },
      { term: "Hatched, dashed blocks", text: "Orphans: nothing is using them. An amber tint means the orphan has uncommitted changes." },
      { term: "Red border with ✓", text: "Selected for deletion." },
      { term: "Clicking", text: "Hover a block to preview it in the panel. Click it to pin it (highlighted outline): the panel then stays on it while you move the pointer. Click it again, press ✕ in the panel, or click empty map space to unpin." },
      { term: "Selecting orphans", text: "Tick the box in an orphan’s top-left corner, or use Select to delete in its details. Selecting also pins it. Click a name in the Selected list to bring its details back." },
    ],
  },
  list: {
    title: "The worktree list",
    body: [
      { term: "By repository", text: "A tree like WinDirStat's: all worktrees, then each repository, then its worktrees, sorted by name. Click a repository (or its ▸) to fold it." },
      { term: "Flat list", text: "Every worktree in one list, sorted top to bottom by any column. Sort by Size to see the biggest first." },
      { term: "Sorting", text: "Click a column heading to sort by it; click again to reverse. Any heading except Name switches to the flat list, so the column reads in order from top to bottom; By repository groups again, by name. Each column sorts by what it shows: Last commit ▲ is newest first (1d ago before 3d ago). Values not known yet (size still measuring, no commits) always go last." },
      { term: "Size proportion", text: "The bar shows a share of its parent: a repository's share of all worktrees, a worktree's share of its repository. Percent is always the share of the total." },
      { term: "Rows and the map", text: "Hovering a row highlights its block on the map; clicking pins it in the details panel. The box on orphan rows selects them for deletion." },
      { term: "Select a whole repository", text: "The box on a repository row (or on the map's repository header) selects every orphan in it; click again to deselect. A dash means some are selected. The box on All worktrees selects every orphan." },
    ],
  },
  cache: {
    title: "Caching",
    body: [
      { term: "What's stored", text: "One file, ~/.config/herdr-app/data/worktree-sprawl/cache.json: the list of worktrees with their repository, branch and git status counts, the stale records, and each worktree's disk size with when it was measured. No file contents, nothing outside this machine." },
      { term: "When you open Worktrees", text: "The last results show at once (the header says \"Showing cached results … updating\"). Folders and git state are re-read in the background, usually in a second or two. Disk sizes older than the re-measure time are measured again with du; newer ones are reused." },
      { term: "While it's open", text: "Every 60 seconds git state is re-read and only worktrees without a size are measured. Refresh always re-measures every worktree." },
      { term: "Safety", text: "Deleting stays disabled until this session's own scan has finished, so nothing is ever removed based on cached data. Removal also re-checks for live terminals first." },
      { term: "Re-measure time", text: "Shorter keeps sizes more accurate but runs du more often on open, which takes several seconds for worktrees with node_modules or build output. Longer opens faster with possibly older sizes." },
      { term: "Turning it off", text: "Deletes the cache file and writes nothing more. Every open then does a full scan, including du on every worktree, before the map appears." },
      "The cache is ignored if the folders to scan have changed since it was saved, and it's rebuilt after the next scan.",
    ],
  },
  git: {
    title: "Git state",
    body: [
      { term: "Changes", text: "Modified and new (untracked) files that aren't committed. These are the only thing lost if the worktree is removed, and only after you confirm." },
      { term: "Upstream ↑ ↓", text: "↑ commits on this branch not yet pushed to its tracking branch; ↓ commits on the remote branch you don't have locally. \"No upstream\" means the branch was never pushed with tracking." },
      { term: "Unpushed", text: "Commits in this worktree that aren't on any remote branch. Removing the worktree keeps them on the branch, but they exist only on this machine until pushed." },
    ],
  },
  delete: {
    title: "Deleting worktrees",
    body: [
      { term: "Delete all orphans", text: "Offers every orphan for removal. Nothing happens until you confirm." },
      { term: "Delete selected", text: "Tick the box in an orphan’s corner (or use Select to delete in its details) to pick specific ones." },
      { term: "What removal does", text: "Runs git worktree remove, which deletes the folder and git's record of it. The branch and all its commits are kept, so you can recreate the worktree later." },
      { term: "Uncommitted changes and local files", text: "Orphans with uncommitted changes, or with ignored local files git would delete too (.env, local config; build output like node_modules doesn't count), are listed separately. You choose whether to remove only the clean ones or those as well." },
      { term: "Final checks", text: "Right before each removal, with symlinks resolved, it checks again that no terminal is inside the worktree and that git doesn't have it locked. If git's lock state can't be read, the worktree is skipped." },
      "Deleting is available only after a complete scan this session, never while scanning, measuring or pruning.",
    ],
  },
};

// ---------------------------------------------------------------- helpers

// `.bg()` takes a plain colour; gradients and patterns are painted as a layer.
const RECT = () => PathBuilder.fill().move_to("0%", "0%").line_to("100%", "0%").line_to("100%", "100%").line_to("0%", "100%").close().build();
const layer = (background) => window.paint_path(RECT(), background).absolute().top(0).left(0).size_full();

const expand = (p) => {
  let s = String(p ?? "").trim();
  if (s === "~") s = home();
  else if (s.startsWith("~/")) s = home() + s.slice(1);
  while (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
  return s;
};
const tilde = (p) => (p && p.startsWith(home() + "/") ? "~" + p.slice(home().length) : p);
const basename = (p) => String(p).split("/").filter(Boolean).pop() ?? p;
const inside = (child, parent) => Boolean(child && parent) && (child === parent || child.startsWith(parent + "/"));
/** Comparison key for a path: case-folded where the file system usually is (macOS, Windows). */
const pkey = (p) => {
  if (!p) return "";
  return ["macos", "windows"].includes(appWindow()?.platform) ? String(p).toLowerCase() : String(p);
};
/** True when `cwd` is inside the worktree, comparing raw and physical (symlink-resolved) spellings. */
const within = (cwd, cwdReal, w) =>
  inside(pkey(cwd), pkey(w.path)) || inside(pkey(cwd), pkey(w.real)) || inside(pkey(cwdReal), pkey(w.real)) || inside(pkey(cwdReal), pkey(w.path));
const firstLine = (s) => String(s ?? "").trim().split("\n")[0] ?? "";

// MB is the smallest unit shown; GB from 1000 MB, so no size shows four digits.
function formatKB(kb) {
  if (kb == null) return "…";
  if (kb <= 0) return "0 MB";
  const mb = kb / 1024;
  if (mb < 0.05) return "<0.1 MB";
  if (mb < 1000) return `${mb.toFixed(mb < 9.95 ? 1 : 0)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(gb < 99.95 ? 1 : 0)} GB`;
}

function formatAge(unix) {
  if (!unix) return "—";
  const s = Math.max(0, Date.now() / 1000 - unix);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 60) return `${Math.round(s / 86400)}d ago`;
  return `${Math.round(s / 86400 / 30)}mo ago`;
}

/** The file manager opener for this platform. */
const revealCommand = () => ({ macos: "open", windows: "explorer" })[appWindow()?.platform] ?? "xdg-open";

/** Opens the folder in the file manager; says so when that fails (no desktop, no opener installed). */
async function reveal(path) {
  const cmd = revealCommand();
  const r = await safeExec(cmd, [path], { timeout: 15_000 });
  // explorer exits 1 even when it opened the folder.
  if (r.code !== 0 && cmd !== "explorer") {
    notify({ title: "Couldn't open the folder", body: firstLine(r.stderr) || `${cmd} exited ${r.code}`, level: "warning" });
  }
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function parseHex(hex) {
  const m = /^#([0-9a-f]{6})/i.exec(String(hex ?? ""));
  if (!m) return null;
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
function toHex(rgb) {
  return "#" + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
}
function mix(a, b, t) {
  const x = parseHex(a), y = parseHex(b);
  if (!x || !y) return a;
  return toHex(x.map((v, i) => v + (y[i] - v) * t));
}
function readableOn(hex, light, dark) {
  const rgb = parseHex(hex);
  if (!rgb) return light;
  const [r, g, b] = rgb.map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? dark : light;
}

async function mapLimit(list, limit, fn) {
  const out = new Array(list.length);
  let next = 0;
  const worker = async () => {
    while (next < list.length) { const i = next++; out[i] = await fn(list[i], i); }
  };
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
  return out;
}

const safeExec = (cmd, args, options) =>
  exec(cmd, args, options).catch((error) => ({ code: -1, stdout: "", stderr: String(error?.message ?? error) }));

/**
 * Physical paths (symlinks resolved, `cd && pwd -P`) for each path. A path that can't be
 * resolved (gone, unreadable) maps to itself, so callers still compare its raw spelling.
 */
async function physicalPaths(paths) {
  const list = [...new Set(paths.filter((p) => typeof p === "string" && p))];
  const out = new Map(list.map((p) => [p, p]));
  for (let i = 0; i < list.length; i += 200) {
    const chunk = list.slice(i, i + 200);
    const r = await safeExec("/bin/sh", ["-c", 'for p in "$@"; do (cd -- "$p" 2>/dev/null && pwd -P) || echo; done', "sh", ...chunk], { timeout: 20_000 });
    const lines = r.stdout.split("\n");
    chunk.forEach((p, j) => { const v = (lines[j] ?? "").trim(); if (v) out.set(p, v); });
  }
  return out;
}

/** One Worktrees tab per space: focus it if open, else open it. */
function showWorktrees() {
  const active = spaces().find((space) => space.active);
  const tabIds = new Set(active?.tabs.map((tab) => tab.id) ?? []);
  const open = panes().find((pane) => pane.mod === MOD && tabIds.has(pane.tab));
  if (open) {
    const zoomed = panes().find((pane) => pane.tab === open.tab && pane.zoomed);
    if (zoomed && zoomed.pane !== open.pane) run("pane.zoom", { pane: zoomed.pane });
    return run("pane.focus", { pane: open.pane });
  }
  return run("tab.new", { name: "Worktrees", mod: MOD });
}

/** Every live local terminal with its folder, and whether it's an agent. */
function linkTerminals() {
  const byAgent = new Map(agents().map((a) => [a.address, a]));
  const byPane = new Map(panes().filter((p) => p.terminal).map((p) => [p.terminal, p]));
  const tabInfo = new Map();
  for (const s of spaces()) for (const tb of s.tabs) tabInfo.set(tb.id, { space: s.name, tab: tb.name });
  const out = [];
  for (const term of terminals()) {
    const address = term?.address;
    if (!address || String(address).includes("/")) continue; // other machines
    if (term.state && term.state !== "live") continue;
    const pane = byPane.get(address);
    const agent = byAgent.get(address);
    const cwd = pane?.cwd || term.cwd;
    if (!cwd) continue;
    const reported = STATUS_RANK[term.status] ? term.status : null;
    const status = agent?.status ?? pane?.status ?? reported;
    const program = agent?.program ?? pane?.program ?? term.program;
    const where = pane ? tabInfo.get(pane.tab) : null;
    out.push({
      address,
      cwd,
      agent: Boolean(agent || status || program?.agent),
      status,
      name: program?.name ?? term.agent ?? "Terminal",
      title: agent?.title ?? pane?.title ?? "",
      space: agent?.space_name ?? where?.space ?? null,
      tab: agent?.tab_name ?? where?.tab ?? null,
      shown: Boolean(pane),
    });
  }
  return out;
}

// ---------------------------------------------------------------- git

async function inspectWorktree(path) {
  const git = (args) => safeExec("git", ["-C", path, ...args], { timeout: 20_000 });
  const dirs = await git(["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"]);
  if (dirs.code !== 0) return null;
  const [gitDir, commonDir] = dirs.stdout.trim().split("\n");
  // A main checkout or a submodule has git dir == common dir: not a linked worktree.
  if (!gitDir || !commonDir || gitDir === commonDir) return null;
  const repoRoot = commonDir.endsWith("/.git") ? commonDir.slice(0, -5) : commonDir;

  const [status, log, unpushed, ignored] = await Promise.all([
    git(["status", "--porcelain=v2", "--branch", "--untracked-files=normal"]),
    git(["log", "-1", "--format=%ct%x09%s"]),
    git(["rev-list", "--count", "HEAD", "--not", "--remotes"]),
    // Ignored files git worktree remove deletes without --force; --directory stops at ignored folders.
    git(["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "--no-empty-directory"]),
  ]);
  const localFiles = ignored.code === 0
    ? ignored.stdout.split("\n").map((l) => l.trim()).filter(Boolean).filter((entry) => {
      const name = entry.replace(/\/$/, "").split("/").pop();
      return !REGENERABLE.has(name) && !/\.(pyc|log)$/.test(name);
    })
    : [];
  let branch = null, upstream = null, ahead = 0, behind = 0, changed = 0, untracked = 0;
  for (const line of status.stdout.split("\n")) {
    if (line.startsWith("# branch.head ")) { const b = line.slice(14); branch = b === "(detached)" ? null : b; }
    else if (line.startsWith("# branch.upstream ")) upstream = line.slice(18);
    else if (line.startsWith("# branch.ab ")) {
      const m = /\+(\d+) -(\d+)/.exec(line);
      if (m) { ahead = Number(m[1]); behind = Number(m[2]); }
    } else if (line.startsWith("? ")) untracked += 1;
    else if (/^[12u] /.test(line)) changed += 1;
  }
  const [ct, ...subject] = log.stdout.trim().split("\t");
  return {
    path,
    name: basename(path),
    repoRoot,
    repo: basename(repoRoot),
    branch,
    upstream,
    ahead,
    behind,
    changed,
    untracked,
    unpushed: unpushed.code === 0 ? Number(unpushed.stdout.trim()) || 0 : 0,
    lastCommit: Number(ct) || null,
    subject: subject.join("\t"),
    locked: false,
    lockUnknown: false,
    real: path,
    localFiles: localFiles.length,
    localSample: localFiles.slice(0, 4),
    // Couldn't list ignored files: treat as possibly holding local files (fail closed).
    localUnknown: ignored.code !== 0,
  };
}

/** Locked worktrees and records whose folder is gone, per repo. */
async function repoRecords(repoRoot) {
  const r = await safeExec("git", ["-C", repoRoot, "worktree", "list", "--porcelain"], { timeout: 20_000 });
  const ok = r.code === 0;
  const locked = new Set();
  const stale = [];
  let current = null;
  for (const line of `${r.stdout}\n`.split("\n")) {
    if (line.startsWith("worktree ")) current = { path: line.slice(9) };
    else if (line === "" && current) current = null;
    else if (current && line.startsWith("locked")) locked.add(current.path);
    else if (current && line.startsWith("prunable")) stale.push({ repoRoot, path: current.path, reason: line.slice(9) });
  }
  return { ok, locked, stale };
}

// ---------------------------------------------------------------- view

export default class WorktreeSprawl extends View {
  init(_props, cx) {
    this.toolbarMode = props()?.mode === "toolbar";
    if (this.toolbarMode) return;

    this.items = [];
    this.stale = [];
    this.sizes = {};
    this.sizeAt = {};               // path -> ms when its size was measured
    this.liveScan = false;          // true while the list is confirmed by a complete scan this session
    this.everLive = false;          // a scan has completed this session (cached results replaced)
    this.queued = null;             // a scan asked for while busy: "missing" | "stale" | "all"
    this.pruning = false;
    this.demo = null;               // made-up data for screenshots (demo.js); set, nothing is scanned or changed
    this.demoRoots = null;
    this.gitOk = false;             // true once `git --version` showed a usable git
    this.pruneReport = null;
    this.knownRepos = new Set();    // repositories seen before, so stale-only ones can still be pruned
    this.cwdReal = new Map();       // terminal folder -> physical path, refreshed each scan
    this.cacheChain = Promise.resolve();
    this.lastTick = 0;
    this.cacheSavedAt = null;       // ms of the cache file's last save (this session or loaded)
    this.openedFromCache = false;
    this.sizing = null;
    this.scanning = false;
    this.scannedAt = null;
    this.rootErrors = [];
    this.error = null;
    this.hover = null;
    this.pinned = null;
    this.selected = new Set();
    this.confirm = null;
    this.deleting = null;
    this.failures = [];
    this.showSettings = false;
    this.openHelp = null;
    this.openColor = null;
    // One hex field per colour slot and per repository colour, made here (not in render).
    this.colorInputs = {};
    for (const key of [...COLOR_SLOTS.map((slot) => slot.key), ...REPO_COLORS.map((_, i) => `repo-${i}`)]) {
      const input = InputState.new({ placeholder: "#rrggbb" });
      input.on("submit", (_event, submitCx) => this.applyHex(key, input.value(), submitCx));
      this.colorInputs[key] = input;
    }
    this.loaded = false;            // false until the first scan and disk measurement finish
    this.progress = null;           // { label, done, total } while working
    this.mapSize = { width: 0, height: 0 };
    const view = shared(VIEW_KEY) ?? {};
    this.sizeMode = view.sizeMode === "equal" ? "equal" : "disk";
    this.colorMode = view.colorMode === "repo" ? "repo" : "status";
    this.layoutMode = ["map", "list", "both"].includes(view.layoutMode) ? view.layoutMode : "both";
    ({ listMode: this.listMode, sort: this.sort } = normalizeListState(view));
    this.collapsed = new Set();      // repo roots folded in the list
    this.leftSize = { width: 0, height: 0 };

    this.rootInput = InputState.new({ placeholder: "~/code/worktrees" });
    this.rootInput.on("submit", (_event, submitCx) => this.addRoot(this.rootInput.value(), submitCx));

    cx.timer.every(REFRESH_MS, (timerCx) => this.scan(timerCx, { sizes: "missing" }));
    // Show the last results at once from the cache, then refresh them in the background.
    cx.spawn(async (scx) => {
      const demo = await readDemo();
      if (demo) { this.applyDemo(demo); scx.notify(); return; }
      const cached = this.prefs().cache;
      if (cached) await this.loadCache();
      scx.notify();
      this.scan(scx, { sizes: cached ? "stale" : "all" });
    });
  }

  // ------------------------------------------------------------ state

  /** Made-up worktrees for documentation screenshots (see demo.js): nothing is scanned or changed. */
  applyDemo(demo) {
    const d = demoData(demo, expand, Date.now());
    this.demo = d;
    this.demoRoots = Array.isArray(demo.roots) ? demo.roots : null;
    this.items = d.items.sort((a, b) => a.repo.localeCompare(b.repo) || a.name.localeCompare(b.name));
    this.sizes = d.sizes;
    this.stale = d.stale;
    this.scannedAt = Date.now();
    this.loaded = !demo.loading;
    this.liveScan = this.everLive = this.loaded;
    if (demo.loading) this.progress = { label: "Measuring disk use", done: 0, total: 0, ...demo.loading };
    const view = demo.view ?? {};
    if (["disk", "equal"].includes(view.sizeMode)) this.sizeMode = view.sizeMode;
    if (["status", "repo"].includes(view.colorMode)) this.colorMode = view.colorMode;
    if (["map", "list", "both"].includes(view.layoutMode)) this.layoutMode = view.layoutMode;
    if (view.listMode || view.sort) ({ listMode: this.listMode, sort: this.sort } = normalizeListState(view));
    this.pinned = demo.pinned ? d.pathOf(demo.pinned) : null;
    this.selected = new Set((demo.selected ?? []).map(d.pathOf).filter(Boolean));
    this.collapsed = new Set((demo.collapsed ?? []).map(d.repoRootOf));
    this.showSettings = Boolean(demo.settings);
    if (demo.confirm) {
      const orphans = this.model().orphans.map((o) => o.path);
      this.confirm = { paths: demo.confirm === "selected" ? [...this.selected] : orphans, kind: demo.confirm };
    }
  }

  roots() {
    if (this.demoRoots) return this.demoRoots;
    const saved = shared(ROOTS_KEY);
    return Array.isArray(saved) ? saved.filter((r) => typeof r === "string" && r.trim()) : DEFAULT_ROOTS;
  }

  setRoots(list, cx) {
    if (this.demo) return;
    setShared(ROOTS_KEY, Array.from(new Set(list.map((r) => tilde(expand(r))))));
    this.scan(cx, { sizes: "missing" });
  }

  addRoot(value, cx) {
    const v = String(value ?? "").trim();
    if (!v) return;
    this.rootInput.set_value("");
    this.setRoots([...this.roots(), v], cx);
  }

  saveView() {
    setShared(VIEW_KEY, { sizeMode: this.sizeMode, colorMode: this.colorMode, layoutMode: this.layoutMode, listMode: this.listMode, sort: this.sort });
  }

  /** Anything that must not overlap a scan, a removal or a prune. */
  busyWork() {
    return this.scanning || Boolean(this.sizing) || Boolean(this.deleting) || this.pruning;
  }

  queueScan(mode) {
    const rank = { missing: 0, stale: 1, all: 2 };
    if (!this.queued || rank[mode] > rank[this.queued]) this.queued = mode;
  }

  runQueued(cx) {
    if (!this.queued || this.busyWork()) return;
    const mode = this.queued;
    this.queued = null;
    this.scan(cx, { sizes: mode });
  }

  /** A redraw at most every 150 ms, for progress counters. */
  tick(cx) {
    const now = Date.now();
    if (now - this.lastTick > 150) { this.lastTick = now; cx.notify(); }
  }

  scan(cx, { sizes }) {
    if (this.demo) return;
    // One operation at a time: a request made while busy runs when the current one ends.
    if (this.busyWork()) { this.queueScan(sizes); return; }
    const roots = this.roots();
    this.scanning = true;
    this.liveScan = false;
    this.error = null;
    cx.notify();
    cx.spawn(async (scx) => {
      let ok = false;
      try {
        const problem = await this.environmentProblem();
        if (problem) throw new Error(problem);
        const found = new Set();
        const rootErrors = [];
        this.progress = { label: "Finding worktrees", done: 0, total: 0 };
        scx.notify();
        for (const root of roots) {
          const dir = expand(root);
          // -H: a configured folder that is itself a symlink is followed (links below it are not).
          const r = await safeExec("find", ["-H", dir, "-maxdepth", String(SCAN_DEPTH),
            "(", "-name", "node_modules", "-o", "-name", ".venv", "-o", "-name", ".terraform", ")", "-prune",
            "-o", "-name", ".git", "-type", "f", "-print"], { timeout: 60_000 });
          if (r.code !== 0 && !r.stdout.trim()) { rootErrors.push({ root, message: firstLine(r.stderr) || "Not readable" }); continue; }
          for (const line of r.stdout.split("\n")) if (line.endsWith("/.git")) found.add(line.slice(0, -5));
        }
        this.progress = { label: "Reading git state", done: 0, total: found.size };
        scx.notify();
        const inspected = (await mapLimit([...found], 8, async (path) => {
          const info = await inspectWorktree(path);
          this.progress.done += 1;
          if (!this.loaded) this.tick(scx);
          return info;
        })).filter(Boolean);

        // Physical paths, so symlinked folders compare equal to terminals' folders and git's records.
        const real = await physicalPaths([...inspected.map((w) => w.path), ...linkTerminals().map((l) => l.cwd)]);
        for (const w of inspected) w.real = real.get(w.path) ?? w.path;

        const repos = [...new Set([...inspected.map((w) => w.repoRoot), ...this.knownRepos])];
        const records = await mapLimit(repos, 6, async (repo) => ({ repo, ...(await repoRecords(repo)) }));
        const lockedRaw = records.flatMap((r) => [...r.locked]);
        const lockedReal = await physicalPaths(lockedRaw);
        const lockedKeys = new Set(lockedRaw.flatMap((p) => [pkey(p), pkey(lockedReal.get(p))]));
        const failedRepos = new Set(records.filter((r) => !r.ok).map((r) => r.repo));
        for (const w of inspected) {
          w.locked = lockedKeys.has(pkey(w.path)) || lockedKeys.has(pkey(w.real));
          // Lock state unreadable: never offer it for removal (fail closed).
          w.lockUnknown = failedRepos.has(w.repoRoot);
        }

        if (JSON.stringify(roots) !== JSON.stringify(this.roots())) {
          // The folders changed while scanning: this result is for the old list. Scan again.
          this.queueScan(sizes);
        } else {
          this.items = inspected.sort((a, b) => a.repo.localeCompare(b.repo) || a.name.localeCompare(b.name));
          this.stale = records.filter((r) => r.ok).flatMap((r) => r.stale);
          this.knownRepos = new Set([...inspected.map((w) => w.repoRoot), ...records.filter((r) => r.ok).map((r) => r.repo)]);
          this.cwdReal = real;
          this.rootErrors = rootErrors;
          this.scannedAt = Date.now();
          const known = new Set(this.items.map((w) => w.path));
          for (const p of [...this.selected]) if (!known.has(p)) this.selected.delete(p);
          ok = true;
        }
      } catch (error) {
        this.error = String(error?.message ?? error);
      }
      this.scanning = false;
      this.progress = null;
      scx.notify();
      if (ok) {
        await this.measure(scx, sizes);
        // Deleting opens only after a complete, successful scan and measurement.
        this.liveScan = true;
        this.everLive = true;
        this.loaded = true;
        await this.saveCache(roots);
        if (this.pruneReport) {
          const { before, failed } = this.pruneReport;
          const cleared = Math.max(0, before - this.stale.length);
          notify({
            title: `Pruned ${plural(cleared, "stale record")}`,
            body: failed.length ? `git worktree prune failed in ${failed.join("; ")}` : this.stale.length ? `${plural(this.stale.length, "record")} remain.` : undefined,
            level: failed.length || this.stale.length ? "warning" : "success",
          });
          this.pruneReport = null;
        }
      } else if (!this.loaded) {
        this.loaded = true; // show the error instead of the progress card
      }
      scx.notify();
      this.runQueued(scx);
    });
  }

  /** Why scanning can't work here (Windows, git missing or too old), or null. A good git is checked once. */
  async environmentProblem() {
    const platform = platformProblem(appWindow()?.platform);
    if (platform) return platform;
    if (this.gitOk) return null;
    const git = gitProblem(await safeExec("git", ["--version"], { timeout: 10_000 }));
    this.gitOk = !git;
    return git;
  }

  cachePath() {
    return `${appHome()}/data/${MOD}/cache.json`;
  }

  async loadCache() {
    try {
      const text = await readTextFile(this.cachePath());
      if (!text) return;
      const data = JSON.parse(text);
      if (data?.version !== CACHE_VERSION) return;
      this.cacheSavedAt = Number(data.savedAt) || null;
      for (const [path, v] of Object.entries(data.sizes ?? {})) {
        if (Number.isFinite(v?.kb)) { this.sizes[path] = v.kb; this.sizeAt[path] = Number(v.at) || 0; }
      }
      if (Array.isArray(data.repos)) this.knownRepos = new Set(data.repos.filter((r) => typeof r === "string"));
      // Every cached worktree must have the fields the views read; otherwise the cache is ignored.
      const str = (v) => typeof v === "string" && v.length > 0;
      const valid = Array.isArray(data.items) && data.items.every((w) => w && str(w.path) && str(w.name) && str(w.repoRoot) && str(w.repo)
        && ["changed", "untracked", "ahead", "behind", "unpushed", "localFiles"].every((k) => Number.isFinite(w[k])));
      // The list itself is only reused when it was made from the same folders.
      if (valid && JSON.stringify(data.roots) === JSON.stringify(this.roots()) && data.items.length) {
        this.items = data.items.map((w) => ({ ...w, real: str(w.real) ? w.real : w.path, localSample: Array.isArray(w.localSample) ? w.localSample : [] }));
        this.stale = Array.isArray(data.stale) ? data.stale : [];
        this.scannedAt = Number(data.savedAt) || null;
        this.loaded = true;
        this.openedFromCache = true;
      }
    } catch (error) {
      console.log(`worktree-sprawl: cache not used: ${error?.message ?? error}`);
    }
  }

  /** Cache writes and deletes run one after another; each write replaces the file atomically. */
  saveCache(roots = this.roots()) {
    if (this.demo) return this.cacheChain;
    this.cacheChain = this.cacheChain.then(() => this.writeCache(roots)).catch(() => {});
    return this.cacheChain;
  }

  async writeCache(roots) {
    if (!this.prefs().cache) return;
    // A snapshot made from other folders than the current ones is never written.
    if (JSON.stringify(roots) !== JSON.stringify(this.roots())) return;
    try {
      const sizes = {};
      for (const w of this.items) {
        if (this.sizes[w.path] != null) sizes[w.path] = { kb: this.sizes[w.path], at: this.sizeAt[w.path] || Date.now() };
      }
      const text = JSON.stringify({
        version: CACHE_VERSION, savedAt: this.scannedAt || Date.now(), roots, items: this.items, stale: this.stale,
        repos: [...this.knownRepos], sizes,
      });
      await fs.mkdir(`${appHome()}/data/${MOD}`, { recursive: true });
      // writeTextFile replaces atomically if the file still matches what we read; retry once on a race.
      for (let attempt = 0; ; attempt += 1) {
        const current = await readTextFile(this.cachePath());
        try { await writeTextFile(this.cachePath(), text, current); break; } catch (error) { if (attempt >= 1) throw error; }
      }
    } catch (error) {
      console.log(`worktree-sprawl: could not save cache: ${error?.message ?? error}`);
      return;
    }
    this.cacheSavedAt = this.scannedAt || Date.now();
  }

  clearCache() {
    if (this.demo) return this.cacheChain;
    this.cacheChain = this.cacheChain.then(async () => {
      try {
        if (await fs.exists(this.cachePath())) await fs.unlink(this.cachePath());
      } catch (error) {
        console.log(`worktree-sprawl: could not delete cache: ${error?.message ?? error}`);
      }
      this.cacheSavedAt = null;
    });
    return this.cacheChain;
  }

  setCaching(on, cx) {
    this.savePrefs({ cache: on });
    cx.spawn(async (scx) => {
      // Off: nothing stays on disk. On: save what's on screen now.
      if (on) await this.saveCache(); else await this.clearCache();
      scx.notify();
    });
  }

  /** mode: "all" (Refresh), "stale" (missing or older than the cache's re-measure time), "missing" (new worktrees only). */
  async measure(cx, mode) {
    const now = Date.now();
    const todo = this.items.map((w) => w.path).filter((p) => mode === "all" || this.sizes[p] == null
      || (mode === "stale" && now - (this.sizeAt[p] || 0) > this.prefs().cacheTtlMin * 60_000));
    if (todo.length === 0) return;
    this.sizing = { done: 0, total: todo.length };
    this.progress = { label: "Measuring disk use", done: 0, total: todo.length };
    cx.notify();
    // Sizes are staged and applied together, so the map doesn't reflow block by block.
    const staged = {};
    await mapLimit(todo, 4, async (path) => {
      const r = await safeExec("du", ["-sk", path], { timeout: 300_000 });
      const kb = parseInt(r.stdout, 10);
      if (Number.isFinite(kb)) staged[path] = kb;
      this.sizing.done += 1;
      this.progress.done += 1;
      this.tick(cx);
    });
    const current = new Set(this.items.map((w) => w.path));
    for (const [path, kb] of Object.entries(staged)) {
      if (!current.has(path)) continue;
      this.sizes[path] = kb;
      this.sizeAt[path] = Date.now();
    }
    this.sizing = null;
    this.progress = null;
    cx.notify();
  }

  /** The worktrees joined with the live terminals in them. */
  model() {
    const links = linkTerminals();
    const tiles = this.items.map((w) => {
      const users = this.demo ? (this.demo.users.get(w.path) ?? []) : links.filter((l) => within(l.cwd, this.cwdReal.get(l.cwd), w));
      const agentsIn = users.filter((u) => u.agent);
      let status = null;
      for (const a of agentsIn) if ((STATUS_RANK[a.status] ?? 0) > (STATUS_RANK[status] ?? 0)) status = a.status;
      const state = agentsIn.length ? "agent" : users.length ? "terminal" : "orphan";
      return {
        ...w,
        users,
        agentsIn,
        status,
        state,
        dirty: w.changed + w.untracked > 0,
        // Removing it would also delete files git doesn't track (local config, .env, …).
        hasLocal: (w.localFiles ?? 0) > 0 || Boolean(w.localUnknown),
        // A worktree whose lock state couldn't be read is treated as locked.
        locked: Boolean(w.locked || w.lockUnknown),
        size: this.sizes[w.path] ?? null,
      };
    });
    for (const p of [...this.selected]) {
      const t = tiles.find((x) => x.path === p);
      if (!t || t.state !== "orphan" || t.locked) this.selected.delete(p);
    }
    // Every count of orphans shown is of all of them; `orphans` are the ones that can be removed (not locked).
    const allOrphans = tiles.filter((t) => t.state === "orphan");
    const orphans = allOrphans.filter((t) => !t.locked);
    const repoIndex = new Map([...new Set(tiles.map((x) => x.repoRoot))].sort().map((r, i) => [r, i]));
    return {
      tiles,
      repoIndex,
      orphans,
      allOrphans,
      cleanOrphans: orphans.filter((t) => !t.dirty),
      dirtyOrphans: orphans.filter((t) => t.dirty),
      totalKB: tiles.reduce((s, t) => s + (t.size ?? 0), 0),
      orphanKB: allOrphans.reduce((s, t) => s + (t.size ?? 0), 0),
    };
  }

  // ------------------------------------------------------------ actions

  /** Click: pin a worktree's details in the panel (again: unpin). */
  pinTile(tile, cx) {
    this.pinned = this.pinned === tile.path ? null : tile.path;
    cx.notify();
  }

  /** The orphan checkbox and the panel's Select button: mark for deletion. */
  toggleSelect(tile, cx) {
    if (tile.state !== "orphan" || tile.locked) return;
    if (this.selected.has(tile.path)) this.selected.delete(tile.path);
    else {
      this.selected.add(tile.path);
      // Selecting also pins it, so its details stay in the panel as the pointer moves over.
      this.pinned = tile.path;
    }
    cx.notify();
  }

  askRemove(paths, kind, cx) {
    this.confirm = { paths, kind };
    cx.notify();
  }

  remove(paths, cx) {
    this.confirm = null;
    if (this.demo) { cx.notify(); return; }
    if (this.busyWork() || !this.liveScan) {
      notify({ title: "Wait for the scan to finish", body: "Worktrees can be removed once the current scan is complete.", level: "warning" });
      cx.notify();
      return;
    }
    cx.spawn(async (scx) => {
      const { tiles } = this.model();
      const byPath = new Map(tiles.map((t) => [t.path, t]));
      this.deleting = { done: 0, total: paths.length };
      this.failures = [];
      scx.notify();
      const repos = new Set();
      let removed = 0, freed = 0;
      for (const path of paths) {
        const tile = byPath.get(path);
        let skip = null;
        if (!tile) skip = "no longer listed";
        else if (tile.locked) skip = tile.lockUnknown ? "lock state unknown" : "locked";
        else {
          // Final checks right before the destructive command, with symlinks resolved:
          // no live terminal inside it, and git's own records still say it isn't locked.
          const links = linkTerminals();
          const real = await physicalPaths([path, ...links.map((l) => l.cwd)]);
          const target = { path, real: real.get(path) ?? path };
          const rec = await repoRecords(tile.repoRoot);
          const lockedReal = rec.ok ? await physicalPaths([...rec.locked]) : new Map();
          if (links.some((l) => within(l.cwd, real.get(l.cwd), target))) skip = "now in use";
          else if (!rec.ok) skip = "could not read git's lock state";
          else if ([...rec.locked].some((p) => [pkey(p), pkey(lockedReal.get(p))].some((k) => k === pkey(target.path) || k === pkey(target.real)))) skip = "locked";
        }
        if (skip) {
          this.failures.push(`${tilde(path)}: skipped (${skip})`);
        } else {
          // --force only for uncommitted changes, which the person chose to discard in the confirmation.
          const args = ["-C", tile.repoRoot, "worktree", "remove", ...(tile.dirty ? ["--force"] : []), path];
          const r = await safeExec("git", args, { timeout: 180_000 });
          if (r.code === 0) {
            removed += 1;
            freed += tile.size ?? 0;
            repos.add(tile.repoRoot);
            this.selected.delete(path);
            delete this.sizes[path];
            delete this.sizeAt[path];
            if (this.pinned === path) this.pinned = null;
            if (this.hover === path) this.hover = null;
          } else {
            this.failures.push(`${tilde(path)}: ${firstLine(r.stderr) || `git exited ${r.code}`}`);
          }
        }
        this.deleting.done += 1;
        scx.notify();
      }
      for (const repo of repos) await safeExec("git", ["-C", repo, "worktree", "prune"], { timeout: 30_000 });
      this.deleting = null;
      notify({
        title: `Removed ${plural(removed, "worktree")}`,
        body: freed ? `Freed about ${formatKB(freed)}. Branches were kept.` : "Branches were kept.",
        level: this.failures.length ? "warning" : "success",
      });
      scx.notify();
      this.scan(scx, { sizes: "missing" });
    });
  }

  pruneStale(cx) {
    if (this.demo || this.busyWork()) return;
    this.pruning = true;
    cx.notify();
    cx.spawn(async (scx) => {
      const repos = [...new Set(this.stale.map((s) => s.repoRoot))];
      const failed = [];
      for (const repo of repos) {
        const r = await safeExec("git", ["-C", repo, "worktree", "prune"], { timeout: 30_000 });
        if (r.code !== 0) failed.push(`${basename(repo)} (${firstLine(r.stderr) || `exit ${r.code}`})`);
      }
      // The toast reports what the follow-up scan confirms, not what was attempted.
      this.pruneReport = { before: this.stale.length, failed };
      this.pruning = false;
      scx.notify();
      this.scan(scx, { sizes: "missing" });
    });
  }

  browseRoot(cx) {
    cx.spawn(async (scx) => {
      const folder = await pickFolder({ prompt: "Add folder" });
      if (folder) this.setRoots([...this.roots(), folder], scx);
      scx.notify();
    });
  }

  // ------------------------------------------------------------ preferences

  prefs() {
    const saved = shared(SETTINGS_KEY);
    const p = saved && typeof saved === "object" ? saved : {};
    const clamp = (v) => Math.min(SCALE_MAX, Math.max(SCALE_MIN, Number(v) || 1));
    return {
      textScale: clamp(p.textScale),
      labelScale: clamp(p.labelScale),
      colors: p.colors && typeof p.colors === "object" ? p.colors : {},
      repoColors: Array.isArray(p.repoColors) ? p.repoColors : [],
      cache: p.cache !== false,
      cacheTtlMin: TTL_CHOICES.includes(p.cacheTtlMin) ? p.cacheTtlMin : 15,
    };
  }

  savePrefs(patch) {
    setShared(SETTINGS_KEY, { ...this.prefs(), ...patch });
  }

  /** Font size in px, scaled by the mod's text size. */
  fs(px) {
    return Math.round(px * this.prefs().textScale * 10) / 10;
  }

  /** Scales the shared type and control sizes from ui.js for this render. */
  applyScale() {
    const k = this.prefs().textScale;
    for (const key of Object.keys(T0)) T[key] = Math.round(T0[key] * k * 10) / 10;
    for (const key of Object.keys(HC0)) HC[key] = Math.round(HC0[key] * k);
  }

  defaultColor(key, t, c) {
    switch (key) {
      case "waiting": return t.blocked;
      case "working": return t.working;
      case "done": return t.done;
      case "idle": return t.idle;
      case "terminal": return mix(t.accent, t.surface ?? t.background, 0.35);
      case "orphan": return t.raised ?? c.secondary;
      case "dirty": return t.ansi3 ?? "#e0a23c";
      case "selected": return c.destructive;
      case "pinned": return c.ring;
      default: {
        const i = Number(String(key).replace("repo-", ""));
        return REPO_COLORS[i % REPO_COLORS.length];
      }
    }
  }

  /** A colour slot: the person's choice, else the theme's. */
  color(key, t = theme(), c = tokens(t)) {
    const p = this.prefs();
    const chosen = key.startsWith("repo-") ? p.repoColors[Number(key.slice(5))] : p.colors[key];
    return HEX.test(chosen ?? "") ? chosen : this.defaultColor(key, t, c);
  }

  isCustom(key) {
    const p = this.prefs();
    const chosen = key.startsWith("repo-") ? p.repoColors[Number(key.slice(5))] : p.colors[key];
    return HEX.test(chosen ?? "");
  }

  statusColor(status, t, c) {
    return STATUS_SLOT[status] ? this.color(STATUS_SLOT[status], t, c) : c.accent;
  }

  setColor(key, hex) {
    const p = this.prefs();
    const value = hex && HEX.test(hex) ? hex.toLowerCase() : null;
    if (key.startsWith("repo-")) {
      const list = REPO_COLORS.map((_, i) => p.repoColors[i] ?? null);
      list[Number(key.slice(5))] = value;
      this.savePrefs({ repoColors: list });
    } else {
      const colors = { ...p.colors };
      if (value) colors[key] = value; else delete colors[key];
      this.savePrefs({ colors });
    }
  }

  applyHex(key, raw, cx) {
    let v = String(raw ?? "").trim();
    if (/^[0-9a-f]{6}$/i.test(v)) v = `#${v}`;
    if (!HEX.test(v)) { this.hexError = key; cx.notify(); return; }
    this.hexError = null;
    this.setColor(key, v);
    this.openColor = null;
    cx.notify();
  }

  // ------------------------------------------------------------ help

  /** A small "?" whose explanation (from HELP) opens while the pointer rests on it or on the card. */
  helpIcon(key, c) {
    const help = HELP[key];
    const size = Math.round(16 * this.prefs().textScale);
    const trigger = div().id(`wtm-help-${key}`).size(size).flex_none().items_center().justify_center().rounded_full()
      .border_1().border_color(c.input).bg(c.card).cursor_pointer()
      .hover((style) => style.bg(c.subtle).border_color(c.ring))
      .child(div().text_size(this.fs(10)).font_semibold().text_color(c.mutedForeground).child("?"));
    const body = v_flex().w(Math.round(340 * this.prefs().textScale)).p(G.md).gap(G.sm).rounded(R.card).bg(c.popover).border_1().border_color(c.border)
      .child(div().text_size(this.fs(12.5)).font_semibold().text_color(c.text).child(help.title))
      .children(help.body.map((para) => (typeof para === "string"
        ? div().w_full().text_size(T.body).text_color(c.mutedForeground).child(para)
        : v_flex().w_full().gap(1)
          .child(div().text_size(T.body).font_semibold().text_color(c.text).child(para.term))
          .child(div().w_full().text_size(T.body).text_color(c.mutedForeground).child(para.text)))));
    // The close delay lets the pointer cross from the "?" onto the card without it closing.
    return HoverCard.new(`wtm-help-card-${key}`).open_delay(120).close_delay(350).trigger(trigger).content(body);
  }

  // ------------------------------------------------------------ render

  render(_cx) {
    if (this.toolbarMode) return this.toolbar();
    this.applyScale();
    const t = theme();
    const c = tokens(t);
    const m = this.model();

    const body = [this.header(c, m)];
    if (this.error) body.push(notice(c, { title: "Scan failed", body: this.error }));
    if (this.deleting) body.push(notice(c, { tone: c.accent, title: `Removing worktrees… ${this.deleting.done}/${this.deleting.total}`, body: "Running git worktree remove." }));
    else if (this.confirm) body.push(this.confirmBar(c, m));
    if (this.failures.length && !this.deleting) body.push(this.failuresBar(c));
    if (this.stale.length && !this.showSettings && this.loaded) body.push(this.staleBar(c));

    if (this.showSettings) body.push(this.settingsView(c, m));
    else if (!this.loaded) body.push(this.loadingView(c));
    else {
      body.push(this.legendRow(c, t));
      const zoom = Number(settings()?.zoom) || 1;
      const leftH = this.leftSize.height / zoom;
      const listH = this.layoutMode === "both" ? Math.max(140, Math.round((leftH - G.md) * 0.42)) : null;
      const left = v_flex().id("wtm-left").flex_1().min_w(0).h_full().min_h(0).gap(G.md)
        .on_size_change((size, scx) => {
          if (Math.abs(size.height - this.leftSize.height) >= 1 || Math.abs(size.width - this.leftSize.width) >= 1) {
            this.leftSize = size;
            scx.notify();
          }
        })
        .when(this.layoutMode !== "map", (el) => el.child(this.listView(c, t, m, listH)))
        .when(this.layoutMode !== "list", (el) => el.child(this.mapArea(c, t, m)));
      body.push(h_flex().w_full().flex_1().min_h(0).gap(G.md).items_start()
        .child(left)
        .child(this.sidePanel(c, t, m)));
    }

    return v_flex().id("wtm-root").size_full().min_h(0).bg(c.canvas).text_color(c.text)
      .p(G.lg).gap(G.md).children(body);
  }

  toolbar() {
    const t = theme();
    return h_flex().size_full().pr(6).items_center()
      .bg(t.chrome).border_b(1).border_color(t.border)
      .child(h_flex().id("wtm-open").h(26).px(8).gap(5).flex_none()
        .items_center().rounded(6).text_size(12).bg(t.chrome).text_color(t.muted)
        .hover((style) => style.bg(t.hover).text_color(t.foreground))
        .on_mouse_down("left", (_event, cx) => cx.stop_propagation())
        .on_click(() => showWorktrees())
        .child(svg(`mods/${MOD}/icon.svg`).size(14))
        .child("Worktrees"));
  }

  header(c, m) {
    const when = (ms) => {
      const d = new Date(ms);
      const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
    };
    const status = this.pruning ? "Pruning records…" : this.scanning ? (this.everLive || !this.loaded ? "Scanning…" : `Showing cached results from ${when(this.scannedAt)} · updating…`)
      : this.sizing ? `Measuring disk use… ${this.sizing.done}/${this.sizing.total}`
        : this.scannedAt ? `Updated ${when(this.scannedAt)}` : "";
    const summaryLead = !this.loaded ? "Loading…" : `${plural(m.tiles.length, "worktree")} · ${formatKB(m.totalKB)} ·`;
    const lockedOrphans = m.allOrphans.length - m.orphans.length;
    const summaryOrphans = `${plural(m.allOrphans.length, "orphan")} (${formatKB(m.orphanKB)}${lockedOrphans ? `, ${lockedOrphans} locked` : ""})`;
    // Deleting waits for a complete scan this session, so it never acts on a cached or failed one.
    const working = this.busyWork();
    const busy = working || !this.liveScan;
    return h_flex().w_full().flex_wrap().gap(G.md).items_center().justify_between()
      .child(v_flex().gap(2)
        .child(pageTitle(this.showSettings ? "Settings" : "Worktrees", c))
        .child(h_flex().gap(6).items_center()
          .child(mutedText(summaryLead, c))
          .when(this.loaded, (el) => el.child(div().text_size(T.small).font_bold()
            .text_color(m.allOrphans.length ? c.destructive : c.text).child(summaryOrphans)))
          .child(this.helpIcon("orphans", c))))
      .child(h_flex().flex_wrap().gap(G.sm).items_center()
        .when(Boolean(status), (el) => el.child(h_flex().gap(6).items_center()
          .when(this.busyWork(), (e) => e.child(this.spinner(c)))
          .child(div().text_size(T.small).text_color(c.dim).child(status))))
        .child(button("wtm-refresh", "↻ Refresh", (_e, cx) => this.scan(cx, { sizes: "all" }), c, { variant: "outline", disabled: working }))
        .child(button("wtm-settings", this.showSettings ? "← Back to map" : "⚙ Settings", (_e, cx) => { this.showSettings = !this.showSettings; this.openColor = null; cx.notify(); }, c, { variant: "outline" }))
        .child(this.helpIcon("delete", c))
        .when(this.selected.size > 0, (el) => el.child(button("wtm-del-selected", `Delete selected (${this.selected.size})`,
          (_e, cx) => this.askRemove([...this.selected], "selected", cx), c, { variant: "danger", disabled: busy })))
        .child(button("wtm-del-orphans", `Delete all orphans (${this.loaded ? m.orphans.length : "…"})`,
          (_e, cx) => this.askRemove(m.orphans.map((o) => o.path), "orphans", cx), c, { variant: "primary", disabled: busy || !this.loaded || m.orphans.length === 0 })));
  }

  confirmBar(c, m) {
    const byPath = new Map(m.tiles.map((t) => [t.path, t]));
    const targets = this.confirm.paths.map((p) => byPath.get(p)).filter((t) => t && t.state === "orphan" && !t.locked);
    // "Clean" means nothing is lost but the folder: no uncommitted changes and no ignored local files.
    const clean = targets.filter((t) => !t.dirty && !t.hasLocal);
    const risky = targets.filter((t) => t.dirty || t.hasLocal);
    const dirty = targets.filter((t) => t.dirty);
    const local = targets.filter((t) => t.hasLocal);
    const kb = (list) => list.reduce((s, t) => s + (t.size ?? 0), 0);
    const what = this.confirm.kind === "orphans" ? "orphaned" : "selected";
    const lines = [
      `${plural(targets.length, `${what} worktree`)}, about ${formatKB(kb(targets))}. Folders are deleted with git worktree remove; branches and their commits are kept.`,
    ];
    if (dirty.length) lines.push(`${plural(dirty.length, "worktree")} ${dirty.length === 1 ? "has" : "have"} uncommitted changes (${dirty.map((d) => d.name).slice(0, 4).join(", ")}${dirty.length > 4 ? ", …" : ""}). Those changes are lost if removed.`);
    if (local.length) {
      const sample = [...new Set(local.flatMap((t) => t.localSample ?? []))].slice(0, 4);
      lines.push(`${plural(local.length, "worktree")} ${local.length === 1 ? "has" : "have"} ignored local files git would delete too${sample.length ? ` (${sample.join(", ")}${local.length > 1 || (local[0].localFiles ?? 0) > sample.length ? ", …" : ""})` : ""}. Build output like node_modules isn't counted.`);
    }
    const actions = h_flex().gap(G.sm).flex_wrap()
      .child(button("wtm-confirm-cancel", "Cancel", (_e, cx) => { this.confirm = null; cx.notify(); }, c, { variant: "outline" }))
      .when(clean.length > 0, (el) => el.child(button("wtm-confirm-clean",
        risky.length ? `Remove ${clean.length} clean` : `Remove ${clean.length}`,
        (_e, cx) => this.remove(clean.map((t) => t.path), cx), c, { variant: risky.length ? "outline" : "danger" })))
      .when(risky.length > 0, (el) => el.child(button("wtm-confirm-all",
        `Remove all ${targets.length}, discard ${dirty.length && local.length ? "changes and local files" : dirty.length ? "changes" : "local files"}`,
        (_e, cx) => this.remove(targets.map((t) => t.path), cx), c, { variant: "danger" })));
    return v_flex().w_full().gap(G.sm).p(G.md).rounded(R.control).bg(c.card).border_1().border_color(c.destructive)
      .child(div().text_size(this.fs(12)).font_semibold().child(targets.length ? "Remove worktrees?" : "Nothing to remove"))
      .children(lines.map((l) => div().text_size(T.small).text_color(c.mutedForeground).child(l)))
      .child(actions);
  }

  failuresBar(c) {
    return v_flex().w_full().gap(G.xs).p(G.md).rounded(R.control).bg(c.card).border_1().border_color(c.destructive)
      .child(h_flex().justify_between().items_center()
        .child(div().text_size(this.fs(12)).font_semibold().child(`${plural(this.failures.length, "worktree")} not removed`))
        .child(button("wtm-fail-dismiss", "Dismiss", (_e, cx) => { this.failures = []; cx.notify(); }, c, { variant: "ghost" })))
      .children(this.failures.slice(0, 6).map((f) => div().text_size(T.small).text_color(c.mutedForeground).truncate().child(f)));
  }

  staleBar(c) {
    const repos = [...new Set(this.stale.map((s) => basename(s.repoRoot)))];
    const tip = this.stale.slice(0, 12).map((s) => tilde(s.path)).join("\n") + (this.stale.length > 12 ? "\n…" : "");
    return h_flex().w_full().gap(G.md).items_center().px(G.md).py(G.sm).rounded(R.control)
      .bg(c.card).border_1().border_color(c.border)
      .child(div().size(7).flex_none().rounded_full().bg(c.accent))
      .child(div().id("wtm-stale-text").flex_1().min_w(0).text_size(T.small).text_color(c.mutedForeground).truncate().tooltip(tip)
        .child(`${plural(this.stale.length, "stale worktree record")} in ${repos.slice(0, 4).join(", ")}${repos.length > 4 ? ` +${repos.length - 4}` : ""}: the folders are gone. Pruning only removes git's records.`))
      .child(this.helpIcon("stale", c))
      .child(button("wtm-prune", this.pruning ? "Pruning…" : "Prune records", (_e, cx) => this.pruneStale(cx), c, { variant: "outline", disabled: this.busyWork() }));
  }

  spinner(c) {
    // Native frame animation: no timer, stops when not shown.
    return div().text_size(T.value).text_color(c.accent).frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 90);
  }

  loadingView(c) {
    const p = this.progress ?? { label: "Starting", done: 0, total: 0 };
    const steps = ["Finding worktrees", "Reading git state", "Measuring disk use"];
    const current = Math.max(0, steps.indexOf(p.label));
    const frac = p.total ? Math.min(1, p.done / p.total) : 0;
    const BAR = 320;
    return v_flex().w_full().flex_1().min_h(0).items_center().justify_center()
      .child(v_flex().w(BAR + 48).p(G.xl).gap(G.md).rounded(R.card).bg(c.card).border_1().border_color(c.border)
        .child(h_flex().gap(G.sm).items_center()
          .child(this.spinner(c))
          .child(div().text_size(T.card).font_semibold().child(`${p.label}…`)))
        .child(div().w(BAR).h(6).rounded_full().bg(c.secondary).overflow_hidden()
          .child(p.total
            ? div().h_full().rounded_full().bg(c.accent).w(Math.max(6, Math.round(BAR * frac)))
            : div().h_full().w(80).rounded_full().bg(c.accent).loop("opacity", { from: 0.35, to: 1, period: 900 })))
        .child(div().text_size(T.small).text_color(c.dim).child(p.total ? `${p.done} of ${p.total}` : "Searching the configured folders"))
        .child(v_flex().gap(4).pt(G.xs)
          .children(steps.map((label, i) => h_flex().gap(G.sm).items_center()
            .child(div().w(12).text_size(T.small).text_color(i < current ? c.done : i === current ? c.accent : c.dim)
              .child(i < current ? "✓" : i === current ? "•" : "○"))
            .child(div().text_size(T.small).text_color(i <= current ? c.text : c.dim).child(label)))))
        .child(div().text_size(T.label).text_color(c.dim).child("Disk use takes longest for worktrees with node_modules or build output.")));
  }

  // ------------------------------------------------------------ colours

  colorsFor(tile, t, repoIndex) {
    const c = tokens(t);
    if (this.colorMode === "repo") return this.color(`repo-${repoIndex % REPO_COLORS.length}`, t, c);
    if (tile.state === "agent") return this.statusColor(tile.status, t, c);
    if (tile.state === "terminal") return this.color("terminal", t, c);
    return null; // orphan
  }

  legendRow(c, t) {
    const chip = (label, color, hatched = false) => h_flex().gap(5).items_center()
      .child(div().size(Math.round(10 * this.prefs().textScale)).rounded(2).bg(color ?? c.secondary).border_1().border_color(hatched ? c.dim : color ?? c.border)
        .when(hatched, (el) => el.border_dashed()))
      .child(div().text_size(T.small).text_color(c.mutedForeground).child(label));
    const legend = this.colorMode === "status"
      ? [chip("Waiting", this.color("waiting", t, c)), chip("Working", this.color("working", t, c)), chip("Done", this.color("done", t, c)),
        chip("Idle", this.color("idle", t, c)), chip("Terminal only", this.color("terminal", t, c)), chip("Orphan", this.color("orphan", t, c), true)]
      : [chip("Coloured by repository; orphans hatched", null, true)];
    return h_flex().w_full().flex_wrap().gap(G.lg).items_center()
      .child(h_flex().gap(G.sm).items_center().child(metaLabel("View", c))
        .child(segmented("wtm-layout", [{ key: "both", label: "List + map" }, { key: "list", label: "List" }, { key: "map", label: "Map" }], this.layoutMode,
          (key) => { this.layoutMode = key; this.saveView(); }, c)))
      .child(h_flex().gap(G.sm).items_center().child(metaLabel("Size", c))
        .child(segmented("wtm-size", [{ key: "disk", label: "Disk use" }, { key: "equal", label: "Equal" }], this.sizeMode,
          (key) => { this.sizeMode = key; this.saveView(); }, c)))
      .child(h_flex().gap(G.sm).items_center().child(metaLabel("Colour", c))
        .child(segmented("wtm-color", [{ key: "status", label: "Agent status" }, { key: "repo", label: "Repository" }], this.colorMode,
          (key) => { this.colorMode = key; this.saveView(); }, c)))
      .child(h_flex().flex_wrap().gap(G.md).items_center().children(legend).child(this.helpIcon("map", c)));
  }

  // ------------------------------------------------------------ treemap

  mapArea(c, t, m) {
    // on_size_change reports zoomed pixels, while left/top/w/h are scaled by the zoom again.
    const zoom = Number(settings()?.zoom) || 1;
    const W = Math.max(0, this.mapSize.width / zoom - 2);
    const H = Math.max(0, this.mapSize.height / zoom - 2);
    const area = div().id("wtm-map").flex_1().w_full().min_w(0).min_h(0).relative().overflow_hidden()
      .rounded(R.card).bg(c.card).border_1().border_color(c.border)
      .on_size_change((size, scx) => {
        if (Math.abs(size.width - this.mapSize.width) >= 1 || Math.abs(size.height - this.mapSize.height) >= 1) {
          this.mapSize = size;
          scx.notify();
        }
      })
      .on_hover((hovered, hcx) => { if (!hovered && this.hover) { this.hover = null; hcx.notify(); } });

    if (m.tiles.length === 0) {
      const msg = this.scanning ? "Looking for worktrees…" : "No worktrees found under the configured folders.";
      return area.child(v_flex().size_full().items_center().justify_center().gap(G.sm)
        .child(div().text_size(T.card).text_color(c.mutedForeground).child(msg))
        .when(!this.scanning, (el) => el.child(button("wtm-empty-folders", "Choose folders", (_e, cx) => { this.showSettings = true; cx.notify(); }, c, { variant: "outline" }))));
    }
    if (W < 20 || H < 20) return area;

    // Tile weights: disk use (unknown sizes count as the median known size), with
    // a floor so a tiny worktree beside a huge one is still big enough to hover.
    const known = m.tiles.map((x) => x.size).filter((s) => s != null).sort((a, b) => a - b);
    const median = known.length ? known[Math.floor(known.length / 2)] : 1;
    const raw = (x) => (this.sizeMode === "equal" ? 1 : Math.max(1, x.size ?? median));
    const total = m.tiles.reduce((s, x) => s + raw(x), 0);
    const floor = total * 0.012;
    const weight = (x) => (this.sizeMode === "equal" ? 1 : Math.max(raw(x), floor));

    const groups = new Map();
    for (const tile of m.tiles) {
      if (!groups.has(tile.repoRoot)) groups.set(tile.repoRoot, { repoRoot: tile.repoRoot, repo: tile.repo, tiles: [] });
      groups.get(tile.repoRoot).tiles.push(tile);
    }
    const repoOrder = [...groups.keys()].sort();
    const repoIndex = new Map(repoOrder.map((r, i) => [r, i]));
    const repoRects = squarify([...groups.values()].map((g) => ({ ...g, value: g.tiles.reduce((s, x) => s + weight(x), 0) })),
      { x: 0, y: 0, w: W, h: H });

    const children = [];
    const repoHeader = Math.round(REPO_HEADER * this.prefs().textScale);
    let n = 0;
    for (const rr of repoRects) {
      const g = rr.item;
      const box = snap(rr);
      const showHeader = box.h > repoHeader + 24 && box.w > 70;
      const groupKB = g.tiles.reduce((s, x) => s + (x.size ?? 0), 0);
      children.push(div().id(`wtm-repo-${repoIndex.get(g.repoRoot)}`).absolute().left(box.x).top(box.y).w(box.w).h(box.h)
        .border_1().border_color(c.border).bg(c.canvas)
        .on_click((_e, ccx) => { if (this.pinned) { this.pinned = null; ccx.notify(); } })
        .when(showHeader, (el) => el.child(h_flex().h(repoHeader).px(6).gap(6).items_center()
          .when(Boolean(this.groupCheck("x", g.tiles, g.repo, c, t)), (e) => e.child(this.groupCheck(`wtm-mgchk-${repoIndex.get(g.repoRoot)}`, g.tiles, g.repo, c, t)))
          .child(div().text_size(T.small).font_semibold().text_color(c.text).truncate().child(g.repo))
          .child(div().text_size(T.label).text_color(c.dim).flex_none().child(`${g.tiles.length} · ${formatKB(groupKB)}`)))));
      const inner = showHeader
        ? { x: rr.x + 2, y: rr.y + repoHeader, w: rr.w - 4, h: rr.h - repoHeader - 2 }
        : { x: rr.x + 2, y: rr.y + 2, w: rr.w - 4, h: rr.h - 4 };
      for (const tr of squarify(g.tiles.map((x) => ({ tile: x, value: weight(x) })), inner)) {
        children.push(this.tileEl(tr.item.tile, snap(tr), c, t, repoIndex.get(g.repoRoot), n));
        n += 1;
      }
    }
    return area.children(children);
  }

  tileEl(tile, box, c, t, repoIdx, n) {
    const x = box.x + 1, y = box.y + 1, w = Math.max(0, box.w - 2), h = Math.max(0, box.h - 2);
    const base = this.colorsFor(tile, t, repoIdx);
    const orphan = tile.state === "orphan";
    const selected = this.selected.has(tile.path);
    const hovered = this.hover === tile.path;
    const pinned = this.pinned === tile.path;

    const fillBase = base ?? this.color("orphan", t, c);
    const fill = orphan && tile.dirty ? mix(fillBase, this.color("dirty", t, c), 0.25) : fillBase;
    const selColor = this.color("selected", t, c);
    const pinColor = this.color("pinned", t, c);
    // Block labels: the mod's text size times the label size.
    const k = (this.prefs().textScale) * this.prefs().labelScale;
    const L = { name: Math.round(T0.small * k * 10) / 10, sub: Math.round(T0.label * k * 10) / 10, box: Math.round(14 * Math.min(k, 1.5)) };
    const fg = base ? readableOn(base, "#ffffff", "#111111") : c.mutedForeground;
    const sub = [tile.branch ?? "detached", formatKB(tile.size)].join(" · ");
    const border = selected ? selColor : pinned || hovered ? pinColor : orphan ? c.dim : mix(fillBase, "#000000", 0.3);
    const selectable = orphan && !tile.locked;

    const tip = `${tile.repo}/${tile.name} · ${formatKB(tile.size)} · ${this.stateText(tile)}`;
    let el = div().id(`wtm-tile-${n}`).absolute().left(x).top(y).w(w).h(h).overflow_hidden().rounded(3)
      .bg(fill).cursor_pointer()
      .when(selected || pinned, (e) => e.border_2().border_color(border))
      .when(!selected && !pinned, (e) => e.border_1().border_color(border))
      .when(orphan && !selected && !pinned, (e) => e.border_dashed())
      .on_hover((isHovered, hcx) => {
        if (isHovered && this.hover !== tile.path) { this.hover = tile.path; hcx.notify(); }
        else if (!isHovered && this.hover === tile.path) { this.hover = null; hcx.notify(); }
      })
      .on_click((_e, ccx) => this.pinTile(tile, ccx))
      .tooltip(tip);

    if (base) {
      // Cushion shading, after WinDirStat: lighter top-left, darker bottom-right.
      el = el.child(layer(Background.linear_gradient(135, mix(base, "#ffffff", 0.28), mix(base, "#000000", 0.22))));
    }
    if (orphan) {
      // Hatching marks a worktree no terminal or agent is using.
      el = el.child(layer(Background.pattern_slash(mix(c.dim, fillBase, 0.45), 1, 7)));
    }
    if (pinned && parseHex(pinColor)) {
      // A light wash so the pinned block reads as "the one in the panel".
      el = el.child(div().absolute().top(0).left(0).size_full().bg(`${String(pinColor).slice(0, 7)}26`));
    }
    const checkbox = div().id(`wtm-chk-${n}`).size(L.box).flex_none().rounded(3).items_center().justify_center()
      .border_1().border_color(selected ? selColor : c.mutedForeground)
      .bg(selected ? selColor : c.card).cursor_pointer()
      .hover((st) => st.border_color(selColor))
      .tooltip(selected ? "Deselect" : "Select for deletion")
      // Stopping the press keeps the tile's own click (pin) from firing too.
      .on_mouse_down("left", (_e, mcx) => mcx.stop_propagation())
      .on_click((_e, ccx) => this.toggleSelect(tile, ccx))
      .child(div().text_size(Math.round(L.box * 0.72)).font_semibold().text_color(readableOn(selColor, "#ffffff", "#111111")).child(selected ? "✓" : ""));
    if (w > 54 * k && h > 24 * k) {
      el = el.child(v_flex().relative().p(5).gap(1).min_w(0)
        .child(h_flex().gap(5).items_center().min_w(0)
          .when(selectable, (e) => e.child(checkbox))
          .child(div().text_size(L.name).font_semibold().text_color(fg).truncate().child(tile.name)))
        .when(h > 42 * k, (e) => e.child(div().text_size(L.sub).text_color(fg).opacity(0.8).truncate().child(sub)))
        .when(h > 60 * k && tile.agentsIn.length > 0, (e) => e.child(div().text_size(L.sub).text_color(fg).opacity(0.8).truncate()
          .child(tile.agentsIn.map((a) => a.name).join(", ")))));
    }
    else if (selectable && w > L.box + 8 && h > L.box + 8) el = el.child(div().relative().p(4).child(checkbox));
    return el;
  }

  stateText(tile) {
    if (tile.state === "agent") {
      const a = tile.agentsIn;
      return `${a.length === 1 ? a[0].name : plural(a.length, "agent")} · ${STATUS_LABEL[tile.status] ?? "running"}`;
    }
    if (tile.state === "terminal") return `${plural(tile.users.length, "terminal")}, no agent`;
    if (tile.lockUnknown) return "Orphan (lock state unknown)";
    if (tile.locked) return "Orphan (locked)";
    return tile.dirty ? "Orphan · uncommitted changes" : tile.hasLocal ? "Orphan · ignored local files" : "Orphan";
  }

  // ------------------------------------------------------------ list (WinDirStat-style tree)

  /** A column heading: sorts (and leaves By repository for the flat list unless it's Name). */
  sortBy(key, cx) {
    ({ listMode: this.listMode, sort: this.sort } = clickColumn({ listMode: this.listMode, sort: this.sort }, key));
    this.saveView();
    cx.notify();
  }

  /** A checkbox selecting every orphan in `tiles` (all / some / none selected). Null when there are none. */
  groupCheck(id, tiles, label, c, t) {
    const pick = tiles.filter((x) => x.state === "orphan" && !x.locked);
    if (pick.length === 0) return null;
    const n = pick.filter((x) => this.selected.has(x.path)).length;
    const all = n === pick.length;
    const some = n > 0 && !all;
    const sel = this.color("selected", t, c);
    const size = Math.round(13 * this.prefs().textScale);
    return div().id(id).size(size).flex_none().rounded(3).items_center().justify_center().cursor_pointer()
      .border_1().border_color(n ? sel : c.mutedForeground).bg(all ? sel : some ? mix(sel, c.card, 0.55) : c.card)
      .hover((st) => st.border_color(sel))
      .tooltip(all ? `Deselect the ${plural(pick.length, "orphan")} in ${label}` : `Select all ${plural(pick.length, "orphan")} in ${label}`)
      .on_mouse_down("left", (_e, mcx) => mcx.stop_propagation())
      .on_click((_e, ccx) => {
        for (const x of pick) { if (all) this.selected.delete(x.path); else this.selected.add(x.path); }
        ccx.notify();
      })
      .child(div().text_size(Math.round(size * 0.72)).font_semibold().text_color(readableOn(sel, "#ffffff", "#111111"))
        .child(all ? "✓" : some ? "–" : ""));
  }

  listView(c, t, m, height) {
    const k = this.prefs().textScale;
    const px = (n) => Math.round(n * k);
    const rowH = px(24);
    const COLS = [
      { key: "name", label: "Name" },
      { key: "bar", label: "Size proportion", w: px(132), sort: "size" },
      { key: "pct", label: "Percent", w: px(62), sort: "size", end: true },
      { key: "size", label: "Size", w: px(74), end: true },
      { key: "changes", label: "Changes", w: px(66), end: true },
      { key: "state", label: "State", w: px(160) },
      { key: "age", label: "Last commit", w: px(86), end: true },
    ];
    const total = Math.max(1, m.totalKB);
    const repoIndex = new Map([...new Set(m.tiles.map((x) => x.repoRoot))].sort().map((r, i) => [r, i]));

    const byRepo = new Map();
    for (const x of m.tiles) {
      if (!byRepo.has(x.repoRoot)) byRepo.set(x.repoRoot, { repoRoot: x.repoRoot, repo: x.repo, tiles: [] });
      byRepo.get(x.repoRoot).tiles.push(x);
    }
    const groups = [...byRepo.values()];
    for (const g of groups) {
      Object.assign(g, groupTotals(g.tiles));   // size, changes, rank, newest: as the repository row shows them
      g.orphans = g.tiles.filter((x) => x.state === "orphan").length;
      g.agents = g.tiles.filter((x) => x.state === "agent").length;
    }
    // Each column sorts by the value it shows (see sorting.js); unknown values go last.
    const { key: sortKey, dir } = this.sort;
    const now = Date.now() / 1000;
    const flat = this.listMode === "flat";
    const tileOrder = comparator((x, k) => tileSortValue(x, k, { now, flat }),
      (x) => (flat ? `${x.repo} / ${x.name}` : x.name).toLowerCase(), sortKey, dir);
    const groupOrder = comparator((g, k) => groupSortValue(g, k, { now }), (g) => g.repo.toLowerCase(), sortKey, dir);

    const cell = (col, content) => (col.w
      ? h_flex().w(col.w).flex_none().px(px(6)).items_center().when(col.end, (e) => e.justify_end()).child(content)
      : h_flex().flex_1().min_w(0).px(px(6)).items_center().child(content));
    const txt = (value, color = c.text, opts = {}) => div().text_size(T.small).text_color(color).truncate()
      .when(Boolean(opts.bold), (e) => e.font_semibold()).child(value);
    const bar = (frac, color) => {
      const w = COLS[1].w - px(12);
      return div().w(w).h(px(11)).rounded(2).bg(c.secondary).border_1().border_color(c.border).overflow_hidden()
        .child(div().h_full().w(frac > 0 ? Math.max(2, Math.round(w * Math.min(1, frac))) : 0)
          .bg(color).child(layer(Background.linear_gradient(90, mix(color, "#ffffff", 0.25), mix(color, "#000000", 0.2)))));
    };
    const pct = (kb) => {
      if (kb == null) return "…";
      const p = (kb / total) * 100;
      return p >= 99.95 ? "100%" : `${p.toFixed(p < 10 ? 2 : 1)}%`;
    };

    const header = h_flex().w_full().h(px(26)).flex_none().px(px(4)).items_center().bg(c.muted).border_b(1).border_color(c.border)
      .children(COLS.map((col) => {
        const key = col.sort ?? col.key;
        const active = this.sort.key === key && col.key !== "bar" && col.key !== "pct";
        const label = h_flex().gap(3).items_center().when(col.end, (e) => e.justify_end())
          .child(div().text_size(T.label).font_semibold().text_color(active ? c.text : c.mutedForeground).child(col.label))
          .when(active, (e) => e.child(div().text_size(T.label).text_color(c.text).child(dir === "asc" ? "▲" : "▼")));
        const tips = { name: "Sort by name", size: "Sort by disk use", changes: "Sort by uncommitted changes",
          state: "Sort by state: waiting, done, working, idle, terminal only, orphan", age: "Sort by last commit: ▲ newest first, ▼ oldest first" };
        const switches = this.listMode === "tree" && key !== "name";
        return cell(col, div().id(`wtm-col-${col.key}`).w_full().cursor_pointer()
          .tooltip(`${tips[key] ?? "Sort"}${switches ? " (shows the flat list)" : " (click again to reverse)"}`)
          .on_click((_e, ccx) => this.sortBy(key, ccx))
          .hover((st) => st.opacity(0.85)).child(label));
      }));

    const rows = [];
    const rowBase = (id, depth) => h_flex().id(id).w_full().h(rowH).flex_none().px(px(4)).items_center();
    const nameCell = (depth, parts) => h_flex().gap(px(6)).items_center().min_w(0).pl(px(depth * 16)).children(parts);
    const chevron = (open) => div().w(px(12)).flex_none().text_size(T.small).text_color(c.dim).child(open ? "▾" : "▸");
    const swatch = (color, dashed) => div().size(px(10)).flex_none().rounded(2).bg(color).border_1().border_color(dashed ? c.dim : color)
      .when(dashed, (e) => e.border_dashed());

    const worktreeRow = (x, depth, parentKB, i) => {
      const base = this.colorsFor(x, t, repoIndex.get(x.repoRoot));
      const color = base ?? this.color("orphan", t, c);
      const orphan = x.state === "orphan";
      const selected = this.selected.has(x.path);
      const pinned = this.pinned === x.path;
      const hovered = this.hover === x.path;
      const selColor = this.color("selected", t, c);
      const check = div().id(`wtm-lchk-${i}`).size(px(13)).flex_none().rounded(3).items_center().justify_center()
        .border_1().border_color(selected ? selColor : c.mutedForeground).bg(selected ? selColor : c.card).cursor_pointer()
        .tooltip(selected ? "Deselect" : "Select for deletion")
        .on_mouse_down("left", (_e, mcx) => mcx.stop_propagation())
        .on_click((_e, ccx) => this.toggleSelect(x, ccx))
        .child(div().text_size(this.fs(9)).font_semibold().text_color(readableOn(selColor, "#ffffff", "#111111")).child(selected ? "✓" : ""));
      const changes = x.changed + x.untracked;
      const stateColor = x.state === "agent" ? this.statusColor(x.status, t, c) : x.state === "terminal" ? this.color("terminal", t, c) : c.dim;
      const stateLabel = x.state === "agent"
        ? `${x.agentsIn.length === 1 ? x.agentsIn[0].name : plural(x.agentsIn.length, "agent")} · ${STATUS_LABEL[x.status] ?? "running"}`
        : x.state === "terminal" ? "Shell only" : x.locked ? "Orphan (locked)" : "Orphan";
      const title = depth === 0 ? `${x.repo} / ${x.name}` : x.name;
      return rowBase(`wtm-row-${i}`, depth)
        .cursor_pointer()
        .when(pinned, (e) => e.bg(c.selected))
        .when(!pinned && hovered, (e) => e.bg(c.subtle))
        .on_hover((isHovered, hcx) => {
          if (isHovered && this.hover !== x.path) { this.hover = x.path; hcx.notify(); }
          else if (!isHovered && this.hover === x.path) { this.hover = null; hcx.notify(); }
        })
        .on_click((_e, ccx) => this.pinTile(x, ccx))
        .child(cell(COLS[0], nameCell(depth, [
          div().w(px(12)).flex_none(),
          orphan && !x.locked ? check : div().w(px(13)).flex_none(),
          swatch(color, orphan),
          txt(title, c.text, { bold: pinned }),
          div().text_size(T.label).text_color(c.dim).truncate().child(x.branch ?? "detached"),
        ])))
        .child(cell(COLS[1], bar(x.size == null ? 0 : x.size / Math.max(1, parentKB), color)))
        .child(cell(COLS[2], txt(pct(x.size), c.mutedForeground)))
        .child(cell(COLS[3], txt(formatKB(x.size))))
        .child(cell(COLS[4], txt(changes ? String(changes) : "—", changes ? this.color("dirty", t, c) : c.dim)))
        .child(cell(COLS[5], h_flex().gap(px(5)).items_center().min_w(0)
          .child(div().size(px(7)).flex_none().rounded_full().bg(stateColor))
          .child(txt(stateLabel, orphan ? c.mutedForeground : c.text))))
        .child(cell(COLS[6], txt(formatAge(x.lastCommit), c.mutedForeground)));
    };

    let n = 0;
    if (this.listMode === "tree") {
      rows.push(rowBase("wtm-row-root", 0)
        .child(cell(COLS[0], nameCell(0, [chevron(true),
          this.groupCheck("wtm-gchk-all", m.tiles, "all folders", c, t) ?? div().w(px(13)).flex_none(),
          swatch(c.accent, false), txt(`All worktrees (${m.tiles.length})`, c.text, { bold: true })])))
        .child(cell(COLS[1], bar(1, c.accent)))
        .child(cell(COLS[2], txt("100%", c.mutedForeground)))
        .child(cell(COLS[3], txt(formatKB(m.totalKB), c.text, { bold: true })))
        .child(cell(COLS[4], txt(String(groups.reduce((s, g) => s + g.changes, 0)), c.mutedForeground)))
        .child(cell(COLS[5], txt(`${plural(m.allOrphans.length, "orphan")}`, m.allOrphans.length ? c.destructive : c.mutedForeground, { bold: m.allOrphans.length > 0 })))
        .child(cell(COLS[6], div())));
      for (const g of [...groups].sort(groupOrder)) {
        const open = !this.collapsed.has(g.repoRoot);
        const color = this.colorMode === "repo" ? this.color(`repo-${repoIndex.get(g.repoRoot) % REPO_COLORS.length}`, t, c) : c.mutedForeground;
        rows.push(rowBase(`wtm-row-g-${repoIndex.get(g.repoRoot)}`, 1).cursor_pointer().hover((st) => st.bg(c.subtle))
          .on_click((_e, ccx) => { if (open) this.collapsed.add(g.repoRoot); else this.collapsed.delete(g.repoRoot); ccx.notify(); })
          .child(cell(COLS[0], nameCell(1, [chevron(open),
            this.groupCheck(`wtm-gchk-${repoIndex.get(g.repoRoot)}`, g.tiles, g.repo, c, t) ?? div().w(px(13)).flex_none(),
            swatch(color, false), txt(g.repo, c.text, { bold: true }),
            div().text_size(T.label).text_color(c.dim).flex_none().child(plural(g.tiles.length, "worktree"))])))
          .child(cell(COLS[1], bar((g.size ?? 0) / total, color)))
          .child(cell(COLS[2], txt(pct(g.size), c.mutedForeground)))
          .child(cell(COLS[3], txt(formatKB(g.size), c.text, { bold: true })))
          .child(cell(COLS[4], txt(g.changes ? String(g.changes) : "—", g.changes ? this.color("dirty", t, c) : c.dim)))
          .child(cell(COLS[5], txt([g.agents ? plural(g.agents, "agent") : null, g.orphans ? plural(g.orphans, "orphan") : null].filter(Boolean).join(" · ") || "Shells only",
            c.mutedForeground)))
          .child(cell(COLS[6], txt(formatAge(g.newest), c.mutedForeground))));
        if (open) for (const x of [...g.tiles].sort(tileOrder)) rows.push(worktreeRow(x, 2, g.size ?? 0, n++));
      }
    } else {
      for (const x of [...m.tiles].sort(tileOrder)) rows.push(worktreeRow(x, 0, total, n++));
    }

    const toolbar = h_flex().w_full().flex_none().gap(G.sm).items_center().justify_between().px(px(8)).py(px(6)).border_b(1).border_color(c.border)
      .child(segmented("wtm-listmode", [{ key: "tree", label: "By repository" }, { key: "flat", label: "Flat list" }], this.listMode,
        (key) => { ({ listMode: this.listMode, sort: this.sort } = setListMode({ listMode: this.listMode, sort: this.sort }, key)); this.saveView(); }, c))
      .child(h_flex().gap(G.sm).items_center()
        .when(this.listMode === "tree", (el) => el
          .child(button("wtm-expand-all", "Expand all", (_e, cx) => { this.collapsed.clear(); cx.notify(); }, c, { variant: "ghost" }))
          .child(button("wtm-collapse-all", "Collapse all", (_e, cx) => { for (const g of groups) this.collapsed.add(g.repoRoot); cx.notify(); }, c, { variant: "ghost" })))
        .child(this.helpIcon("list", c)));

    return v_flex().id("wtm-list").w_full().min_w(0).min_h(0)
      .when(height != null, (e) => e.h(height).flex_none())
      .when(height == null, (e) => e.flex_1())
      .rounded(R.card).bg(c.card).border_1().border_color(c.border).overflow_hidden()
      .child(toolbar)
      .child(header)
      .child(v_flex().id("wtm-list-rows").w_full().flex_1().min_h(0).overflow_y_scrollbar()
        .on_hover((hovered, hcx) => { if (!hovered && this.hover) { this.hover = null; hcx.notify(); } })
        .children(rows));
  }

  // ------------------------------------------------------------ side panel

  sidePanel(c, t, m) {
    // A pinned worktree stays put while the pointer travels; hover only previews when nothing is pinned.
    const focus = m.tiles.find((x) => x.path === (this.pinned ?? this.hover));
    return v_flex().id("wtm-side").w(Math.round(SIDE_WIDTH * Math.min(1.45, this.prefs().textScale))).flex_none().h_full().min_h(0).gap(G.md).overflow_y_scrollbar()
      .child(focus ? this.detailCard(focus, c, t, focus.path === this.pinned, m) : this.overviewCard(c, t, m))
      .when(this.selected.size > 0, (el) => el.child(this.selectionCard(c, m)));
  }

  overviewCard(c, t, m) {
    const counts = { agent: 0, terminal: 0, orphan: 0 };
    for (const x of m.tiles) counts[x.state] += 1;
    const biggest = m.orphans.filter((o) => o.size != null).sort((a, b) => b.size - a.size).slice(0, 6);
    return card(c, G.lg, G.md)
      .child(cardHeader("Overview", "Hover a block to preview it; click it to pin its details here. Tick the box in an orphan’s corner to select it for deletion.", c))
      .child(h_flex().gap(G.sm)
        .child(statCell("With agent", String(counts.agent), c))
        .child(statCell("Terminal only", String(counts.terminal), c))
        .child(statCell("Orphans", String(counts.orphan), c, { color: counts.orphan ? c.destructive : c.text })))
      .when(biggest.length > 0, (el) => el.child(v_flex().gap(G.xs)
        .child(metaLabel("Largest orphans", c))
        .children(biggest.map((o, i) => h_flex().id(`wtm-big-${i}`).gap(G.sm).items_center().justify_between()
          .px(4).py(2).rounded(4).cursor_pointer().hover((s) => s.bg(c.subtle))
          .on_click((_e, ccx) => { this.pinned = o.path; ccx.notify(); })
          .child(div().text_size(T.small).truncate().min_w(0).child(`${o.repo}/${o.name}`))
          .child(div().text_size(T.small).text_color(c.dim).flex_none().child(formatKB(o.size)))))));
  }

  detailCard(tile, c, t, isPinned, m) {
    const base = this.colorsFor(tile, t, m.repoIndex.get(tile.repoRoot) ?? 0);
    const stateColor = tile.state === "agent" ? this.statusColor(tile.status, t, c) : tile.state === "terminal" ? this.color("terminal", t, c) : c.dim;
    const changes = tile.changed + tile.untracked;
    const sync = tile.upstream ? `↑${tile.ahead} ↓${tile.behind}` : "No upstream";
    const userRow = (u, i) => h_flex().id(`wtm-user-${i}`).gap(G.sm).items_center().px(6).py(4).rounded(R.control)
      .bg(c.muted).cursor_pointer().hover((s) => s.bg(c.subtle))
      .on_click(() => (u.agent ? run("agent.focus", { terminal: u.address }) : u.shown ? run("pane.focus", { terminal: u.address }) : run("terminal.peek", { terminal: u.address })))
      .child(div().size(8).flex_none().rounded_full().bg(u.agent ? this.statusColor(u.status, t, c) : c.dim))
      .child(v_flex().flex_1().min_w(0)
        .child(div().text_size(T.small).font_semibold().truncate().child(`${u.name}${u.status ? ` · ${STATUS_LABEL[u.status]}` : ""}`))
        .child(div().text_size(T.label).text_color(c.dim).truncate()
          .child([u.space, u.tab ? `tab ${u.tab}` : null, u.address].filter(Boolean).join(" · "))))
      .child(div().text_size(T.label).text_color(c.dim).flex_none().child("Go →"));

    const isOrphan = tile.state === "orphan";
    const selected = this.selected.has(tile.path);
    return card(c, G.lg, G.md)
      .child(v_flex().gap(4)
        .child(h_flex().gap(G.sm).items_center()
          .child(div().size(10).flex_none().rounded(2).bg(base ?? c.secondary).border_1().border_color(c.dim).when(isOrphan, (e) => e.border_dashed()))
          .child(div().flex_1().min_w(0).text_size(T.card).font_semibold().truncate().child(tile.name))
          .when(isPinned, (e) => e.child(button("wtm-unpin", "✕", (_e, cx) => { this.pinned = null; cx.notify(); }, c,
            { variant: "ghost", square: true, tooltip: "Unpin (or click the block again)" }))))
        .when(!isPinned, (e) => e.child(div().text_size(T.label).text_color(c.accent).child("Previewing · click the block to keep it here")))
        .child(div().text_size(T.small).text_color(c.mutedForeground).truncate().child(`${tile.repo} · ${tile.branch ?? "detached HEAD"}`))
        .child(h_flex().gap(6).items_center()
          .child(div().size(7).rounded_full().bg(stateColor))
          .child(div().text_size(T.small).text_color(c.text).child(this.stateText(tile)))))
      .when(tile.users.length > 0, (el) => el.child(v_flex().gap(G.xs)
        .child(metaLabel(tile.agentsIn.length ? "Agents and terminals here" : "Terminals here", c))
        .children(tile.users.map(userRow))))
      .child(h_flex().gap(6).items_center().child(metaLabel("Git state", c)).child(this.helpIcon("git", c)))
      .when(tile.hasLocal, (el) => el.child(div().text_size(T.small).text_color(this.color("dirty", t, c))
        .child(tile.localUnknown ? "Couldn't list ignored files; treat it as holding local files."
          : `${plural(tile.localFiles, "ignored local file")} (${(tile.localSample ?? []).join(", ")}${tile.localFiles > (tile.localSample ?? []).length ? ", …" : ""}) would be deleted with it.`)))
      .child(h_flex().gap(G.sm)
        .child(statCell("Size", formatKB(tile.size), c))
        .child(statCell("Changes", changes ? String(changes) : "Clean", c, { color: changes ? this.color("dirty", t, c) : c.text, note: changes ? `${tile.changed} modified · ${tile.untracked} new` : null })))
      .child(h_flex().gap(G.sm)
        .child(statCell("Upstream", sync, c, { tooltip: tile.upstream ?? "No upstream branch" }))
        .child(statCell("Unpushed", String(tile.unpushed), c, { note: tile.unpushed ? "kept on the branch" : null })))
      .child(v_flex().gap(2)
        .child(metaLabel("Last commit", c))
        .child(div().text_size(T.small).truncate().child(`${formatAge(tile.lastCommit)} · ${tile.subject || "—"}`)))
      .child(v_flex().gap(2)
        .child(metaLabel("Path", c))
        .child(div().id("wtm-path").text_size(T.label).text_color(c.dim).truncate().tooltip(tile.path).child(tilde(tile.path))))
      .child(h_flex().flex_wrap().gap(G.sm)
        .child(button("wtm-open-space", "Open space here", () => run("space.new", { folder: tile.path }), c, { variant: "outline" }))
        .child(button("wtm-reveal", "Reveal", (_e, cx) => { cx.spawn(async () => { await reveal(tile.path); }); }, c, { variant: "outline", tooltip: "Open the folder in the file manager" }))
        .when(isOrphan && !tile.locked, (el) => el.child(button("wtm-toggle-select", selected ? "Deselect" : "Select to delete",
          (_e, cx) => this.toggleSelect(tile, cx), c, { variant: selected ? "outline" : "danger" }))));
  }

  selectionCard(c, m) {
    const byPath = new Map(m.tiles.map((t) => [t.path, t]));
    const list = [...this.selected].map((p) => byPath.get(p)).filter(Boolean);
    const kb = list.reduce((s, t) => s + (t.size ?? 0), 0);
    return card(c, G.lg, G.sm)
      .child(h_flex().justify_between().items_center()
        .child(cardHeader(`${list.length} selected`, `About ${formatKB(kb)}`, c))
        .child(button("wtm-clear-sel", "Clear", (_e, cx) => { this.selected.clear(); cx.notify(); }, c, { variant: "ghost" })))
      .children(list.map((x, i) => h_flex().id(`wtm-sel-${i}`).gap(G.sm).items_center().justify_between()
        .px(4).py(2).rounded(4).cursor_pointer()
        .when(this.pinned === x.path, (e) => e.bg(c.selected))
        .when(this.pinned !== x.path, (e) => e.hover((st) => st.bg(c.subtle)))
        .on_click((_e, ccx) => { this.pinned = x.path; ccx.notify(); })
        .child(div().text_size(T.small).truncate().min_w(0).child(`${x.repo}/${x.name}`))
        .child(h_flex().gap(G.xs).items_center().flex_none()
          .when(x.dirty, (e) => e.child(div().text_size(T.label).text_color(this.color("dirty")).child("changes")))
          .child(div().text_size(T.small).text_color(c.dim).child(formatKB(x.size)))
          .child(div().id(`wtm-sel-x-${i}`).px(4).text_size(T.small).text_color(c.dim).cursor_pointer()
            .hover((s) => s.text_color(c.text))
            .on_mouse_down("left", (_e, mcx) => mcx.stop_propagation())
            .on_click((_e, ccx) => { this.selected.delete(x.path); ccx.notify(); })
            .child("✕")))))
      .child(button("wtm-del-selected-2", `Delete ${list.length} selected`, (_e, cx) => this.askRemove(list.map((x) => x.path), "selected", cx), c,
        { variant: "danger", disabled: this.busyWork() || !this.liveScan, tooltip: this.liveScan && !this.busyWork() ? null : "Waiting for the scan to finish" }));
  }

  // ------------------------------------------------------------ settings

  settingsView(c, m) {
    return v_flex().id("wtm-settings-scroll").w_full().flex_1().min_h(0).overflow_y_scrollbar()
      .child(v_flex().w_full().max_w(820).gap(G.lg).pb(G.xl)
        .child(this.foldersCard(c, m))
        .child(this.cacheCard(c))
        .child(this.textCard(c))
        .child(this.colorsCard(c))
        .child(card(c, G.lg, G.sm)
          .child(cardHeader("What counts as an orphan", null, c))
          .child(mutedText("A worktree with no live terminal whose folder is inside it: no agent, no shell. Worktrees with only a shell are shown as Terminal only and are never removed. Locked worktrees are skipped. Removing runs git worktree remove (with --force only for worktrees with uncommitted changes, after you confirm), then git worktree prune. Branches are never deleted.", c, T.body))));
  }

  foldersCard(c, m) {
    const roots = this.roots();
    const errors = new Map(this.rootErrors.map((e) => [e.root, e.message]));
    const rows = roots.map((root, i) => {
      const dir = expand(root);
      const count = m.tiles.filter((x) => inside(x.path, dir)).length;
      const err = errors.get(root);
      return h_flex().w_full().gap(G.md).items_center().justify_between().px(G.md).py(G.sm)
        .rounded(R.control).bg(c.muted).border_1().border_color(err ? c.destructive : c.border)
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(div().text_size(T.value).font_medium().truncate().child(tilde(dir)))
          .child(div().text_size(T.label).text_color(err ? c.destructive : c.dim).child(err ?? plural(count, "worktree"))))
        .child(button(`wtm-root-rm-${i}`, "Remove", (_e, cx) => this.setRoots(roots.filter((r) => r !== root), cx), c, { variant: "ghost" }));
    });
    return card(c, G.lg, G.md)
      .child(cardHeader("Worktree folders",
        `Each folder is searched ${SCAN_DEPTH} levels deep for linked git worktrees (a checkout whose .git is a file). Main checkouts and submodules are ignored.`, c))
      .children(rows.length ? rows : [mutedText("No folders yet. Add one below.", c)])
      .child(h_flex().w_full().gap(G.sm).items_center()
        .child(div().flex_1().min_w(0).child(controlInput(Input.new(this.rootInput).w_full(), c)))
        .child(button("wtm-root-browse", "Browse…", (_e, cx) => this.browseRoot(cx), c, { variant: "outline" }))
        .child(button("wtm-root-add", "Add", (_e, cx) => this.addRoot(this.rootInput.value(), cx), c, { variant: "primary" })))
      .child(h_flex().gap(G.sm)
        .child(button("wtm-root-reset", "Reset to defaults", (_e, cx) => this.setRoots(DEFAULT_ROOTS, cx), c, { variant: "ghost" })));
  }

  cacheCard(c) {
    const p = this.prefs();
    const label = (min) => (min < 60 ? `${min} min` : `${min / 60} h`);
    const saved = this.cacheSavedAt
      ? `Last saved ${new Date(this.cacheSavedAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`
      : "No cache saved yet";
    return card(c, G.lg, G.md)
      .child(h_flex().w_full().gap(G.md).items_start().justify_between()
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(h_flex().gap(6).items_center()
            .child(div().text_size(T.card).font_semibold().text_color(c.text).child("Caching"))
            .child(this.helpIcon("cache", c)))
          .child(div().text_size(T.small).text_color(c.dim)
            .child("Remember the last results so the map opens instantly, then refresh them in the background.")))
        .child(toggleSwitch("wtm-cache-toggle", p.cache, (next, cx) => this.setCaching(next, cx), c, { label: "Caching" })))
      .when(p.cache, (el) => el
        .child(h_flex().w_full().flex_wrap().gap(G.md).items_center().justify_between()
          .child(v_flex().gap(2).min_w(180)
            .child(div().text_size(T.value).font_medium().child("Re-measure disk use after"))
            .child(div().text_size(T.label).text_color(c.dim).child("On open, sizes older than this are measured again; newer ones are reused.")))
          .child(segmented("wtm-cache-ttl", TTL_CHOICES.map((min) => ({ key: String(min), label: label(min) })), String(p.cacheTtlMin),
            (key, cx) => { this.savePrefs({ cacheTtlMin: Number(key) }); cx.notify(); }, c))))
      .child(h_flex().w_full().flex_wrap().gap(G.md).items_center().justify_between().px(G.md).py(G.sm)
        .rounded(R.control).bg(c.muted).border_1().border_color(c.border)
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(div().id("wtm-cache-path").text_size(T.small).font_medium().truncate().tooltip(this.cachePath()).child(tilde(this.cachePath())))
          .child(div().text_size(T.label).text_color(c.dim).child(p.cache ? saved : "Caching is off: nothing is written, and every open runs a full scan.")))
        .child(button("wtm-cache-clear", "Clear cache", (_e, cx) => {
          cx.spawn(async (scx) => { await this.clearCache(); notify({ title: "Worktree cache cleared", level: "success" }); scx.notify(); });
        }, c, { variant: "outline", disabled: !this.cacheSavedAt })));
  }

  /** A − 100% + stepper with preset sizes, for one scale setting. */
  scaleRow(id, label, hint, field, c) {
    const value = this.prefs()[field];
    const set = (v, cx) => { this.savePrefs({ [field]: Math.round(Math.min(SCALE_MAX, Math.max(SCALE_MIN, v)) * 100) / 100 }); cx.notify(); };
    const pct = (v) => `${Math.round(v * 100)}%`;
    return h_flex().w_full().flex_wrap().gap(G.md).items_center().justify_between()
      .child(v_flex().gap(2).min_w(180)
        .child(div().text_size(T.value).font_medium().child(label))
        .child(div().text_size(T.label).text_color(c.dim).child(hint)))
      .child(h_flex().gap(G.sm).items_center().flex_wrap()
        .child(button(`${id}-dec`, "A−", (_e, cx) => set(value - SCALE_STEP, cx), c, { variant: "outline", disabled: value <= SCALE_MIN + 1e-6, tooltip: "Smaller" }))
        .child(div().w(Math.round(52 * this.prefs().textScale)).text_size(T.value).font_semibold().text_color(c.text).child(pct(value)))
        .child(button(`${id}-inc`, "A+", (_e, cx) => set(value + SCALE_STEP, cx), c, { variant: "outline", disabled: value >= SCALE_MAX - 1e-6, tooltip: "Larger" }))
        .child(segmented(`${id}-presets`, SCALE_PRESETS.map((v) => ({ key: String(v), label: pct(v) })),
          SCALE_PRESETS.some((v) => Math.abs(v - value) < 1e-6) ? String(SCALE_PRESETS.find((v) => Math.abs(v - value) < 1e-6)) : "",
          (key, cx) => set(Number(key), cx), c)));
  }

  textCard(c) {
    return card(c, G.lg, G.md)
      .child(h_flex().justify_between().items_center()
        .child(cardHeader("Text size", "Applies to this mod only. Herdr's own zoom (⌘+ / ⌘−) still scales everything.", c))
        .child(button("wtm-text-reset", "Reset", (_e, cx) => { this.savePrefs({ textScale: 1, labelScale: 1 }); cx.notify(); }, c, { variant: "ghost" })))
      .child(this.scaleRow("wtm-scale-all", "All text", "Headings, buttons, panels and the map", "textScale", c))
      .child(div().h(1).w_full().bg(c.border))
      .child(this.scaleRow("wtm-scale-labels", "Block labels", "Names on the treemap blocks, on top of All text", "labelScale", c));
  }

  /** A swatch that opens a picker: preset colours, a hex field, and the theme default. */
  colorPicker(key, label, c) {
    const t = theme();
    const current = this.color(key, t, c);
    const custom = this.isCustom(key);
    const open = this.openColor === key;
    const sw = Math.round(22 * this.prefs().textScale);
    const trigger = Button.new(`wtm-color-${key}`).h(HC.control).px(6).gap(G.sm).items_center().rounded(R.control)
      .border_1().border_color(open ? c.ring : c.border).bg(c.card).cursor_pointer()
      .hover((style) => style.bg(c.subtle))
      .focus((style) => style.border_color(c.ring))
      .accessibility_label(`${label} colour: ${current}`)
      .child(div().size(sw).rounded(4).bg(parseHex(current) ? current : c.secondary).border_1().border_color(c.input))
      .child(div().text_size(T.small).text_color(c.mutedForeground).child(parseHex(current) ? current : "theme"))
      .child(div().text_size(T.small).text_color(c.dim).child("⌄"));
    const pop = Popover.new(`wtm-color-pop-${key}`).trigger(trigger).open(open)
      .on_open_change((next, ocx) => {
        if (next) {
          this.openColor = key;
          this.hexError = null;
          this.colorInputs[key]?.set_value(parseHex(this.color(key)) ? this.color(key) : "");
        } else if (this.openColor === key) this.openColor = null;
        ocx.notify();
      });
    if (open) {
      const chip = (hex, i) => div().id(`wtm-preset-${key}-${i}`).size(sw).rounded(4).bg(hex).cursor_pointer()
        .border_2().border_color(hex.toLowerCase() === String(current).toLowerCase() ? c.text : hex)
        .hover((style) => style.border_color(c.text))
        .tooltip(hex)
        .on_click((_e, ccx) => { this.setColor(key, hex); this.openColor = null; ccx.notify(); });
      pop.content(v_flex().w(Math.round(8 * (sw + 6) + 2 * G.md)).p(G.md).gap(G.sm).rounded(R.card).bg(c.popover).border_1().border_color(c.border)
        .child(div().text_size(T.body).font_semibold().child(label))
        .child(h_flex().flex_wrap().gap(6).children(PRESET_COLORS.map(chip)))
        .child(h_flex().gap(G.sm).items_center()
          .child(div().flex_1().min_w(0).child(controlInput(Input.new(this.colorInputs[key]).w_full(), c)
            .when(this.hexError === key, (el) => el.border_color(c.destructive))))
          .child(button(`wtm-hex-apply-${key}`, "Apply", (_e, cx) => this.applyHex(key, this.colorInputs[key].value(), cx), c, { variant: "primary" })))
        .when(this.hexError === key, (el) => el.child(div().text_size(T.label).text_color(c.destructive).child("Use a hex colour like #3b82f6.")))
        .child(h_flex().gap(G.sm).items_center().justify_between()
          .child(h_flex().gap(6).items_center()
            .child(div().size(Math.round(sw * 0.7)).rounded(3).bg(parseHex(this.defaultColor(key, t, c)) ? this.defaultColor(key, t, c) : c.secondary).border_1().border_color(c.input))
            .child(div().text_size(T.label).text_color(c.dim).child("Theme default")))
          .child(button(`wtm-color-default-${key}`, "Use default", (_e, cx) => { this.setColor(key, null); this.openColor = null; cx.notify(); }, c,
            { variant: "outline", disabled: !custom }))));
    }
    return pop;
  }

  colorsCard(c) {
    const groups = [];
    for (const slot of COLOR_SLOTS) {
      let g = groups.find((x) => x.name === slot.group);
      if (!g) groups.push((g = { name: slot.group, slots: [] }));
      g.slots.push(slot);
    }
    const row = (key, label) => h_flex().w_full().gap(G.md).items_center().justify_between().py(2)
      .child(h_flex().gap(G.sm).items_center().min_w(0)
        .child(div().text_size(T.value).truncate().child(label))
        .when(this.isCustom(key), (el) => el.child(div().text_size(T.label).text_color(c.accent).child("custom"))))
      .child(this.colorPicker(key, label, c));
    const anyCustom = COLOR_SLOTS.some((s) => this.isCustom(s.key)) || REPO_COLORS.some((_, i) => this.isCustom(`repo-${i}`));
    return card(c, G.lg, G.md)
      .child(h_flex().justify_between().items_center()
        .child(cardHeader("Colours", "Click a swatch to pick a preset or type a hex colour. Unchanged colours follow your Herdr theme.", c))
        .child(button("wtm-colors-reset", "Reset all", (_e, cx) => { this.savePrefs({ colors: {}, repoColors: [] }); this.openColor = null; cx.notify(); }, c,
          { variant: "ghost", disabled: !anyCustom })))
      .children(groups.map((g) => v_flex().w_full().gap(G.xs)
        .child(metaLabel(g.name, c))
        .children(g.slots.map((slot) => row(slot.key, slot.label)))))
      .child(v_flex().w_full().gap(G.sm)
        .child(metaLabel("Repository palette (Colour: Repository)", c))
        .child(h_flex().w_full().flex_wrap().gap(G.sm)
          .children(REPO_COLORS.map((_, i) => this.colorPicker(`repo-${i}`, `Repository colour ${i + 1}`, c)))));
  }
}
