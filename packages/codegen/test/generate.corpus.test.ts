import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { generate } from "@tscomfy/codegen";
import { normalizeObjectInfo } from "@tscomfy/core";
import { CORPUS_DIR, listCorpus } from "@tscomfy/fixtures";

// Corpus tests (docs/plan.md §13): the generated code for each real dump must type-check and be
// exactly what oxfmt would produce. Output goes to corpus/generated/, which is gitignored like
// the rest of the corpus.

const REPO = join(import.meta.dir, "../../..");
const BIN = join(REPO, "node_modules/.bin");
const TIMEOUT = 120_000;

const dumps = await listCorpus("object-info");

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
        const { files } = generate(schema, { exportName: "corpus" });
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
      },
      TIMEOUT,
    );
  }
});
