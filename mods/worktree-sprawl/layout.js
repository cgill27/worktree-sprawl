// Putting the Worktrees launcher button into a layout. Pure: no Herdr imports.

export const BUTTON_ID = "worktree-sprawl-toolbar-button";
const SHIPPED = ["main", "terminals", "win98"]; // used only when Herdr's own list can't be read

const isButton = (n, mod) => n?.id === BUTTON_ID || (n?.content?.mod === mod && n?.content?.props?.mode === "toolbar");

/** True when the layout already has the button, wherever it was put and whatever its id. */
export function hasToolbarButton(tree, mod) {
  return Boolean(tree) && (isButton(tree, mod) || (tree.children ?? []).some((c) => hasToolbarButton(c, mod))
    || (tree.floating ?? []).some((c) => hasToolbarButton(c, mod)));
}

/**
 * A copy of `tree` with the button beside the tab bar (the block with id "tabs", else the one showing
 * the `tabs` mod). In a row it goes right after the tab bar; otherwise the tab bar is wrapped in a row
 * that takes its size. Returns { tree, added }: added is false when the layout already has the button
 * (never twice) or has no tab bar to put it beside.
 */
export function withToolbarButton(tree, mod) {
  const copy = JSON.parse(JSON.stringify(tree ?? null));
  if (!copy || hasToolbarButton(copy, mod)) return { tree: copy, added: false };
  const block = { id: BUTTON_ID, type: "block", size: { px: 112 }, content: { mod, props: { mode: "toolbar" } } };
  const ids = new Set();
  const collect = (n) => { if (n?.id) ids.add(n.id); (n?.children ?? []).forEach(collect); };
  collect(copy);
  const isTabs = (n) => n?.id === "tabs" || n?.content?.mod === "tabs";
  const place = (n) => {
    const kids = n?.children;
    if (!Array.isArray(kids)) return false;
    const i = kids.findIndex(isTabs);
    if (i < 0) return kids.some(place);
    if (n.type === "row") { kids.splice(i + 1, 0, block); return true; }
    const target = kids[i];
    const { size, min, max } = target;
    const inner = { ...target, size: { weight: 1 } };
    delete inner.min; delete inner.max;
    kids[i] = {
      id: ids.has("tabs-row") ? "worktree-sprawl-tabs-row" : "tabs-row", type: "row", size: size ?? { weight: 1 },
      ...(min != null ? { min } : {}), ...(max != null ? { max } : {}), ...(target.window_drag ? { window_drag: true } : {}),
      children: [inner, block],
    };
    return true;
  };
  return { tree: copy, added: place(copy) };
}

/** A name for the copy of a shipped layout: "<name>-worktrees", numbered when taken. */
export function copyName(name, taken) {
  const used = new Set(taken ?? []);
  let as = `${name}-worktrees`;
  for (let n = 2; used.has(as); n += 1) as = `${name}-worktrees-${n}`;
  return as;
}

/**
 * Whether `name` is one of Herdr's own layouts, which it replaces on every start (an edit there is lost).
 * `installedText` is Herdr's installed.json, which lists them as "layout:<name>"; unreadable, a known list.
 */
export function isShippedLayout(name, installedText) {
  try {
    const installed = JSON.parse(installedText);
    if (installed && typeof installed === "object") return Object.prototype.hasOwnProperty.call(installed, `layout:${name}`);
  } catch { /* fall through */ }
  return SHIPPED.includes(name);
}
