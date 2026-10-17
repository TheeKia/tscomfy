import { namedOutputs } from "../schema/frontend.ts";
import type { TypedSchema } from "../schema/typed.ts";
import type { NodeDef } from "../schema/types.ts";
import type { BuildContext, Graph, GraphNode, InputValue, RawNode, Workflow } from "./graph.ts";
import { isOutputRef, outputRef } from "./output-ref.ts";
import type { NodeHandle, NodeId } from "./types.ts";

/**
 * Builds a workflow (docs/plan.md §7): `build` calls node functions on `n`, which add nodes and
 * return their outputs, and `raw` for untyped nodes. The result is frozen; ids are `"1"`, `"2"`,
 * … in creation order unless set with `options.id`.
 *
 * Throws a `TypeError` for misuse the types can't catch: a duplicate or empty id, a node function
 * called after `build` returned, or an input value that isn't JSON or an output reference.
 */
export function workflow<N>(
  schema: TypedSchema<N>,
  build: (context: BuildContext<N>) => void,
): Workflow<N> {
  const builder = new GraphBuilder<N>(schema);
  build({
    n: builder.nodes(),
    raw: (classType, inputs, options) => builder.raw(classType, inputs, options),
  });
  builder.close();
  return Object.freeze({ schema, graph: builder.graph() });
}

class GraphBuilder<N> {
  readonly #schema: TypedSchema<N>;
  readonly #nodes = new Map<NodeId, GraphNode>();
  readonly #functions = new Map<string, (inputs?: unknown, options?: unknown) => unknown>();
  #next = 1;
  #open = true;

  constructor(schema: TypedSchema<N>) {
    this.#schema = schema;
  }

