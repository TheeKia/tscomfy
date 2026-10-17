import {
  type ApiNode,
  type ApiPrompt,
  type Diagnostic,
  type JsonValue,
  normalizeObjectInfo,
  parse,
  type Schema,
  stringify,
  validateApi,
} from "@tscomfy/core";
import { type MockObjectInfoName, readMockObjectInfo } from "@tscomfy/fixtures";

/** The schema of several mocks together, read losslessly. */
export async function schemaOf(...names: readonly MockObjectInfoName[]): Promise<Schema> {
  const merged: { [classType: string]: JsonValue } = {};
  for (const name of names) {
    // oxlint-disable-next-line no-await-in-loop -- a few small reads, in order
    const { value } = parse(await readMockObjectInfo(name));
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      Object.assign(merged, value);
    }
  }
  return normalizeObjectInfo(stringify(merged)).schema;
}

/** A prompt node. */
export function node(
  classType: string,
  inputs: { readonly [key: string]: JsonValue } = {},
): ApiNode {
  return { inputs, class_type: classType };
}

/**
 * A valid pipeline ending in an output node, `out`: added to a prompt under test so that only
 * what the prompt itself does wrong is reported. Its nodes are `vae`, `latent`, `decode`, `out`.
 */
export const PIPELINE: ApiPrompt = {
  vae: node("VAELoader", { vae_name: "pixel_space" }),
  latent: node("EmptyLatentImage", { width: 512, height: 512, batch_size: 1 }),
  decode: node("VAEDecode", { samples: ["latent", 0], vae: ["vae", 0] }),
  out: node("SaveImage", { filename_prefix: "x", images: ["decode", 0] }),
};

/** Validates `prompt` plus {@link PIPELINE} over basic-pipeline and the given mocks. */
export async function validated(
  prompt: ApiPrompt,
  ...names: readonly MockObjectInfoName[]
): Promise<readonly Diagnostic[]> {
  return validateApi({ ...PIPELINE, ...prompt }, await schemaOf("basic-pipeline", ...names));
}

/** A prompt with its node ids, and the links to them, renamed by `ids` (as `toUi` numbers them). */
export function renumbered(prompt: ApiPrompt, ids: ReadonlyMap<string, number>): ApiPrompt {
  const id = (key: string): string => String(ids.get(key) ?? key);
  return Object.fromEntries(
    Object.entries(prompt).map(([key, each]) => [
      id(key),
      {
        ...each,
        inputs: Object.fromEntries(
          Object.entries(each.inputs).map(([input, value]) => [
            input,
            Array.isArray(value) && typeof value[0] === "string" ? [id(value[0]), value[1]] : value,
          ]),
        ),
      },
    ]),
  );
}
