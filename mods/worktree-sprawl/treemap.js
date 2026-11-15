// Squarified treemap (Bruls, Huizing & van Wijk). Pure layout: no host calls.

/**
 * Lays `items` (each with a positive `value`) out inside `rect` {x, y, w, h}.
 * Returns [{ item, x, y, w, h }] in float pixels, largest first.
 */
export function squarify(items, rect) {
  const total = items.reduce((sum, item) => sum + Math.max(0, item.value), 0);
  if (items.length === 0 || total <= 0 || rect.w <= 0 || rect.h <= 0) return [];
  const scale = (rect.w * rect.h) / total;
  const nodes = items
    .filter((item) => item.value > 0)
    .map((item) => ({ item, area: item.value * scale }))
    .sort((a, b) => b.area - a.area);

  const out = [];
  let { x, y, w, h } = rect;

  const worst = (row, side) => {
    let sum = 0, max = -Infinity, min = Infinity;
    for (const n of row) { sum += n.area; if (n.area > max) max = n.area; if (n.area < min) min = n.area; }
    const sum2 = sum * sum, side2 = side * side;
    return Math.max((side2 * max) / sum2, sum2 / (side2 * min));
  };

  const place = (row) => {
    const sum = row.reduce((acc, n) => acc + n.area, 0);
    if (w >= h) {
      // A column against the left edge.
      const cw = Math.min(w, sum / h);
      let cy = y;
      for (const n of row) { const nh = n.area / cw; out.push({ item: n.item, x, y: cy, w: cw, h: nh }); cy += nh; }
      x += cw; w -= cw;
    } else {
      // A row against the top edge.
      const rh = Math.min(h, sum / w);
      let cx = x;
      for (const n of row) { const nw = n.area / rh; out.push({ item: n.item, x: cx, y, w: nw, h: rh }); cx += nw; }
      y += rh; h -= rh;
    }
  };

  let row = [];
  let i = 0;
  while (i < nodes.length) {
    const side = Math.max(1e-6, Math.min(w, h));
    const n = nodes[i];
    if (row.length === 0 || worst(row, side) >= worst([...row, n], side)) {
      row.push(n);
      i += 1;
    } else {
      place(row);
      row = [];
    }
  }
  if (row.length) place(row);
  return out;
}

/** Snaps a float rect to whole pixels so neighbours share edges exactly. */
export function snap(r) {
  const x0 = Math.round(r.x), y0 = Math.round(r.y);
  const x1 = Math.round(r.x + r.w), y1 = Math.round(r.y + r.h);
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}
