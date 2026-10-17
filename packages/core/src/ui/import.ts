// UI workflow → Workflow (docs/plan.md §11): what the ComfyUI frontend would queue for a saved
// workflow, as a graph. Frontend 1.55.17, read as a specification (`LGraph.configure`,
// `ComfyNode.configure`, `graphToPrompt`, `ExecutableNodeDTO`, `SubgraphNode`):
// - nodes are rebuilt from their definitions: widget values restored by name or position, links
//   placed on the input that references them;
// - what a graph of ours can't hold is resolved here, as the frontend resolves it when it builds a
//   prompt: Reroute nodes, PrimitiveNode values, subgraph boundaries and promoted values, and the
//   mode of a subgraph instance;
// - real nodes keep their links and modes (bypass, mute), which the exporter then applies.
// So `toApi(importUi(x))` is the prompt the frontend builds for `x`.

import { type Link, wireNode, type WireNode } from "../api/import.ts";
import { bypassSlot } from "../api/modes.ts";
import { createDiagnostic, type Diagnostic } from "../diagnostic/diagnostic.ts";
import type { Workflow } from "../graph/graph.ts";
import type { NodeId, NodeMode } from "../graph/types.ts";
import { assembleWorkflow, type AssembledNode } from "../graph/workflow.ts";
import { parse } from "../json/parse.ts";
import { stringify } from "../json/stringify.ts";
import { isJsonObject, type JsonObject, type JsonValue } from "../json/value.ts";
import type { TypedSchema } from "../schema/typed.ts";
import type { NodeDef } from "../schema/types.ts";
import { frontendSlots, frontendWidgets, type FrontendWidget } from "./frontend.ts";

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
 * except where pack JavaScript changes it at queue time (date substitutions, injected links) and
 * for nodes of classes the schema doesn't have, which the frontend sends without a class.
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

/** A link of a UI graph. */
interface UiLink {
  readonly id: number;
  readonly originId: number;
  readonly originSlot: number;
  readonly targetId: number;
  readonly targetSlot: number;
}

/** A node of a UI graph, as saved. */
interface UiNode {
  readonly id: number;
  readonly type: string;
  readonly mode: number;
  readonly title?: string;
  /** Saved inputs: their names, and the link each references. */
  readonly inputs: readonly { readonly name: string; readonly link: number | undefined }[];
  readonly values: JsonValue | undefined;
  readonly named: JsonObject | undefined;
}

/** A graph: the root, or a subgraph definition's interior. */
interface UiGraph {
  readonly nodes: ReadonlyMap<number, UiNode>;
  /** Node ids in file order. */
  readonly order: readonly number[];
  readonly links: ReadonlyMap<number, UiLink>;
  /** Links by target node, then by the name of the input they land on; filled once all
   * definitions are read, since an instance's slots come from its definition. */
  readonly into: Map<number, Map<string, UiLink>>;
}

/** A subgraph definition. */
interface Definition {
  readonly id: string;
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
  readonly path: readonly number[];
  /** The instance this graph is the interior of, and the context that instance sits in. */
  readonly instance?: {
    readonly node: UiNode;
    readonly definition: Definition;
    readonly outer: Context;
  };
}

/** What a link resolves to: a link to a node we keep, a promoted value, or nothing. */
type Resolved =
  | { readonly link: readonly [NodeId, number] }
  | { readonly value: JsonValue }
  | undefined;

const MUTE = 2;
const BYPASS = 4;
const SUBGRAPH_INPUT = -10;
/** Frontend-only nodes: resolved through, or dropped. */
const VIRTUAL: ReadonlySet<string> = new Set(["Reroute", "PrimitiveNode", "Note", "MarkdownNote"]);

class UiReader {
  readonly #file: JsonObject;
  readonly #schema: TypedSchema<unknown>;
  readonly #diagnostics: Diagnostic[];
  readonly #definitions = new Map<string, Definition>();
  /** Restored widget values by node: in a context, `path:id`. */
  readonly #values = new Map<string, Map<string, JsonValue>>();

