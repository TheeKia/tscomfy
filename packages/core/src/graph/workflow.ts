import { namedOutputs } from "../schema/frontend.ts";
import type { TypedSchema } from "../schema/typed.ts";
import type { NodeDef } from "../schema/types.ts";
import type { BuildContext, Graph, GraphNode, InputValue, RawNode, Workflow } from "./graph.ts";
import { isOutputRef, outputRef, ownerOf } from "./output-ref.ts";
import type { NodeHandle, NodeId, NodeMode, Out } from "./types.ts";

/**
 * Builds a workflow: `build` calls node functions on `n`, which add nodes and
 * return their outputs, and `raw` for untyped nodes. The result is frozen; ids are `"1"`, `"2"`,
 * … in creation order unless set with `options.id`.
 *
 * Throws a `TypeError` for misuse the types can't catch: a duplicate or empty id, a node function
 * called after `build` returned or from an async `build`, an input value that isn't JSON or an
 * output reference of this workflow, or a sparse array.
 */
export function workflow<N>(
  schema: TypedSchema<N>,
  build: (context: BuildContext<N>) => void,
): Workflow<N> {
  const builder = new GraphBuilder<N>(schema);
  let returned: unknown;
  try {
    returned = build({
      n: builder.nodes(),
      raw: (classType, inputs, options) => builder.raw(classType, inputs, options),
    });
  } finally {
    builder.close();
  }
  // Nodes added after an `await` would come too late; refuse rather than build half a graph.
  if (isThenable(returned)) {
    throw new TypeError("workflow: the build function must be synchronous");
  }
  return Object.freeze({ schema, graph: builder.graph() });
}

/** A node given whole, as an importer reads it: its id, class, structured inputs and title. */
export interface AssembledNode {
  readonly id: NodeId;
  readonly classType: string;
  readonly inputs: { readonly [name: string]: InputValue };
  readonly title?: string;
  readonly raw: boolean;
  readonly mode?: NodeMode;
}

/**
 * Builds a workflow from whole nodes, for importers (not part of the package API). `build`
 * receives `link`, which makes an output reference of this workflow, to a node added before or
 * after, and returns the nodes in order. Throws a `TypeError` as {@link workflow} does.
 */
export function assembleWorkflow<N>(
  schema: TypedSchema<N>,
  build: (link: (node: NodeId, slot: number) => Out<string>) => readonly AssembledNode[],
): Workflow<N> {
  const builder = new GraphBuilder<N>(schema);
  try {
    for (const node of build((source, slot) => outputRef(builder, source, slot))) {
      builder.assemble(node);
    }
  } finally {
    builder.close();
  }
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
        // `n` is read-only: its functions come from the schema.
        set: () => false,
        defineProperty: () => false,
        deleteProperty: () => false,
      },
    );
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- N types exactly these functions
    return proxy as N;
  }

  raw(classType: string, inputs: unknown, options: unknown): RawNode {
    const id = this.#add(classType, inputs, options, true);
    return Object.freeze({
      id,
      output: (slot: number) => {
        if (!Number.isSafeInteger(slot) || slot < 0) {
          throw new TypeError(`workflow: output slot ${String(slot)} is not a slot index`);
        }
        return outputRef<"*">(this, id, slot);
      },
    });
  }

  close(): void {
    this.#open = false;
  }

  assemble(node: AssembledNode): void {
    if (node.id === "" || this.#nodes.has(node.id)) {
      throw new TypeError(`workflow: node id ${JSON.stringify(node.id)} is empty or taken`);
    }
    this.#nodes.set(
      node.id,
      Object.freeze({
        id: node.id,
        classType: node.classType,
        inputs: freezeInputs(node.inputs, this),
        ...(node.title === undefined ? {} : { title: node.title }),
        raw: node.raw,
        ...(node.mode === undefined ? {} : { mode: node.mode }),
      }),
    );
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
      result(this, definition, this.#add(classType, inputs, options, false));
    this.#functions.set(classType, created);
    return created;
  }

  #add(classType: string, inputs: unknown, options: unknown, raw: boolean): NodeId {
    if (!this.#open) {
      throw new TypeError("workflow: a node was added after the build function returned");
    }
    const { id: requested, title, mode } = readOptions(options);
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
        inputs: freezeInputs(inputs, this),
        ...(title === undefined ? {} : { title }),
        raw,
        ...(mode === undefined ? {} : { mode }),
      }),
    );
    return id;
  }
}

