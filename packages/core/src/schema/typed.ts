import { parse, type ParseResult } from "../json/parse.ts";
import { isJsonObject, type JsonValue } from "../json/value.ts";
import { freezeSchema } from "./freeze.ts";
import type { Schema } from "./types.ts";

declare const nodesType: unique symbol;

/**
 * A schema together with the generated `Nodes` interface that types its node functions. The
 * brand exists only at compile time; {@link defineSchema} and {@link typedSchema} apply it.
 */
export type TypedSchema<N> = Schema & { readonly [nodesType]: N };

/**
 * The `Nodes` interface of a typed schema: `Workflow<NodesOf<typeof local>>` names a workflow's
 * type without importing the generated `nodes.ts`.
 */
export type NodesOf<S> = S extends TypedSchema<infer N> ? N : never;

/**
 * Loads the schema a generated `index.ts` embeds. `text` is
 * `stringify(schema)` as codegen wrote it; it is parsed losslessly, so big integers stay exact.
 *
 * Throws when the text isn't such a schema: generated files are tscomfy's own output, so a
 * mismatch means the file was edited or truncated, which is misuse rather than data to report.
 */
export function defineSchema<N>(text: string): TypedSchema<N> {
  return schemaFromParse(parse(text));
}

/**
 * A schema as a typed schema, to build and import workflows over a schema read at runtime (from
 * `normalizeObjectInfo`) rather than generated. With `N` left `unknown`, `n` has no node
 * functions, and nodes are added with `raw`; `importApi` and `importUi` work as with generated
 * types. The schema is frozen, as the normalizer returns it.
 */
export function typedSchema<N = unknown>(schema: Schema): TypedSchema<N> {
  return brand(
    freezeSchema({
      formatVersion: schema.formatVersion,
      ...(schema.comfyVersion === undefined ? {} : { comfyVersion: schema.comfyVersion }),
      nodes: Object.fromEntries(Object.entries(schema.nodes)),
    }),
  );
}

/** {@link defineSchema} from a parse result. Exported for tests; not part of the public API. */
export function schemaFromParse<N>({ value, diagnostics }: ParseResult): TypedSchema<N> {
  if (diagnostics.some((diagnostic) => diagnostic.code === "W_PRECISION_LOSS")) {
    throw new TypeError(
      "defineSchema: this runtime has no JSON.parse source-text access, so the schema's big integers would lose precision (V8 11.4+ as in Node 21+, Deno and Chromium; Bun; Firefox 135+)",
    );
  }
  if (value === undefined || diagnostics.length > 0 || !isSchemaShaped(value)) {
    throw new TypeError("defineSchema: the text is not a schema written by tscomfy codegen");
  }
  return typedSchema(value);
}

/** Applies the compile-time `Nodes` brand: a branding helper, the one documented cast. */
function brand<N>(schema: Schema): TypedSchema<N> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the brand has no runtime part
  return schema as TypedSchema<N>;
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
