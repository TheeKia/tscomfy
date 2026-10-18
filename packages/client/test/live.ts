// Helpers for the live tests (`*.live.test.ts`, run by `bun run test:live` only): the server, its
// schema, and model-free workflows. Set TSCOMFY_LIVE_URL for a server other than
// http://127.0.0.1:8188.

import type { JobEvent } from "@tscomfy/client";
import {
  normalizeObjectInfo,
  type TypedSchema,
  typedSchema,
  type Workflow,
  workflow,
} from "@tscomfy/core";
import type { LooseNodes } from "./loose.ts";

export const LIVE_URL: string = process.env["TSCOMFY_LIVE_URL"] ?? "http://127.0.0.1:8188";

let cached: Promise<TypedSchema<LooseNodes>> | undefined;

/** The live server's schema, typed loosely; read once per process. */
export function liveSchema(): Promise<TypedSchema<LooseNodes>> {
  cached ??= fetch(`${LIVE_URL}/object_info`)
    .then((response) => response.text())
    .then((text) => typedSchema<LooseNodes>(normalizeObjectInfo(text).schema));
  return cached;
}

/** A color no earlier run used, so nothing is cached. */
export function fresh(): number {
  return Math.floor(Math.random() * 0xffffff);
}

/** A small image, previewed: a job of a few milliseconds. */
export function quick(schema: TypedSchema<LooseNodes>): Workflow<LooseNodes> {
  return workflow(schema, ({ n }) => {
    const image = n["EmptyImage"]!({ width: 16, height: 16, batch_size: 1, color: fresh() });
    return { preview: n["PreviewImage"]!({ images: image }) };
  });
}

/** Blurs of a large image, one node each: long enough to act on mid-run, with nodes to stop at. */
export function slow(schema: TypedSchema<LooseNodes>, steps = 12): Workflow<LooseNodes> {
  return workflow(schema, ({ n }) => {
    let image = n["EmptyImage"]!({ width: 2048, height: 2048, batch_size: 1, color: fresh() });
    for (let step = 0; step < steps; step++) {
      image = n["ImageBlur"]!({ image, blur_radius: 31, sigma: 10 }, { id: `blur${String(step)}` });
    }
    return { preview: n["PreviewImage"]!({ images: image }) };
  });
}

/** Every event, until the job ends. */
export async function collect(events: AsyncIterable<JobEvent>): Promise<JobEvent[]> {
  const seen: JobEvent[] = [];
  for await (const event of events) seen.push(event);
  return seen;
}
