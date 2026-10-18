#!/usr/bin/env node
// The `tscomfy` executable.

import { systemIo } from "./io.ts";
import { run } from "./run.ts";

process.exitCode = await run(process.argv.slice(2), systemIo());
