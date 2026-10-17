import { rm } from "node:fs/promises";
import { join } from "node:path";
import { MOCK_OBJECT_INFO_NAMES } from "@tscomfy/fixtures";
import { GENERATED_DIR, generateMock } from "./generated-fixtures.ts";

await rm(GENERATED_DIR, { recursive: true, force: true });
await Promise.all(
  MOCK_OBJECT_INFO_NAMES.map(async (name) => {
    const { files } = await generateMock(name);
    await Promise.all(
      files.map((file) => Bun.write(join(GENERATED_DIR, name, file.path), file.contents)),
    );
  }),
);
console.log(`Wrote ${String(MOCK_OBJECT_INFO_NAMES.length)} fixtures to ${GENERATED_DIR}`);