  constructor(file: JsonObject, schema: TypedSchema<unknown>, diagnostics: Diagnostic[]) {
    this.#file = file;
    this.#schema = schema;
    this.#diagnostics = diagnostics;
  }

  read(link: Link): AssembledNode[] {
    const version = this.#file["version"];
    const tuples = version === 0.4;
    const reserved = new Set<number>();
    const root = this.#graph(this.#file, tuples, []);
    for (const id of root.order) reserved.add(id);
    let counter = numberOr(this.#file["last_node_id"], 0);
    const state = this.#file["state"];
    if (isJsonObject(state)) counter = Math.max(counter, numberOr(state["lastNodeId"], 0));
    for (const raw of flattenDefinitions(this.#file)) {
      const definition = this.#definition(
        raw,
        reserved,
        () => ++counter,
        (id) => {
          counter = Math.max(counter, id);
        },
      );
      if (definition !== undefined) this.#definitions.set(definition.id, definition);
    }
    for (const graph of [root, ...[...this.#definitions.values()].map((each) => each.graph)]) {
      for (const [target, inputs] of placeLinks(graph.nodes, graph.links, (node) =>
        this.#slotNames(node),
      )) {
        graph.into.set(target, inputs);
      }
    }
    const top: Context = { graph: root, path: [] };
    // Widget values everywhere first: PrimitiveNodes write into them before anything resolves.
    const contexts = this.#contexts(top);
    for (const context of contexts) this.#restore(context);
    for (const context of contexts) this.#primitives(context);
    const nodes: AssembledNode[] = [];
    for (const { context, node } of this.#emitted(top)) {
      nodes.push(wireNode(this.#wire(context, node), this.#schema, link, this.#diagnostics));
    }
    return nodes;
  }

  /** A graph's nodes and links, read defensively; `prefix` is the path of a diagnostic. */
  #graph(source: JsonObject, tuples: boolean, prefix: readonly (string | number)[]): UiGraph {
    const nodes = new Map<number, UiNode>();
    const order: number[] = [];
    const rawNodes = source["nodes"];
    for (const [index, raw] of (Array.isArray(rawNodes)
      ? (rawNodes as readonly JsonValue[])
      : []
    ).entries()) {
      const node = readUiNode(raw);
      if (node === undefined || nodes.has(node.id)) {
        this.#report(
          "E_INVALID_WORKFLOW",
          [...prefix, "nodes", index],
          "This node can't be read, or its id is taken; dropping it.",
        );
        continue;
      }
      nodes.set(node.id, node);
      order.push(node.id);
    }
    const links = new Map<number, UiLink>();
    const rawLinks = source["links"];
    for (const [index, raw] of (Array.isArray(rawLinks)
      ? (rawLinks as readonly JsonValue[])
      : []
    ).entries()) {
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
      if (!links.has(read.id)) links.set(read.id, read);
    }
    return { nodes, order, links, into: new Map() };
  }

  /** A subgraph definition, with ids that collide with ones seen earlier reminted (§11). */
  #definition(
    raw: JsonObject,
    used: Set<number>,
    next: () => number,
    observe: (id: number) => void,
  ): Definition | undefined {
    const id = raw["id"];
    if (typeof id !== "string") return undefined;
    // Remint first, on the raw definition, so links and boundaries follow.
    const renames = new Map<number, number>();
    const rawNodes = raw["nodes"];
    for (const node of Array.isArray(rawNodes) ? (rawNodes as readonly JsonValue[]) : []) {
      const nodeId = isJsonObject(node) ? node["id"] : undefined;
      if (typeof nodeId !== "number") continue;
      if (used.has(nodeId)) {
        const fresh = next();
        renames.set(nodeId, fresh);
        used.add(fresh);
      } else {
        used.add(nodeId);
        observe(nodeId);
      }
    }
    const renamed = renames.size === 0 ? raw : renumber(raw, renames);
    const graph = this.#graph(renamed, false, ["definitions", "subgraphs", id]);
    const boundaries = (key: string): Boundary[] => {
      const list = renamed[key];
      return (Array.isArray(list) ? (list as readonly JsonValue[]) : []).flatMap(
        (each): Boundary[] => {
          if (!isJsonObject(each)) return [];
          const linkIds = each["linkIds"];
          return [
            {
              name: typeof each["name"] === "string" ? each["name"] : "",
              type: typeof each["type"] === "string" ? each["type"] : "*",
              linkIds: (Array.isArray(linkIds) ? (linkIds as readonly JsonValue[]) : []).filter(
                (link): link is number => typeof link === "number",
              ),
            },
          ];
        },
      );
    };
    return { id, graph, inputs: boundaries("inputs"), outputs: boundaries("outputs") };
  }

  /** Every context: the root and the interior of every instance, whatever its mode. */
  #contexts(top: Context): Context[] {
    const contexts: Context[] = [];
    const pending: Context[] = [top];
    for (let context = pending.pop(); context !== undefined; context = pending.pop()) {
      contexts.push(context);
      if (context.path.length > 32) continue;
      for (const id of context.graph.order) {
        const node = context.graph.nodes.get(id);
        const definition = node === undefined ? undefined : this.#definitions.get(node.type);
        if (node !== undefined && definition !== undefined) {
          pending.push({
            graph: definition.graph,
            path: [...context.path, node.id],
            instance: { node, definition, outer: context },
          });
        }
      }
    }
    return contexts;
  }

  /**
   * The nodes the prompt holds, in the frontend's order (`graphToPrompt`): the root in execution
   * order, each instance's interior after it in its definition's node order, depth-first. A muted
   * or bypassed instance at the top isn't expanded; one nested inside another is (a frontend
   * quirk, reported).
   */
  #emitted(top: Context): { readonly context: Context; readonly node: UiNode }[] {
    const result: { context: Context; node: UiNode }[] = [];
    const visit = (context: Context, ids: readonly number[]): void => {
      for (const id of ids) {
        const node = context.graph.nodes.get(id);
        if (node === undefined) continue;
        const definition = this.#definitions.get(node.type);
        if (definition !== undefined) {
          const off = node.mode === MUTE || node.mode === BYPASS;
          if (off && context.path.length === 0) continue;
          if (off) {
            this.#report(
              "W_FRONTEND_QUIRK",
              [...context.path.map(String), String(node.id)],
              "A muted or bypassed subgraph inside another subgraph still sends its interior, as the frontend does.",
            );
          }
          if (context.path.length > 32) continue;
          visit(
            {
              graph: definition.graph,
              path: [...context.path, node.id],
              instance: { node, definition, outer: context },
            },
            definition.graph.order,
          );
          continue;
        }
        if (VIRTUAL.has(node.type)) continue;
        if (this.#definitionOf(node.type) === undefined && !linked(context.graph, node.id)) {
          // Unknown to the schema and linked to nothing: a pack's frontend-only node (a label, a
          // group toggle), which the frontend never sends, or a missing class, which only makes
          // the backend reject the prompt. Either way it changes nothing else.
          this.#report(
            "W_IMPORTED_AS_RAW",
            [nodeKey(context, node.id)],
            `Node ${nodeKey(context, node.id)} has class ${node.type}, which the schema doesn't have, and no links; leaving it out.`,
          );
          continue;
        }
        result.push({ context, node });
      }
    };
    visit(top, executionOrder(top.graph));
    return result;
  }

  /** Restores the widget values of every node of a context (§11), by name or by position. */
  #restore(context: Context): void {
    for (const id of context.graph.order) {
      const node = context.graph.nodes.get(id);
      const definition = node === undefined ? undefined : this.#definitionOf(node.type);
      if (node === undefined || definition === undefined) continue;
      this.#values.set(nodeKey(context, node.id), this.#widgetValues(context, node, definition));
    }
  }

  /** A node's widget values, by wire key, with the frontend's load-time fixups. */
  #widgetValues(context: Context, node: UiNode, definition: NodeDef): Map<string, JsonValue> {
    const values = new Map<string, JsonValue>();
    const chosen = (key: string): JsonValue | undefined => values.get(key);
    // Positional values move as dynamic-combo options add widgets: settle the layout first.
    let widgets: FrontendWidget[] = [];
    for (let pass = 0; pass < 8; pass++) {
      widgets = frontendWidgets(definition, chosen);
      const before = stringify([...values]);
      assign(widgets, node, values);
      if (stringify([...values]) === before && pass > 0) break;
    }
    const persisted = widgets.filter((widget) => widget.persisted).length;
    if (
      node.named === undefined &&
      Array.isArray(node.values) &&
      node.values.length !== persisted
    ) {
      this.#report(
        "W_WIDGET_VALUES_MISMATCH",
        [...context.path.map(String), String(node.id), "widgets_values"],
        `Node ${String(node.id)} (${node.type}) saves ${String(node.values.length)} widget values where its definition has ${String(persisted)}: a pack's own widgets, or a file older than its definition. Values are read by position.`,
      );
    }
    for (const widget of widgets) {
      const { input, key } = widget;
      if (input === undefined || key === undefined) continue;
      // A widget without a saved value keeps the one it was created with.
      if (!values.has(key)) values.set(key, widget.initial);
      const value = values.get(key);
      // A combo saved as null takes its first option.
      if (input.kind === "combo" && (value === null || value === undefined) && widget.persisted) {
        const first = input.options[0];
        if (first !== undefined && value === null) values.set(key, first);
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
   * PrimitiveNode (`applyToGraph`): writes its value into every widget it links to, whatever its
   * mode. Into a subgraph's promoted input the value is lost, as in the frontend (reported).
   */
  #primitives(context: Context): void {
    for (const id of context.graph.order) {
      const primitive = context.graph.nodes.get(id);
      if (primitive?.type !== "PrimitiveNode") continue;
      const value = Array.isArray(primitive.values)
        ? (primitive.values as readonly JsonValue[])[0]
        : undefined;
      if (value === undefined) continue;
      for (const link of context.graph.links.values()) {
        if (link.originId !== primitive.id || link.originSlot !== 0) continue;
        const target = context.graph.nodes.get(link.targetId);
        if (target === undefined) continue;
        const name = [...(context.graph.into.get(target.id) ?? [])].find(
          ([, each]) => each.id === link.id,
        )?.[0];
        if (name === undefined) continue;
        if (this.#definitions.has(target.type)) {
          this.#report(
            "W_FRONTEND_QUIRK",
            [...context.path.map(String), String(primitive.id)],
            "A PrimitiveNode linked to a subgraph's promoted input doesn't reach it, as in the frontend.",
          );
          continue;
        }
        this.#values.get(nodeKey(context, target.id))?.set(name, value);
      }
    }
  }

  /** A node to keep, as the wire carries it: widget values, then resolved links. */
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
      // Unknown to the schema: the frontend sends it without a class; keep it raw, with the
      // values it saved by name, and its links.
      this.#report(
        "W_IMPORTED_AS_RAW",
        [id],
        `Node ${id} has class ${node.type}, which the schema doesn't have; it is kept raw, with ${node.named === undefined ? "its links only" : "its named widget values and links"}.`,
      );
      for (const [name, value] of Object.entries(node.named ?? {}))
        inputs.push([name, wrap(value)]);
    } else {
      const values = this.#values.get(id) ?? new Map<string, JsonValue>();
      for (const widget of frontendWidgets(definition, (key) => values.get(key))) {
        if (widget.key === undefined || widget.input === undefined || !sent(widget)) continue;
        const value = values.get(widget.key);
        if (value !== undefined) inputs.push([widget.key, wrap(value)]);
      }
    }
    for (const [name, link] of context.graph.into.get(node.id) ?? []) {
      const resolved = this.#resolveLink(
        context,
        link,
        this.#slotType(context, node, name),
        new Set(),
      );
      if (resolved === undefined) continue;
      const value =
        "link" in resolved ? [resolved.link[0], resolved.link[1]] : wrap(resolved.value);
      const at = inputs.findIndex(([key]) => key === name);
      if (at === -1) inputs.push([name, value]);
      else inputs[at] = [name, value];
    }
    return { ...base, inputs: Object.fromEntries(inputs) };
  }

  /** `resolveInput` for a link that lands in `context`. */
  #resolveLink(context: Context, link: UiLink, type: string, seen: Set<string>): Resolved {
    if (link.originId === SUBGRAPH_INPUT) {
      const instance = context.instance;
      if (instance === undefined) return undefined;
      const boundary = instance.definition.inputs[link.originSlot];
      if (boundary === undefined) return undefined;
      const outer = instance.outer.graph.into.get(instance.node.id)?.get(boundary.name);
      if (outer !== undefined) return this.#resolveLink(instance.outer, outer, boundary.type, seen);
      const promoted = this.#promoted(
        instance.outer,
        instance.node,
        instance.definition,
        link.originSlot,
      );
      return promoted === undefined ? undefined : { value: promoted };
    }
    return this.#resolveOutput(context, link.originId, link.originSlot, type, seen, link);
  }

  /** `resolveOutput`: where output `slot` of node `id` of `context` leads. */
  #resolveOutput(
    context: Context,
    id: number,
    slot: number,
    type: string,
    seen: Set<string>,
    via: UiLink,
  ): Resolved {
    const step = `${context.path.join(":")}|${String(id)}|${String(slot)}`;
    const node = context.graph.nodes.get(id);
    if (node === undefined || seen.has(step)) {
      // The frontend refuses to build the prompt for either.
      this.#report(
        "W_UNRESOLVED_LINK",
        [...context.path.map(String), "links", via.id],
        node === undefined
          ? `Link ${String(via.id)} comes from node ${String(id)}, which the graph doesn't have; dropping it.`
          : `Link ${String(via.id)} loops back on itself through node ${String(id)}; dropping it.`,
      );
      return undefined;
    }
    seen.add(step);
    const definition = this.#definitions.get(node.type);
    if (definition !== undefined)
      return this.#resolveInstance(context, node, definition, slot, type, seen);
    switch (node.type) {
      case "Reroute": {
        if (node.mode === MUTE) return undefined;
        const input = context.graph.into.get(node.id)?.values().next().value;
        if (input === undefined) return undefined;
        // A bypassed Reroute passes on no type.
        return this.#resolveLink(context, input, node.mode === BYPASS ? "*" : type, seen);
      }
      case "PrimitiveNode":
      case "Note":
      case "MarkdownNote":
        return undefined;
      default:
        // A node we keep: its own mode, if any, is applied when the prompt is built.
        return { link: [nodeKey(context, node.id), slot] };
    }
  }

  /** An output of a subgraph instance: through its interior, or by its mode. */
  #resolveInstance(
    context: Context,
    node: UiNode,
    definition: Definition,
    slot: number,
    type: string,
    seen: Set<string>,
  ): Resolved {
    if (node.mode === MUTE) return undefined;
    if (node.mode === BYPASS) {
      const output = definition.outputs[slot]?.type ?? "*";
      const index = bypassSlot(definition.inputs, output, slot, type);
      const boundary = index === -1 ? undefined : definition.inputs[index];
      const link =
        boundary === undefined ? undefined : context.graph.into.get(node.id)?.get(boundary.name);
      return link === undefined
        ? undefined
        : this.#resolveLink(context, link, boundary?.type ?? "*", seen);
    }
    const boundary = definition.outputs[slot];
    const inner = boundary?.linkIds
      .map((id) => definition.graph.links.get(id))
      .find((link) => link !== undefined);
    if (inner === undefined) return undefined;
    const interior: Context = {
      graph: definition.graph,
      path: [...context.path, node.id],
      instance: { node, definition, outer: context },
    };
    return this.#resolveOutput(interior, inner.originId, inner.originSlot, type, seen, inner);
  }

  /**
   * The promoted value of input `index` of an instance (`SubgraphNode`): an input promotes the
   * first widget its links reach inside; its value is the instance's saved value for it (one per
   * promoting input, in input order), else the interior widget's own.
   */
  #promoted(
    context: Context,
    node: UiNode,
    definition: Definition,
    index: number,
  ): JsonValue | undefined {
    const promoting = definition.inputs.map((_, each) =>
      this.#promotedWidget(context, node, definition, each),
    );
    const own = promoting[index];
    if (own === undefined) return undefined;
    const position = promoting.slice(0, index).filter((each) => each !== undefined).length;
    const saved = Array.isArray(node.values)
      ? (node.values as readonly JsonValue[])[position]
      : undefined;
    return saved ?? own.value;
  }

  /** The widget input `index` of an instance promotes, and the interior value it starts from. */
  #promotedWidget(
    context: Context,
    node: UiNode,
    definition: Definition,
    index: number,
  ): { readonly value: JsonValue | undefined } | undefined {
    const interior: Context = {
      graph: definition.graph,
      path: [...context.path, node.id],
      instance: { node, definition, outer: context },
    };
    for (const id of definition.inputs[index]?.linkIds ?? []) {
      const link = definition.graph.links.get(id);
      const target = link === undefined ? undefined : definition.graph.nodes.get(link.targetId);
      if (link === undefined || target === undefined) continue;
      const name = [...(definition.graph.into.get(target.id) ?? [])].find(
        ([, each]) => each.id === link.id,
      )?.[0];
      if (name === undefined) continue;
      const nested = this.#definitions.get(target.type);
      if (nested !== undefined) {
        const at = nested.inputs.findIndex((input) => input.name === name);
        if (at !== -1 && this.#promotedWidget(interior, target, nested, at) !== undefined) {
          return { value: this.#promoted(interior, target, nested, at) };
        }
        continue;
      }
      const targetDefinition = this.#definitionOf(target.type);
      const widget =
        targetDefinition === undefined
          ? undefined
          : frontendWidgets(targetDefinition, () => undefined).find((each) => each.key === name);
      if (widget !== undefined)
        return { value: this.#values.get(nodeKey(interior, target.id))?.get(name) };
    }
    return undefined;
  }

  /** The names of a node's slots in the frontend's order, for links that name no input. */
  #slotNames(node: UiNode): readonly string[] {
    const definition = this.#definitionOf(node.type);
    const saved = node.inputs.map((input) => input.name);
    if (definition === undefined) {
      const instance = this.#definitions.get(node.type);
      return instance === undefined ? saved : instance.inputs.map((input) => input.name);
    }
    const linkedNames = new Set(
      node.inputs.filter((input) => input.link !== undefined).map((input) => input.name),
    );
    const values = valuesByName(node);
    const fresh = frontendSlots(
      definition,
      (key) => values.get(key),
      (key, input) => {
        let chain = 0;
        while (chain < input.slots.length && linkedNames.has(`${key}.${input.slots[chain] ?? ""}`))
          chain++;
        return Math.min(input.slots.length, Math.max(input.min + 1, 1, chain + 1));
      },
    ).map((slot) => slot.name);
    const known = new Set(fresh);
    return [...fresh, ...saved.filter((name) => !known.has(name))];
  }

  #slotType(context: Context, node: UiNode, name: string): string {
    const definition = this.#definitionOf(node.type);
    if (definition === undefined) {
      return (
        this.#definitions.get(node.type)?.inputs.find((input) => input.name === name)?.type ?? "*"
      );
    }
    const values = this.#values.get(nodeKey(context, node.id));
    const slots = frontendSlots(
      definition,
      (key) => values?.get(key),
      () => Number.POSITIVE_INFINITY,
    );
    return slots.find((slot) => slot.name === name)?.type ?? "*";
  }

  #definitionOf(type: string): NodeDef | undefined {
    return Object.hasOwn(this.#schema.nodes, type) ? this.#schema.nodes[type] : undefined;
  }

  #report(
    code: Parameters<typeof createDiagnostic>[0],
    path: readonly (string | number)[],
    message: string,
  ): void {
    this.#diagnostics.push(createDiagnostic(code, path, message));
  }
}

