// The client against a real ComfyUI server: `bun run test:live`, never in `check` or CI (plan
// §17, ADR-0023). It queues model-free prompts (empty images, blurs, text), so it costs no GPU
// time; set TSCOMFY_LIVE_URL for a server other than http://127.0.0.1:8188. Saved files go to
// the server's output/tscomfy-live/, uploads to its temp directory.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type Connection,
  connect,
  fetchFile,
  type JobEvent,
  type Outcome,
  outputFiles,
  outputOf,
  submit,
  uploadFile,
} from "@tscomfy/client";
import { type ApiPrompt, normalizeObjectInfo, typedSchema, workflow } from "@tscomfy/core";
import type { LooseNodes } from "./loose.ts";

const url = process.env["TSCOMFY_LIVE_URL"] ?? "http://127.0.0.1:8188";
let comfy: Connection;
let schema: ReturnType<typeof typedSchema<LooseNodes>>;

beforeAll(async () => {
  comfy = await connect({ url });
  const text = await (await fetch(`${url}/object_info`)).text();
  schema = typedSchema<LooseNodes>(normalizeObjectInfo(text).schema);
});

afterAll(async () => {
  await comfy.close();
});

async function collect(events: AsyncIterable<JobEvent>): Promise<JobEvent[]> {
  const seen: JobEvent[] = [];
  for await (const event of events) seen.push(event);
  return seen;
}

/** A color no earlier run used, so nothing is cached. */
const fresh = (): number => Math.floor(Math.random() * 0xffffff);

/** A chain of blurs over a large image: long enough to cancel, with node boundaries to stop at. */
function slow(): ReturnType<typeof workflow<LooseNodes>> {
  return workflow(schema, ({ n }) => {
    let image = n["EmptyImage"]!({ width: 2048, height: 2048, batch_size: 1, color: fresh() });
    for (let step = 0; step < 12; step++) {
      image = n["ImageBlur"]!({ image, blur_radius: 31, sigma: 10 });
    }
    n["PreviewImage"]!({ images: image });
  });
}

function statusOf(outcome: Outcome): string {
  return outcome.status;
}

