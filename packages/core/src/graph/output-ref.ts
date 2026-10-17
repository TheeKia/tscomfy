import type { NodeId, Out } from "./types.ts";

/**
 * The runtime value behind {@link Out}: output `slot` of node `node`. Frozen, and only created by
 * the builder, so a look-alike object or a raw `[id, slot]` tuple is never mistaken for one.
 */
class OutputRef {
  readonly node: NodeId;
  readonly slot: number;

  constructor(node: NodeId, slot: number) {
    this.node = node;
    this.slot = slot;
    Object.freeze(this);
  }
}

/** The builder each reference came from, so one workflow can't take another's references. */
const owners = new WeakMap<OutputRef, object>();

/**
 * A reference to an output of a node `owner` built, typed by its socket type. A branding helper:
 * `Out`'s brand exists only at compile time, so this is the one place that applies it.
 */
export function outputRef<T extends string>(owner: object, node: NodeId, slot: number): Out<T> {
  const ref = new OutputRef(node, slot);
  owners.set(ref, owner);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the brand has no runtime part
  return ref as unknown as Out<T>;
}

/** Whether a value is an output reference made by the builder. */
export function isOutputRef(value: unknown): value is Out<string> {
  return value instanceof OutputRef;
}

/** The builder that made a reference. */
export function ownerOf(ref: Out<string>): object | undefined {
  return ref instanceof OutputRef ? owners.get(ref) : undefined;
}
