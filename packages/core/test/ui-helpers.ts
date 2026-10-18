import { type Diagnostic, importUi, type TypedSchema, toApi } from "@tscomfy/core";
import { readMockObjectInfo } from "@tscomfy/fixtures";
import { type LooseNodes, looseSchema } from "./loose.ts";

// Shared by the UI format tests (docs/plan.md §11). The mock UI workflows' expected prompts were
// captured from frontend 1.55.17 itself (internal/fixtures/scripts/frontend.ts); the inline cases
// follow probes run the same way (docs/research/ui-format.md).

/** The schema the mock UI workflows are written for. */
export const schema: TypedSchema<LooseNodes> = looseSchema(
  await readMockObjectInfo("basic-pipeline"),
);

/** The schema of widgets the frontend adds without an input of their own. */
export const widgets: TypedSchema<LooseNodes> = looseSchema(await readMockObjectInfo("ui-widgets"));

export const found = (diagnostics: readonly Diagnostic[]): [string, (string | number)[]][] =>
  diagnostics.map((diagnostic) => [diagnostic.code, [...diagnostic.path]]);

/** The prompt the frontend builds for a UI workflow, through `importUi`. */
export function queued(text: string): {
  readonly prompt: unknown;
  readonly found: [string, (string | number)[]][];
} {
  const { workflow: imported, diagnostics } = importUi(text, schema);
  return { prompt: toApi(imported, { validate: false }), found: found(diagnostics) };
}

/** A format 0.4 file around nodes and tuple links. */
export const file = (
  nodes: readonly unknown[],
  links: readonly unknown[] = [],
  rest: object = {},
): string =>
  JSON.stringify({ last_node_id: 100, last_link_id: 100, nodes, links, version: 0.4, ...rest });

/** An object read back from a file, or a failed test. */
export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected an object");
  }
  return Object.fromEntries(Object.entries(value));
}

/** A record with some fields replaced, key order kept. */
export function patched(record: Record<string, unknown>, changes: Record<string, unknown>): object {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      key,
      Object.hasOwn(changes, key) ? changes[key] : value,
    ]),
  );
}

/** The objects of a list read back from a file. */
export function objects(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("expected a list");
  return value.map((each: unknown) => object(each));
}

/** A Reroute fed by `link`. */
export const reroute = (id: number, link: number, mode = 0): object => ({
  id,
  type: "Reroute",
  mode,
  inputs: [{ name: "", type: "*", link }],
});

export const ckpt: object = {
  id: 1,
  type: "CheckpointLoaderSimple",
  widgets_values: ["model-a.safetensors"],
};
export const encode = (id: number, text: string, link: number | null): object => ({
  id,
  type: "CLIPTextEncode",
  inputs: [{ name: "clip", type: "CLIP", link }],
  widgets_values: [text],
});
export const ckptPrompt = {
  inputs: { ckpt_name: "model-a.safetensors" },
  class_type: "CheckpointLoaderSimple",
  _meta: { title: "Load Checkpoint" },
};
export const encodePrompt = (text: string, clip?: readonly [string, number]): object => ({
  inputs: { text, ...(clip === undefined ? {} : { clip }) },
  class_type: "CLIPTextEncode",
  _meta: { title: "CLIP Text Encode (Prompt)" },
});
