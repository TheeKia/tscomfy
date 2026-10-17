import {
  isOutputRef,
  type InputValue,
  type NodeId,
  uiNodeSizes,
  type Workflow,
} from "@tscomfy/core";
import { layered, type LayoutSpacing, type Position } from "./layered.ts";

/**
 * Positions for `toUi` (docs/plan.md §11): the workflow laid out left to right in columns by
 * dependency depth, each node the size `toUi` writes for it.
 *
 * ```ts
 * const { workflow: ui } = toUi(built, { positions: layout(built) });
 * ```
 */
export function layout(workflow: Workflow, spacing?: LayoutSpacing): ReadonlyMap<NodeId, Position> {
  const sizes = uiNodeSizes(workflow);
  const boxes = [...workflow.graph.nodes.values()].map((node) => {
    const [width, height] = sizes.get(node.id) ?? [0, 0];
    return { id: node.id, width, height, sources: sources(node.inputs) };
  });
  return layered(boxes, spacing);
}

/** The nodes a node's inputs link to. */
function sources(inputs: { readonly [name: string]: InputValue }): string[] {
  const found = new Set<string>();
  const pending: InputValue[] = Object.values(inputs);
  for (let value = pending.pop(); value !== undefined; value = pending.pop()) {
    if (isOutputRef(value)) found.add(value.node);
    else if (Array.isArray(value)) pending.push(...(value as readonly InputValue[]));
    else if (typeof value === "object" && value !== null) pending.push(...Object.values(value));
  }
  return [...found];
}
