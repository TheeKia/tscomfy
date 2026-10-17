// A layered layout (after Sugiyama et al., much simplified): columns by dependency depth, rows
// in each column ordered by where their sources sit, then packed from the top. Deterministic,
// and linear apart from one sort per column.

/** A box to place: its size, and the boxes its inputs come from. */
export interface LayoutBox {
  readonly id: string;
  readonly width: number;
  readonly height: number;
  /** Ids of the boxes linked into this one; unknown ids and cycles are ignored. */
  readonly sources: readonly string[];
}

/** Spacing between columns and between boxes in a column. */
export interface LayoutSpacing {
  readonly column: number;
  readonly row: number;
}

/** Where a box goes: its top-left corner. */
export type Position = readonly [x: number, y: number];

/**
 * Positions for boxes that flow left to right: a box sits one column right of its rightmost
 * source, boxes without sources in the first column; in each column boxes are ordered by the
 * average row of their sources (ties by input order), and each column is as wide as its widest
 * box. Boxes on a cycle go where the cycle is broken, in input order.
 */
export function layered(
  boxes: readonly LayoutBox[],
  spacing: LayoutSpacing = { column: 80, row: 40 },
): ReadonlyMap<string, Position> {
  const index = new Map(boxes.map((box, position) => [box.id, position]));
  const columns = depths(boxes, index);
  const byColumn = new Map<number, LayoutBox[]>();
  for (const box of boxes) {
    const column = columns.get(box.id) ?? 0;
    const list = byColumn.get(column);
    if (list === undefined) byColumn.set(column, [box]);
    else list.push(box);
  }
  const rows = new Map<string, number>();
  const positions = new Map<string, Position>();
  let x = 0;
  for (const column of [...byColumn.keys()].toSorted((a, b) => a - b)) {
    const members = byColumn.get(column) ?? [];
    const order = (box: LayoutBox): number => {
      const placed = box.sources.flatMap((source) => {
        const row = rows.get(source);
        return row === undefined ? [] : [row];
      });
      return placed.length === 0
        ? Number.POSITIVE_INFINITY
        : placed.reduce((sum, row) => sum + row, 0) / placed.length;
    };
    const sorted = members
      .map((box) => ({ box, key: order(box), at: index.get(box.id) ?? 0 }))
      .toSorted((a, b) => (a.key === b.key ? a.at - b.at : a.key < b.key ? -1 : 1));
    let y = 0;
    let width = 0;
    for (const [row, { box }] of sorted.entries()) {
      rows.set(box.id, row);
      positions.set(box.id, [x, y]);
      y += box.height + spacing.row;
      width = Math.max(width, box.width);
    }
    x += width + spacing.column;
  }
  return positions;
}

/** Each box's column: the longest path from a box without sources (iterative, cycle-safe). */
function depths(
  boxes: readonly LayoutBox[],
  index: ReadonlyMap<string, number>,
): ReadonlyMap<string, number> {
  const depth = new Map<string, number>();
  const state = new Map<string, "open" | "done">();
  for (const start of boxes) {
    if (state.has(start.id)) continue;
    const stack: { readonly box: LayoutBox; next: number }[] = [{ box: start, next: 0 }];
    state.set(start.id, "open");
    while (stack.length > 0) {
      const frame = stack.at(-1);
      if (frame === undefined) break;
      const source = frame.box.sources[frame.next++];
      if (source !== undefined) {
        const at = index.get(source);
        const box = at === undefined ? undefined : boxes[at];
        // Unknown sources, and back edges of a cycle, don't count.
        if (box !== undefined && !state.has(box.id)) {
          state.set(box.id, "open");
          stack.push({ box, next: 0 });
        }
        continue;
      }
      stack.pop();
      state.set(frame.box.id, "done");
      const sources = frame.box.sources.flatMap((id) => {
        const value = state.get(id) === "done" ? depth.get(id) : undefined;
        return value === undefined ? [] : [value];
      });
      depth.set(frame.box.id, sources.length === 0 ? 0 : Math.max(...sources) + 1);
    }
  }
  return depth;
}
