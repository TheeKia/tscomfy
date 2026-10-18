import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { generate, transpile } from "@tscomfy/codegen";
import {
  typedSchema,
  importApi,
  normalizeObjectInfo,
  parse,
  stringify,
  toApi,
  type Workflow,
} from "@tscomfy/core";
import { CORPUS_DIR, listCorpus, oxfmt, typecheckProject } from "@tscomfy/fixtures";

// Corpus tests (docs/plan.md §13): the generated code for each real dump must type-check and be
// exactly what oxfmt would produce, and so must every corpus API workflow transpiled over it
// (§10), which must also rebuild its prompt byte for byte. Output goes to corpus/generated/,
// which is gitignored like the rest of the corpus.

const TIMEOUT = 120_000;

const dumps = await listCorpus("object-info");
const prompts = await listCorpus("workflows/api");

describe("generate the corpus", () => {
  if (dumps.length === 0) test.skip("object-info is empty", () => {});

  for (const dump of dumps) {
    const directory = join(CORPUS_DIR, "generated", dump.name.replace(/\.json$/, ""));

    test(
      `${dump.name}: the generated code type-checks and is oxfmt-formatted`,
      async () => {
        const { schema } = normalizeObjectInfo(await Bun.file(dump.path).text());
        const typed = typedSchema(schema);
        const transpiled = await Promise.all(
          prompts.map(async (prompt) => {
            const text = await Bun.file(prompt.path).text();
            const result = transpile(importApi(text, typed).workflow, {
              name: "prompt",
              schemaModule: "./index.ts",
              schemaName: "corpus",
            });
            expect(result.diagnostics).toEqual([]);
            const path = `transpiled-${prompt.name.replace(/\.json$/, "")}.ts`;
            return { path, contents: result.code, expected: stringify(parse(text).value ?? null) };
          }),
        );
        const files = [...generate(schema, { exportName: "corpus" }).files, ...transpiled];
        await Promise.all(
          files.map((file) => Bun.write(join(directory, file.path), file.contents)),
        );
        const tsc = await typecheckProject(directory);
        expect(tsc.output).toBe("");
        expect(tsc.code).toBe(0);

        const formatted = await Promise.all(files.map((file) => oxfmt(file.path, file.contents)));
        expect(formatted.map((result) => result.output)).toEqual(
          files.map((file) => file.contents),
        );

        // Bun resolves @tscomfy/core through the tsconfig's paths typecheckProject wrote.
        for (const file of transpiled) {
          // oxlint-disable-next-line no-await-in-loop -- one module at a time, in order
          const module: unknown = await import(join(directory, file.path));
          const built: unknown =
            typeof module === "object" && module !== null
              ? Reflect.get(module, "prompt")
              : undefined;
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the module's export
          expect(stringify(toApi(built as Workflow))).toBe(file.expected);
        }
      },
      TIMEOUT,
    );
  }
});
