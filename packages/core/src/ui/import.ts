// UI workflow → Workflow (docs/plan.md §11): what the ComfyUI frontend would queue for a saved
// workflow, as a graph. Frontend 1.55.17, read as a specification (`LGraph.configure`,
// `linkDeduplication.ts`, `subgraphDeduplication.ts`, `ComfyNode.configure`, `graphToPrompt`,
// `ExecutableNodeDTO`, `SubgraphNode`, `searchAndReplace.ts`):
// - nodes are rebuilt from their definitions: widget values restored by position or name, links
//   deduplicated and placed as the frontend places them;
// - what a graph of ours can't hold is resolved here, as the frontend resolves it when it builds a
//   prompt: Reroute nodes, PrimitiveNode values, subgraph boundaries and promoted values, the mode
//   of a subgraph instance, `%Node.widget%` references in file names;
// - real nodes keep their links and modes (bypass, mute), which the exporter then applies.
// So `toApi(importUi(x))` is the prompt the frontend builds for `x`.

import { type Link, wireNode, type WireNode } from "../api/import.ts";
import { bypassSlot } from "../api/modes.ts";
import {
  createDiagnostic,
  type Diagnostic,
  type DiagnosticCode,
} from "../diagnostic/diagnostic.ts";
import type { Workflow } from "../graph/graph.ts";
import type { NodeId, NodeMode } from "../graph/types.ts";
import { assembleWorkflow, type AssembledNode } from "../graph/workflow.ts";
import { parse } from "../json/parse.ts";
import { stringify } from "../json/stringify.ts";
import { isJsonObject, type JsonObject, type JsonValue } from "../json/value.ts";
import type { TypedSchema } from "../schema/typed.ts";
import type { InputDef, NodeDef } from "../schema/types.ts";
import {
  controlOn,
  frontendSlots,
  frontendWidgets,
  type FrontendWidget,
  SAVE_NODES,
} from "./frontend.ts";

/** What {@link importUi} returns. */
export interface UiImportResult<N> {
  /** The workflow the frontend would queue, as a graph over `schema`. */
  readonly workflow: Workflow<N>;
  /** Problems reading the workflow, and frontend behavior it reproduces with a warning. */
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * Reads a UI workflow, as the frontend saves it (format 0.4 with tuple links, or 1), into a
 * workflow over `schema` (docs/plan.md §11). Takes raw text, so big integers stay exact (the
 * frontend rounds them).
 *
 * Exporting the result gives the prompt the frontend builds for the same file, byte for byte,
 * except where JavaScript changes it at queue time (dates in file names, packs' injected links
 * and widgets) and for nodes of classes the schema doesn't have, which the frontend sends without
 * a class.
 */
export function importUi<N>(text: string, schema: TypedSchema<N>): UiImportResult<N> {
  const diagnostics: Diagnostic[] = [];
  const parsed = parse(text);
  diagnostics.push(...parsed.diagnostics);
  const workflow = assembleWorkflow(schema, (link) => {
    if (parsed.value === undefined) return [];
    if (!isJsonObject(parsed.value) || !Array.isArray(parsed.value["nodes"])) {
      diagnostics.push(
        createDiagnostic(
          "E_INVALID_WORKFLOW",
          [],
          "Expected a UI workflow: an object with a nodes list.",
        ),
      );
      return [];
    }
    return new UiReader(parsed.value, schema, diagnostics).read(link);
  });
  return { workflow, diagnostics };
}

/** A node id as the frontend keys it (`toNodeId`): `4` and `"4"` are the same node. */
type Id = string;

/** A link of a UI graph. */
interface UiLink {
  readonly id: number;
  readonly originId: Id;
  readonly originSlot: number;
  readonly targetId: Id;
  readonly targetSlot: number;
}

/** A node of a UI graph, as saved. */
interface UiNode {
  readonly id: Id;
  readonly type: string;
  readonly mode: number;
  readonly title?: string;
  readonly properties: JsonObject;
  /** Saved inputs: their names, and the link each references. */
  readonly inputs: readonly { readonly name: string; readonly link: number | undefined }[];
  readonly values: JsonValue | undefined;
  readonly named: JsonObject | undefined;
}

/** A graph: the root, or a subgraph definition's interior. */
interface UiGraph {
  /** The definition's id; empty for the root. */
  readonly key: string;
  /** Where its nodes are in the file, for diagnostics: `[]`, or the definition's. */
  readonly prefix: readonly (string | number)[];
  readonly nodes: ReadonlyMap<Id, UiNode>;
  /** Node ids in file order. */
  readonly order: readonly Id[];
  /** Every link read, by id. */
  readonly links: ReadonlyMap<number, UiLink>;
  /** Links that survive deduplication (`normalizeConfiguredTopology`), and what the rest became. */
  readonly alive: Map<number, UiLink>;
  readonly remap: Map<number, number>;
  /** Placed links: by target node and input name, the input each lands on, those from a node. */
  readonly into: Map<Id, Map<string, UiLink>>;
  readonly names: Map<number, string>;
  readonly outgoing: Map<Id, UiLink[]>;
  /** Restored widget values by node and wire key; the same for every instance of a definition. */
  readonly values: Map<Id, Map<string, JsonValue>>;
  /** Slots of each node once loaded, in order, with their types. */
  readonly layouts: Map<Id, readonly { readonly name: string; readonly type: string }[]>;
}

/** A subgraph definition. */
interface Definition {
  readonly id: string;
  readonly name: string;
  readonly graph: UiGraph;
  readonly inputs: readonly Boundary[];
  readonly outputs: readonly Boundary[];
}

/** An input or output of a subgraph definition. */
interface Boundary {
  readonly name: string;
  readonly type: string;
  readonly linkIds: readonly number[];
}

/** Where a node sits: the graph, and the instances it is nested in. */
interface Context {
  readonly graph: UiGraph;
  /** Instance ids from the root, which prefix inner ids: `40:31:21`. */
  readonly path: readonly Id[];
  /** The instance this graph is the interior of, and the context that instance sits in. */
  readonly instance?: {
    readonly node: UiNode;
    readonly definition: Definition;
    readonly outer: Context;
  };
}

/** What a link resolves to: a link to a node we keep, a promoted value, nothing, or a refusal. */
type Resolved =
  | { readonly link: readonly [NodeId, number] }
  | { readonly value: JsonValue }
  | { readonly unresolved: string }
  | undefined;

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

/** A memoized step at the root: the result, and the guard keys its continuation uses. */
interface Memo {
  readonly resolved: Resolved;
  readonly keys: readonly string[];
  readonly quirk: boolean;
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

/** A promoted input of a definition: the value its interior widget starts from. */
type Promotion = { readonly value: JsonValue | undefined } | undefined;

const MUTE = 2;
const BYPASS = 4;
const SUBGRAPH_INPUT = "-10";
/** Frontend-only nodes: resolved through, or dropped. */
const VIRTUAL: ReadonlySet<string> = new Set(["Reroute", "PrimitiveNode", "Note", "MarkdownNote"]);
const REPLACE_PROPERTY = "Run widget replace on values";
const SEARCH_NAME = "Node name for S&R";

class UiReader {
  readonly #file: JsonObject;
  readonly #schema: TypedSchema<unknown>;
  readonly #diagnostics: Diagnostic[];
  readonly #definitions = new Map<string, Definition>();
  /** Definitions in dependency order: each after the ones it instantiates. */
  #ordered: readonly Definition[] = [];
  readonly #promotions = new Map<Definition, readonly Promotion[]>();
  readonly #memo = new Map<string, Memo>();
  /** The node ids taken, as numbers, and the frontend's id counter (`state.lastNodeId`). */
  readonly #used = new Set<number>();
  #counter = 0;

