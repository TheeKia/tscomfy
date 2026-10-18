// Resolving a link the way the frontend does when it builds a prompt (docs/plan.md §11): through
// Reroutes, subgraph boundaries and the mode of a subgraph instance, to a link to a node the
// workflow keeps, a promoted widget value, or nothing (`ExecutableNodeDTO.resolveInput`,
// `resolveOutput`, `_getBypassSlotIndex`; `SubgraphNode` promoted widgets).

import { bypassSlot } from "../../frontend/links.ts";
import { frontendWidgets } from "../../frontend/node.ts";
import type { NodeId } from "../../graph/types.ts";
import type { JsonValue } from "../../json/value.ts";
import { definitionOf } from "../../schema/lookup.ts";
import { MODE_BYPASS, MODE_MUTE } from "../format.ts";
import type { Boundary, Id, UiLink, UiNode } from "./file.ts";
import {
  type Context,
  type Loaded,
  nodeKey,
  SUBGRAPH_INPUT,
  type Subgraph,
  VIRTUAL_NODES,
} from "./graph.ts";
import { positionalValues } from "./widget-values.ts";

/** Why the frontend refuses to build a prompt for a link: its source is missing, or it loops. */
export interface LinkProblem {
  readonly kind: "missing" | "loop";
  /** The node the link comes from. */
  readonly node: Id;
  /** The link into that node. */
  readonly link: number;
}

/** What a link resolves to: a link to a node we keep, a promoted value, nothing, or a refusal. */
export type Resolved =
  | { readonly link: readonly [NodeId, number] }
  | { readonly value: JsonValue }
  | { readonly problem: LinkProblem }
  | undefined;

/** A resolution and whether it went through two instances of one subgraph in a row. */
export interface Resolution {
  readonly resolved: Resolved;
  /** The frontend's loop guard, which keys steps by definition, refuses this one. */
  readonly quirk: boolean;
}

/** The promoted value of a definition's input: the value its interior widget starts from. */
type Promotion = { readonly value: JsonValue | undefined } | undefined;

/**
 * A memoized step at the root: its result, and the guard keys its continuation uses. A problem at
 * this very step is kept without its link: each chain names the link it arrives by.
 */
interface Memo {
  readonly resolved:
    | Exclude<Resolved, { readonly problem: LinkProblem }>
    | { readonly problem: Omit<LinkProblem, "link"> & { readonly link: number | undefined } };
  readonly keys: readonly string[];
  readonly quirk: boolean;
}

/**
 * One resolution, from a consumer's input back to its source: the steps taken (`seen`, by
 * instance path), and the frontend's own loop guard, which keys steps by definition instead and
 * so also trips on two instances of one subgraph in a row.
 */
interface Chain {
  readonly seen: Set<string>;
  readonly guard: Set<string>;
  /** Guard keys inside subgraphs, in order, for the memo. */
  readonly keys: string[];
  quirk: boolean;
}

/** One step of a resolution: a link into an input, or an output it comes from. */
type ResolveStep =
  | {
      readonly side: "input";
      readonly context: Context;
      readonly link: UiLink;
      readonly type: string;
    }
  | {
      readonly side: "output";
      readonly context: Context;
      readonly id: Id;
      readonly slot: number;
      readonly type: string;
      readonly via: UiLink;
    };

/**
 * Resolves links of a loaded file. Steps at the root are memoized with their result, so long
 * Reroute chains resolve in linear time; promoted values are computed once per definition, in
 * dependency order.
 */
export class LinkResolver {
  readonly #loaded: Loaded;
  readonly #promotions = new Map<Subgraph, readonly Promotion[]>();
  readonly #memo = new Map<string, Memo>();

  constructor(loaded: Loaded) {
    this.#loaded = loaded;
    for (const subgraph of loaded.ordered) this.#promotions.set(subgraph, this.#promote(subgraph));
  }

