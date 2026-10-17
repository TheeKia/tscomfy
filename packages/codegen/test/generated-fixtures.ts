// The generated output for every mock, committed under test/generated/ so tsc type-checks it,
// oxfmt checks its formatting, and the type tests (*.test-d.ts) can import it. Regenerate with
// `bun run generate:fixtures`; generated.test.ts fails while the committed copy is stale.

import { join } from "node:path";
import { generate, type GenerateResult } from "@tscomfy/codegen";
import { normalizeObjectInfo } from "@tscomfy/core";
import { type MockObjectInfoName, readMockObjectInfo } from "@tscomfy/fixtures";

/** Where the committed fixtures live. */
export const GENERATED_DIR: string = join(import.meta.dir, "generated");

/** Generates one mock's files exactly as committed. */
export async function generateMock(name: MockObjectInfoName): Promise<GenerateResult> {
  const { schema } = normalizeObjectInfo(await readMockObjectInfo(name), {
    comfyVersion: "0.41.0",
  });
  return generate(schema, {
    exportName: "mock",
    command: "bun run generate:fixtures",
  });
}