  constructor(file: JsonObject, schema: TypedSchema<unknown>, diagnostics: Diagnostic[]) {
    this.#file = file;
    this.#schema = schema;
    this.#diagnostics = diagnostics;
  }

  read(link: Link): AssembledNode[] {
    const tuples = this.#file["version"] === 0.4;
    const rootNodes = list(this.#file["nodes"]);
    this.#counter = numberOr(this.#file["last_node_id"], 0);
    const state = this.#file["state"];
    if (isJsonObject(state)) {
      this.#counter = Math.max(this.#counter, numberOr(state["lastNodeId"], 0));
    }
    // Inner ids that collide with the root's, or with an earlier definition's, are reminted
    // first (`normalizeSubgraphDefinitions`); then root nodes, a repeated id reminted as added.
    const reserved = new Set<Id>();
    for (const raw of rootNodes) {
      const id = isJsonObject(raw) ? nodeIdOf(raw["id"]) : undefined;
      if (id === undefined) continue;
      reserved.add(id);
      const numeric = numericId(id);
      if (numeric !== undefined) this.#used.add(numeric);
    }
    for (const raw of flattenDefinitions(this.#file)) {
      const id = raw["id"];
      if (typeof id !== "string" || this.#definitions.has(id)) continue;
      this.#definitions.set(id, this.#definition(id, raw, reserved));
    }
    const root = this.#graph(this.#file, tuples, [], "", "remint");
    if (!this.#order()) return [];
    for (const graph of [...this.#ordered.map((each) => each.graph), root]) {
      for (const id of graph.order) {
        const node = graph.nodes.get(id);
        const definition = node === undefined ? undefined : this.#definitionOf(node.type);
        if (node !== undefined && definition !== undefined) {
          graph.values.set(id, this.#widgetValues(graph, node, definition));
        }
      }
      this.#place(graph);
    }
    // PrimitiveNodes write into widgets before anything resolves, then save nodes replace
    // `%…%` in their file names, from the values as they are then.
    for (const graph of [root, ...this.#ordered.map((each) => each.graph)]) {
      const order = graph === root ? executionOrder(graph) : graph.order;
      this.#primitives(graph, order);
    }
    for (const graph of [root, ...this.#ordered.map((each) => each.graph)]) {
      this.#fileNames(graph, root);
    }
    for (const definition of this.#ordered)
      this.#promotions.set(definition, this.#promote(definition));
    const nodes: AssembledNode[] = [];
    for (const { context, node } of this.#emitted({ graph: root, path: [] })) {
      nodes.push(wireNode(this.#wire(context, node), this.#schema, link, this.#diagnostics));
    }
    return nodes;
  }

  /**
   * A graph's nodes and links, read defensively. In a definition a repeated node id keeps the
   * first node (`dropSameOwnerDuplicates`); at the root the later one gets a fresh id, and links
   * stay with the first.
   */
  #graph(
    source: JsonObject,
    tuples: boolean,
    prefix: readonly (string | number)[],
    key: string,
    repeated: "drop" | "remint",
    renames: ReadonlyMap<Id, Id> = new Map(),
  ): UiGraph {
    const nodes = new Map<Id, UiNode>();
    const order: Id[] = [];
    for (const [index, raw] of list(source["nodes"]).entries()) {
      const read = readUiNode(raw);
      if (read === undefined) {
        this.#report(
          "E_INVALID_WORKFLOW",
          [...prefix, "nodes", index],
          "This node can't be read (it needs an id and a type); dropping it.",
        );
        continue;
      }
      let node: UiNode = { ...read, id: renames.get(read.id) ?? read.id };
      if (nodes.has(node.id)) {
        if (repeated === "drop") continue;
        node = { ...node, id: String(this.#mint()) };
      } else if (repeated === "remint") {
        this.#observe(node.id);
      }
      nodes.set(node.id, node);
      order.push(node.id);
    }
    const links = new Map<number, UiLink>();
    for (const [index, raw] of list(source["links"]).entries()) {
      const read = tuples ? readTupleLink(raw) : readObjectLink(raw);
      if (read === undefined) {
        if (!tuples && Array.isArray(raw)) {
          this.#report(
            "E_INVALID_WORKFLOW",
            [...prefix, "links", index],
            "A tuple link outside format 0.4, which the frontend drops; dropping it.",
          );
        } else if (raw !== null) {
          this.#report(
            "E_INVALID_WORKFLOW",
            [...prefix, "links", index],
            "This link can't be read; dropping it.",
          );
        }
        continue;
      }
      if (links.has(read.id)) continue;
      links.set(read.id, {
        ...read,
        originId: renames.get(read.originId) ?? read.originId,
        targetId: renames.get(read.targetId) ?? read.targetId,
      });
    }
    return {
      key,
      prefix,
      nodes,
      order,
      links,
      alive: new Map(),
      remap: new Map(),
      into: new Map(),
      names: new Map(),
      outgoing: new Map(),
      values: new Map(),
      layouts: new Map(),
    };
  }

  /** A subgraph definition, with inner ids that collide with ones seen earlier reminted. */
  #definition(id: string, raw: JsonObject, used: Set<Id>): Definition {
    const renames = new Map<Id, Id>();
    const seen = new Set<Id>();
    for (const node of list(raw["nodes"])) {
      const nodeId = isJsonObject(node) ? nodeIdOf(node["id"]) : undefined;
      if (nodeId === undefined || seen.has(nodeId)) continue;
      seen.add(nodeId);
      if (used.has(nodeId)) {
        const fresh = String(this.#mint());
        renames.set(nodeId, fresh);
        used.add(fresh);
      } else {
        used.add(nodeId);
        this.#observe(nodeId);
      }
    }
    const graph = this.#graph(raw, false, ["definitions", "subgraphs", id], id, "drop", renames);
    const boundaries = (key: string): Boundary[] =>
      list(raw[key]).flatMap((each): Boundary[] => {
        if (!isJsonObject(each)) return [];
        return [
          {
            name: typeof each["name"] === "string" ? each["name"] : "",
            type: typeof each["type"] === "string" ? each["type"] : "*",
            linkIds: list(each["linkIds"]).filter(
              (link): link is number => typeof link === "number",
            ),
          },
        ];
      });
    const name = raw["name"];
    return {
      id,
      name: typeof name === "string" ? name : id,
      graph,
      inputs: boundaries("inputs"),
      outputs: boundaries("outputs"),
    };
  }

  /** The next free id after the counter (`mintNodeId`, sequential). */
  #mint(): number {
    let id = this.#counter + 1;
    while (this.#used.has(id)) id++;
    this.#used.add(id);
    this.#counter = id;
    return id;
  }

  #observe(id: Id): void {
    const numeric = numericId(id);
    if (numeric === undefined) return;
    this.#used.add(numeric);
    if (numeric >= 0 && numeric > this.#counter) this.#counter = numeric;
  }

  /**
   * Orders the definitions so each comes after the ones it instantiates. A definition that
   * contains itself, directly or not, makes the frontend refuse the whole file.
   */
  #order(): boolean {
    const state = new Map<Definition, "open" | "done">();
    const ordered: Definition[] = [];
    for (const start of this.#definitions.values()) {
      if (state.has(start)) continue;
      const stack: { readonly definition: Definition; readonly inner: Definition[] }[] = [];
      const open = (definition: Definition): void => {
        state.set(definition, "open");
        const inner = definition.graph.order.flatMap((id) => {
          const type = definition.graph.nodes.get(id)?.type;
          const found = type === undefined ? undefined : this.#definitions.get(type);
          return found === undefined ? [] : [found];
        });
        stack.push({ definition, inner: inner.toReversed() });
      };
      open(start);
      for (let frame = stack.at(-1); frame !== undefined; frame = stack.at(-1)) {
        const next = frame.inner.pop();
        if (next === undefined) {
          stack.pop();
          state.set(frame.definition, "done");
          ordered.push(frame.definition);
          continue;
        }
        const seen = state.get(next);
        if (seen === "done") continue;
        if (seen === "open") {
          this.#report(
            "E_INVALID_WORKFLOW",
            ["definitions", "subgraphs", next.id],
            `Subgraph ${next.name} contains itself, so the frontend refuses to load the file; importing nothing.`,
          );
          return false;
        }
        open(next);
      }
    }
    this.#ordered = ordered;
    return true;
  }

  /**
   * The nodes the prompt holds, in the frontend's order (`graphToPrompt`): the root in execution
   * order, each instance's interior after it in its definition's node order, depth-first. A muted
   * or bypassed instance at the top isn't expanded; one nested inside another is (a frontend
   * quirk, reported).
   */
  #emitted(top: Context): { readonly context: Context; readonly node: UiNode }[] {
    const result: { context: Context; node: UiNode }[] = [];
    const stack: { readonly context: Context; readonly ids: readonly Id[]; next: number }[] = [
      { context: top, ids: executionOrder(top.graph), next: 0 },
    ];
    for (let frame = stack.at(-1); frame !== undefined; frame = stack.at(-1)) {
      const id = frame.ids[frame.next++];
      if (id === undefined) {
        stack.pop();
        continue;
      }
      const { context } = frame;
      const node = context.graph.nodes.get(id);
      if (node === undefined) continue;
      const definition = this.#definitions.get(node.type);
      if (definition !== undefined) {
        const off = node.mode === MUTE || node.mode === BYPASS;
        if (off && context.path.length === 0) continue;
        if (off) {
          this.#report(
            "W_FRONTEND_QUIRK",
            [nodeKey(context, node.id)],
            "A muted or bypassed subgraph inside another subgraph still sends its interior, as the frontend does.",
          );
        }
        stack.push({
          context: {
            graph: definition.graph,
            path: [...context.path, node.id],
            instance: { node, definition, outer: context },
          },
          ids: definition.graph.order,
          next: 0,
        });
        continue;
      }
      if (VIRTUAL.has(node.type)) continue;
      if (
        this.#definitionOf(node.type) === undefined &&
        !this.#groupNode(node.type) &&
        !this.#linked(context.graph, node.id)
      ) {
        // Unknown to the schema and linked to nothing: a pack's frontend-only node (a label, a
        // group toggle), which the frontend never sends, or a missing class, which only makes
        // the backend reject the prompt. Either way it changes nothing else.
        this.#report(
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

  /**
   * A node's widget values, by wire key (§11). By position, as the frontend restores them, after
   * dropping the placeholders old files saved for `forceInput` inputs; by name when the positions
   * don't fit the layout (pack widgets the schema can't predict, which 1.55's names do hold).
   * Then the frontend's load-time fixups.
   */
  #widgetValues(graph: UiGraph, node: UiNode, definition: NodeDef): Map<string, JsonValue> {
    const path = [...graph.prefix, node.id, "widgets_values"];
    const named = node.named ?? (isNamedValues(node.values) ? node.values : undefined);
    const saved = positionalValues(node.values);
    const positional = saved === undefined ? undefined : migrate(definition, saved);
    const byPosition =
      positional === undefined
        ? undefined
        : settle(definition, (widgets) => byPositionOf(widgets, positional));
    let restored: Settled;
    if (byPosition !== undefined && positional !== undefined) {
      const fits = byPosition.persisted === positional.length;
      if (fits || named === undefined) {
        restored = byPosition;
        if (!fits) {
          this.#report(
            "W_WIDGET_VALUES_MISMATCH",
            path,
            `Node ${node.id} (${node.type}) saves ${String(positional.length)} widget values where its definition has ${String(byPosition.persisted)}: a pack's own widgets, or a file older than its definition. Values are read by position, as the frontend reads them.`,
          );
        } else if (named !== undefined && disagree(byPosition, named)) {
          this.#report(
            "W_WIDGET_VALUES_MISMATCH",
            path,
            `Node ${node.id} (${node.type}) saves widget values by name that disagree with its values by position; the frontend reads them by position, and so does this import.`,
          );
        }
      } else {
        restored = settle(definition, (widgets) => byNameOf(widgets, named));
      }
    } else {
      restored =
        named === undefined
          ? settle(definition, () => new Map())
          : settle(definition, (widgets) => byNameOf(widgets, named));
    }
    const { values } = restored;
    for (const widget of restored.widgets) {
      const { input, key } = widget;
      if (input === undefined || key === undefined) continue;
      // A widget without a saved value keeps the one it was created with.
      if (!values.has(key)) values.set(key, widget.initial);
      const value = values.get(key);
      // A combo saved as null takes its first option.
      if (input.kind === "combo" && value === null && widget.persisted) {
        const first = input.options[0];
        if (first !== undefined) values.set(key, first);
      }
      // KSampler's old `sample_` sampler names.
      if (
        (definition.classType === "KSampler" || definition.classType === "KSamplerAdvanced") &&
        input.name === "sampler_name" &&
        typeof value === "string" &&
        value.startsWith("sample_")
      ) {
        values.set(key, value.slice("sample_".length));
      }
    }
    return values;
  }

  /**
   * Places a graph's links as the frontend does. Links competing for one slot keep the first,
   * unless only a later one is referenced by an input (`normalizeConfiguredTopology`). Each lands
   * on its `target_slot` of the node as created; a dynamic combo's options are then rebuilt for
   * the restored value, dropping links on slots the chosen option doesn't have; then a link that
   * a saved input of its own target references moves to the slot of that name
   * (`realignInputLinkSlots`).
   */
  #place(graph: UiGraph): void {
    const referenced = new Set<number>();
    for (const node of graph.nodes.values()) {
      for (const input of node.inputs) if (input.link !== undefined) referenced.add(input.link);
    }
    const kept: UiLink[] = [];
    const at = new Map<string, number>();
    for (const link of graph.links.values()) {
      const key = `${link.targetId}\u0000${String(link.targetSlot)}`;
      const index = at.get(key);
      const survivor = index === undefined ? undefined : kept[index];
      if (index === undefined || survivor === undefined) {
        at.set(key, kept.length);
        kept.push(link);
        continue;
      }
      const same = survivor.originId === link.originId && survivor.originSlot === link.originSlot;
      if (!same && referenced.has(link.id) && !referenced.has(survivor.id)) {
        kept[index] = link;
        for (const [dropped, to] of graph.remap)
          if (to === survivor.id) graph.remap.set(dropped, link.id);
        graph.remap.set(survivor.id, link.id);
      } else {
        graph.remap.set(link.id, survivor.id);
      }
    }
    const byTarget = new Map<Id, UiLink[]>();
    for (const link of kept) {
      graph.alive.set(link.id, link);
      if (!graph.nodes.has(link.targetId)) continue;
      const links = byTarget.get(link.targetId);
      if (links === undefined) byTarget.set(link.targetId, [link]);
      else links.push(link);
    }
    for (const [target, links] of byTarget) {
      const node = graph.nodes.get(target);
      if (node === undefined) continue;
      const created = this.#slotNames(graph, node, true);
      const loaded = this.#slotNames(graph, node, false);
      const onto = new Map<UiLink, string>();
      // A slot past the node's still holds the link, which realignment can move by name.
      for (const link of links) {
        onto.set(link, created[link.targetSlot] ?? `\u0000${String(link.targetSlot)}`);
      }
      const ref = (id: number): number => graph.remap.get(id) ?? id;
      if (node.inputs.some((input) => isOptionChild(this.#definitionOf(node.type), input.name))) {
        // `realignGroupWidgetChildLinks`: before the options are rebuilt, over the created slots
        // and the saved ones the definition lacks.
        realign(onto, created, node, (id) => graph.alive.get(ref(id)));
      }
      // Rebuilding the options removes the slots the chosen ones lack, and their links.
      const available = new Set(loaded);
      const removable = new Set(created.filter((name) => !available.has(name)));
      for (const [link, name] of onto) if (removable.has(name)) onto.delete(link);
      realign(onto, loaded, node, (id) => graph.alive.get(ref(id)));
      const placed = new Map<string, UiLink>();
      for (const name of loaded) {
        const link = [...onto].find(([, each]) => each === name)?.[0];
        if (link === undefined) continue;
        placed.set(name, link);
        graph.names.set(link.id, name);
        const from = graph.outgoing.get(link.originId);
        if (from === undefined) graph.outgoing.set(link.originId, [link]);
        else from.push(link);
      }
      graph.into.set(target, placed);
    }
  }

  /**
   * The names of a node's slots in the frontend's order: as created (`fresh`, links land there
   * by `target_slot`) or once loaded, then the saved inputs the definition lacks. A subgraph
   * instance's slots are its definition's inputs.
   */
  #slotNames(graph: UiGraph, node: UiNode, fresh: boolean): readonly string[] {
    const definition = this.#definitionOf(node.type);
    const saved = node.inputs.map((input) => input.name);
    if (definition === undefined) {
      const instance = this.#definitions.get(node.type);
      const slots =
        instance === undefined
          ? saved.map((name) => ({ name, type: "*" }))
          : instance.inputs.map((input) => ({ name: input.name, type: input.type }));
      graph.layouts.set(node.id, slots);
      return slots.map((slot) => slot.name);
    }
    const linkedNames = new Set(
      node.inputs.filter((input) => input.link !== undefined).map((input) => input.name),
    );
    const values = graph.values.get(node.id);
    const slots = frontendSlots(
      definition,
      (key) => values?.get(key),
      (key, input) => {
        const created = Math.max(input.min + 1, 1);
        if (fresh) return Math.min(input.slots.length, created);
        // Linked slots from the first grow the group, with one empty slot after them.
        let chain = 0;
        while (chain < input.slots.length && linkedNames.has(`${key}.${input.slots[chain] ?? ""}`))
          chain++;
        return Math.min(input.slots.length, Math.max(created, chain + 1));
      },
      fresh,
    );
    const known = new Set(slots.map((slot) => slot.name));
    const extra = saved.filter((name) => !known.has(name));
    if (!fresh) {
      graph.layouts.set(node.id, [
        ...slots.map((slot) => ({ name: slot.name, type: slot.type })),
        ...extra.map((name) => ({ name, type: "*" })),
      ]);
    }
    return [...slots.map((slot) => slot.name), ...extra];
  }

  /**
   * PrimitiveNode (`applyToGraph`): writes its value into every widget it links to, whatever its
   * mode, after `%…%` replacement when its `Run widget replace on values` property is on. Into a
   * subgraph's promoted input the value is lost, as in the frontend (reported).
   */
  #primitives(graph: UiGraph, order: readonly Id[]): void {
    for (const id of order) {
      const primitive = graph.nodes.get(id);
      if (primitive?.type !== "PrimitiveNode") continue;
      let value = positionalValues(primitive.values)?.[0] ?? primitive.named?.["value"];
      if (value === undefined) continue;
      if (
        typeof value === "string" &&
        value !== "" &&
        primitive.properties[REPLACE_PROPERTY] === true
      ) {
        value = this.#replace(value, graph, [...graph.prefix, primitive.id]);
      }
      for (const link of graph.outgoing.get(primitive.id) ?? []) {
        if (link.originSlot !== 0) continue;
        const target = graph.nodes.get(link.targetId);
        const name = graph.names.get(link.id);
        if (target === undefined || name === undefined) continue;
        if (this.#definitions.has(target.type)) {
          this.#report(
            "W_FRONTEND_QUIRK",
            [...graph.prefix, primitive.id],
            "A PrimitiveNode linked to a subgraph's promoted input doesn't reach it, as in the frontend.",
          );
          continue;
        }
        graph.values.get(target.id)?.set(name, value);
      }
    }
  }

  /** Save nodes' `filename_prefix`, with `%Node.widget%` replaced as the frontend sends it. */
  #fileNames(graph: UiGraph, root: UiGraph): void {
    for (const id of graph.order) {
      const node = graph.nodes.get(id);
      if (node === undefined || !SAVE_NODES.has(node.type)) continue;
      const values = graph.values.get(id);
      const prefix = values?.get("filename_prefix");
      if (values === undefined || typeof prefix !== "string" || !prefix.includes("%")) continue;
      values.set(
        "filename_prefix",
        this.#replace(prefix, root, [...graph.prefix, id, "filename_prefix"]),
      );
    }
  }

  /**
   * `applyTextReplacements`: `%Node.widget%` becomes the widget's value, the node found by its
   * `Node name for S&R` property, else its title, first in the frontend's node order (interiors
   * before their instance). `%date:…%` is the queue time, which can't be reproduced (reported).
   */
  #replace(text: string, scope: UiGraph, path: readonly (string | number)[]): string {
    const seen = { dated: false };
    // oxlint-disable-next-line no-control-regex -- the characters the frontend replaces
    const unsafe = /[/?<>\\:*|"\u0000-\u001f\u007f]/g;
    const replaced = text.replaceAll(/%([^%]+)%/g, (match: string, pattern: string): string => {
      const split = pattern.split(".");
      if (split.length !== 2) {
        if (split[0]?.startsWith("date:") === true) seen.dated = true;
        return match;
      }
      const [name = "", widget = ""] = split;
      const nodes = this.#allNodes(scope);
      const found =
        nodes.find(({ node }) => this.#searchName(node) === name) ??
        nodes.find(({ node }) => this.#title(node) === name);
      if (found === undefined) return match;
      const value = this.#widgetValue(found.graph, found.node, widget);
      return value === undefined ? match : jsString(value).replaceAll(unsafe, "_");
    });
    if (seen.dated) {
      this.#report(
        "W_QUEUE_TIME_VALUE",
        path,
        "This file name holds %date:…%, which the frontend replaces with the time it queues the prompt; it is sent as written.",
      );
    }
    return replaced;
  }

  /** Every node under a graph, interiors before their instance (`mapAllNodes`). */
  #allNodes(scope: UiGraph): { readonly graph: UiGraph; readonly node: UiNode }[] {
    const found: { graph: UiGraph; node: UiNode }[] = [];
    type Entry = { readonly graph: UiGraph; readonly node: UiNode };
    const stack: { readonly graph: UiGraph; next: number; readonly instance?: Entry }[] = [
      { graph: scope, next: 0 },
    ];
    for (let frame = stack.at(-1); frame !== undefined; frame = stack.at(-1)) {
      const id = frame.graph.order[frame.next++];
      if (id === undefined) {
        stack.pop();
        if (frame.instance !== undefined) found.push(frame.instance);
        continue;
      }
      const node = frame.graph.nodes.get(id);
      if (node === undefined) continue;
      const definition = this.#definitions.get(node.type);
      if (definition === undefined) found.push({ graph: frame.graph, node });
      else stack.push({ graph: definition.graph, next: 0, instance: { graph: frame.graph, node } });
    }
    return found;
  }

  #searchName(node: UiNode): string | undefined {
    const given = node.properties[SEARCH_NAME];
    if (typeof given === "string") return given;
    // Added at creation to every node of a server class but the save nodes.
    return this.#definitionOf(node.type) !== undefined && !SAVE_NODES.has(node.type)
      ? node.type
      : undefined;
  }

  #title(node: UiNode): string {
    if (node.title !== undefined) return node.title;
    return (
      this.#definitionOf(node.type)?.displayName ??
      this.#definitions.get(node.type)?.name ??
      node.type
    );
  }