describe("against a real server", () => {
  test("a workflow runs, streams events, and its saved image downloads by handle", async () => {
    const built = workflow(schema, ({ n }) => {
      const image = n["EmptyImage"]!({ width: 48, height: 32, batch_size: 1, color: fresh() });
      const save = n["SaveImage"]!({
        images: n["ImageInvert"]!({ image }),
        filename_prefix: "tscomfy-live/run",
      });
      const preview = n["PreviewImage"]!({ images: image });
      return { save, preview };
    });
    const job = submit(comfy, built);
    const events = await collect(job.events);
    const outcome = await job.outcome;
    expect(statusOf(outcome)).toBe("success");
    expect(events[0]).toEqual({ type: "started" });
    expect(events.filter((event) => event.type === "output")).toHaveLength(2);

    const [saved] = outputFiles(outcome, built.handles.save);
    expect(saved).toMatchObject({
      type: "output",
      subfolder: "tscomfy-live",
      kind: "image",
      width: 48,
      height: 32,
    });
    const [previewed] = outputFiles(outcome, built.handles.preview);
    expect(previewed).toMatchObject({ type: "temp", kind: "image" });
    if (saved === undefined) throw new Error("no saved file");
    const data = await fetchFile(comfy, saved);
    expect(data.mime).toBe("image/png");
    expect(Array.from(data.bytes.subarray(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  test("a 63-bit integer travels to the node and back exactly", async () => {
    const big = 9223372036854775807n;
    const built = workflow(schema, ({ n }) => {
      const value = n["PrimitiveInt"]!({ value: big });
      return { shown: n["PreviewAny"]!({ source: value }) };
    });
    const outcome = await submit(comfy, built).outcome;
    if (outcome.status !== "success") throw new Error(outcome.status);
    expect(outputOf(outcome, built.handles.shown)?.text).toEqual([big.toString()]);
  });

  test("SaveImageWebsocket's image arrives as a preview of its node", async () => {
    const built = workflow(schema, ({ n }) => {
      const image = n["EmptyImage"]!({ width: 8, height: 8, batch_size: 1, color: fresh() });
      return { socket: n["SaveImageWebsocket"]!({ images: image }) };
    });
    const job = submit(comfy, built);
    const previews = (await collect(job.events)).filter((event) => event.type === "preview");
    expect(previews).toHaveLength(1);
    expect(previews[0]).toMatchObject({ node: built.handles.socket.id, mime: "image/png" });
    expect(statusOf(await job.outcome)).toBe("success");
  });

  test("the server's own validation rejects, as diagnostics", async () => {
    // Sent as a prompt: the schema would refuse it before it left (blur_radius max is 31).
    const prompt: ApiPrompt = {
      "1": { class_type: "EmptyImage", inputs: { width: 8, height: 8, batch_size: 1, color: 0 } },
      "2": { class_type: "ImageBlur", inputs: { image: ["1", 0], blur_radius: 99, sigma: 1 } },
      "3": { class_type: "PreviewImage", inputs: { images: ["2", 0] } },
    };
    const outcome = await submit(comfy, prompt).outcome;
    expect(statusOf(outcome)).toBe("rejected");
    expect(outcome.diagnostics.map((each) => [each.code, each.path])).toEqual([
      ["E_PROMPT_REJECTED", []],
      ["E_SERVER_VALIDATION", ["2", "inputs", "blur_radius"]],
    ]);
  });

  test("a node error fails the job", async () => {
    const built = workflow(schema, ({ n }) => {
      const value = n["PrimitiveInt"]!({ value: fresh() });
      const math = n["ComfyMathExpression"]!(
        { expression: "a / 0", values: [value] },
        { id: "math" },
      );
      n["PreviewAny"]!({ source: math[0] });
    });
    const outcome = await submit(comfy, built).outcome;
    if (outcome.status !== "failed") throw new Error(outcome.status);
    expect(outcome.error).toMatchObject({ node: "math", exceptionType: "ZeroDivisionError" });
  });

  test("cancel() interrupts a running job; a queued one is cancelled before it starts", async () => {
    const running = submit(comfy, slow());
    const queued = submit(comfy, slow());
    for await (const event of running.events) {
      if (event.type === "executing") {
        await queued.cancel();
        await running.cancel();
      }
    }
    expect(statusOf(await queued.outcome)).toBe("cancelled");
    expect(statusOf(await running.outcome)).toBe("cancelled");
  });

  test("an uploaded image feeds LoadImage", async () => {
    const source = workflow(schema, ({ n }) => {
      const image = n["EmptyImage"]!({ width: 16, height: 16, batch_size: 1, color: fresh() });
      return { preview: n["PreviewImage"]!({ images: image }) };
    });
    const first = await submit(comfy, source).outcome;
    const [file] = outputFiles(first, source.handles.preview);
    if (file === undefined) throw new Error("no preview");
    const bytes = (await fetchFile(comfy, file)).bytes;
    const uploaded = await uploadFile(
      comfy,
      { name: "tscomfy-live.png", bytes, mime: "image/png" },
      { type: "temp", subfolder: "tscomfy-live" },
    );
    expect(uploaded.value).toMatch(/^tscomfy-live\/tscomfy-live.*\.png \[temp\]$/);
    const built = workflow(schema, ({ n }) => {
      const [image] = n["LoadImage"]!({ image: uploaded.value });
      return { preview: n["PreviewImage"]!({ images: image }) };
    });
    const outcome = await submit(comfy, built).outcome;
    expect(statusOf(outcome)).toBe("success");
    expect(outputFiles(outcome, built.handles.preview)[0]).toMatchObject({ width: 16, height: 16 });
  });
});
