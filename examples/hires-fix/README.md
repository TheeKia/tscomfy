# Example: hires fix

A two-pass workflow assembled from reusable pieces, typed by your own ComfyUI server:

- `src/pieces.ts`: plain functions that take the builder's `n` and outputs and return outputs: a
  checkpoint with a LoRA stack, the prompts encoded once, and one sampling pass. A disabled LoRA stays in the graph,
  bypassed, so the prompt skips it and the UI file shows it ready to switch on.
- `src/hires-fix.ts`: the workflow: a base image (previewed), the latent upscaled and sampled
  again at a lower denoise, saved.
- `src/main.ts`: prints the prompt, or writes a UI workflow laid out with `@tscomfy/layout`.
  Diagnostics go to stderr; an error exits 1.
- `src/server.ts`: reads the server's model lists from the generated schema, typed by the
  generated unions.

```sh
bun run generate                         # types from http://127.0.0.1:8188 into src/comfy/local
bun run typecheck
bun run start "a lighthouse at dusk"     # the prompt; POST it to /prompt yourself
bun run start --ui hires.json "a fox"    # a workflow file to open in the frontend
bun run check                            # has the server changed since generate?
```

It uses the first checkpoint and the first two LoRAs the server lists (the second one bypassed),
and only nodes every ComfyUI install has. Like [txt2img](../txt2img), it runs inside this
repository and generates with `--import-extension .ts` so Bun and `tsc` run the sources as they
are; `src/comfy/local` is never committed.
