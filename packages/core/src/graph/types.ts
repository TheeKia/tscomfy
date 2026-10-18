// The type surface generated node types are written against (docs/plan.md §6.2, D9). The runtime
// values behind it (OutputRef, node handles) come with the builder.

/** A node's id in a prompt: `"1"`, `"2"`, … unless set explicitly. */
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
 * backend accepts `*` on either side.
 */
export type In<T extends string> = Out<T | "*">;

/**
 * The link type of a MatchType input after the first one of its template: the inferred
 * type or `*`, or any output when the template was inferred as `*`.
 */
export type Match<T extends string> = "*" extends T ? string : T | "*";

/**
 * The socket type tscomfy gives an output that is a list of combo options. The backend
 * connects one only into an input typed exactly `COMBO` or `*`, so it needs a name of its own:
 * a plain `COMBO` output also fits comma unions that contain `COMBO`.
 */
export type OptionList = "COMBO (option list)";

/**
 * A list type of a limited length: `T` with `length` one of `L`. Generated types use it
 * for Autogrow slots and DynamicGroup rows, whose count the backend bounds.
 */
export type Bounded<T extends readonly unknown[], L extends number> = T & { readonly length: L };

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
  /**
   * `"bypass"`: the node isn't sent, and links through it reroute to one of its inputs, as the
   * frontend's bypass does. `"mute"`: the node isn't sent. An input whose link then resolves to
   * nothing is left out, or, for a widget, sends the widget's value instead.
   */
  readonly mode?: NodeMode;
}

/** How a node takes part in a prompt, besides normally. */
export type NodeMode = "bypass" | "mute";