  /**
   * `resolveInput` for a link that lands in `context`, then `resolveOutput` at its source, and on
   * through Reroutes, subgraph boundaries and bypassed instances, in a loop (chains can be long).
   */
  resolve(context: Context, start: UiLink, startType: string): Resolution {
    const chain: Chain = { seen: new Set(), guard: new Set(), keys: [], quirk: false };
    const pending: { readonly key: string; readonly keys: number; readonly quirks: number }[] = [];
    let quirks = 0;
    const guard = (key: string): void => {
      if (chain.guard.has(key)) {
        chain.quirk = true;
        quirks++;
      }
      chain.guard.add(key);
      chain.keys.push(key);
    };
    /** The key of the step the problem is at, so a memo of that step leaves its link open. */
    let problemStep: string | undefined;
    let step: ResolveStep = { side: "input", context, link: start, type: startType };
    let resolved: Resolved;
    for (;;) {
      if (step.side === "input") {
        const link: UiLink = step.link;
        if (step.context.path.length > 0) {
          guard(`${step.context.graph.file.key}:${link.targetId}[I]${String(link.id)}`);
        }
        if (link.originId !== SUBGRAPH_INPUT) {
          step = {
            side: "output",
            context: step.context,
            id: link.originId,
            slot: link.originSlot,
            type: step.type,
            via: link,
          };
          continue;
        }
        const instance: Context["instance"] = step.context.instance;
        const boundary: Boundary | undefined = instance?.subgraph.inputs[link.originSlot];
        if (instance === undefined || boundary === undefined) {
          resolved = undefined;
          break;
        }
        const outer: UiLink | undefined = instance.outer.graph.placement.into
          .get(instance.node.id)
          ?.get(boundary.name);
        if (outer !== undefined) {
          step = { side: "input", context: instance.outer, link: outer, type: boundary.type };
          continue;
        }
        const promoted = this.promotedValue(instance.node, instance.subgraph, link.originSlot);
        resolved = promoted?.value === undefined ? undefined : { value: promoted.value };
        break;
      }
      const at: Context = step.context;
      const id: Id = step.id;
      const slot: number = step.slot;
      const type: string = step.type;
      const via: UiLink = step.via;
      const memoKey = at.path.length === 0 ? `${id}\u0000${String(slot)}\u0000${type}` : undefined;
      if (memoKey !== undefined) {
        const known = this.#memo.get(memoKey);
        if (known !== undefined) {
          if (known.quirk || known.keys.some((each) => chain.guard.has(each))) {
            chain.quirk = true;
            quirks++;
          }
          const { resolved: memoized } = known;
          resolved =
            memoized !== undefined && "problem" in memoized
              ? { problem: { ...memoized.problem, link: memoized.problem.link ?? via.id } }
              : memoized;
          break;
        }
        pending.push({ key: memoKey, keys: chain.keys.length, quirks });
      }
      const node: UiNode | undefined = at.graph.file.nodes.get(id);
      const seen = `${at.path.join(":")}\u0000${id}\u0000${String(slot)}`;
      // The frontend refuses to build the prompt for either.
      if (node === undefined || chain.seen.has(seen)) {
        resolved = {
          problem: { kind: node === undefined ? "missing" : "loop", node: id, link: via.id },
        };
        problemStep = memoKey;
        break;
      }
      chain.seen.add(seen);
      if (at.path.length > 0) guard(`${at.graph.file.key}:${id}[O]${String(slot)}`);
      const subgraph = this.#loaded.subgraphs.get(node.type);
      if (subgraph !== undefined) {
        const next = this.#throughInstance(at, node, subgraph, slot, type);
        if (next === undefined) {
          resolved = undefined;
          break;
        }
        step = next;
        continue;
      }
      if (node.type === "Reroute") {
        const input: UiLink | undefined =
          node.mode === MODE_MUTE
            ? undefined
            : at.graph.placement.into.get(node.id)?.values().next().value;
        if (input === undefined) {
          resolved = undefined;
          break;
        }
        // A bypassed Reroute passes on no type.
        step = {
          side: "input",
          context: at,
          link: input,
          type: node.mode === MODE_BYPASS ? "*" : type,
        };
        continue;
      }
      // PrimitiveNode and Notes have no output; a node we keep is linked to, and its own mode,
      // if any, is applied when the prompt is built.
      resolved = VIRTUAL_NODES.has(node.type) ? undefined : { link: [nodeKey(at, node.id), slot] };
      break;
    }
    for (const entry of pending) {
      const open: Memo["resolved"] =
        entry.key === problemStep && resolved !== undefined && "problem" in resolved
          ? { problem: { ...resolved.problem, link: undefined } }
          : resolved;
      this.#memo.set(entry.key, {
        resolved: open,
        keys: chain.keys.slice(entry.keys),
        quirk: quirks > entry.quirks,
      });
    }
    return { resolved, quirk: chain.quirk };
  }

  /**
   * The value of promoted input `index` of an instance: its saved value (one per promoted
   * input, in input order), else the interior widget's own.
   */
  promotedValue(node: UiNode, subgraph: Subgraph, index: number): Promotion {
    const promotions = this.#promotions.get(subgraph) ?? [];
    const own = promotions[index];
    if (own === undefined) return undefined;
    const position = promotions.slice(0, index).filter((each) => each !== undefined).length;
    const saved = positionalValues(node.values)?.[position];
    return { value: saved === undefined ? own.value : saved };
  }

  /** The promoted inputs of a definition (`SubgraphNode`), its nested ones decided first. */
  #promote(subgraph: Subgraph): Promotion[] {
    const { file, placement, values } = subgraph.graph;
    return subgraph.inputs.map((input): Promotion => {
      for (const id of input.linkIds) {
        const link = placement.liveLink(id);
        const target = link === undefined ? undefined : file.nodes.get(link.targetId);
        const name = link === undefined ? undefined : placement.names.get(link.id);
        if (target === undefined || name === undefined) continue;
        const nested = this.#loaded.subgraphs.get(target.type);
        if (nested !== undefined) {
          const index = nested.inputs.findIndex((each) => each.name === name);
          const value = this.promotedValue(target, nested, index);
          if (value !== undefined) return value;
          continue;
        }
        const own = definitionOf(this.#loaded.schema, target.type);
        const restored = values.get(target.id)?.values;
        if (own === undefined || restored === undefined) continue;
        const widget = frontendWidgets(own, (key) => restored.get(key)).some(
          (each) => each.key === name,
        );
        if (widget) return { value: restored.get(name) };
      }
      return undefined;
    });
  }

  /**
   * Where output `slot` of a subgraph instance leads: through its interior, or, bypassed,
   * through one of its inputs; nothing when muted.
   */
  #throughInstance(
    context: Context,
    node: UiNode,
    subgraph: Subgraph,
    slot: number,
    type: string,
  ): ResolveStep | undefined {
    if (node.mode === MODE_MUTE) return undefined;
    if (node.mode === MODE_BYPASS) {
      const output = subgraph.outputs[slot]?.type ?? "*";
      const index = bypassSlot(subgraph.inputs, output, slot, type);
      const boundary = index === -1 ? undefined : subgraph.inputs[index];
      const link =
        boundary === undefined
          ? undefined
          : context.graph.placement.into.get(node.id)?.get(boundary.name);
      return link === undefined || boundary === undefined
        ? undefined
        : { side: "input", context, link, type: boundary.type };
    }
    const { graph } = subgraph;
    const inner = subgraph.outputs[slot]?.linkIds
      .map((id) => graph.placement.liveLink(id))
      .find((link) => link !== undefined);
    if (inner === undefined) return undefined;
    const interior: Context = {
      graph,
      path: [...context.path, node.id],
      instance: { node, subgraph, outer: context },
    };
    return {
      side: "output",
      context: interior,
      id: inner.originId,
      slot: inner.originSlot,
      type,
      via: inner,
    };
  }
}

/** The message for a link the frontend refuses to resolve. */
export function problemMessage(problem: LinkProblem): string {
  return problem.kind === "missing"
    ? `Link ${String(problem.link)} comes from node ${problem.node}, which the graph doesn't have; dropping it.`
    : `Link ${String(problem.link)} loops back on itself through node ${problem.node}; dropping it.`;
}
