import { cp, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { run, systemIo } from "@tscomfy/cli";
import { exec, REPO_DIR, TOOLS } from "@tscomfy/fixtures";

/** An example project under examples/. */
export type ExampleName = "txt2img" | "hires-fix";

/** What a command printed, and its exit code. */
export interface Ran {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** What running an example gave: `tsc`, then each run of `main` and the files they wrote. */
export interface ExampleRun {
  readonly tsc: Ran;
  /** One per run asked for, in order; none when `tsc` failed. */
  readonly mains: readonly Ran[];
  /** The `written` files, by the path given, `undefined` when `main` didn't write one. */
  readonly files: ReadonlyMap<string, string | undefined>;
}

/**
 * An example over the `/object_info` in `from`, instead of a server: generates into a copy of
 * the example, type-checks the copy with the example's tsconfig, and runs its `src/main.ts` once
 * per entry of `runs`, with those arguments, from the copy. `written` are paths, relative to the
 * copy, of files the runs write.
 */
export async function runExample(
  name: ExampleName,
  from: string,
  runs: readonly (readonly string[])[],
  written: readonly string[] = [],
): Promise<ExampleRun> {
  const example = join(REPO_DIR, "examples", name);
  // Inside the example, so @tscomfy/core resolves through its node_modules; gitignored.
  const copy = await mkdtemp(join(example, ".test-"));
  try {
    await cp(join(example, "src"), join(copy, "src"), {
      recursive: true,
      filter: (source) => !source.startsWith(join(example, "src", "comfy")),
    });
    // `include` is resolved against the config that declares it, so the copy needs its own.
    const tsconfig = { extends: "../tsconfig.json", include: ["src"] };
    await Bun.write(join(copy, "tsconfig.json"), JSON.stringify(tsconfig));
    const out = join(copy, "src", "comfy", "local");
    const quiet = { ...systemIo(), out: () => {} };
    const generated = await run(
      ["generate", "--from", from, "--out", out, "--import-extension", ".ts"],
      quiet,
    );
    if (generated !== 0) throw new Error(`generate exited with ${String(generated)}`);
    const tsc = ran(await exec([TOOLS.tsc, "-p", "."], { cwd: copy }));
    if (tsc.code !== 0) return { tsc, mains: [], files: new Map() };
    const mains: Ran[] = [];
    for (const args of runs) {
      const main = [process.execPath, "--conditions=@tscomfy/source", join("src", "main.ts")];
      // oxlint-disable-next-line no-await-in-loop -- in order: a later run may read what one wrote
      mains.push(ran(await exec([...main, ...args], { cwd: copy })));
    }
    const files = new Map<string, string | undefined>();
    for (const path of written) {
      const file = Bun.file(join(copy, path));
      // oxlint-disable-next-line no-await-in-loop -- a few small files, read in order
      files.set(path, (await file.exists()) ? await file.text() : undefined);
    }
    return { tsc, mains, files };
  } finally {
    await rm(copy, { recursive: true, force: true });
  }
}

function ran({ code, stdout, stderr }: Ran): Ran {
  return { code, stdout, stderr };
}
