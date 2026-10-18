import { sha256Hex, utf8 } from "../hash/sha256.ts";
import { stringify } from "../json/stringify.ts";
import type { Schema } from "./types.ts";

/**
 * The identity of a schema: `sha256:` and the SHA-256 of
 * `stringify({ formatVersion, nodes })`. Equal for equal node definitions, whatever the server's
 * whitespace, key order or node load order; `comfyVersion` is metadata and not part of it.
 * Generated files record it, and `tscomfy check` compares it.
 */
export function hashSchema(schema: Schema): string {
  const identity = { formatVersion: schema.formatVersion, nodes: schema.nodes };
  return `sha256:${sha256Hex(utf8(stringify(identity)))}`;
}
