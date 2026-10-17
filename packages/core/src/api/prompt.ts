import type { NodeId } from "../graph/types.ts";
import type { JsonValue } from "../json/value.ts";

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
