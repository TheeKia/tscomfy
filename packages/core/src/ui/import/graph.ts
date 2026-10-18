// The graphs of a UI file once loaded: what the file holds, the widget values restored, and where
// the links landed. The steps of `importUi` (`../import.ts`) build these in order.

import { definitionOf } from "../../schema/lookup.ts";
import type { NodeDef, Schema } from "../../schema/types.ts";
import type { Boundary, GraphFile, Id, UiNode } from "./file.ts";
import type { Placement } from "./placement.ts";
import type { Report } from "./report.ts";
import type { RestoredValues } from "./widget-values.ts";

/** A graph once loaded: the root, or a subgraph definition's interior. */
export interface Graph {
  readonly file: GraphFile;
  /**
   * Restored widget values by node; the same for every instance of a definition. PrimitiveNodes
   * and file-name replacement then write into them, as the frontend does before it builds a
   * prompt.
   */
  readonly values: ReadonlyMap<Id, RestoredValues>;
  readonly placement: Placement;
}

/** A subgraph definition once loaded. */
export interface Subgraph {
  readonly id: string;
  readonly name: string;
  readonly graph: Graph;
  readonly inputs: readonly Boundary[];
  readonly outputs: readonly Boundary[];
}

/** Everything the later steps read. */
export interface Loaded {
  readonly schema: Schema;
  readonly root: Graph;
  /** Subgraph definitions by id. */
  readonly subgraphs: ReadonlyMap<string, Subgraph>;
  /** The definitions in dependency order: each after the ones it instantiates. */
  readonly ordered: readonly Subgraph[];
  /** Whether a type is a legacy group node (`workflow>Name` with `extra.groupNodes[Name]`). */
  readonly groupNode: (type: string) => boolean;
  readonly report: Report;
}

/** Where a node sits: the graph, and the instances it is nested in. */
export interface Context {
  readonly graph: Graph;
  /** Instance ids from the root, which prefix inner ids: `40:31:21`. */
  readonly path: readonly Id[];
  /** The instance this graph is the interior of, and the context that instance sits in. */
  readonly instance?: {
    readonly node: UiNode;
    readonly subgraph: Subgraph;
    readonly outer: Context;
  };
}

/** A node and the graph it is in. */
export interface NodeIn {
  readonly graph: Graph;
  readonly node: UiNode;
}

/** The schema's definition of a node's class, if it has one. */
export function classOf(loaded: Loaded, type: string): NodeDef | undefined {
  return definitionOf(loaded.schema, type);
}

/** A node's id in the prompt: its instance path and its own id, joined with `:`. */
export function nodeKey(context: Context, id: Id): string {
  return [...context.path, id].join(":");
}

/** Frontend-only nodes: resolved through, or dropped. */
export const VIRTUAL_NODES: ReadonlySet<string> = new Set([
  "Reroute",
  "PrimitiveNode",
  "Note",
  "MarkdownNote",
]);

/** Where a subgraph's input links come from: node `-10` of the definition. */
export const SUBGRAPH_INPUT = "-10";