  /** A widget's value by its name, for `%Node.widget%`. */
  #widgetValue(graph: UiGraph, node: UiNode, name: string): JsonValue | undefined {
    if (node.type === "PrimitiveNode") {
      return name === "value"
        ? (positionalValues(node.values)?.[0] ?? node.named?.["value"] ?? null)
        : undefined;
    }
    const definition = this.#definitionOf(node.type);
    const values = graph.values.get(node.id);
    if (definition === undefined || values === undefined) return undefined;
    const widget = frontendWidgets(definition, (key) => values.get(key)).find(
      (each) => each.name === name,
    );
    return widget?.key === undefined ? undefined : (values.get(widget.key) ?? null);
  }

  /** The promoted inputs of a definition (`SubgraphNode`), its nested ones decided first. */
  #promote(definition: Definition): Promotion[] {
    const { graph } = definition;
    return definition.inputs.map((input): Promotion => {
      for (const id of input.linkIds) {
        const link = graph.alive.get(graph.remap.get(id) ?? id);
        const target = link === undefined ? undefined : graph.nodes.get(link.targetId);
        const name = link === undefined ? undefined : graph.names.get(link.id);
        if (target === undefined || name === undefined) continue;
        const nested = this.#definitions.get(target.type);
        if (nested !== undefined) {
          const index = nested.inputs.findIndex((each) => each.name === name);
          const value = this.#promotedValue(target, nested, index);
          if (value !== undefined) return value;
          continue;
        }
        const own = this.#definitionOf(target.type);
        const values = graph.values.get(target.id);
        if (own === undefined || values === undefined) continue;
        const widget = frontendWidgets(own, (key) => values.get(key)).some(
          (each) => each.key === name,
        );
        if (widget) return { value: values.get(name) };
      }
      return undefined;
    });
  }