/** Whether any link of a graph starts or ends at a node. */
function linked(graph: UiGraph, id: number): boolean {
  for (const link of graph.links.values())
    if (link.originId === id || link.targetId === id) return true;
  return false;
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

/**
 * Assigns saved values to widgets: by name from `widgets_values_named` when the file has it
 * (exact, whatever widgets packs add), else by position over the persisted widgets, as the
 * frontend restores them.
 */
function assign(
  widgets: readonly FrontendWidget[],
  node: UiNode,
  values: Map<string, JsonValue>,
): void {
  if (node.named !== undefined) {
    for (const widget of widgets) {
      if (widget.key === undefined || !widget.persisted) continue;
      if (Object.hasOwn(node.named, widget.name))
        values.set(widget.key, node.named[widget.name] ?? null);
    }
    return;
  }
  const saved = Array.isArray(node.values) ? (node.values as readonly JsonValue[]) : [];
  let position = 0;
  for (const widget of widgets) {
    if (!widget.persisted) continue;
    const value = saved[position++];
    if (widget.key !== undefined && value !== undefined) values.set(widget.key, value);
  }
}

/** Values by widget name, for choosing dynamic-combo options before the full restore. */
function valuesByName(node: UiNode): ReadonlyMap<string, JsonValue> {
  return new Map(Object.entries(node.named ?? {}));
}

/** A value for the wire: lists wrapped, since a bare list there is a link. */
function wrap(value: JsonValue): JsonValue {
  return Array.isArray(value) ? { __value__: value } : value;
}

function nodeKey(context: Context, id: number): NodeId {
  return [...context.path, id].join(":");
}

/**
 * The frontend's execution order (`computeExecutionOrder`): nodes without linked inputs first,
 * in file order, then breadth-first along links in ascending id; nodes on cycles last.
 */
function executionOrder(graph: UiGraph): number[] {
  const waiting = new Map<number, number>();
  for (const id of graph.order) waiting.set(id, graph.into.get(id)?.size ?? 0);
  const outgoing = new Map<number, UiLink[]>();
  for (const link of graph.links.values()) {
    const list = outgoing.get(link.originId);
    if (list === undefined) outgoing.set(link.originId, [link]);
    else list.push(link);
  }
  const queue = graph.order.filter((id) => waiting.get(id) === 0);
  const order: number[] = [];
  const seen = new Set<number>();
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head];
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    order.push(id);
    const links = (outgoing.get(id) ?? []).toSorted(
      (a, b) => a.originSlot - b.originSlot || a.id - b.id,
    );
    for (const link of links) {
      if (!graph.nodes.has(link.targetId)) continue;
      const left = (waiting.get(link.targetId) ?? 0) - 1;
      waiting.set(link.targetId, left);
      if (left === 0) queue.push(link.targetId);
    }
  }
  const rest = graph.order.filter((id) => !seen.has(id)).toSorted((a, b) => a - b);
  return [...order, ...rest];
}

