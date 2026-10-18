import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { connect, fetchFile, outputFiles, submit } from "@tscomfy/client";
import { checkpoints, txt2img } from "./txt2img.ts";

const [checkpoint] = checkpoints();
if (checkpoint === undefined) {
  console.error("The server lists no checkpoints; put one in models/checkpoints and regenerate.");
  process.exit(1);
}
const prompt = process.argv[2] ?? "a cat in a hat";
const workflow = txt2img({ checkpoint, prompt, seed: BigInt(Date.now()), steps: 20 });
const out = join(import.meta.dir, "..", "out");
await mkdir(out, { recursive: true });

const comfy = await connect({ url: process.env["COMFY_URL"] ?? "http://127.0.0.1:8188" });
try {
  // Live previews from the sampler; ten minutes at most, then the job is cancelled.
  const job = submit(comfy, workflow, { previews: "auto", signal: AbortSignal.timeout(600_000) });
  for await (const event of job.events) {
    if (event.type === "progress") {
      process.stdout.write(`\rnode ${event.node}: ${String(event.value)}/${String(event.max)}   `);
    }
    // Overwritten as the sampler goes: open it in a viewer that reloads.
    if (event.type === "preview") await writeFile(join(out, "preview.jpg"), event.bytes);
  }
  process.stdout.write("\n");
  const outcome = await job.outcome;
  if (outcome.status === "rejected") {
    for (const each of outcome.diagnostics) console.error(`${each.code} ${each.message}`);
  } else if (outcome.status === "failed") {
    console.error(`${outcome.error.classType} failed: ${outcome.error.message}`);
  } else if (outcome.status === "cancelled") {
    console.error("Cancelled.");
  }
  for (const file of outputFiles(outcome, workflow.handles.save)) {
    const { bytes } = await fetchFile(comfy, file);
    await writeFile(join(out, file.filename), bytes);
    console.log(`saved out/${file.filename}`);
  }
} finally {
  await comfy.close();
}
