// Frontend behavior the builder, the exporter and codegen must agree on (docs/plan.md §6.2, §7.4).
// The frontend's widgets themselves are modeled in `frontend/`.

import type { OutputDef } from "./types.ts";

/** Whether the exporter sends a value for an input; see `frontend/widgets.ts`. */
export { sendsInputValue } from "../frontend/widgets.ts";

/**
 * Output names that can't become named members of a multi-output result: members of `NodeHandle`
 * and `Out`, of arrays (the result is a tuple) and of `Object.prototype`. A fixed list, so the
 * result doesn't depend on the runtime's built-ins.
 */
const RESERVED_OUTPUT_NAMES: ReadonlySet<string> = new Set([
  "id",
  "node",
  "slot",
  "length",
  "at",
  "concat",
  "entries",
  "every",
  "filter",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "flat",
  "flatMap",
  "forEach",
  "includes",
  "indexOf",
  "join",
  "keys",
  "lastIndexOf",
  "map",
  "reduce",
  "reduceRight",
  "slice",
  "some",
  "toLocaleString",
  "toReversed",
  "toSorted",
  "toSpliced",
  "toString",
  "values",
  "with",
  "constructor",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "valueOf",
  "__proto__",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
]);

/**
 * The outputs of a multi-output node that are also reachable by name, as name → slot. A name is
 * left out when two outputs share it, when it is reserved, or when it looks like an index. Codegen
 * types these members and the builder creates them, from this one rule.
 */
export function namedOutputs(outputs: readonly OutputDef[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const output of outputs) counts.set(output.name, (counts.get(output.name) ?? 0) + 1);
  const named = new Map<string, number>();
  for (const output of outputs) {
    if (
      counts.get(output.name) === 1 &&
      !RESERVED_OUTPUT_NAMES.has(output.name) &&
      !/^\d+$/.test(output.name)
    ) {
      named.set(output.name, output.index);
    }
  }
  return named;
}