/**
 * Each link placed on the input it lands on: the saved input that references it, by name, else
 * the slot at its `target_slot` (`realignInputLinkSlots`). The first link to a slot wins.
 */
function placeLinks(
  nodes: ReadonlyMap<number, UiNode>,
  links: ReadonlyMap<number, UiLink>,
  slots: (node: UiNode) => readonly string[],
): Map<number, Map<string, UiLink>> {
  const into = new Map<number, Map<string, UiLink>>();
  const named = new Map<number, string>();
  for (const node of nodes.values()) {
    for (const input of node.inputs)
      if (input.link !== undefined) named.set(input.link, input.name);
  }
  const slotNames = new Map<number, readonly string[]>();
  for (const link of links.values()) {
    const target = nodes.get(link.targetId);
    if (target === undefined) continue;
    let name = named.get(link.id);
    if (name === undefined) {
      let names = slotNames.get(target.id);
      if (names === undefined) {
        names = slots(target);
        slotNames.set(target.id, names);
      }
      name = names[link.targetSlot];
    }
    if (name === undefined) continue;
    const map = into.get(target.id) ?? new Map<string, UiLink>();
    if (!map.has(name) || named.get(link.id) === name) map.set(name, link);
    into.set(target.id, map);
  }
  return into;
}

function readUiNode(raw: JsonValue): UiNode | undefined {
  if (!isJsonObject(raw)) return undefined;
  const { id, type } = raw;
  if (typeof id !== "number" || typeof type !== "string") return undefined;
  const inputs = Array.isArray(raw["inputs"]) ? (raw["inputs"] as readonly JsonValue[]) : [];
  const named = raw["widgets_values_named"];
  const title = raw["title"];
  return {
    id,
    type,
    mode: numberOr(raw["mode"], 0),
    ...(typeof title === "string" ? { title } : {}),
    inputs: inputs.flatMap((input) => {
      if (!isJsonObject(input) || typeof input["name"] !== "string") return [];
      const link = input["link"];
      return [{ name: input["name"], link: typeof link === "number" ? link : undefined }];
    }),
    values: raw["widgets_values"],
    named: isJsonObject(named) ? named : undefined,
  };
}

