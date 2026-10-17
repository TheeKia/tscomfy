import { join } from "node:path";
import { CliError, type Io } from "./io.ts";

/** The record `generate` writes last, next to the files, for `check`. */
export const MANIFEST = "tscomfy.json";

/**
 * What one `generate` run wrote: the codegen version, the schema hash, the options needed to
 * regenerate, and a content hash of every file, so `check` notices an edited, missing or
 * half-written file and output from another version.
 */
export interface Manifest {
  readonly codegen: string;
  /** `hashSchema` of the snapshot (D15). */
  readonly schema: string;
  readonly exportName: string;
  readonly importExtension: ".js" | ".ts";
  /** `sha256:<hex>` of each file, by its name in the output directory. */
  readonly files: { readonly [file: string]: string };
}

/** `sha256:<hex>` of a text's UTF-8 bytes. */
export function contentHash(text: string): string {
  return `sha256:${new Bun.CryptoHasher("sha256").update(text).digest("hex")}`;
}

/** The manifest's file contents: stable key order, one trailing newline. */
export function formatManifest(manifest: Manifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** The manifest in `out`, or `undefined` when there is none. Throws for one that isn't ours. */
export async function readManifest(io: Io, out: string): Promise<Manifest | undefined> {
  const path = join(out, MANIFEST);
  const text = await io.readText(path);
  if (text === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new CliError(`${path} is not JSON; run tscomfy generate again.`);
  }
  if (!isManifest(value)) {
    throw new CliError(`${path} is not a tscomfy manifest; run tscomfy generate again.`);
  }
  return value;
}

function isManifest(value: unknown): value is Manifest {
  if (typeof value !== "object" || value === null) return false;
  const field = (name: string): unknown => Reflect.get(value, name);
  const files = field("files");
  const extension = field("importExtension");
  return (
    typeof field("codegen") === "string" &&
    typeof field("schema") === "string" &&
    typeof field("exportName") === "string" &&
    (extension === ".js" || extension === ".ts") &&
    typeof files === "object" &&
    files !== null &&
    Object.values(files).every((hash) => typeof hash === "string")
  );
}
