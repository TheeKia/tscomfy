// How the frontend matches link types (ComfyUI_frontend 1.55.17, read as a specification): LiteGraph
// `isValidConnection`, `ExecutableNodeDTO._getBypassSlotIndex` and `withComfyMatchType`'s
// `commonType`. Types are the frontend's type strings (`*`, `IMAGE`, `IMAGE,MASK`).

/**
 * The input of a bypassed node that output `slot` passes through (`_getBypassSlotIndex`):
 * 1. for a target typed `*` or untyped, the input at the same index, else the first;
 * 2. the input at the same index, if it is valid for both the output's type and the target's;
 * 3. the first input whose type is exactly the target's;
 * 4. the first input valid for both; else none (`-1`).
 */
export function bypassSlot(
  inputs: readonly { readonly type: string }[],
  output: string,
  slot: number,
  target: string,
): number {
  if (target === "*" || target === "") return inputs.length > slot ? slot : 0;
  const same = inputs[slot];
  if (
    same !== undefined &&
    validConnection(same.type, output) &&
    validConnection(same.type, target)
  ) {
    return slot;
  }
  const exact = inputs.findIndex((input) => input.type === target);
  if (exact !== -1) return exact;
  return inputs.findIndex(
    (input) => validConnection(input.type, output) && validConnection(input.type, target),
  );
}

/**
 * LiteGraph's `isValidConnection`: `*` and the empty type match anything; otherwise the types
 * match ignoring case, or, for comma lists, when any member of one matches any of the other.
 */
export function validConnection(a: string, b: string): boolean {
  if (a === "" || a === "*" || b === "" || b === "*" || a === b) return true;
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (!x.includes(",") && !y.includes(",")) return x === y;
  return x.split(",").some((one) => y.split(",").some((other) => validConnection(one, other)));
}

/**
 * The frontend's `commonType`: `*` when every type is `*`, else the members all the other types
 * share (comma lists split, `*` ignored, case kept), or `undefined` when they share none.
 */
export function commonType(types: readonly string[]): string | undefined {
  const typed = types.filter((type) => type !== "*");
  if (typed.length === 0) return "*";
  const counts = new Map<string, number>();
  for (const type of typed) {
    for (const member of new Set(type.split(","))) {
      counts.set(member, (counts.get(member) ?? 0) + 1);
    }
  }
  const shared = [...counts]
    .filter(([, count]) => count === typed.length)
    .map(([member]) => member);
  return shared.length === 0 ? undefined : shared.join(",");
}
