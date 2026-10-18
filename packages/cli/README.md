# @tscomfy/cli

[![npm](https://img.shields.io/npm/v/@tscomfy/cli)](https://www.npmjs.com/package/@tscomfy/cli)

The `tscomfy` command. It generates the types
[`@tscomfy/core`](https://www.npmjs.com/package/@tscomfy/core) builds workflows with from your
ComfyUI server, tells you when they are out of date, and turns workflows saved in ComfyUI into
typed code. It only sends `GET` requests; it never queues anything.

```sh
npm install @tscomfy/core
npm install --save-dev @tscomfy/cli
```

Runs on Node 24 or later and Bun 1.4 or later.

| Command | What it does |
|---|---|
| `tscomfy generate --url <server> --out <dir>` | Writes types for every node, model and sampler the server has |
| `tscomfy check --url <server> --out <dir>` | Exits 1 when the server, or the generated files, changed since `generate` |
| `tscomfy transpile --workflow <file> --schema <dir>` | Writes a saved workflow, or with `--prompt` an "Export (API)" file, as typed code |

`tscomfy help <command>` lists every option. Exit codes: 0 for success, 1 for a failure or
drift, 2 for a usage error.

## generate

```sh
npx tscomfy generate --url http://127.0.0.1:8188 --out src/comfy/local
```

| File | What |
|---|---|
| `nodes.ts` | The `Nodes` interface: a function per node class, combo options as literal unions |
| `index.ts` | `export const local`: the schema `workflow` takes, typed by `Nodes` |
| `object_info.json` | The server's response, for `check` and for regenerating offline with `--from` |
| `tscomfy.json` | The manifest `check` and `transpile` read |

The constant is named after the directory; `--name` picks another. `index.ts` imports
`./nodes.js`, as `tsc` and bundlers expect; `--import-extension .ts` makes it `./nodes.ts`, to
run the sources with Node or Bun without a build. The files hold your model names and change
with what the server has installed, so most projects gitignore them and regenerate.

## check

```sh
npx tscomfy check --url http://127.0.0.1:8188 --out src/comfy/local
```

Prints what changed (nodes, inputs, combo options, outputs) and the `generate` command that
updates the files. It also fails when a generated file was edited or comes from another tscomfy
version. Files uploaded to the server, such as `LoadImage`'s images, don't count as drift.

## transpile

```sh
npx tscomfy transpile --workflow portrait.json --schema src/comfy/local --out src/portrait.ts
```

The module exports the workflow, built with your generated types; exporting it with `toApi`
gives back the prompt the frontend queues for the file. A node the types can't express is
written as `raw(…)`, so the module always compiles. `--no-inline` gives every node a variable.

## From code

`run(args, io)` runs the CLI in-process and resolves to the exit code; `systemIo()` is the real
file system, network and console.

```ts
import { run, systemIo } from "@tscomfy/cli";

const code = await run(["check", "--url", "http://127.0.0.1:8188", "--out", "src/comfy/local"], systemIo());
```

To generate or transpile without files, use [`@tscomfy/codegen`](https://www.npmjs.com/package/@tscomfy/codegen).

## Documentation

[The CLI reference](https://github.com/TheeKia/tscomfy/blob/main/docs/guides/cli.md) has every
option. See also [getting started](https://github.com/TheeKia/tscomfy/blob/main/docs/guides/getting-started.md)
and [importing and transpiling](https://github.com/TheeKia/tscomfy/blob/main/docs/guides/import-and-transpile.md).

## License

MIT