  /**
   * The value of promoted input `index` of an instance: its saved value (one per promoted
   * input, in input order), else the interior widget's own.
   */
  #promotedValue(node: UiNode, definition: Definition, index: number): Promotion {
    const promotions = this.#promotions.get(definition) ?? [];
    const own = promotions[index];
    if (own === undefined) return undefined;
    const position = promotions.slice(0, index).filter((each) => each !== undefined).length;
    const saved = positionalValues(node.values)?.[position];
    return { value: saved === undefined ? own.value : saved };
  }

  /** A node to keep, as the wire carries it: widget values, then links in slot order. */
  #wire(context: Context, node: UiNode): WireNode {
    const id = nodeKey(context, node.id);
    const definition = this.#definitionOf(node.type);
    const mode: NodeMode | undefined =
      node.mode === MUTE ? "mute" : node.mode === BYPASS ? "bypass" : undefined;
    const base = {
      id,
      classType: node.type,
      ...(node.title === undefined ? {} : { title: node.title }),
      ...(mode === undefined ? {} : { mode }),
    };
    const inputs: [string, JsonValue][] = [];
    if (definition === undefined) {
      if (this.#groupNode(node.type)) {
        this.#report(
          "E_LEGACY_GROUP_NODE",
          [id],
          `Node ${id} is a group node (${node.type}), which the frontend converts into a subgraph on load; that isn't supported, so it is kept raw and the prompt differs from the frontend's.`,
        );
      } else {
        // Unknown to the schema: the frontend sends it without a class; keep it raw, with the
        // values it saved by name, and its links.
        this.#report(
          "W_IMPORTED_AS_RAW",
          [id],
          `Node ${id} has class ${node.type}, which the schema doesn't have; it is kept raw, with ${node.named === undefined ? "its links only" : "its widget values by name and its links"}.`,
        );
      }
      const named = node.named ?? (isNamedValues(node.values) ? node.values : {});
      for (const [name, value] of Object.entries(named)) inputs.push([name, wrap(value)]);
    } else {
      const values = context.graph.values.get(node.id) ?? new Map<string, JsonValue>();
      for (const widget of frontendWidgets(definition, (key) => values.get(key))) {
        if (widget.key === undefined || widget.input === undefined || !sent(widget)) continue;
        const value = values.get(widget.key);
        if (value !== undefined) inputs.push([widget.key, wrap(value)]);
      }
    }
    const placed = context.graph.into.get(node.id);
    const slots =
      context.graph.layouts.get(node.id) ??
      node.inputs.map((input) => ({ name: input.name, type: "*" }));
    for (const slot of slots) {
      const link = placed?.get(slot.name);
      if (link === undefined) continue;
      const chain: Chain = { seen: new Set(), guard: new Set(), keys: [], quirk: false };
      const resolved = this.#resolveLink(context, link, slot.type, chain);
      if (chain.quirk) {
        this.#report(
          "W_FRONTEND_QUIRK",
          [id, "inputs", slot.name],
          `Input ${slot.name} of node ${id} is linked through two instances of one subgraph in a row; the frontend's loop check refuses to build the prompt for that. It is resolved through both.`,
        );
      }
      if (resolved === undefined) continue;
      if ("unresolved" in resolved) {
        this.#report("W_UNRESOLVED_LINK", [id, "inputs", slot.name], resolved.unresolved);
        continue;
      }
      const value =
        "link" in resolved ? [resolved.link[0], resolved.link[1]] : wrap(resolved.value);
      const index = inputs.findIndex(([key]) => key === slot.name);
      if (index === -1) inputs.push([slot.name, value]);
      else inputs[index] = [slot.name, value];
    }
    return { ...base, inputs: Object.fromEntries(inputs) };
  }

  /**
   * `resolveInput` for a link that lands in `context`, then `resolveOutput` at its source, and on
   * through Reroutes, subgraph boundaries and bypassed instances, in a loop (chains can be long).
   * Steps at the root are memoized with their result.
   */
  #resolveLink(context: Context, start: UiLink, startType: string, chain: Chain): Resolved {
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
    let step: ResolveStep = { side: "input", context, link: start, type: startType };
    let resolved: Resolved;
    for (;;) {
      if (step.side === "input") {
        const link: UiLink = step.link;
        if (step.context.path.length > 0) {
          guard(`${step.context.graph.key}:${link.targetId}[I]${String(link.id)}`);
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
        const boundary: Boundary | undefined = instance?.definition.inputs[link.originSlot];
        if (instance === undefined || boundary === undefined) {
          resolved = undefined;
          break;
        }
        const outer: UiLink | undefined = instance.outer.graph.into
          .get(instance.node.id)
          ?.get(boundary.name);
        if (outer !== undefined) {
          step = { side: "input", context: instance.outer, link: outer, type: boundary.type };
          continue;
        }
        const promoted = this.#promotedValue(instance.node, instance.definition, link.originSlot);
        resolved = promoted?.value === undefined ? undefined : { value: promoted.value };
        break;
      }
      const at: Context = step.context;
      const id: Id = step.id;
      const slot: number = step.slot;
      const type: string = step.type;
      const via: UiLink = step.via;
      if (at.path.length === 0) {
        const key = `${id}\u0000${String(slot)}\u0000${type}`;
        const known = this.#memo.get(key);
        if (known !== undefined) {
          if (known.quirk || known.keys.some((each) => chain.guard.has(each))) {
            chain.quirk = true;
            quirks++;
          }
          resolved = known.resolved;
          break;
        }
        pending.push({ key, keys: chain.keys.length, quirks });
      }
      const node: UiNode | undefined = at.graph.nodes.get(id);
      const seen = `${at.path.join(":")}\u0000${id}\u0000${String(slot)}`;
      // The frontend refuses to build the prompt for either.
      if (node === undefined) {
        resolved = {
          unresolved: `Link ${String(via.id)} comes from node ${id}, which the graph doesn't have; dropping it.`,
        };
        break;
      }
      if (chain.seen.has(seen)) {
        resolved = {
          unresolved: `Link ${String(via.id)} loops back on itself through node ${id}; dropping it.`,
        };
        break;
      }
      chain.seen.add(seen);
      if (at.path.length > 0) guard(`${at.graph.key}:${id}[O]${String(slot)}`);
      const definition = this.#definitions.get(node.type);
      if (definition !== undefined) {
        const next = this.#throughInstance(at, node, definition, slot, type);
        if (next === undefined) {
          resolved = undefined;
          break;
        }
        step = next;
        continue;
      }
      if (node.type === "Reroute") {
        const input: UiLink | undefined =
          node.mode === MUTE ? undefined : at.graph.into.get(node.id)?.values().next().value;
        if (input === undefined) {
          resolved = undefined;
          break;
        }
        // A bypassed Reroute passes on no type.
        step = { side: "input", context: at, link: input, type: node.mode === BYPASS ? "*" : type };
        continue;
      }
      // PrimitiveNode and Notes have no output; a node we keep is linked to, and its own mode,
      // if any, is applied when the prompt is built.
      resolved = VIRTUAL.has(node.type) ? undefined : { link: [nodeKey(at, node.id), slot] };
      break;
    }
    for (const entry of pending) {
      this.#memo.set(entry.key, {
        resolved,
        keys: chain.keys.slice(entry.keys),
        quirk: quirks > entry.quirks,
      });
    }
    return resolved;
  }

  /**
   * Where output `slot` of a subgraph instance leads: through its interior, or, bypassed,
   * through one of its inputs; nothing when muted.
   */
  #throughInstance(
    context: Context,
    node: UiNode,
    definition: Definition,
    slot: number,
    type: string,
  ): ResolveStep | undefined {
    if (node.mode === MUTE) return undefined;
    if (node.mode === BYPASS) {
      const output = definition.outputs[slot]?.type ?? "*";
      const index = bypassSlot(definition.inputs, output, slot, type);
      const boundary = index === -1 ? undefined : definition.inputs[index];
      const link =
        boundary === undefined ? undefined : context.graph.into.get(node.id)?.get(boundary.name);
      return link === undefined || boundary === undefined
        ? undefined
        : { side: "input", context, link, type: boundary.type };
    }
    const { graph } = definition;
    const inner = definition.outputs[slot]?.linkIds
      .map((id) => graph.alive.get(graph.remap.get(id) ?? id))
      .find((link) => link !== undefined);
    if (inner === undefined) return undefined;
    const interior: Context = {
      graph,
      path: [...context.path, node.id],
      instance: { node, definition, outer: context },
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

  /** Whether any placed link starts or ends at a node. */
  #linked(graph: UiGraph, id: Id): boolean {
    return (graph.into.get(id)?.size ?? 0) > 0 || (graph.outgoing.get(id)?.length ?? 0) > 0;
  }

  /** A legacy group node: `workflow>Name` (or `workflow/Name`) with `extra.groupNodes[Name]`. */
  #groupNode(type: string): boolean {
    const match = /^workflow[>/](.+)$/.exec(type);
    const extra = this.#file["extra"];
    const groups = isJsonObject(extra) ? extra["groupNodes"] : undefined;
    return match?.[1] !== undefined && isJsonObject(groups) && Object.hasOwn(groups, match[1]);
  }

  #definitionOf(type: string): NodeDef | undefined {
    return Object.hasOwn(this.#schema.nodes, type) ? this.#schema.nodes[type] : undefined;
  }

  #report(code: DiagnosticCode, path: readonly (string | number)[], message: string): void {
    this.#diagnostics.push(createDiagnostic(code, path, message));
  }
}

