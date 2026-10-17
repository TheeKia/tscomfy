/**
 * @module @tscomfy/cli
 *
 * The `tscomfy` command: generate types from a ComfyUI server and check drift
 * against a snapshot. The only package with I/O
 * (see docs/plan.md §4). Exported for running the CLI programmatically.
 */

export { CliError, type Io, systemIo } from "./io.ts";
export { CLI_VERSION, run } from "./run.ts";
