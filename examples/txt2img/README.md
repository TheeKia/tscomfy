# Example: txt2img

A text-to-image workflow written with tscomfy and typed by your own ComfyUI server: wrong wiring,
misspelled samplers and missing inputs are compile errors.

```sh
bun run generate    # types from http://127.0.0.1:8188 into src/comfy/local (gitignored)
bun run typecheck
bun run start "a cat in a hat"   # prints the API prompt; POST it to /prompt yourself
bun run check       # has the server changed since generate?
```

When `check` reports drift, `bun run generate` updates the types (the command it prints assumes
`tscomfy` is on your PATH).

`src/comfy/local` is generated from your server and holds its model names, so it is never
committed. The example only uses nodes every ComfyUI install has.
