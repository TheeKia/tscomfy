import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  ClientError,
  fetchFile,
  fileUrl,
  outputFiles,
  outputOf,
  uploadFile,
} from "@tscomfy/client";
import { workflow } from "@tscomfy/core";
import { FakeServer, readMockObjectInfo } from "@tscomfy/fixtures";
import { EventQueue } from "../src/event-queue.ts";
import type { JobEvent } from "../src/events.ts";
import { decodeFrame } from "../src/frames.ts";
import { readNodeOutput } from "../src/read-outputs.ts";
import { serverDiagnostics } from "../src/server-errors.ts";
import { randomUuid } from "../src/uuid.ts";
import { looseSchema } from "./loose.ts";

function frame(type: number, ...parts: Uint8Array[]): ArrayBuffer {
  const length = 4 + parts.reduce((sum, part) => sum + 4 + part.length, 0) - 4;
  const bytes = new Uint8Array(length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, type);
  let offset = 4;
  parts.forEach((part, index) => {
    // Every part but the last is length-prefixed.
    if (index < parts.length - 1) {
      view.setUint32(offset, part.length);
      offset += 4;
    }
    bytes.set(part, offset);
    offset += part.length;
  });
  return bytes.buffer.slice(0, offset);
}

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

describe("binary frames", () => {
  test("type 4: a preview with its node and prompt", () => {
    const metadata = {
      node_id: "5.0.0.1",
      display_node_id: "5",
      prompt_id: "p",
      image_type: "image/png",
    };
    const decoded = decodeFrame(
      frame(4, text(JSON.stringify(metadata)), Uint8Array.of(1, 2, 3)),
      false,
    );
    expect(decoded).toEqual({
      kind: "preview",
      promptId: "p",
      node: "5",
      mime: "image/png",
      bytes: Uint8Array.of(1, 2, 3),
    });
  });

  test("type 3: progress text, with a prompt id only when the server says so", () => {
    expect(decodeFrame(frame(3, text("7"), text("half done")), false)).toEqual({
      kind: "text",
      promptId: undefined,
      node: "7",
      text: "half done",
    });
    expect(decodeFrame(frame(3, text("p"), text("7"), text("ok")), true)).toMatchObject({
      promptId: "p",
      node: "7",
      text: "ok",
    });
  });

  test("type 1, unknown types and short or lying frames decode to nothing", () => {
    expect(decodeFrame(frame(1, Uint8Array.of(0, 0, 0, 1, 9)), false)).toBeUndefined();
    expect(decodeFrame(frame(9, Uint8Array.of(1)), false)).toBeUndefined();
    expect(decodeFrame(new ArrayBuffer(2), false)).toBeUndefined();
    const lying = new Uint8Array(12);
    new DataView(lying.buffer).setUint32(0, 4);
    new DataView(lying.buffer).setUint32(4, 1000);
    expect(decodeFrame(lying.buffer, false)).toBeUndefined();
    expect(decodeFrame(frame(4, text("[1]"), Uint8Array.of(1)), false)).toBeUndefined();
  });
});

const names = (files: readonly { readonly filename: string }[]): string[] =>
  files.map((file) => file.filename);

const progress = (node: string, value: number): JobEvent => ({
  type: "progress",
  node,
  value,
  max: 9,
});

