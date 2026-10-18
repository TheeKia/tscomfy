// Prints the prompt for POST /prompt, or with `--ui <file>` writes a UI workflow to open in the
// frontend. Diagnostics go to stderr; an error (the backend would reject the prompt) exits 1.

import { exportApi, stringify, toUi } from "@tscomfy/core";
import { layout } from "@tscomfy/layout";
import { hiresFix } from "./hires-fix.ts";
import { options } from "./server.ts";

const [checkpoint] = options("CheckpointLoaderSimple", "ckpt_name");
if (checkpoint === undefined) {
  console.error("The server lists no checkpoints; put one in models/checkpoints and regenerate.");
  process.exit(1);
}
const loras = options("LoraLoader", "lora_name")
  .slice(0, 2)
  .map((name, index) => ({ name, strength: 0.8, enabled: index === 0 }));

const args = process.argv.slice(2);
const ui = args[0] === "--ui" ? args[1] : undefined;
const prompt = (ui === undefined ? args[0] : args[2]) ?? "a lighthouse at dusk, oil painting";
const built = hiresFix({ checkpoint, loras, prompt, seed: 7n });

const { prompt: api, diagnostics } = exportApi(built);
for (const { code, path, message } of diagnostics) {
  console.error(`${code} ${path.join(" › ")}: ${message}`);
}
if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) process.exit(1);
if (ui === undefined) {
  console.log(stringify({ prompt: api }));
} else {
  const exported = toUi(built, { positions: layout(built) });
  for (const { code, message } of exported.diagnostics) console.error(`${code}: ${message}`);
  await Bun.write(ui, stringify(exported.workflow));
  console.error(`Wrote ${ui}; open it in the ComfyUI frontend.`);
}
