import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { generate, transpile } from "@tscomfy/codegen";
import {
  defineSchema,
  importApi,
  normalizeObjectInfo,
  parse,
  stringify,
  toApi,
  type Workflow,
} from "@tscomfy/core";
import { CORPUS_DIR, listCorpus } from "@tscomfy/fixtures";

// Corpus tests (docs/plan.md §13): the generated code for each real dump must type-check and be
// exactly what oxfmt would produce, and so must every corpus API workflow transpiled over it
// (§10), which must also rebuild its prompt byte for byte. Output goes to corpus/generated/,
// which is gitignored like the rest of the corpus.

const REPO = join(import.meta.dir, "../../..");
const BIN = join(REPO, "node_modules/.bin");
const TIMEOUT = 120_000;

const dumps = await listCorpus("object-info");
const prompts = await listCorpus("workflows/api");

async function run(
  command: readonly string[],
  stdin?: string,
): Promise<{ code: number; output: string }> {
  const process = Bun.spawn([...command], {
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { code, output: stdout + stderr };
}

describe("generate the corpus", () => {
  if (dumps.length === 0) test.skip("object-info is empty", () => {});

  for (const dump of dumps) {
    const directory = join(CORPUS_DIR, "generated", dump.name.replace(/\.json$/, ""));

    test(
      `${dump.name}: the generated code type-checks and is oxfmt-formatted`,
      async () => {
        const { schema } = normalizeObjectInfo(await Bun.file(dump.path).text());
        const typed = defineSchema(stringify(schema));
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
        await Bun.write(
          join(directory, "tsconfig.json"),
          JSON.stringify({
            extends: join(REPO, "tsconfig.base.json"),
            compilerOptions: {
              noEmit: true,
              allowImportingTsExtensions: true,
              paths: { "@tscomfy/core": [join(REPO, "packages/core/src/index.ts")] },
            },
            include: ["*.ts"],
          }),
        );
        const tsc = await run([join(BIN, "tsc"), "-p", directory]);
        expect(tsc.output).toBe("");
        expect(tsc.code).toBe(0);

        const formatted = await Promise.all(
          files.map((file) =>
            run(
              [
                join(BIN, "oxfmt"),
                "--stdin-filepath",
                file.path,
                "-c",
                join(REPO, ".oxfmtrc.json"),
              ],
              file.contents,
            ),
          ),
        );
        expect(formatted.map((result) => result.output)).toEqual(
          files.map((file) => file.contents),
        );

        // Bun resolves @tscomfy/core through the tsconfig's paths.
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
