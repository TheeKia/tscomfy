import { cp, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { run, systemIo } from "@tscomfy/cli";

const REPO = join(import.meta.dir, "..", "..", "..");
const EXAMPLE = join(REPO, "examples", "txt2img");

/** What a command printed, and its exit code. */
export interface Ran {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * examples/txt2img over the `/object_info` in `from`, instead of a server: generates into a
 * copy of the example, type-checks the copy with the example's tsconfig, and runs it.
 */
export async function runExample(
  from: string,
  prompt: string,
): Promise<{ readonly tsc: Ran; readonly main?: Ran }> {
  // Inside the example, so @tscomfy/core resolves through its node_modules; gitignored.
  const copy = await mkdtemp(join(EXAMPLE, ".test-"));
  try {
    await cp(join(EXAMPLE, "src"), join(copy, "src"), {
      recursive: true,
      filter: (source) => !source.startsWith(join(EXAMPLE, "src", "comfy")),
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
    const tsc = await exec(copy, [
      join(REPO, "node_modules", "typescript", "bin", "tsc"),
      "-p",
      ".",
    ]);
    if (tsc.code !== 0) return { tsc };
    const main = await exec(copy, ["--conditions=@tscomfy/source", join("src", "main.ts"), prompt]);
    return { tsc, main };
  } finally {
    await rm(copy, { recursive: true, force: true });
  }
}

async function exec(cwd: string, args: readonly string[]): Promise<Ran> {
  const child = Bun.spawn([process.execPath, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}
