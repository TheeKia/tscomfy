import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Schema } from "@tscomfy/core";
import { CliError, type Io } from "./io.ts";
import { loadSchema } from "./source.ts";

/** The record `generate` writes last, next to the files, for `check` and `transpile`. */
export const MANIFEST = "tscomfy.json";

/** The raw snapshot written next to the generated files, for `--from` and `check`. */
export const SNAPSHOT = "object_info.json";

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
  /**
   * The ComfyUI version of the snapshot, when known: the server's with `--url`, the
   * `--comfy-version` given with `--from`. For regenerating from the snapshot, and for the
   * command `check` suggests with `--from`.
   */
  readonly comfyVersion?: string;
  /** `sha256:<hex>` of each file, by its name in the output directory: exactly {@link FILES}. */
  readonly files: { readonly [file: string]: string };
}

/** The files a manifest covers, in the order `check` reports them. */
export const FILES: readonly string[] = ["nodes.ts", "index.ts", SNAPSHOT];

/** `sha256:<hex>` of a text's UTF-8 bytes. */
export function contentHash(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
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
  const comfyVersion = field("comfyVersion");
  return (
    typeof field("codegen") === "string" &&
    typeof field("schema") === "string" &&
    typeof field("exportName") === "string" &&
    (extension === ".js" || extension === ".ts") &&
    (comfyVersion === undefined || typeof comfyVersion === "string") &&
    typeof files === "object" &&
    files !== null &&
    // Exactly our files: a hand-edited list must not hide one, or name a path outside `out`.
    Object.keys(files).toSorted().join("\n") === FILES.toSorted().join("\n") &&
    Object.values(files).every((hash) => typeof hash === "string")
  );
}

/** A directory `tscomfy generate` wrote: its manifest, and the snapshot normalized. */
export interface Generated {
  readonly manifest: Manifest;
  readonly snapshotPath: string;
  /** The snapshot's text, exactly as written. */
  readonly snapshotText: string;
  readonly schema: Schema;
}

/** The manifest and snapshot in `dir`; fails when either is missing, or isn't ours. */
export async function readGenerated(io: Io, dir: string): Promise<Generated> {
  const manifest = await readManifest(io, dir);
  const snapshotPath = join(dir, SNAPSHOT);
  const snapshotText = await io.readText(snapshotPath);
  if (manifest === undefined || snapshotText === undefined) {
    throw new CliError(
      `There is no ${manifest === undefined ? MANIFEST : SNAPSHOT} in ${dir}; run tscomfy generate first.`,
    );
  }
  const { schema } = loadSchema({ text: snapshotText, label: snapshotPath, flag: "" });
  return { manifest, snapshotPath, snapshotText, schema };
}
