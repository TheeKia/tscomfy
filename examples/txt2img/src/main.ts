import { stringify, toApi } from "@tscomfy/core";
import { checkpoints, txt2img } from "./txt2img.ts";

const [checkpoint] = checkpoints();
if (checkpoint === undefined) {
  console.error("The server lists no checkpoints; put one in models/checkpoints and regenerate.");
  process.exit(1);
}
const prompt = process.argv[2] ?? "a cat in a hat";
// The body of POST /prompt. tscomfy builds it; queueing it is up to you.
console.log(stringify({ prompt: toApi(txt2img({ checkpoint, prompt, seed: 42n })) }));
