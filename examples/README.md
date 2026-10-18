# Examples

Complete projects, each typed by your own ComfyUI server (`bun run generate` in its directory,
with the server at `http://127.0.0.1:8188`). Their tests run them over the repository's mock
schemas, and the corpus tests over your local real data.

| Example | Shows |
|---|---|
| [txt2img](txt2img) | The basics: generate, a workflow as a function, export, drift check |
| [hires-fix](hires-fix) | Reusable pieces, a LoRA stack with bypass, two outputs, diagnostics, a UI workflow with layout |
