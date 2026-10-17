// The type surface generated node types are written against (docs/plan.md §6.2, D9). The runtime
// values behind it (OutputRef, node handles) come with the builder.

/** A node's id in a prompt: `"1"`, `"2"`, … unless set explicitly (§7.3). */
export type NodeId = string;

declare const socketType: unique symbol;

/**
 * A reference to output `slot` of node `node`, carrying the socket type `T` it produces. Branded,
 * so a plain `[id, slot]` tuple or an object of the right shape can't pass for one, and
 * covariant, so `Out<"MODEL">` fits wherever `Out<"MODEL" | "*">` is expected.
 */
export interface Out<out T extends string> {
  readonly [socketType]: T;
  readonly node: NodeId;
  readonly slot: number;
}

/**
 * What a socket of type `T` accepts: an output of type `T`, or an any-typed (`*`) output. The
 * backend accepts `*` on either side (§5.2).
 */
export type In<T extends string> = Out<T | "*">;

/**
 * The link type of a MatchType input after the first one of its template (§6.3): the inferred
 * type or `*`, or any output when the template was inferred as `*`.
 */
export type Match<T extends string> = "*" extends T ? string : T | "*";

/**
 * The socket type tscomfy gives an output that is a list of combo options (§5.2). The backend
 * connects one only into an input typed exactly `COMBO` or `*`, so it needs a name of its own:
 * a plain `COMBO` output also fits comma unions that contain `COMBO`.
 */
export type OptionList = "COMBO (option list)";

/** What a node without outputs returns. */
export interface NodeHandle {
  readonly id: NodeId;
}

/** Per-node options, the second argument of every node function. */
export interface NodeOptions {
  /** An explicit id instead of the next sequential one. */
  readonly id?: NodeId;
  /** Sent as `_meta.title`. */
  readonly title?: string;
}
