// What the frontend writes into widgets before it builds a prompt (docs/plan.md §11): a
// PrimitiveNode's value into the widgets it links to (`widgetInputs.ts` `applyToGraph`), and
// `%Node.widget%` references in save nodes' file names (`applyTextReplacements`).

import { frontendWidgets } from "../../frontend/node.ts";
import { fileNameSafe, replaceText, SAVE_NODES } from "../../frontend/text.ts";
import { isJsonArray, type JsonValue } from "../../json/value.ts";
import { SEARCH_NAME_PROPERTY } from "../format.ts";
import type { Id, UiNode } from "./file.ts";
import { classOf, type Graph, type Loaded, type NodeIn } from "./graph.ts";
import { fixedUp, positionalValues } from "./widget-values.ts";

const REPLACE_PROPERTY = "Run widget replace on values";
/** The titles the frontend gives its own nodes (`rerouteNode.ts`, `widgetInputs.ts`, `noteNode.ts`). */
const FRONTEND_TITLES: ReadonlyMap<string, string> = new Map([
  ["Reroute", "Reroute"],
  ["PrimitiveNode", "Primitive"],
  ["Note", "Note"],
  ["MarkdownNote", "Markdown Note"],
]);
/** A PrimitiveNode's widgets, by position in its `widgets_values`. */
const PRIMITIVE_WIDGETS = ["value", "control_after_generate"] as const;

/**
 * PrimitiveNode (`applyToGraph`): writes its value into every widget it links to, whatever its
 * mode, after `%…%` replacement when its `Run widget replace on values` property is on, in
 * `order`. Into a subgraph's promoted input the value is lost, as in the frontend (reported).
 */
export function applyPrimitives(
  loaded: Loaded,
  graph: Graph,
  order: readonly Id[],
  text: TextReplacer,
): void {
  const { file, placement } = graph;
  for (const id of order) {
    const primitive = file.nodes.get(id);
    if (primitive?.type !== "PrimitiveNode") continue;
    let value = positionalValues(primitive.values)?.[0] ?? primitive.named?.["value"];
    if (value === undefined) continue;
    if (
      typeof value === "string" &&
      value !== "" &&
      primitive.properties[REPLACE_PROPERTY] === true
    ) {
      value = text.replace(value, graph, [...file.prefix, primitive.id]);
    }
    for (const link of placement.outgoing.get(primitive.id) ?? []) {
      if (link.originSlot !== 0) continue;
      const target = file.nodes.get(link.targetId);
      const name = placement.names.get(link.id);
      if (target === undefined || name === undefined) continue;
      if (loaded.subgraphs.has(target.type)) {
        loaded.report(
          "W_FRONTEND_QUIRK",
          [...file.prefix, primitive.id],
          "A PrimitiveNode linked to a subgraph's promoted input doesn't reach it, as in the frontend.",
        );
        continue;
      }
      graph.values.get(target.id)?.values.set(name, value);
    }
  }
}

/** Save nodes' `filename_prefix`, with `%Node.widget%` replaced as the frontend sends it. */
export function replaceFileNames(graph: Graph, root: Graph, text: TextReplacer): void {
  const { file } = graph;
  for (const id of file.order) {
    const node = file.nodes.get(id);
    if (node === undefined || !SAVE_NODES.has(node.type)) continue;
    const values = graph.values.get(id)?.values;
    const prefix = values?.get("filename_prefix");
    if (values === undefined || typeof prefix !== "string" || !prefix.includes("%")) continue;
    values.set(
      "filename_prefix",
      text.replace(prefix, root, [...file.prefix, id, "filename_prefix"]),
    );
  }
}

/**
 * `applyTextReplacements`: `%Node.widget%` becomes the widget's value, the node found by its
 * `Node name for S&R` property, else its title, first in the frontend's node order (interiors
 * before their instance). `%date:…%` is the queue time, which can't be reproduced (reported).
 */
export class TextReplacer {
  readonly #loaded: Loaded;
  readonly #lookups = new Map<
    Graph,
    { readonly search: ReadonlyMap<string, NodeIn>; readonly title: ReadonlyMap<string, NodeIn> }
  >();

  constructor(loaded: Loaded) {
    this.#loaded = loaded;
  }

