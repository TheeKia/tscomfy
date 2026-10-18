// Reading a UI workflow file (docs/plan.md §11): its root graph and subgraph definitions, read
// defensively, with node ids reminted as the frontend remints them (`LGraph.configure`,
// `subgraphDeduplication.ts`, `recordUnambiguousRemint`, `dropSameOwnerDuplicates`). Nothing here
// knows node definitions.

import { isJsonArray, isJsonObject, type JsonObject, type JsonValue } from "../../json/value.ts";
import type { Report } from "./report.ts";

/** A node id as the frontend keys it (`toNodeId`): `4` and `"4"` are the same node. */
export type Id = string;

/** A link of a UI graph. */
export interface UiLink {
  readonly id: number;
  readonly originId: Id;
  readonly originSlot: number;
  readonly targetId: Id;
  readonly targetSlot: number;
}

/** A node of a UI graph, as saved. */
export interface UiNode {
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

/** A graph as the file holds it: the root, or a subgraph definition's interior. */
export interface GraphFile {
  /** The definition's id; empty for the root. */
  readonly key: string;
  /** Where its nodes are in the file, for diagnostics: `[]`, or the definition's. */
  readonly prefix: readonly (string | number)[];
  readonly nodes: ReadonlyMap<Id, UiNode>;
  /** Node ids in file order. */
  readonly order: readonly Id[];
  /** Every link read, by id. */
  readonly links: ReadonlyMap<number, UiLink>;
}

/** An input or output of a subgraph definition. */
export interface Boundary {
  readonly name: string;
  readonly type: string;
  readonly linkIds: readonly number[];
}

/** A subgraph definition as the file holds it. */
export interface DefinitionFile {
  readonly id: string;
  readonly name: string;
  readonly graph: GraphFile;
  readonly inputs: readonly Boundary[];
  readonly outputs: readonly Boundary[];
}

/** A UI file's graphs. */
export interface UiFile {
  readonly root: GraphFile;
  /** Subgraph definitions by id, in file order. */
  readonly definitions: ReadonlyMap<string, DefinitionFile>;
  /** The definitions in dependency order: each after the ones it instantiates. */
  readonly ordered: readonly DefinitionFile[];
}

/**
 * The graphs of a UI file. Inner ids that collide with the root's, or with an earlier
 * definition's, are reminted first (`normalizeSubgraphDefinitions`); then root nodes, a repeated
 * id reminted as the node is added. `undefined` when a definition contains itself, which makes
 * the frontend refuse the whole file (reported).
 */
export function readUiFile(file: JsonObject, report: Report): UiFile | undefined {
  const minter = new IdMinter(file);
  const reserved = new Set<Id>();
  for (const raw of list(file["nodes"])) {
    const id = isJsonObject(raw) ? nodeIdOf(raw["id"]) : undefined;
    if (id === undefined) continue;
    reserved.add(id);
    minter.reserve(id);
  }
  const definitions = new Map<string, DefinitionFile>();
  for (const raw of flattenDefinitions(file)) {
    const id = raw["id"];
    if (typeof id !== "string" || definitions.has(id)) continue;
    definitions.set(id, readDefinition(id, raw, reserved, minter, report));
  }
  const root = readGraph(file, file["version"] === 0.4, [], "", "remint", minter, report);
  const ordered = orderDefinitions(definitions, report);
  return ordered === undefined ? undefined : { root, definitions, ordered };
}

/**
 * The frontend's node id counter (`state.lastNodeId`) and the numeric ids taken: new ids are the
 * next free number after the counter (`mintNodeId`), in the order nodes are added.
 */
class IdMinter {
  readonly #used = new Set<number>();
  #counter: number;

  constructor(file: JsonObject) {
    this.#counter = numberOr(file["last_node_id"], 0);
    const state = file["state"];
    if (isJsonObject(state)) {
      this.#counter = Math.max(this.#counter, numberOr(state["lastNodeId"], 0));
    }
  }

  /** Marks an id taken without moving the counter: a root id, seen before definitions mint. */
  reserve(id: Id): void {
    const numeric = numericId(id);
    if (numeric !== undefined) this.#used.add(numeric);
  }

