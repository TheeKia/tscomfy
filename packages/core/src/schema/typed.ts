import { parse } from "../json/parse.ts";
import { isJsonObject, type JsonValue } from "../json/value.ts";
import { freezeSchema } from "./freeze.ts";
import type { Schema } from "./types.ts";

declare const nodesType: unique symbol;

/**
 * A schema together with the generated `Nodes` interface that types its node functions. The type
 * parameter exists only at compile time.
 */
export type TypedSchema<N> = Schema & { readonly [nodesType]?: N };

/**
 * Loads the schema a generated `index.ts` embeds (docs/plan.md §6.1, D13). `text` is
 * `stringify(schema)` as codegen wrote it; it is parsed losslessly, so big integers stay exact.
 *
 * Throws when the text isn't such a schema: generated files are tscomfy's own output, so a
 * mismatch means the file was edited or truncated, which is misuse rather than data to report.
 */
export function defineSchema<N>(text: string): TypedSchema<N> {
  const { value, diagnostics } = parse(text);
  if (value === undefined || diagnostics.length > 0 || !isSchemaShaped(value)) {
    throw new TypeError("defineSchema: the text is not a schema written by tscomfy codegen");
  }
  return freezeSchema({
    formatVersion: value.formatVersion,
    ...(value.comfyVersion === undefined ? {} : { comfyVersion: value.comfyVersion }),
    nodes: Object.fromEntries(Object.entries(value.nodes)),
  });
}

/**
 * The top-level shape of a schema. Codegen wrote the nodes from a normalized schema, so they are
 * trusted below this level rather than re-validated on every import.
 */
function isSchemaShaped(value: JsonValue): value is Schema {
  return (
    isJsonObject(value) &&
    value["formatVersion"] === 1 &&
    (value["comfyVersion"] === undefined || typeof value["comfyVersion"] === "string") &&
    isJsonObject(value["nodes"])
  );
}
