// Running the repository's tools from tests and scripts: a command's output, and type-checking a
// scratch directory of generated code against core's source.

import { join } from "node:path";

/** Absolute path of the repository root. */
export const REPO_DIR: string = join(import.meta.dir, "..", "..", "..");

/** Absolute paths of the tools the tests run: TypeScript's compiler and oxfmt. */
export const TOOLS: { readonly tsc: string; readonly oxfmt: string } = {
  tsc: join(REPO_DIR, "node_modules", ".bin", "tsc"),
  oxfmt: join(REPO_DIR, "node_modules", ".bin", "oxfmt"),
};

/** The repository's oxfmt configuration, which generated code must already satisfy. */
export const OXFMT_CONFIG: string = join(REPO_DIR, ".oxfmtrc.json");

/** What a command printed, and its exit code. */
export interface Executed {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  /** Standard output, then standard error. */
  readonly output: string;
}

/** Options for {@link exec}. */
export interface ExecOptions {
  /** Text for standard input; none by default. */
  readonly stdin?: string;
  /** The working directory; the current one by default. */
  readonly cwd?: string;
  /** The environment; the current one by default. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** Runs a command to its end and collects what it printed. Never throws for a failing command. */
export async function exec(
  command: readonly string[],
  options: ExecOptions = {},
): Promise<Executed> {
  const child = Bun.spawn([...command], {
    stdin: options.stdin === undefined ? "ignore" : new TextEncoder().encode(options.stdin),
    stdout: "pipe",
    stderr: "pipe",
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: { ...options.env } }),
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr, output: stdout + stderr };
}

/** `text` as oxfmt formats it, for a file named `path`, with the repository's configuration. */
export function oxfmt(path: string, text: string): Promise<Executed> {
  return exec([TOOLS.oxfmt, "--stdin-filepath", path, "-c", OXFMT_CONFIG], { stdin: text });
}

/**
 * Makes `directory` a scratch TypeScript project for the files directly in it: a `tsconfig.json`
 * with the repository's strict settings (`tsconfig.base.json`), `@tscomfy/core` resolved to its
 * source (for `tsc`, and for Bun importing the files) and `.ts` imports allowed, and a
 * `package.json` that makes it an ES module package, as generated code expects under `nodenext`.
 */
export async function writeScratchProject(directory: string): Promise<void> {
  await Bun.write(join(directory, "package.json"), JSON.stringify({ type: "module" }));
  await Bun.write(
    join(directory, "tsconfig.json"),
    JSON.stringify({
      extends: join(REPO_DIR, "tsconfig.base.json"),
      compilerOptions: {
        noEmit: true,
        allowImportingTsExtensions: true,
        paths: { "@tscomfy/core": [join(REPO_DIR, "packages", "core", "src", "index.ts")] },
      },
      include: ["*.ts"],
    }),
  );
}

/** Type-checks `directory` as a {@link writeScratchProject} project; `args` go to `tsc` too. */
export async function typecheckProject(
  directory: string,
  args: readonly string[] = [],
): Promise<Executed> {
  await writeScratchProject(directory);
  return exec([TOOLS.tsc, "-p", directory, ...args]);
}
