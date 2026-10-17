import type { SocketType } from "../schema/types.ts";

/**
 * Parses a ComfyUI type string. Exactly `*` is `any`; a comma list becomes a union of its trimmed,
 * non-empty names without duplicates (the backend trims when it compares). A `*` inside a comma
 * list stays a member, because the backend treats it differently from a bare `*` for option-list
 * outputs. Returns `undefined` for a string with no names.
 */
export function parseSocketType(text: string): SocketType | undefined {
  if (text === "*") return { kind: "any" };
  const names = [
    ...new Set(
      text
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name !== ""),
    ),
  ];
  const [first] = names;
  if (first === undefined) return undefined;
  return names.length === 1 ? { kind: "named", name: first } : { kind: "union", names };
}