/** A node's widgets and values once its dynamic combos settle on the restored choices. */
interface Settled {
  readonly widgets: readonly FrontendWidget[];
  readonly values: Map<string, JsonValue>;
  /** How many of the widgets are saved. */
  readonly persisted: number;
}

/**
 * Restores values over a layout that dynamic combos change: each pass lays the widgets out for
 * the choices the previous pass read, and assigns afresh, until the layout stays.
 */
function settle(
  definition: NodeDef,
  assign: (widgets: readonly FrontendWidget[]) => Map<string, JsonValue>,
): Settled {
  let values = new Map<string, JsonValue>();
  let widgets: FrontendWidget[] = [];
  let layout = "";
  for (let pass = 0; pass < 8; pass++) {
    const previous = values;
    widgets = frontendWidgets(definition, (key) => previous.get(key));
    values = assign(widgets);
    const next = widgets.map((widget) => widget.name).join("\u0000");
    if (next === layout) break;
    layout = next;
  }
  return { widgets, values, persisted: widgets.filter((widget) => widget.persisted).length };
}

/** Values by position over the saved widgets, as the frontend restores them. */
function byPositionOf(
  widgets: readonly FrontendWidget[],
  saved: readonly JsonValue[],
): Map<string, JsonValue> {
  const values = new Map<string, JsonValue>();
  let position = 0;
  for (const widget of widgets) {
    if (!widget.persisted) continue;
    const value = saved[position++];
    if (widget.key !== undefined && value !== undefined) values.set(widget.key, value);
  }
  return values;
}