describe("outputs", () => {
  test("files are found under any key, their kind by metadata, extension or key", () => {
    const output = readNodeOutput("9", {
      images: [
        {
          filename: "a.png",
          subfolder: "",
          type: "output",
          metadata: { kind: "image", width: 8, height: 4 },
        },
        { filename: "b.mp4", subfolder: "clips", type: "output" },
      ],
      animated: [true],
      audio: [{ filename: "c.flac", subfolder: "", type: "temp" }],
      "3d": [{ filename: "d.glb", subfolder: "", type: "output" }],
      gifs: [{ filename: "e.webm", subfolder: "", type: "output", format: "video/webm" }],
      latents: [{ filename: "f.latent", subfolder: "", type: "output" }],
      text: ["hello", 3],
      result: ["mesh.glb", null],
      camera_info: [{ position: 1 }],
    });
    expect(output.files.map((file) => [file.filename, file.kind, file.animated, file.key])).toEqual(
      [
        ["a.png", "image", true, "images"],
        ["b.mp4", "video", true, "images"],
        ["c.flac", "audio", false, "audio"],
        ["d.glb", "3d", false, "3d"],
        ["e.webm", "video", true, "gifs"],
        ["f.latent", "file", false, "latents"],
      ],
    );
    expect(output.files[0]).toMatchObject({ width: 8, height: 4 });
    expect(output.files[1]).not.toHaveProperty("width");
    expect(output.text).toEqual(["hello"]);
    expect(Object.isFrozen(output.files[0])).toBeTrue();
  });

  test("entries that aren't files are skipped", () => {
    const output = readNodeOutput("1", {
      images: [
        { filename: "", subfolder: "", type: "output" },
        { filename: "x.png", subfolder: "", type: "elsewhere" },
        { filename: "y.png", type: "temp" },
        "z.png",
      ],
    });
    expect(output.files.map((file) => [file.filename, file.subfolder])).toEqual([["y.png", ""]]);
  });

  test("outputFiles looks nodes up by id, handle or output reference", async () => {
    const schema = looseSchema(await readMockObjectInfo("basic-pipeline"));
    const handles = workflow(schema, ({ n }) => {
      const vae = n["VAELoader"]!({ vae_name: "pixel_space" }, { id: "2" });
      const save = n["SaveImage"]!({ images: n["VAEDecode"]!({ vae }, { id: "3" }) }, { id: "1" });
      return { vae, save };
    }).handles;
    const outputs = new Map([
      [
        "1",
        readNodeOutput("1", { images: [{ filename: "one.png", subfolder: "", type: "output" }] }),
      ],
      [
        "2",
        readNodeOutput("2", { images: [{ filename: "two.png", subfolder: "", type: "temp" }] }),
      ],
    ]);
    const outcome = { status: "success", outputs, diagnostics: [] } as const;
    expect(names(outputFiles(outcome, handles.save))).toEqual(["one.png"]);
    expect(names(outputFiles(outcome, handles.vae))).toEqual(["two.png"]);
    expect(names(outputFiles(outcome, "2", "1"))).toEqual(["two.png", "one.png"]);
    expect(names(outputFiles(outcome))).toEqual(["one.png", "two.png"]);
    expect(outputFiles({ status: "rejected", diagnostics: [] })).toEqual([]);
    expect(outputOf(outcome, handles.vae)?.node).toBe("2");
    expect(outputOf(outcome, "3")).toBeUndefined();
    expect(outputOf({ status: "rejected", diagnostics: [] }, "1")).toBeUndefined();
  });
});

describe("the event queue", () => {
  test("replaces an unread progress or preview of a node where it stands", async () => {
    const queue = new EventQueue();
    queue.push({ type: "started" });
    queue.push(progress("1", 1));
    queue.push(progress("2", 1));
    queue.push({ type: "executing", node: "3" });
    queue.push(progress("1", 2));
    queue.end();
    queue.push({ type: "started" });
    const seen: JobEvent[] = [];
    for await (const event of queue) seen.push(event);
    expect(seen).toEqual([
      { type: "started" },
      progress("1", 2),
      progress("2", 1),
      { type: "executing", node: "3" },
    ]);
  });

  test("keeps every progress text: each says something new", async () => {
    const queue = new EventQueue();
    for (const said of ["Downloading", "Loaded", "Generating"])
      queue.push({ type: "text", node: "5", text: said });
    queue.end();
    const seen: JobEvent[] = [];
    for await (const event of queue) seen.push(event);
    expect(seen.map((event) => (event.type === "text" ? event.text : ""))).toEqual([
      "Downloading",
      "Loaded",
      "Generating",
    ]);
  });

  test("next() called again before the first settles loses nothing", async () => {
    const queue = new EventQueue();
    const iterator = queue[Symbol.asyncIterator]();
    const first = iterator.next();
    const second = iterator.next();
    const third = iterator.next();
    queue.push(progress("1", 1));
    queue.push(progress("2", 1));
    queue.end();
    expect(await Promise.all([first, second, third])).toEqual([
      { done: false, value: progress("1", 1) },
      { done: false, value: progress("2", 1) },
      { done: true, value: undefined },
    ]);
  });

  test("a waiting consumer gets events as they come; breaking stops the buffer", async () => {
    const queue = new EventQueue();
    const iterator = queue[Symbol.asyncIterator]();
    const next = iterator.next();
    queue.push(progress("1", 1));
    expect(await next).toEqual({ done: false, value: progress("1", 1) });
    await iterator.return?.();
    queue.push(progress("1", 2));
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
  });
});

