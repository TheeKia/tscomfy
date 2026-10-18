import type { TypedSchema } from "../schema/typed.ts";
import type { NodeHandle, NodeId, NodeMode, NodeOptions, Out } from "./types.ts";

/**
 * A value in a node's inputs, as the builder records it: structured, with dynamic inputs nested
 * (`{ option, inputs }`, slot lists, group rows) rather than flattened to wire keys. Flattening is
 * the exporter's job.
 */
export type InputValue =
  | string
  | number
  | bigint
  | boolean
  | null
  | Out<string>
  | readonly InputValue[]
  | { readonly [key: string]: InputValue };

/** One node of a graph. */
export interface GraphNode {
  readonly id: NodeId;
  readonly classType: string;
  /** Structured inputs, keyed by input name, in the order they were given. */
  readonly inputs: { readonly [name: string]: InputValue };
  /** Sent as `_meta.title` instead of the display name. */
  readonly title?: string;
  /**
   * Added with `raw`, or imported as raw (`W_IMPORTED_AS_RAW`): inputs are wire keys, exported as
   * given, without schema rules.
   */
  readonly raw: boolean;
  /** Bypassed or muted; absent for a node that runs. */
  readonly mode?: NodeMode;
}

/** The nodes of a workflow, in creation order: build order, or the order an importer read them. */
export interface Graph {
  readonly nodes: ReadonlyMap<NodeId, GraphNode>;
}

/**
 * A built workflow: its schema, its graph, and the handles its build function returned. Frozen
 * (the handles are kept as returned). `H` defaults to `unknown`, so `Workflow<N>` accepts a
 * workflow with any handles.
 */
export interface Workflow<N = unknown, H = unknown> {
  readonly schema: TypedSchema<N>;
  readonly graph: Graph;
  /**
   * What the build function of {@link workflow} returned, usually an object of node handles:
   * `return { save }`. `undefined` when it returned nothing, and for imported workflows. Graph
   * operations keep it, since they keep node ids.
   */
  readonly handles: H;
}

/** A node added with {@link BuildContext.raw}: its id, and untyped access to its outputs. */
export interface RawNode extends NodeHandle {
  /** Output `slot`, typed `*` because nothing is known about it. */
  output(slot: number): Out<"*">;
}

/**
 * Adds a node without types: any class type, inputs keyed by their wire names. The escape hatch
 * for nodes the schema doesn't know or the types can't express.
 */
export type RawBuilder = (
  classType: string,
  inputs?: { readonly [key: string]: InputValue },
  options?: NodeOptions,
) => RawNode;

/** What the build function of {@link workflow} receives. */
export interface BuildContext<N> {
  /** One function per node class, typed by the generated `Nodes` interface. */
  readonly n: N;
  /** Untyped nodes. Kept apart from `n`, so no class type can collide with it. */
  readonly raw: RawBuilder;
}