/** Values by widget name. */
function byNameOf(widgets: readonly FrontendWidget[], named: JsonObject): Map<string, JsonValue> {
  const values = new Map<string, JsonValue>();
  for (const widget of widgets) {
    if (widget.key === undefined || !widget.persisted) continue;
    if (Object.hasOwn(named, widget.name)) values.set(widget.key, named[widget.name] ?? null);
  }
  return values;
}

/** Whether values by name disagree with the ones restored by position. */
function disagree(restored: Settled, named: JsonObject): boolean {
  return restored.widgets.some(
    (widget) =>
      widget.key !== undefined &&
      widget.persisted &&
      Object.hasOwn(named, widget.name) &&
      stringify(named[widget.name] ?? null) !== stringify(restored.values.get(widget.key) ?? null),
  );
}

/**
 * `migrateWidgetsValues`: files from frontends before 1.16 saved a placeholder for every
 * `forceInput` input. Over the inputs that have a widget or are `forceInput`, in declaration
 * order (an explicit truthy `control_after_generate` counting a second entry), the placeholders
 * are dropped when the values line up with that list, with or without the unsaved widgets'.
 */
function migrate(definition: NodeDef, saved: readonly JsonValue[]): readonly JsonValue[] {
  const created = frontendWidgets(definition, () => undefined);
  const names = new Set(created.map((widget) => widget.name));
  const unsaved = new Set(created.filter((widget) => !widget.persisted).map((each) => each.name));
  const placeholders = definition.inputs
    .filter((input) => names.has(input.name) || isForced(input))
    .flatMap((input) => {
      if (unsaved.has(input.name)) return [];
      return explicitControl(input) ? [isForced(input), false] : [isForced(input)];
    });
  // The `upload` pseudo-input the upload extensions add sorts last.
  if (created.some((widget) => widget.name === "upload" && widget.key === undefined)) {
    placeholders.push(false);
  }
  const persisted = created.filter((widget) => widget.persisted).length;
  if (!placeholders.includes(true) && saved.length === persisted) return saved;
  const compacted = saved.filter((_, index) => created[index]?.persisted !== false);
  const aligned =
    compacted.length === placeholders.length
      ? compacted
      : saved.length === placeholders.length
        ? saved
        : undefined;
  return aligned === undefined ? saved : aligned.filter((_, index) => placeholders[index] !== true);
}