  /** `text` with its references replaced, looking nodes up under `scope`. */
  replace(text: string, scope: Graph, path: readonly (string | number)[]): string {
    const seen = { dated: false };
    const replaced = replaceText(text, (pattern, match) => {
      if (pattern.kind === "date") seen.dated = true;
      if (pattern.kind !== "widget") return match;
      const lookup = this.#lookup(scope);
      const found = lookup.search.get(pattern.node) ?? lookup.title.get(pattern.node);
      if (found === undefined) return match;
      const value = this.#widgetValue(found, pattern.widget);
      return value === undefined ? match : fileNameSafe(jsString(value));
    });
    if (seen.dated) {
      this.#loaded.report(
        "W_QUEUE_TIME_VALUE",
        path,
        "This file name holds %date:…%, which the frontend replaces with the time it queues the prompt; it is sent as written.",
      );
    }
    return replaced;
  }

  /** The first node under a graph by search name and by title, built once per graph. */
  #lookup(scope: Graph): {
    readonly search: ReadonlyMap<string, NodeIn>;
    readonly title: ReadonlyMap<string, NodeIn>;
  } {
    const known = this.#lookups.get(scope);
    if (known !== undefined) return known;
    const search = new Map<string, NodeIn>();
    const title = new Map<string, NodeIn>();
    for (const entry of this.#allNodes(scope)) {
      const name = this.#searchName(entry.node);
      if (name !== undefined && !search.has(name)) search.set(name, entry);
      const shown = this.#title(entry.node);
      if (!title.has(shown)) title.set(shown, entry);
    }
    const built = { search, title };
    this.#lookups.set(scope, built);
    return built;
  }

  /** Every node under a graph, interiors before their instance (`mapAllNodes`). */
  #allNodes(scope: Graph): NodeIn[] {
    const found: NodeIn[] = [];
    const stack: { readonly graph: Graph; next: number; readonly instance?: NodeIn }[] = [
      { graph: scope, next: 0 },
    ];
    for (let frame = stack.at(-1); frame !== undefined; frame = stack.at(-1)) {
      const id = frame.graph.file.order[frame.next++];
      if (id === undefined) {
        stack.pop();
        if (frame.instance !== undefined) found.push(frame.instance);
        continue;
      }
      const node = frame.graph.file.nodes.get(id);
      if (node === undefined) continue;
      const subgraph = this.#loaded.subgraphs.get(node.type);
      if (subgraph === undefined) found.push({ graph: frame.graph, node });
      else stack.push({ graph: subgraph.graph, next: 0, instance: { graph: frame.graph, node } });
    }
    return found;
  }

  #searchName(node: UiNode): string | undefined {
    const given = node.properties[SEARCH_NAME_PROPERTY];
    if (typeof given === "string") return given;
    // Added at creation to every node of a server class but the save nodes.
    return classOf(this.#loaded, node.type) !== undefined && !SAVE_NODES.has(node.type)
      ? node.type
      : undefined;
  }

  #title(node: UiNode): string {
    if (node.title !== undefined) return node.title;
    return (
      classOf(this.#loaded, node.type)?.displayName ??
      this.#loaded.subgraphs.get(node.type)?.name ??
      FRONTEND_TITLES.get(node.type) ??
      node.type
    );
  }

  /** A widget's value by its name, for `%Node.widget%`, after the load-time fixups. */
  #widgetValue({ graph, node }: NodeIn, name: string): JsonValue | undefined {
    if (node.type === "PrimitiveNode") {
      const at = PRIMITIVE_WIDGETS.findIndex((each) => each === name);
      if (at === -1) return undefined;
      const value = positionalValues(node.values)?.[at] ?? node.named?.[name];
      if (value === undefined) return null;
      return at === 0 ? value : fixedUp(node.type, { name, role: "control" }, value);
    }
    const definition = classOf(this.#loaded, node.type);
    const restored = graph.values.get(node.id);
    if (definition === undefined || restored === undefined) return undefined;
    const widget = frontendWidgets(definition, (key) => restored.values.get(key)).find(
      (each) => each.name === name,
    );
    if (widget === undefined) return undefined;
    // A control or a button: its saved value, else the one it was created with.
    if (widget.key === undefined) return restored.extras.get(name) ?? widget.initial;
    return restored.values.get(widget.key) ?? null;
  }
}

/** A value as JavaScript's `value + ""` writes it. */
function jsString(value: JsonValue): string {
  if (value === null) return "";
  if (isJsonArray(value)) return value.map((each) => jsString(each)).join(",");
  if (typeof value === "object") return "[object Object]";
  return String(value);
}