  /**
   * `n`: a function per class type, created on first use. A proxy, so a schema of thousands of
   * nodes costs nothing up front; unknown names read as `undefined`.
   */
  nodes(): N {
    const proxy = new Proxy(
      {},
      {
        get: (_target, key) => (typeof key === "string" ? this.#function(key) : undefined),
        has: (_target, key) => typeof key === "string" && Object.hasOwn(this.#schema.nodes, key),
      },
    );
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- N types exactly these functions
    return proxy as N;
  }

  raw(classType: string, inputs: unknown, options: unknown): RawNode {
    const id = this.#add(classType, inputs, options, true);
    return Object.freeze({ id, output: (slot: number) => outputRef<"*">(id, slot) });
  }

  close(): void {
    this.#open = false;
  }

  graph(): Graph {
    return Object.freeze({ nodes: new ReadonlyNodeMap(this.#nodes) });
  }

  #function(classType: string): ((inputs?: unknown, options?: unknown) => unknown) | undefined {
    const existing = this.#functions.get(classType);
    if (existing !== undefined) return existing;
    if (!Object.hasOwn(this.#schema.nodes, classType)) return undefined;
    const definition = this.#schema.nodes[classType];
    if (definition === undefined) return undefined;
    const created = (inputs?: unknown, options?: unknown): unknown =>
      result(definition, this.#add(classType, inputs, options, false));
    this.#functions.set(classType, created);
    return created;
  }

  #add(classType: string, inputs: unknown, options: unknown, raw: boolean): NodeId {
    if (!this.#open) {
      throw new TypeError("workflow: a node was added after the build function returned");
    }
    const { id: requested, title } = readOptions(options);
    let id: NodeId;
    if (requested === undefined) {
      while (this.#nodes.has(String(this.#next))) this.#next++;
      id = String(this.#next++);
    } else {
      if (requested === "" || this.#nodes.has(requested)) {
        throw new TypeError(`workflow: node id ${JSON.stringify(requested)} is empty or taken`);
      }
      id = requested;
    }
    this.#nodes.set(
      id,
      Object.freeze({
        id,
        classType,
        inputs: freezeInputs(inputs),
        ...(title === undefined ? {} : { title }),
        raw,
      }),
    );
    return id;
  }
}

/** What a node function returns (§6.2): a handle, one output, or a tuple with named members. */
function result(definition: NodeDef, id: NodeId): unknown {
  const { outputs } = definition;
  if (outputs.length === 0) return Object.freeze({ id } satisfies NodeHandle);
  if (outputs.length === 1) return outputRef(id, 0);
  const refs: unknown[] = outputs.map((output) => outputRef(id, output.index));
  for (const [name, slot] of namedOutputs(outputs)) {
    Object.defineProperty(refs, name, { value: refs[slot], enumerable: true });
  }
  Object.defineProperty(refs, "id", { value: id, enumerable: true });
  return Object.freeze(refs);
}

function readOptions(options: unknown): { readonly id?: NodeId; readonly title?: string } {
  if (options === undefined) return {};
  if (typeof options !== "object" || options === null) {
    throw new TypeError("workflow: node options must be an object");
  }
  const id: unknown = Reflect.get(options, "id");
  const title: unknown = Reflect.get(options, "title");
  if (id !== undefined && typeof id !== "string")
    throw new TypeError("workflow: options.id must be a string");
  if (title !== undefined && typeof title !== "string") {
    throw new TypeError("workflow: options.title must be a string");
  }
  return { ...(id === undefined ? {} : { id }), ...(title === undefined ? {} : { title }) };
}

/** A frozen copy of the given inputs; `undefined` values are left out, as if not given. */
function freezeInputs(inputs: unknown): { readonly [name: string]: InputValue } {
  if (inputs === undefined) return Object.freeze({});
  if (!isPlainObject(inputs)) throw new TypeError("workflow: node inputs must be a plain object");
  const entries: [string, InputValue][] = [];
  for (const [name, value] of Object.entries(inputs)) {
    if (value !== undefined) entries.push([name, freezeValue(value, name)]);
  }
  return Object.freeze(Object.fromEntries(entries));
}

function freezeValue(value: unknown, path: string): InputValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "bigint" ||
    isOutputRef(value)
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (Number.isFinite(value)) return value;
    throw new TypeError(`workflow: input ${path} is ${String(value)}, which has no JSON form`);
  }
  if (Array.isArray(value)) {
    return Object.freeze(
      value.map((item: unknown, index) => freezeValue(item, `${path}[${String(index)}]`)),
    );
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value).flatMap(([key, item]): [string, InputValue][] =>
      item === undefined ? [] : [[key, freezeValue(item, `${path}.${key}`)]],
    );
    return Object.freeze(Object.fromEntries(entries));
  }
  throw new TypeError(`workflow: input ${path} must be JSON or an output reference`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * The graph's nodes, read-only for real: not a `Map` subclass, whose contents
 * `Map.prototype.set.call` could still change, but a view over a private one.
 */
class ReadonlyNodeMap implements ReadonlyMap<NodeId, GraphNode> {
  readonly #map: Map<NodeId, GraphNode>;

  constructor(entries: Iterable<readonly [NodeId, GraphNode]>) {
    this.#map = new Map(entries);
    Object.freeze(this);
  }

  get size(): number {
    return this.#map.size;
  }

  get(key: NodeId): GraphNode | undefined {
    return this.#map.get(key);
  }

  has(key: NodeId): boolean {
    return this.#map.has(key);
  }

  forEach(
    callback: (value: GraphNode, key: NodeId, map: ReadonlyMap<NodeId, GraphNode>) => void,
    thisArg?: unknown,
  ): void {
    for (const [key, value] of this.#map) callback.call(thisArg, value, key, this);
  }

  entries(): MapIterator<[NodeId, GraphNode]> {
    return this.#map.entries();
  }

  keys(): MapIterator<NodeId> {
    return this.#map.keys();
  }

  values(): MapIterator<GraphNode> {
    return this.#map.values();
  }

  [Symbol.iterator](): MapIterator<[NodeId, GraphNode]> {
    return this.#map[Symbol.iterator]();
  }
}