function isForced(input: InputDef): boolean {
  return (input.kind === "socket" || input.kind === "combo") && input.forceInput === true;
}

/** Whether the server states a `control_after_generate` that adds a control. */
function explicitControl(input: InputDef): boolean {
  switch (input.kind) {
    case "int":
    case "float":
    case "combo":
    case "socket":
      return controlOn(input.control);
    case "string":
    case "boolean":
    case "value":
    case "dynamicCombo":
    case "autogrow":
    case "dynamicGroup":
    case "matchType":
    case "unknown":
      return false;
  }
}

/**
 * Moves each link a saved input of its own target references to the slot of that name, as
 * `realignInputLinkSlots` does: in passes, a link whose slot isn't among its names moving to the
 * first; links that would land on a slot another link keeps are skipped, and a referenced link
 * whose names the node lacks gives way to one moving onto its slot.
 */
function realign(
  onto: Map<UiLink, string>,
  layout: readonly string[],
  node: UiNode,
  lookup: (id: number) => UiLink | undefined,
): void {
  const index = new Map(layout.map((name, at) => [name, at]));
  const referenced = new Map<UiLink, string[]>();
  for (const input of node.inputs) {
    if (input.link === undefined) continue;
    const link = lookup(input.link);
    if (link === undefined || link.targetId !== node.id || !onto.has(link)) continue;
    const names = referenced.get(link) ?? [];
    names.push(input.name);
    referenced.set(link, names);
  }
  const skipped = new Set<UiLink>();
  let passes = 0;
  while (passes < referenced.size) {
    const moved: { readonly link: UiLink; readonly name: string }[] = [];
    for (const [link, names] of referenced) {
      if (skipped.has(link) || !onto.has(link)) continue;
      const slots = layout.filter((name) => names.includes(name));
      const first = slots[0];
      if (first === undefined) continue;
      const current = onto.get(link) ?? "";
      const name = slots.includes(current) ? current : first;
      if (name !== current) moved.push({ link, name });
    }
    if (moved.length === 0) break;
    const unmatched = [...referenced]
      .filter(([link, names]) => onto.has(link) && !names.some((name) => index.has(name)))
      .map(([link]) => link);
    const destinations = new Set(moved.map(({ name }) => name));
    const removals = unmatched.filter((link) => destinations.has(onto.get(link) ?? ""));
    const participants = new Set([...moved.map(({ link }) => link), ...removals]);
    const occupant = new Map([...onto].map(([link, name]) => [name, link]));
    const blocked = moved.filter(({ name }) => {
      const there = occupant.get(name);
      return there !== undefined && !participants.has(there);
    });
    if (blocked.length > 0 || destinations.size < moved.length) {
      for (const { link } of blocked.length > 0 ? blocked : moved) skipped.add(link);
      continue;
    }
    passes++;
    for (const link of removals) onto.delete(link);
    for (const { link, name } of moved) onto.set(link, name);
  }
}

/**
 * Whether a saved input is named under a widget of the node as created, as dynamic-combo option
 * inputs are (`isGroupWidgetChildInput`).
 */