function readTupleLink(raw: JsonValue): UiLink | undefined {
  if (!isList(raw)) return undefined;
  const [id, originId, originSlot, targetId, targetSlot] = raw;
  if (
    typeof id !== "number" ||
    typeof originId !== "number" ||
    typeof originSlot !== "number" ||
    typeof targetId !== "number" ||
    typeof targetSlot !== "number"
  ) {
    return undefined;
  }
  return { id, originId, originSlot, targetId, targetSlot };
}

function isList(value: JsonValue | undefined): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function readObjectLink(raw: JsonValue): UiLink | undefined {
  if (!isJsonObject(raw)) return undefined;
  const {
    id,
    origin_id: originId,
    origin_slot: originSlot,
    target_id: targetId,
    target_slot: targetSlot,
  } = raw;
  if (
    typeof id !== "number" ||
    typeof originId !== "number" ||
    typeof originSlot !== "number" ||
    typeof targetId !== "number" ||
    typeof targetSlot !== "number"
  ) {
    return undefined;
  }
  return { id, originId, originSlot, targetId, targetSlot };
}

/** Subgraph definitions, nested ones hoisted, in the frontend's order (`flattenSubgraphDefinitions`). */
function flattenDefinitions(source: JsonObject): JsonObject[] {
  const found: JsonObject[] = [];
  const visit = (holder: JsonObject): void => {
    const definitions = holder["definitions"];
    const list = isJsonObject(definitions) ? definitions["subgraphs"] : undefined;
    for (const each of Array.isArray(list) ? (list as readonly JsonValue[]) : []) {
      if (!isJsonObject(each)) continue;
      found.push(each);
      visit(each);
    }
  };
  visit(source);
  return found;
}

/** A definition with node ids renamed in its nodes and links. */
function renumber(raw: JsonObject, renames: ReadonlyMap<number, number>): JsonObject {
  const rename = (value: JsonValue | undefined): JsonValue | undefined =>
    typeof value === "number" ? (renames.get(value) ?? value) : value;
  /** An object with the ids under `keys` renamed, key order kept. */
  const renamed = (value: JsonValue, keys: readonly string[]): JsonValue =>
    isJsonObject(value)
      ? Object.fromEntries(
          Object.entries(value).map(([key, each]) => [
            key,
            keys.includes(key) ? (rename(each) ?? null) : each,
          ]),
        )
      : value;
  const list = (key: string): readonly JsonValue[] =>
    Array.isArray(raw[key]) ? (raw[key] as readonly JsonValue[]) : [];
  return {
    ...raw,
    nodes: list("nodes").map((node) => renamed(node, ["id"])),
    links: list("links").map((link) => renamed(link, ["origin_id", "target_id"])),
  };
}

function numberOr(value: JsonValue | undefined, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}
