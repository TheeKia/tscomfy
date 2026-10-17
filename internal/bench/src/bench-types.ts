// bench:types — type-checking cost of generated types at growing schema sizes, against the budget
// in docs/plan.md §6.6: at 7k nodes, at most 0.5 s total and 300 MB. Exits non-zero over budget.

import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { generate } from "@tscomfy/codegen";
import { mockNodes, syntheticSchema } from "./synthetic.ts";

const REPO = join(import.meta.dir, "../../..");
const OUT = join(import.meta.dir, "../.out");
const SIZES = [1758, 3516, 7032] as const;
const BUDGET = { size: 7032, seconds: 0.5, megabytes: 300 } as const;

/** A 20-node workflow over the basic pipeline, MatchType and DynamicCombo nodes. */
const WORKFLOW = `import type { Out } from "@tscomfy/core";
import type { Nodes } from "./nodes.js";

declare const n: Nodes;
declare const image: Out<"IMAGE">;
declare const video: Out<"VIDEO">;
declare const float: Out<"FLOAT">;
declare const int: Out<"INT">;

export function build(prompt: string, seed: bigint): void {
  const [model, clip, vae] = n.CheckpointLoaderSimple({ ckpt_name: "model-a.safetensors" });
  const positive = n.CLIPTextEncode({ clip, text: prompt });
  const negative = n.CLIPTextEncode({ clip, text: "" });
  const latent = n.EmptyLatentImage({ width: 1024, height: 1024 });
  const first = n.KSampler({ model, positive, negative, latent_image: latent, seed, sampler_name: "euler", scheduler: "normal" });
  const second = n.KSampler({ model, positive, negative, latent_image: first, seed, steps: 10, sampler_name: "dpmpp_2m", scheduler: "karras" });
  const decoded = n.VAEDecode({ samples: second, vae });
  n.SaveImage({ images: decoded, filename_prefix: "out" });
  const picked = n.MockSwitch({ switch: true, on_false: decoded, on_true: image });
  n.MockMatchConstrained({ input: picked });
  n.MockDynamicComboNested({ video, format: { option: "mp4", inputs: { codec: { option: "h264", inputs: { encoding: "auto" } } } } });
  n.MockDynamicComboSimple({ image: picked, mode: { option: "scale by", inputs: { factor: 2 } } });
  n.MockAutogrowPrefix({ images: [decoded, picked] });
  n.MockDynamicGroup({ model, loras: [{ lora_name: "lora-a.safetensors" }] });
  n.VAEDecode({ samples: first, vae });
  n.CLIPTextEncode({ clip, text: "extra" });
  n.SaveImage({ images: picked });
  n.MockComboMultiselect({ tags: ["red"] });
  n.MockAutogrowNames({ values: { a: float, b: int } });
  n.EmptyLatentImage({ batch_size: 4 });
}
`;

interface Result {
  readonly size: number;
  readonly seconds: number;
  readonly megabytes: number;
}

async function measure(
  size: number,
  templates: Awaited<ReturnType<typeof mockNodes>>,
): Promise<Result> {
  const directory = join(OUT, String(size));
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  const { files } = generate(syntheticSchema(templates, size), { exportName: "bench" });
  await Promise.all([
    ...files.map((file) => Bun.write(join(directory, file.path), file.contents)),
    Bun.write(join(directory, "workflow.ts"), WORKFLOW),
    Bun.write(
      join(directory, "tsconfig.json"),
      JSON.stringify({
        extends: join(REPO, "tsconfig.base.json"),
        compilerOptions: {
          noEmit: true,
          allowImportingTsExtensions: true,
          paths: { "@tscomfy/core": [join(REPO, "packages/core/src/index.ts")] },
        },
        include: ["*.ts"],
      }),
    ),
  ]);
  const process = Bun.spawn(
    [join(REPO, "node_modules/.bin/tsc"), "-p", directory, "--extendedDiagnostics"],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [output, code] = await Promise.all([new Response(process.stdout).text(), process.exited]);
  if (code !== 0) throw new Error(`tsc failed at ${String(size)} nodes:\n${output}`);
  const seconds = Number(/Total time:\s+([\d.]+)s/.exec(output)?.[1]);
  const megabytes = Number(/Memory used:\s+(\d+)K/.exec(output)?.[1]) / 1024;
  return { size, seconds, megabytes };
}

const templates = await mockNodes();
const results: Result[] = [];
for (const size of SIZES) {
  // Sequential on purpose: parallel tsc runs would distort each other's timings.
  // oxlint-disable-next-line no-await-in-loop
  results.push(await measure(size, templates));
}
console.log("nodes  total    memory");
for (const { size, seconds, megabytes } of results) {
  console.log(`${String(size).padStart(5)}  ${seconds.toFixed(2)} s   ${megabytes.toFixed(0)} MB`);
}
const measured = results.find((result) => result.size === BUDGET.size);
if (
  measured === undefined ||
  measured.seconds > BUDGET.seconds ||
  measured.megabytes > BUDGET.megabytes
) {
  console.error(
    `Over budget at ${String(BUDGET.size)} nodes: at most ${String(BUDGET.seconds)} s and ${String(BUDGET.megabytes)} MB.`,
  );
  process.exitCode = 1;
}
