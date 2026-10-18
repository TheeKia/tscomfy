# Example: txt2img

A text-to-image workflow written with tscomfy and typed by your own ComfyUI server: wrong wiring,
misspelled samplers and missing inputs are compile errors.

- `src/txt2img.ts`: the workflow, a function of its parameters.
- `src/main.ts`: prints the prompt for `POST /prompt`.

```sh
bun run generate    # types from http://127.0.0.1:8188 into src/comfy/local
bun run typecheck
bun run start "a cat in a hat"   # prints the API prompt; POST it to /prompt yourself
bun run check       # has the server changed since generate?
```

The server needs at least one checkpoint (`models/checkpoints`); the example uses the first it
lists. When `check` reports drift, `bun run generate` updates the types.

Notes for copying it into your own project:
- The scripts run the CLI from this repository's source (`../../packages/cli/src/main.ts`); in a
  project of your own, run `tscomfy` instead.
- It generates with `--import-extension .ts`, so `index.ts` imports `./nodes.ts` and Bun
  runs the sources as they are. With a build step (`tsc`, a
  bundler), the default `.js` is the usual choice.
- `src/comfy/local` is generated from your server and holds its model names, so it is gitignored.
