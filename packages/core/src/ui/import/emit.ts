// The nodes of the frontend's prompt for a loaded UI file (docs/plan.md §11, `graphToPrompt`): in
// its execution order, subgraph interiors after their instance, each with its widget values and
// then its resolved links, as the wire carries them.

import type { WireNode } from "../../api/import.ts";
import { wrapList } from "../../api/wire.ts";
import { frontendWidgets, SCRIPTED_WIDGETS, uncreatable } from "../../frontend/node.ts";
import type { JsonValue } from "../../json/value.ts";
import { definitionOf } from "../../schema/lookup.ts";
import { MODE_BYPASS, MODE_MUTE, nodeModeOf } from "../format.ts";
import type { Id, UiNode } from "./file.ts";
import { type Context, type Graph, type Loaded, nodeKey, VIRTUAL_NODES } from "./graph.ts";
import { type LinkResolver, problemMessage } from "./resolve.ts";
import { isNamedValues } from "./widget-values.ts";

/** A node the prompt holds, and where it sits. */
export interface Emitted {
  readonly context: Context;
  readonly node: UiNode;
}

/**
 * The frontend's execution order (`computeExecutionOrder`): nodes without linked inputs first,
 * in file order, then breadth-first along links in ascending id; nodes on cycles last, in object
 * key order (integer ids ascending first).
 */
export function executionOrder(graph: Graph): Id[] {
  const { file, placement } = graph;
  const waiting = new Map<Id, number>();
  for (const id of file.order) waiting.set(id, placement.into.get(id)?.size ?? 0);
  const queue = file.order.filter((id) => waiting.get(id) === 0);
  const order: Id[] = [];
  const seen = new Set<Id>();
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head];
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    order.push(id);
    const links = (placement.outgoing.get(id) ?? []).toSorted(
      (a, b) => a.originSlot - b.originSlot || a.id - b.id,
    );
    for (const link of links) {
      if (!file.nodes.has(link.targetId)) continue;
      const left = (waiting.get(link.targetId) ?? 0) - 1;
      waiting.set(link.targetId, left);
      if (left === 0) queue.push(link.targetId);
    }
  }
  const rest = file.order.filter((id) => !seen.has(id));
  const indices = rest.filter((id) => isArrayIndex(id)).toSorted((a, b) => Number(a) - Number(b));
  return [...order, ...indices, ...rest.filter((id) => !isArrayIndex(id))];
}

/**
 * The nodes the prompt holds, in the frontend's order (`graphToPrompt`): the root in execution
 * order (`rootOrder`), each instance's interior after it in its definition's node order,
 * depth-first. A muted or bypassed instance at the top isn't expanded; one nested inside another
 * is (a frontend quirk, reported). Frontend-only nodes are left out, and so are nodes of unknown
 * classes linked to nothing.
 */
export function emittedNodes(loaded: Loaded, rootOrder: readonly Id[]): Emitted[] {
  const result: Emitted[] = [];
  const top: Context = { graph: loaded.root, path: [] };
  const stack: { readonly context: Context; readonly ids: readonly Id[]; next: number }[] = [
    { context: top, ids: rootOrder, next: 0 },
  ];
  for (let frame = stack.at(-1); frame !== undefined; frame = stack.at(-1)) {
    const id = frame.ids[frame.next++];
    if (id === undefined) {
      stack.pop();
      continue;
    }
    const { context } = frame;
    const node = context.graph.file.nodes.get(id);
    if (node === undefined) continue;
    const subgraph = loaded.subgraphs.get(node.type);
    if (subgraph !== undefined) {
      const off = node.mode === MODE_MUTE || node.mode === MODE_BYPASS;
      if (off && context.path.length === 0) continue;
      if (off) {
        loaded.report(
          "W_FRONTEND_QUIRK",
          [nodeKey(context, node.id)],
          "A muted or bypassed subgraph inside another subgraph still sends its interior, as the frontend does.",
        );
      }
      stack.push({
        context: {
          graph: subgraph.graph,
          path: [...context.path, node.id],
          instance: { node, subgraph, outer: context },
        },
        ids: subgraph.graph.file.order,
        next: 0,
      });
      continue;
    }
    if (VIRTUAL_NODES.has(node.type)) continue;
    if (
      definitionOf(loaded.schema, node.type) === undefined &&
      !loaded.groupNode(node.type) &&
      !linked(context.graph, node.id)
    ) {
      // Unknown to the schema and linked to nothing: a pack's frontend-only node (a label, a
      // group toggle), which the frontend never sends, or a missing class, which only makes
      // the backend reject the prompt. Either way it changes nothing else.
      loaded.report(
        "W_NODE_LEFT_OUT",
        [nodeKey(context, node.id)],
        `Node ${nodeKey(context, node.id)} has class ${node.type}, which the schema doesn't have, and no links; leaving it out.`,
      );
      continue;
    }
    result.push({ context, node });
  }
  return result;
}

