/**
 * @module @tscomfy/fixtures
 *
 * Test data for tscomfy. Mocks are committed, hand-written and stable; the corpus is real data
 * captured locally and never committed (see README.md and docs/plan.md §13).
 *
 * Loaders return raw JSON text, not parsed values: how the text is parsed (for example, keeping
 * integers beyond 2^53 exact) is part of what the tests check.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";

export * from "./exec.ts";
export * from "./fake-server.ts";
export * from "./protocol.ts";

const root = join(import.meta.dir, "..");

/** Names of the committed mock `/object_info` responses in `mocks/object-info/`. */
export const MOCK_OBJECT_INFO_NAMES = [
  "accepts",
  "autogrow",
  "basic-pipeline",
  "combos",
  "dynamic-combo",
  "dynamic-group",
  "empty",
  "hidden",
  "legacy-and-flags",
  "malformed",
  "match-type",
  "names",
  "nulls",
  "numbers",
  "outputs",
  "sockets",
  "ui-extensions",
  "ui-widgets",
  "widget-types",
] as const;

export type MockObjectInfoName = (typeof MOCK_OBJECT_INFO_NAMES)[number];

/** Absolute path of the directory holding the mock `/object_info` files. */
export const MOCK_OBJECT_INFO_DIR: string = join(root, "mocks", "object-info");

/** Raw JSON text of one mock `/object_info` response. */
export function readMockObjectInfo(name: MockObjectInfoName): Promise<string> {
  return Bun.file(join(MOCK_OBJECT_INFO_DIR, `${name}.json`)).text();
}

/**
 * Names of the committed mock API-format workflows in `mocks/workflows/api/`. Each is the prompt
 * the frontend would send for a graph built over one mock schema: the expected output of the
 * exporter's parity tests (docs/plan.md §7.4).
 */
export const MOCK_API_WORKFLOW_NAMES = [
  "autogrow",
  "dynamic-combo",
  "dynamic-group",
  "lists",
  "txt2img",
  "value-widgets",
] as const;

export type MockApiWorkflowName = (typeof MOCK_API_WORKFLOW_NAMES)[number];

/** Absolute path of the directory holding the mock API-format workflows. */
export const MOCK_API_WORKFLOW_DIR: string = join(root, "mocks", "workflows", "api");

/** Raw JSON text of one mock API-format workflow. */
export function readMockApiWorkflow(name: MockApiWorkflowName): Promise<string> {
  return Bun.file(join(MOCK_API_WORKFLOW_DIR, `${name}.json`)).text();
}

/**
 * Names of the committed mock UI-format workflows in `mocks/workflows/ui/`, all over the
 * `basic-pipeline` mock schema. Each has, under the same name in `mocks/workflows/ui-api/`, the
 * prompt the ComfyUI frontend itself builds when it loads the file: the expected output of
 * `importUi` (docs/plan.md §11).
 */
export const MOCK_UI_WORKFLOW_NAMES = [
  "modes",
  "subgraph-modes",
  "subgraph-primitive",
  "subgraphs",
  "txt2img",
] as const;

export type MockUiWorkflowName = (typeof MOCK_UI_WORKFLOW_NAMES)[number];

/** Absolute path of the directory holding the mock UI-format workflows. */
export const MOCK_UI_WORKFLOW_DIR: string = join(root, "mocks", "workflows", "ui");

/** Absolute path of the directory holding the prompts the frontend builds for them. */
export const MOCK_UI_API_WORKFLOW_DIR: string = join(root, "mocks", "workflows", "ui-api");

/**
 * Absolute path of the directory holding, for each mock UI workflow, the prompt the frontend
 * builds when it loads `toUi`'s export of it (the import, exported again).
 */
export const MOCK_UI_EXPORT_DIR: string = join(root, "mocks", "workflows", "ui-export");

/** Raw JSON text of one mock UI-format workflow. */
export function readMockUiWorkflow(name: MockUiWorkflowName): Promise<string> {
  return Bun.file(join(MOCK_UI_WORKFLOW_DIR, `${name}.json`)).text();
}

