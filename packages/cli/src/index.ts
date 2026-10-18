/**
 * @module @tscomfy/cli
 *
 * The `tscomfy` command: generate types from a ComfyUI server, check them for drift against a
 * snapshot, and transpile API prompts and UI workflows to code. The only package with I/O,
 * through `node:fs`, `node:crypto` and `fetch`, so it runs on Node and Bun.
 * Exported for running the CLI in-process: `run(args, systemIo())`, or with an {@link Io} of
 * your own, which reports failures as {@link CliError}s.
 */

export { CliError, type Io, systemIo } from "./io.ts";
export { CLI_VERSION, run } from "./run.ts";
