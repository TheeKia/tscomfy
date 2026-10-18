// Output kinds on a real server (test:live only): animated images, video and audio from
// model-free nodes, each read as an `OutputFile` and downloaded, its bytes checked by signature.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type Connection,
  connect,
  fetchFile,
  type NodeRef,
  type Outcome,
  type OutputFile,
  outputFiles,
  submit,
} from "@tscomfy/client";
import { workflow } from "@tscomfy/core";
import { fresh, LIVE_URL, liveSchema } from "./live.ts";

let comfy: Connection;
let outcome: Outcome;
let handles: Record<"webp" | "apng" | "audio" | "video" | "webm" | "heard", NodeRef>;

beforeAll(async () => {
  comfy = await connect({ url: LIVE_URL });
  const built = workflow(await liveSchema(), ({ n }) => {
    // Four frames of 64×48, each a different color, so encoders keep them all.
    const frames = n["ImageBatch"]!({
      image1: n["ImageBatch"]!({
        image1: n["EmptyImage"]!({ width: 64, height: 48, batch_size: 1, color: fresh() }),
        image2: n["EmptyImage"]!({ width: 64, height: 48, batch_size: 1, color: fresh() }),
      }),
      image2: n["EmptyImage"]!({ width: 64, height: 48, batch_size: 2, color: fresh() }),
    });
    const audio = n["EmptyAudio"]!({ duration: 1, sample_rate: 44100, channels: 2 });
    return {
      webp: n["SaveAnimatedWEBP"]!({
        images: frames,
        filename_prefix: "tscomfy-live/anim",
        fps: 8,
        lossless: true,
        quality: 80,
        method: "default",
      }),
      apng: n["SaveAnimatedPNG"]!({
        images: frames,
        filename_prefix: "tscomfy-live/anim",
        fps: 8,
        compress_level: 4,
      }),
      audio: n["SaveAudio"]!({ audio, filename_prefix: "tscomfy-live/audio" }),
      video: n["SaveVideo"]!({
        video: n["CreateVideo"]!({ images: frames, fps: 8, audio }),
        filename_prefix: "tscomfy-live/video",
        format: { option: "mp4", inputs: { codec: "h264" } },
      }),
      webm: n["SaveWEBM"]!({
        images: frames,
        filename_prefix: "tscomfy-live/webm",
        codec: "vp9",
        fps: 8,
        crf: 32,
      }),
      heard: n["PreviewAudio"]!({ audio }),
    };
  });
  handles = built.handles;
  outcome = await submit(comfy, built, { signal: AbortSignal.timeout(120_000) }).outcome;
}, 150_000);

afterAll(async () => {
  await comfy.close();
});

function only(node: NodeRef): OutputFile {
  const files = outputFiles(outcome, node);
  expect(files).toHaveLength(1);
  const [file] = files;
  if (file === undefined) throw new Error("no file");
  return file;
}

async function bytesOf(file: OutputFile): Promise<{ bytes: Uint8Array; mime: string }> {
  return fetchFile(comfy, file);
}

const ascii = (bytes: Uint8Array, start: number, end: number): string =>
  String.fromCharCode(...bytes.subarray(start, end));

describe("output kinds from a real server", () => {
  test("the job succeeds", () => {
    expect(outcome.status).toBe("success");
  });

  test("an animated WEBP is an animated image", async () => {
    const file = only(handles.webp);
    expect(file).toMatchObject({ kind: "image", animated: true, key: "images", type: "output" });
    expect(file.filename).toEndWith(".webp");
    const { bytes, mime } = await bytesOf(file);
    expect(mime).toBe("image/webp");
    expect([ascii(bytes, 0, 4), ascii(bytes, 8, 12)]).toEqual(["RIFF", "WEBP"]);
    expect(ascii(bytes, 0, 200)).toContain("ANIM");
  });

  test("an animated PNG is an animated image", async () => {
    const file = only(handles.apng);
    expect(file).toMatchObject({ kind: "image", animated: true, type: "output" });
    const { bytes, mime } = await bytesOf(file);
    expect(mime).toBe("image/png");
    expect(Array.from(bytes.subarray(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(ascii(bytes, 0, 200)).toContain("acTL");
  });

  test("a video with audio is a video, measured, though listed under images", async () => {
    const file = only(handles.video);
    expect(file).toMatchObject({
      kind: "video",
      animated: true,
      key: "images",
      width: 64,
      height: 48,
    });
    expect(file.filename).toEndWith(".mp4");
    const { bytes, mime } = await bytesOf(file);
    expect(mime).toBe("video/mp4");
    expect(ascii(bytes, 4, 8)).toBe("ftyp");
  });

  test("a WEBM is a video", async () => {
    const file = only(handles.webm);
    expect(file).toMatchObject({ kind: "video", key: "images" });
    const { bytes, mime } = await bytesOf(file);
    expect(mime).toBe("video/webm");
    expect(Array.from(bytes.subarray(0, 4))).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
  });

  test("saved and previewed audio are audio", async () => {
    const saved = only(handles.audio);
    expect(saved).toMatchObject({ kind: "audio", key: "audio", type: "output", animated: false });
    const { bytes } = await bytesOf(saved);
    expect(ascii(bytes, 0, 4)).toBe("fLaC");
    expect(only(handles.heard)).toMatchObject({ kind: "audio", key: "audio", type: "temp" });
  });
});