/** What a node function returns (§6.2): a handle, one output, or a tuple with named members. */
function result(owner: object, definition: NodeDef, id: NodeId): unknown {
  const { outputs } = definition;
  if (outputs.length === 0) return Object.freeze({ id } satisfies NodeHandle);
  if (outputs.length === 1) return outputRef(owner, id, 0);
  const refs: unknown[] = outputs.map((output) => outputRef(owner, id, output.index));
  for (const [name, slot] of namedOutputs(outputs)) {
    Object.defineProperty(refs, name, { value: refs[slot], enumerable: true });
  }
  Object.defineProperty(refs, "id", { value: id, enumerable: true });
  return Object.freeze(refs);
}

function readOptions(options: unknown): {
  readonly id?: NodeId;
  readonly title?: string;
  readonly mode?: NodeMode;
} {
  if (options === undefined) return {};
  if (typeof options !== "object" || options === null) {
    throw new TypeError("workflow: node options must be an object");
  }
  const id: unknown = Reflect.get(options, "id");
  const title: unknown = Reflect.get(options, "title");
  const mode: unknown = Reflect.get(options, "mode");
  if (mode !== undefined && mode !== "bypass" && mode !== "mute") {
    throw new TypeError('workflow: options.mode must be "bypass" or "mute"');
  }
  if (id !== undefined && typeof id !== "string")
    throw new TypeError("workflow: options.id must be a string");
  if (title !== undefined && typeof title !== "string") {
    throw new TypeError("workflow: options.title must be a string");
  }
  return {
    ...(id === undefined ? {} : { id }),
    ...(title === undefined ? {} : { title }),
    ...(mode === undefined ? {} : { mode }),
  };
}

/** A frozen copy of the given inputs; `undefined` values are left out, as if not given. */
function freezeInputs(inputs: unknown, owner: object): { readonly [name: string]: InputValue } {
  if (inputs === undefined) return Object.freeze({});
  if (!isPlainObject(inputs)) throw new TypeError("workflow: node inputs must be a plain object");
  const entries: [string, InputValue][] = [];
  for (const [name, value] of Object.entries(inputs)) {
    if (value !== undefined) entries.push([name, freezeValue(value, name, owner)]);
  }
  return Object.freeze(Object.fromEntries(entries));
}

function freezeValue(value: unknown, path: string, owner: object): InputValue {
  if (isOutputRef(value)) {
    // A reference into another workflow would silently link to whatever has its id here.
    if (ownerOf(value) !== owner) {
      throw new TypeError(`workflow: input ${path} is an output of another workflow`);
    }
    return value;
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (Number.isFinite(value)) return value;
    throw new TypeError(`workflow: input ${path} is ${String(value)}, which has no JSON form`);
  }
  if (Array.isArray(value)) {
    const items: InputValue[] = [];
    for (let index = 0; index < value.length; index++) {
      const where = `${path}[${String(index)}]`;
      // A hole would serialize as invalid JSON, or silently skip an Autogrow slot.
      if (!(index in value)) throw new TypeError(`workflow: input ${where} is a hole in an array`);
      items.push(freezeValue(value[index], where, owner));
    }
    return Object.freeze(items);
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value).flatMap(([key, item]): [string, InputValue][] =>
      item === undefined ? [] : [[key, freezeValue(item, `${path}.${key}`, owner)]],
    );
    return Object.freeze(Object.fromEntries(entries));
  }
  throw new TypeError(`workflow: input ${path} must be JSON or an output reference`);
}

function isThenable(value: unknown): boolean {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof Reflect.get(value, "then") === "function"
  );
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