/** Raw JSON text of the prompt the frontend builds for `toUi`'s export of one mock UI workflow. */
export function readMockUiExportPrompt(name: MockUiWorkflowName): Promise<string> {
  return Bun.file(join(MOCK_UI_EXPORT_DIR, `${name}.json`)).text();
}

/** Raw JSON text of the prompt the frontend builds for one mock UI-format workflow. */
export function readMockUiApiWorkflow(name: MockUiWorkflowName): Promise<string> {
  return Bun.file(join(MOCK_UI_API_WORKFLOW_DIR, `${name}.json`)).text();
}

/**
 * UI workflows over the `ui-extensions` mock schema, of core classes whose widgets the frontend's
 * core extensions make, each with the prompt the frontend builds for it.
 */
export const MOCK_UI_EXTENSION_WORKFLOW_NAMES = ["core-extensions"] as const;

/** A name in {@link MOCK_UI_EXTENSION_WORKFLOW_NAMES}. */
export type MockUiExtensionWorkflowName = (typeof MOCK_UI_EXTENSION_WORKFLOW_NAMES)[number];

/** Where the UI workflows of {@link MOCK_UI_EXTENSION_WORKFLOW_NAMES} are. */
export const MOCK_UI_EXTENSION_DIR: string = join(root, "mocks", "workflows", "ui-extensions");

/** Where the prompts the frontend builds for them are, under the same names. */
export const MOCK_UI_EXTENSION_API_DIR: string = join(
  root,
  "mocks",
  "workflows",
  "ui-extensions-api",
);

/** Where the prompts the frontend builds for `toUi`'s export of them are, under the same names. */
export const MOCK_UI_EXTENSION_EXPORT_DIR: string = join(
  root,
  "mocks",
  "workflows",
  "ui-extensions-export",
);

/** A UI workflow of {@link MOCK_UI_EXTENSION_WORKFLOW_NAMES}, as raw text. */
export function readMockUiExtensionWorkflow(name: MockUiExtensionWorkflowName): Promise<string> {
  return Bun.file(join(MOCK_UI_EXTENSION_DIR, `${name}.json`)).text();
}

/** The prompt the frontend builds for a UI workflow of {@link MOCK_UI_EXTENSION_WORKFLOW_NAMES}. */
export function readMockUiExtensionApiWorkflow(name: MockUiExtensionWorkflowName): Promise<string> {
  return Bun.file(join(MOCK_UI_EXTENSION_API_DIR, `${name}.json`)).text();
}

/** The prompt the frontend builds for `toUi`'s export of one of them. */
export function readMockUiExtensionExportPrompt(
  name: MockUiExtensionWorkflowName,
): Promise<string> {
  return Bun.file(join(MOCK_UI_EXTENSION_EXPORT_DIR, `${name}.json`)).text();
}

/**
 * Sections of the local corpus. `workflows/ui-api` holds, under the same names as
 * `workflows/ui`, the prompts the frontend builds for those files (`scripts/frontend.ts`).
 */
export type CorpusSection =
  | "object-info"
  | "protocol"
  | "workflows/api"
  | "workflows/ui"
  | "workflows/ui-api";

/** One file of the local corpus. */
export interface CorpusFile {
  /** File name, e.g. `local.json`. */
  readonly name: string;
  /** Absolute path. */
  readonly path: string;
}

/** Absolute path of the local corpus directory. */
export const CORPUS_DIR: string = join(root, "corpus");

/**
 * Lists the JSON files in one section of the local corpus, sorted by name in code-unit order.
 * Returns an empty list when the section doesn't exist, so corpus tests skip cleanly on a fresh
 * clone.
 */
export async function listCorpus(section: CorpusSection): Promise<readonly CorpusFile[]> {
  const dir = join(CORPUS_DIR, section);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  return entries
    .filter((name) => name.endsWith(".json"))
    .toSorted()
    .map((name) => ({ name, path: join(dir, name) }));
}
