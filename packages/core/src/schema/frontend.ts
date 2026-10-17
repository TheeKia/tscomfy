// Frontend behavior the exporter and codegen must agree on (docs/plan.md §7.4). Sources:
// ComfyUI_frontend 1.55.17 `src/utils/executionUtil.ts` and the widget composables in
// `src/renderer/extensions/vueNodes/widgets/composables/`.

import type { OutputDef } from "./types.ts";

/**
 * Core widgets whose value the frontend never sends (`options.serialize === false`):
 * RESOLUTION_PREVIEW only displays, IMAGEUPLOAD is the upload button beside a combo.
 */
const DISPLAY_ONLY_WIDGETS: ReadonlySet<string> = new Set(["RESOLUTION_PREVIEW", "IMAGEUPLOAD"]);

/** Whether the frontend sends a value widget's value in a prompt. */
export function sendsValue(widget: string): boolean {
  return !DISPLAY_ONLY_WIDGETS.has(widget);
}

/**
 * Output names that can't become named members of a multi-output result: members of
 * `NodeHandle` and `Out`, of arrays (the result is a tuple) and of `Object.prototype`. A fixed
 * list, so the result doesn't depend on the runtime's built-ins.
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
 * The outputs of a multi-output node that are also reachable by name (docs/plan.md §6.2), as
 * name → slot. A name is left out when two outputs share it, when it is reserved, or when it
 * looks like an index. Codegen types these members and the builder creates them, from this one
 * rule.
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