describe("server errors", () => {
  test("strings, odd shapes and repeated text read sensibly", () => {
    const diagnostics = serverDiagnostics("plain", {
      "4": { errors: [{ type: "t", message: "m", details: "m" }, "bare"] },
      "5": { type: "x", message: "", extra_info: { input_name: "" } },
    });
    expect(diagnostics.map((each) => [each.code, each.path, each.message])).toEqual([
      ["E_PROMPT_REJECTED", [], "plain"],
      ["E_SERVER_VALIDATION", ["4"], "t: m"],
      ["E_SERVER_VALIDATION", ["4"], "bare"],
      ["E_SERVER_VALIDATION", ["5"], "x"],
    ]);
  });
});

test("prompt ids are canonical lowercase version-4 UUIDs, all different", () => {
  const ids = Array.from({ length: 100 }, randomUuid);
  for (const id of ids) {
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  }
  expect(new Set(ids).size).toBe(100);
});

describe("files", () => {
  let fake: FakeServer;
  beforeEach(() => {
    fake = FakeServer.start();
  });
  afterEach(() => {
    fake.stop();
  });

  test("uploadFile sends the bytes and returns the widget value of the stored name", async () => {
    const uploaded = await uploadFile(
      { url: fake.url },
      { name: "cat.png", bytes: Uint8Array.of(1, 2), mime: "image/png" },
      { subfolder: "pets", type: "temp", overwrite: true },
    );
    expect(uploaded).toEqual({
      filename: "cat (1).png",
      subfolder: "pets",
      type: "temp",
      value: "pets/cat (1).png [temp]",
    });
    const request = fake.received.find((each) => each.path === "/upload/image");
    expect(request?.body).toContain('name="overwrite"');
    const plain = await uploadFile({ url: fake.url }, { name: "dog.png", bytes: Uint8Array.of(3) });
    expect(plain.value).toBe("dog (1).png");
  });

  test("fetchFile downloads bytes with their type; a missing file is a ClientError", async () => {
    const file = { filename: "a.png", subfolder: "x", type: "output" } as const;
    const data = await fetchFile({ url: fake.url }, file);
    expect(data.mime).toBe("image/png");
    expect(Array.from(data.bytes.subarray(1, 4))).toEqual([80, 78, 71]);
    expect(fake.received.at(-1)?.search).toBe("?filename=a.png&subfolder=x&type=output");
    const missing = fetchFile({ url: fake.url }, { ...file, filename: "missing.png" });
    expect(missing).rejects.toBeInstanceOf(ClientError);
    expect(missing).rejects.toMatchObject({ status: 404 });
  });

  test("fileUrl keeps the server's path and query", () => {
    expect(
      fileUrl(
        { url: "https://host/comfy/?token=t" },
        { filename: "a b.png", subfolder: "", type: "temp" },
      ),
    ).toBe("https://host/comfy/view?token=t&filename=a+b.png&subfolder=&type=temp");
  });
});