function isOptionChild(definition: NodeDef | undefined, name: string): boolean {
  const separator = name.lastIndexOf(".");
  if (definition === undefined || separator < 1) return false;
  const group = name.slice(0, separator);
  return frontendWidgets(definition, () => undefined).some((widget) => widget.name === group);
}

/** Whether the frontend sends a widget's value in the prompt. */
function sent(widget: FrontendWidget): boolean {
  const { input } = widget;
  if (input === undefined) return false;
  if (input.kind !== "value") return true;
  return (
    input.widget !== "RESOLUTION_PREVIEW" &&
    input.widget !== "CAMERA_INFO_STATE" &&
    input.widget !== "CAMERA_ANGLE_VIEW"
  );
}

/** `widgets_values` as a list: an array, or an object with a numeric `length` (array-like). */
function positionalValues(values: JsonValue | undefined): readonly JsonValue[] | undefined {
  if (Array.isArray(values)) return values as readonly JsonValue[];
  if (!isJsonObject(values) || typeof values["length"] !== "number") return undefined;
  const { length } = values;
  return Array.from(
    { length: Math.max(0, Math.floor(length)) },
    (_, at) => values[String(at)] ?? null,
  );
}

/** `widgets_values` saved as an object (VHS does), which the frontend reads by name. */
function isNamedValues(values: JsonValue | undefined): values is JsonObject {
  return isJsonObject(values) && typeof values["length"] !== "number";
}

/** A value for the wire: lists wrapped, since a bare list there is a link. */
function wrap(value: JsonValue): JsonValue {
  return Array.isArray(value) ? { __value__: value } : value;
}

/** A value as JavaScript's `value + ""` writes it. */
function jsString(value: JsonValue): string {
  if (value === null) return "";
  if (Array.isArray(value)) {
    return (value as readonly JsonValue[]).map((each) => jsString(each)).join(",");
  }
  if (typeof value === "object") return "[object Object]";
  return String(value);
}

function nodeKey(context: Context, id: Id): NodeId {
  return [...context.path, id].join(":");
}

/**
 * The frontend's execution order (`computeExecutionOrder`): nodes without linked inputs first,
 * in file order, then breadth-first along links in ascending id; nodes on cycles last, in object
 * key order (integer ids ascending first).
 */
function executionOrder(graph: UiGraph): Id[] {
  const waiting = new Map<Id, number>();
  for (const id of graph.order) waiting.set(id, graph.into.get(id)?.size ?? 0);
  const queue = graph.order.filter((id) => waiting.get(id) === 0);
  const order: Id[] = [];
  const seen = new Set<Id>();
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head];
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    order.push(id);
    const links = (graph.outgoing.get(id) ?? []).toSorted(
      (a, b) => a.originSlot - b.originSlot || a.id - b.id,
    );
    for (const link of links) {
      if (!graph.nodes.has(link.targetId)) continue;
      const left = (waiting.get(link.targetId) ?? 0) - 1;
      waiting.set(link.targetId, left);
      if (left === 0) queue.push(link.targetId);
    }
  }
  const rest = graph.order.filter((id) => !seen.has(id));
  const indices = rest.filter((id) => isArrayIndex(id)).toSorted((a, b) => Number(a) - Number(b));
  return [...order, ...indices, ...rest.filter((id) => !isArrayIndex(id))];
}

function isArrayIndex(key: string): boolean {
  return /^(?:0|[1-9][0-9]{0,9})$/.test(key) && Number(key) < 2 ** 32 - 1;
}

/** A node id as the frontend reads it: an integer or a non-empty string, as a string. */
function nodeIdOf(value: JsonValue | undefined): Id | undefined {
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : undefined;
  if (typeof value === "bigint") return String(value);
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** The number an id stands for, when it is one written plainly. */
function numericId(id: Id): number | undefined {
  const numeric = Number(id);
  return Number.isSafeInteger(numeric) && String(numeric) === id ? numeric : undefined;
}

function readUiNode(raw: JsonValue): UiNode | undefined {
  if (!isJsonObject(raw)) return undefined;
  const id = nodeIdOf(raw["id"]);
  const { type } = raw;
  if (id === undefined || typeof type !== "string") return undefined;
  const named = raw["widgets_values_named"];
  const title = raw["title"];
  const properties = raw["properties"];
  return {
    id,
    type,
    mode: numberOr(raw["mode"], 0),
    ...(typeof title === "string" ? { title } : {}),
    properties: isJsonObject(properties) ? properties : {},
    inputs: list(raw["inputs"]).flatMap((input) => {
      if (!isJsonObject(input) || typeof input["name"] !== "string") return [];
      const link = input["link"];
      return [{ name: input["name"], link: typeof link === "number" ? link : undefined }];
    }),
    values: raw["widgets_values"],
    named: isJsonObject(named) ? named : undefined,
  };
}

function readTupleLink(raw: JsonValue): UiLink | undefined {
  if (!Array.isArray(raw)) return undefined;
  const [id, originId, originSlot, targetId, targetSlot] = raw as readonly JsonValue[];
  return linkOf(id, originId, originSlot, targetId, targetSlot);
}

function readObjectLink(raw: JsonValue): UiLink | undefined {
  if (!isJsonObject(raw)) return undefined;
  return linkOf(
    raw["id"],
    raw["origin_id"],
    raw["origin_slot"],
    raw["target_id"],
    raw["target_slot"],
  );
}

function linkOf(
  id: JsonValue | undefined,
  origin: JsonValue | undefined,
  originSlot: JsonValue | undefined,
  target: JsonValue | undefined,
  targetSlot: JsonValue | undefined,
): UiLink | undefined {
  const originId = nodeIdOf(origin);
  const targetId = nodeIdOf(target);
  if (
    typeof id !== "number" ||
    originId === undefined ||
    typeof originSlot !== "number" ||
    targetId === undefined ||
    typeof targetSlot !== "number"
  ) {
    return undefined;
  }
  return { id, originId, originSlot, targetId, targetSlot };
}

function list(value: JsonValue | undefined): readonly JsonValue[] {
  return Array.isArray(value) ? (value as readonly JsonValue[]) : [];
}

/** Subgraph definitions, nested ones hoisted, in the frontend's order (`flattenSubgraphDefinitions`). */
function flattenDefinitions(source: JsonObject): JsonObject[] {
  const found: JsonObject[] = [];
  // Depth-first: a definition, then the ones nested in it, then its next sibling.
  const stack: { readonly items: readonly JsonValue[]; next: number }[] = [
    { items: nestedDefinitions(source), next: 0 },
  ];
  for (let frame = stack.at(-1); frame !== undefined; frame = stack.at(-1)) {
    const item = frame.items[frame.next++];
    if (item === undefined) {
      stack.pop();
      continue;
    }
    if (!isJsonObject(item)) continue;
    found.push(item);
    stack.push({ items: nestedDefinitions(item), next: 0 });
  }
  return found;
}

function nestedDefinitions(holder: JsonObject): readonly JsonValue[] {
  const definitions = holder["definitions"];
  return isJsonObject(definitions) ? list(definitions["subgraphs"]) : [];
}

function numberOr(value: JsonValue | undefined, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}
