import { describe, expect, test } from "bun:test";
import { normalizeObjectInfo } from "@tscomfy/core";
import { listCorpus } from "@tscomfy/fixtures";
import { runExample } from "./example.ts";

// examples/txt2img over each real dump: it must type-check, and run when the server has a model.

const dumps = await listCorpus("object-info");

async function hasCheckpoints(path: string): Promise<boolean> {
  const { schema } = normalizeObjectInfo(await Bun.file(path).text());
  const input = schema.nodes["CheckpointLoaderSimple"]?.inputs.find(
    (each) => each.name === "ckpt_name",
  );
  return input?.kind === "combo" && input.options.length > 0;
}

describe("examples/txt2img over the corpus", () => {
  if (dumps.length === 0) test.skip("object-info is empty", () => {});

  for (const dump of dumps) {
    test(
      dump.name,
      async () => {
        const {
          tsc,
          mains: [main],
        } = await runExample("txt2img", dump.path, [["a cat"]]);
        expect(tsc).toEqual({ code: 0, stdout: "", stderr: "" });
        // A server without checkpoints can't build the prompt; the example says so and exits 1.
        if (!(await hasCheckpoints(dump.path))) {
          expect(main?.code).toBe(1);
          expect(main?.stderr).toStartWith("The server lists no checkpoints");
          return;
        }
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

describe("examples/hires-fix over the corpus", () => {
  if (dumps.length === 0) test.skip("object-info is empty", () => {});

  for (const dump of dumps) {
    test(
      dump.name,
      async () => {
        const {
          tsc,
          mains: [main],
        } = await runExample("hires-fix", dump.path, [["a fox"]]);
        expect(tsc).toEqual({ code: 0, stdout: "", stderr: "" });
        if (!(await hasCheckpoints(dump.path))) {
          expect(main?.code).toBe(1);
          expect(main?.stderr).toStartWith("The server lists no checkpoints");
          return;
        }
        // Diagnostics go to stderr; a real server may warn (an unlisted file, …), never error.
        expect(main?.code).toBe(0);
        const classTypes = [...(main?.stdout ?? "").matchAll(/"class_type":"(\w+)"/g)];
        expect(classTypes.map((match) => match[1])).toContain("LatentUpscaleBy");
      },
      60_000,
    );
  }
});
