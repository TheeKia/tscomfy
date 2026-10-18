// Graph operations (docs/plan.md §12): free functions from a workflow to new workflows.

import { definitionOf } from "../schema/lookup.ts";
import type { GraphNode, InputValue, Workflow } from "./graph.ts";
import { isOutputRef } from "./output-ref.ts";
import type { NodeId, Out } from "./types.ts";
import { type AssembledNode, assembleWorkflow } from "./workflow.ts";

/**
 * The workflow without the nodes no output node needs: what remains are the output nodes
 * that run (not bypassed or muted) and everything they link to, through bypassed and muted
 * nodes too, so the result is a workflow the builder could make (no link to a node left out).
 * Nodes of classes the schema doesn't know are kept only when something kept links to them.
 * Cosmetic: the backend only runs output nodes and their ancestors anyway.
 */
export function prune<N>(workflow: Workflow<N>): Workflow<N> {
  return subset(workflow, needed(workflow, outputNodes(workflow)));
}

/**
 * One workflow per output node that runs, in graph order, each holding that node and everything
 * it depends on, as `prune` keeps them. An output node another one depends on is in both.
 */
export function splitOutputs<N>(workflow: Workflow<N>): readonly Workflow<N>[] {
  return outputNodes(workflow).map((root) => subset(workflow, needed(workflow, [root])));
}

/** The output nodes that run: the schema says so, and they aren't bypassed or muted. */
function outputNodes(workflow: Workflow): GraphNode[] {
  return [...workflow.graph.nodes.values()].filter(
    (node) =>
      node.mode === undefined && definitionOf(workflow.schema, node.classType)?.outputNode === true,
  );
}

/** `roots` and every node they link to, directly or not. */
function needed(workflow: Workflow, roots: readonly GraphNode[]): ReadonlySet<NodeId> {
  const kept = new Set<NodeId>();
  const pending = roots.map((root) => root.id);
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    if (kept.has(id)) continue;
    const node = workflow.graph.nodes.get(id);
    if (node === undefined) continue;
    kept.add(id);
    for (const ref of references(node.inputs)) if (!kept.has(ref)) pending.push(ref);
  }
  return kept;
}

/** The nodes in `ids`, in graph order, as a new workflow. */
function subset<N>(workflow: Workflow<N>, ids: ReadonlySet<NodeId>): Workflow<N> {
  const order = positions(workflow);
  const kept = [...ids].toSorted((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  return assembleWorkflow(workflow.schema, (link) =>
    kept.flatMap((id) => {
      const node = workflow.graph.nodes.get(id);
      return node === undefined ? [] : [copy(node, link)];
    }),
  );
}

/** Each node's position in graph order, computed once per workflow. */
const orders = new WeakMap<Workflow, ReadonlyMap<NodeId, number>>();

function positions(workflow: Workflow): ReadonlyMap<NodeId, number> {
  let order = orders.get(workflow);
  if (order === undefined) {
    order = new Map([...workflow.graph.nodes.keys()].map((id, index) => [id, index]));
    orders.set(workflow, order);
  }
  return order;
}

/** A node for another workflow: references belong to the workflow that made them. */
function copy(node: GraphNode, link: (node: NodeId, slot: number) => Out<string>): AssembledNode {
  const inputs = Object.fromEntries(
    Object.entries(node.inputs).map(([name, value]) => [name, relink(value, link)]),
  );
  const { id, classType, raw, title, mode } = node;
  return {
    id,
    classType,
    inputs,
    raw,
    ...(title === undefined ? {} : { title }),
    ...(mode === undefined ? {} : { mode }),
  };
}

function relink(value: InputValue, link: (node: NodeId, slot: number) => Out<string>): InputValue {
  if (isOutputRef(value)) return link(value.node, value.slot);
  if (isList(value)) return value.map((item) => relink(item, link));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, relink(item, link)]),
    );
  }
  return value;
}

/** The ids of the nodes a node's inputs link to. */
function references(inputs: { readonly [name: string]: InputValue }): NodeId[] {
  const found: NodeId[] = [];
  const pending: InputValue[] = Object.values(inputs);
  for (let value = pending.pop(); value !== undefined; value = pending.pop()) {
    if (isOutputRef(value)) found.push(value.node);
    else if (isList(value)) pending.push(...value);
    else if (typeof value === "object" && value !== null) pending.push(...Object.values(value));
  }
  return found;
}

function isList(value: InputValue): value is readonly InputValue[] {
  return Array.isArray(value);
}
