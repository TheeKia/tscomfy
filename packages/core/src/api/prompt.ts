import type { NodeId } from "../graph/types.ts";
import { isJsonArray, type JsonValue } from "../json/value.ts";

/** A link in a prompt: the source node's id and output slot. */
export type ApiLink = readonly [NodeId, number];

/** One node of an API-format prompt. */
export type ApiNode = {
  readonly inputs: { readonly [key: string]: JsonValue };
  readonly class_type: string;
  readonly _meta?: { readonly title: string };
};

/** An API-format prompt: what `POST /prompt` takes as `prompt`. May hold bigint; see `stringify`. */
export type ApiPrompt = { readonly [id: NodeId]: ApiNode };

/** Whether a wire value is a link, `[id, slot]` with a string id, as the backend's `is_link` reads it. */
export function isApiLink(value: JsonValue | undefined): value is ApiLink {
  return (
    isJsonArray(value) &&
    value.length === 2 &&
    typeof value[0] === "string" &&
    typeof value[1] === "number"
  );
}

/** Whether a link can name an output: {@link isApiLink}, with a non-negative integer slot. */
export function isWellFormedLink(value: JsonValue | undefined): value is ApiLink {
  return isApiLink(value) && Number.isSafeInteger(value[1]) && value[1] >= 0;
}
