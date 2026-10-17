import { describe, expect, test } from "bun:test";
import { listCorpus } from "@tscomfy/fixtures";
import { runExample } from "./example.ts";

// examples/txt2img over each real dump: it must type-check, and run when the server has a model.

const dumps = await listCorpus("object-info");

describe("examples/txt2img over the corpus", () => {
  if (dumps.length === 0) test.skip("object-info is empty", () => {});

  for (const dump of dumps) {
    test(
      dump.name,
      async () => {
        const { tsc, main } = await runExample(dump.path, "a cat");
        expect(tsc).toEqual({ code: 0, stdout: "", stderr: "" });
        if (main?.code === 1 && main.stderr.startsWith("The server lists no checkpoints")) return;
        expect(main?.stderr).toBe("");
        expect(main?.code).toBe(0);
        const classTypes = [...(main?.stdout ?? "").matchAll(/"class_type":"(\w+)"/g)];
        expect(classTypes.map((match) => match[1])).toEqual([
          "CheckpointLoaderSimple",
          "CLIPTextEncode",
          "CLIPTextEncode",
          "EmptyLatentImage",
          "KSampler",
          "VAEDecode",
          "SaveImage",
        ]);
      },
      60_000,
    );
  }
});
