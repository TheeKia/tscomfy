import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  MOCK_API_WORKFLOW_NAMES,
  MOCK_OBJECT_INFO_NAMES,
  MOCK_UI_WORKFLOW_NAMES,
} from "@tscomfy/fixtures";
import {
  ACCEPTS_MATRIX_PATH,
  acceptsMatrix,
  GENERATED_DIR,
  generateMock,
  TRANSPILED_DIR,
  TRANSPILED_UI_DIR,
  transpileMock,
  transpileUiMock,
} from "./generated-fixtures.ts";

await rm(GENERATED_DIR, { recursive: true, force: true });
await Promise.all(
  MOCK_OBJECT_INFO_NAMES.map(async (name) => {
    const { files } = await generateMock(name);
    await Promise.all(
      files.map((file) => Bun.write(join(GENERATED_DIR, name, file.path), file.contents)),
    );
  }),
);
await Bun.write(ACCEPTS_MATRIX_PATH, await acceptsMatrix());
await Promise.all(
  MOCK_API_WORKFLOW_NAMES.map(async (name) => {
    const { code } = await transpileMock(name);
    await Bun.write(join(TRANSPILED_DIR, `${name}.ts`), code);
  }),
);
await Promise.all(
  MOCK_UI_WORKFLOW_NAMES.map(async (name) => {
    const { code } = await transpileUiMock(name);
    await Bun.write(join(TRANSPILED_UI_DIR, `${name}.ts`), code);
  }),
);
console.log(`Wrote ${String(MOCK_OBJECT_INFO_NAMES.length)} fixtures to ${GENERATED_DIR}`);