/** A node to keep, as the wire carries it: widget values, then links in slot order. */
export function wireOf(
  loaded: Loaded,
  resolver: LinkResolver,
  { context, node }: Emitted,
): WireNode {
  const id = nodeKey(context, node.id);
  const definition = definitionOf(loaded.schema, node.type);
  const mode = nodeModeOf(node.mode);
  const base = {
    id,
    classType: node.type,
    ...(node.title === undefined ? {} : { title: node.title }),
    ...(mode === undefined ? {} : { mode }),
  };
  const inputs: [string, JsonValue][] = [];
  const reason = definition === undefined ? undefined : uncreatable(definition);
  if (definition === undefined || reason !== undefined) {
    if (loaded.groupNode(node.type)) {
      loaded.report(
        "E_LEGACY_GROUP_NODE",
        [id],
        `Node ${id} is a group node (${node.type}), which the frontend converts into a subgraph on load; that isn't supported, so it is kept raw and the prompt differs from the frontend's.`,
      );
    } else {
      // Unknown to the schema, or a class the frontend can't create: the frontend sends it
      // without a class; keep it raw, with the values it saved by name, and its links.
      const kept =
        node.named === undefined && !isNamedValues(node.values)
          ? "its links only"
          : "its widget values by name and its links";
      loaded.report(
        "W_IMPORTED_AS_RAW",
        [id],
        reason === undefined
          ? `Node ${id} has class ${node.type}, which the schema doesn't have; it is kept raw, with ${kept}.`
          : `Node ${id} has class ${node.type}, which the frontend can't create (${reason}); it is kept raw, with ${kept}.`,
      );
    }
    const named = node.named ?? (isNamedValues(node.values) ? node.values : {});
    for (const [name, value] of Object.entries(named)) inputs.push([name, wrapList(value)]);
  } else {
    if (SCRIPTED_WIDGETS.has(node.type)) {
      loaded.report(
        "W_EXTENSION_WIDGETS",
        [id],
        `Node ${id} (${node.type}) gets widgets from frontend JavaScript that the schema doesn't describe; the frontend also sends their values, which this import leaves out.`,
      );
    }
    const values = context.graph.values.get(node.id)?.values ?? new Map<string, JsonValue>();
    for (const widget of frontendWidgets(definition, (key) => values.get(key))) {
      if (widget.key === undefined || widget.sent === "never") continue;
      if (widget.sent === "queue") {
        loaded.report(
          "W_QUEUE_TIME_VALUE",
          [id, "inputs", widget.key],
          `Input ${widget.key} of node ${id} is a widget whose value the frontend computes when it queues the prompt (a 3D scene, a webcam frame, a recording); it is left out.`,
        );
        continue;
      }
      const value = values.get(widget.key);
      // The frontend sends a widget under its own name, which differs from the input's for a
      // name an earlier widget has (`width#1`) or a widget named by its type (`view`).
      if (value !== undefined) inputs.push([widget.name, wrapList(value)]);
    }
  }
  const placed = context.graph.placement.into.get(node.id);
  for (const slot of context.graph.placement.layouts.get(node.id) ?? []) {
    const link = placed?.get(slot.name);
    if (link === undefined) continue;
    const { resolved, quirk } = resolver.resolve(context, link, slot.type);
    if (quirk) {
      loaded.report(
        "W_FRONTEND_QUIRK",
        [id, "inputs", slot.name],
        `Input ${slot.name} of node ${id} is linked through two instances of one subgraph in a row; the frontend's loop check refuses to build the prompt for that. It is resolved through both.`,
      );
    }
    if (resolved === undefined) continue;
    if ("problem" in resolved) {
      loaded.report(
        "W_UNRESOLVED_LINK",
        [id, "inputs", slot.name],
        problemMessage(resolved.problem),
      );
      continue;
    }
    const value =
      "link" in resolved ? [resolved.link[0], resolved.link[1]] : wrapList(resolved.value);
    // A link replaces a widget's value in place: a repeated key keeps its first position.
    inputs.push([slot.name, value]);
  }
  return { ...base, inputs: Object.fromEntries(inputs) };
}

/** Whether any placed link starts or ends at a node. */
function linked(graph: Graph, id: Id): boolean {
  const { placement } = graph;
  return (placement.into.get(id)?.size ?? 0) > 0 || (placement.outgoing.get(id)?.length ?? 0) > 0;
}

function isArrayIndex(key: string): boolean {
  return /^(?:0|[1-9][0-9]{0,9})$/.test(key) && Number(key) < 2 ** 32 - 1;
}