  /** Marks an id taken, moving the counter past it. */
  observe(id: Id): void {
    const numeric = numericId(id);
    if (numeric === undefined) return;
    this.#used.add(numeric);
    if (numeric >= 0 && numeric > this.#counter) this.#counter = numeric;
  }

  /** The next id after the counter that `taken` doesn't hold, and globally unused when asked. */
  next(taken: (id: number) => boolean): Id {
    let id = this.#counter + 1;
    while (taken(id)) id++;
    this.#counter = id;
    return String(id);
  }

  /** The next id after the counter that no graph uses yet; it is then taken. */
  fresh(): Id {
    const id = this.next((taken) => this.#used.has(taken));
    this.#used.add(Number(id));
    return id;
  }
}

/**
 * A graph's nodes and links, read defensively. In a definition a repeated node id keeps the
 * first node (`dropSameOwnerDuplicates`); at the root the later one gets a fresh id, and links
 * follow it when no other node asked for that id (`recordUnambiguousRemint`).
 */
function readGraph(
  source: JsonObject,
  tuples: boolean,
  prefix: readonly (string | number)[],
  key: string,
  repeated: "drop" | "remint",
  minter: IdMinter,
  report: Report,
  renames: ReadonlyMap<Id, Id> = new Map(),
): GraphFile {
  const nodes = new Map<Id, UiNode>();
  const order: Id[] = [];
  const requested = new Map<Id, number>();
  for (const raw of list(source["nodes"])) {
    const id = isJsonObject(raw) ? nodeIdOf(raw["id"]) : undefined;
    if (id !== undefined) requested.set(id, (requested.get(id) ?? 0) + 1);
  }
  const reminted = new Map<Id, Id>();
  for (const [index, raw] of list(source["nodes"]).entries()) {
    const read = readUiNode(raw);
    if (read === undefined) {
      report(
        "E_INVALID_WORKFLOW",
        [...prefix, "nodes", index],
        "This node can't be read (it needs an id and a type); dropping it.",
      );
      continue;
    }
    let node: UiNode = { ...read, id: renames.get(read.id) ?? read.id };
    if (nodes.has(node.id)) {
      if (repeated === "drop") continue;
      const fresh = minter.next((id) => nodes.has(String(id)));
      if (requested.get(node.id) === 1) reminted.set(node.id, fresh);
      node = { ...node, id: fresh };
    } else if (repeated === "remint") {
      minter.observe(node.id);
    }
    nodes.set(node.id, node);
    order.push(node.id);
  }
  const links = new Map<number, UiLink>();
  for (const [index, raw] of list(source["links"]).entries()) {
    const read = tuples ? readTupleLink(raw) : readObjectLink(raw);
    if (read === undefined) {
      if (!tuples && isJsonArray(raw)) {
        report(
          "E_INVALID_WORKFLOW",
          [...prefix, "links", index],
          "A tuple link outside format 0.4, which the frontend drops; dropping it.",
        );
      } else if (raw !== null) {
        report(
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
      originId: renames.get(read.originId) ?? reminted.get(read.originId) ?? read.originId,
      targetId: renames.get(read.targetId) ?? reminted.get(read.targetId) ?? read.targetId,
    });
  }
  return { key, prefix, nodes, order, links };
}

/** A subgraph definition, with inner ids that collide with ones seen earlier reminted. */
function readDefinition(
  id: string,
  raw: JsonObject,
  used: Set<Id>,
  minter: IdMinter,
  report: Report,
): DefinitionFile {
  const renames = new Map<Id, Id>();
  const seen = new Set<Id>();
  for (const node of list(raw["nodes"])) {
    const nodeId = isJsonObject(node) ? nodeIdOf(node["id"]) : undefined;
    if (nodeId === undefined || seen.has(nodeId)) continue;
    seen.add(nodeId);
    if (used.has(nodeId)) {
      const fresh = minter.fresh();
      renames.set(nodeId, fresh);
      used.add(fresh);
    } else {
      used.add(nodeId);
      minter.observe(nodeId);
    }
  }
  const graph = readGraph(
    raw,
    false,
    ["definitions", "subgraphs", id],
    id,
    "drop",
    minter,
    report,
    renames,
  );
  const boundaries = (key: string): Boundary[] =>
    list(raw[key]).flatMap((each): Boundary[] => {
      if (!isJsonObject(each)) return [];
      return [
        {
          name: typeof each["name"] === "string" ? each["name"] : "",
          type: typeof each["type"] === "string" ? each["type"] : "*",
          linkIds: list(each["linkIds"]).filter((link): link is number => typeof link === "number"),
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

/**
 * The definitions in dependency order, each after the ones it instantiates. A definition that
 * contains itself, directly or not, makes the frontend refuse the whole file: `undefined`.
 */
function orderDefinitions(
  definitions: ReadonlyMap<string, DefinitionFile>,
  report: Report,
): DefinitionFile[] | undefined {
  const state = new Map<DefinitionFile, "open" | "done">();
  const ordered: DefinitionFile[] = [];
  for (const start of definitions.values()) {
    if (state.has(start)) continue;
    const stack: { readonly definition: DefinitionFile; readonly inner: DefinitionFile[] }[] = [];
    const open = (definition: DefinitionFile): void => {
      state.set(definition, "open");
      const inner = definition.graph.order.flatMap((id) => {
        const type = definition.graph.nodes.get(id)?.type;
        const found = type === undefined ? undefined : definitions.get(type);
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
        report(
          "E_INVALID_WORKFLOW",
          ["definitions", "subgraphs", next.id],
          `Subgraph ${next.name} contains itself, so the frontend refuses to load the file; importing nothing.`,
        );
        return undefined;
      }
      open(next);
    }
  }
  return ordered;
}

/** A node id as the frontend reads it: an integer or a non-empty string, as a string. */
function nodeIdOf(value: JsonValue | undefined): Id | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : undefined;
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
  if (!isJsonArray(raw)) return undefined;
  const [id, originId, originSlot, targetId, targetSlot] = raw;
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

/** A value as a list: itself when it is one, else empty. */
function list(value: JsonValue | undefined): readonly JsonValue[] {
  return isJsonArray(value) ? value : [];
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
