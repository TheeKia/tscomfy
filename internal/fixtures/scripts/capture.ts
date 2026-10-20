// Records the raw protocol of real runs on a ComfyUI server, for distilling protocol mocks
// (docs/plan.md Phase 10). It queues prompts, so run it only on your own server:
//
//   bun internal/fixtures/scripts/capture.ts [--url http://127.0.0.1:8188] [scenario…]
//
// Each scenario writes corpus/protocol/<scenario>.json (gitignored): every websocket frame (text
// verbatim; binary as its type, metadata and byte count) and every HTTP exchange, with times.
// The scenarios use model-free nodes only, so they cost no GPU time, except `sampler`, which
// needs a checkpoint and is run only when named.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

type Prompt = Record<string, { class_type: string; inputs: Record<string, unknown> }>;

interface Entry {
  readonly at: number;
  readonly kind: "ws-text" | "ws-binary" | "http" | "note";
  readonly [key: string]: unknown;
}

interface Session {
  readonly url: string;
  readonly clientId: string;
  readonly log: Entry[];
  socket: WebSocket;
  readonly start: number;
  note(text: string): void;
  post(path: string, body: unknown): Promise<{ status: number; text: string }>;
  get(path: string): Promise<{ status: number; text: string }>;
  /** Waits for `executing` with `node: null` for the prompt. */
  finished(promptId: string, timeoutMs?: number): Promise<void>;
  /** Waits for `executing` of a node of the prompt. */
  executing(promptId: string, node: string): Promise<void>;
  reopen(): Promise<void>;
  close(): void;
}

const args = process.argv.slice(2);
const urlFlag = args.indexOf("--url");
const base = (urlFlag === -1 ? "http://127.0.0.1:8188" : args[urlFlag + 1]) ?? "";
const named = args.filter(
  (arg, index) =>
    !arg.startsWith("--") && args[index - 1] !== "--url" && args[index - 1] !== "--ckpt",
);
const out = join(import.meta.dir, "..", "corpus", "protocol");

const image = (width = 64, height = 64, color = 0x3366cc): Prompt[string] => ({
  class_type: "EmptyImage",
  inputs: { width, height, batch_size: 1, color },
});

/** A chain of blurs over a large image: seconds of work, with node boundaries to stop at. */
function slow(steps: number): Prompt {
  // A fresh color, so no node is cached from an earlier run.
  const prompt: Prompt = { "1": image(2048, 2048, Math.floor(Math.random() * 0xffffff)) };
  for (let index = 0; index < steps; index++) {
    prompt[String(index + 2)] = {
      class_type: "ImageBlur",
      inputs: { image: [String(index + 1), 0], blur_radius: 31, sigma: 10 },
    };
  }
  prompt["99"] = { class_type: "PreviewImage", inputs: { images: [String(steps + 1), 0] } };
  return prompt;
}

const SCENARIOS: Record<string, (session: Session) => Promise<void>> = {
  /** Two outputs, a saved and a previewed image, then the same prompt again (all cached). */
  async success(session) {
    const prompt: Prompt = {
      "1": image(),
      "2": { class_type: "ImageInvert", inputs: { image: ["1", 0] } },
      "3": {
        class_type: "SaveImage",
        inputs: { images: ["2", 0], filename_prefix: "tscomfy-capture/run" },
      },
      "4": { class_type: "PreviewImage", inputs: { images: ["1", 0] } },
    };
    await run(session, prompt, "first");
    await run(session, prompt, "cached");
  },
  /** Full-size PNGs over the websocket, and text from PreviewAny. */
  async websocket(session) {
    await run(session, {
      "1": image(32, 16),
      "2": { class_type: "SaveImageWebsocket", inputs: { images: ["1", 0] } },
      "3": { class_type: "PreviewAny", inputs: { source: ["1", 0] } },
    });
  },
  /** Refused prompts: no output node, an unknown class, an invalid input. */
  async rejected(session) {
    await run(session, { "1": image() }, "no-output");
    await run(
      session,
      {
        "1": { class_type: "NoSuchNodeForCapture", inputs: {} },
        "2": { class_type: "PreviewImage", inputs: { images: ["1", 0] } },
      },
      "unknown-class",
    );
    await run(
      session,
      {
        "1": image(),
        "2": { class_type: "ImageBlur", inputs: { image: ["1", 0], blur_radius: 99, sigma: 1 } },
        "3": { class_type: "PreviewImage", inputs: { images: ["2", 0] } },
      },
      "invalid-input",
    );
  },
  /** One output valid, one not: the server runs the valid one and reports the other. */
  async partial(session) {
    await run(session, {
      "1": image(),
      "2": { class_type: "PreviewImage", inputs: { images: ["1", 0] } },
      "3": { class_type: "ImageBlur", inputs: { image: ["1", 0], blur_radius: 99, sigma: 1 } },
      "4": { class_type: "PreviewImage", inputs: { images: ["3", 0] } },
    });
  },
  /** A node that raises while running (a division by zero), after an output ran. */
  async error(session) {
    await run(session, {
      "1": image(64, 64, Math.floor(Math.random() * 0xffffff)),
      "2": { class_type: "PreviewImage", inputs: { images: ["1", 0] } },
      "3": { class_type: "PrimitiveInt", inputs: { value: Math.floor(Math.random() * 1000) } },
      "4": {
        class_type: "ComfyMathExpression",
        inputs: { expression: "a / 0", "values.a": ["3", 0] },
      },
      "5": { class_type: "PreviewAny", inputs: { source: ["4", 0] } },
    });
  },
  /** Cancels a running job through the job API, at a node boundary. */
  async cancel(session) {
    const id = await accepted(session, slow(8), "running");
    await session.executing(id, "3");
    session.note("cancel running");
    await session.post(`/api/jobs/${id}/cancel`, {});
    await session.finished(id);
    await record(session, id);
  },
  /** Cancels a job while it waits behind another; its record is gone afterwards. */
  async pending(session) {
    const first = await accepted(session, slow(4), "first");
    const second = await accepted(session, slow(2), "second");
    session.note("cancel pending");
    await session.post(`/api/jobs/${second}/cancel`, {});
    await record(session, second);
    await session.finished(first);
    await record(session, first);
    await record(session, second);
  },
  /** Drops the websocket mid-run and reopens it with the same client id. */
  async reconnect(session) {
    const id = await accepted(session, slow(6), "running");
    await session.executing(id, "3");
    session.note("close socket");
    await session.reopen();
    session.note("reopened");
    await record(session, id);
    await waitForRecord(session, id);
  },
  /**
   * A loop: the server runs a copy of the body per iteration, each with its own id, displayed as
   * the body's node. A preview outside the loop comes first in the prompt.
   */
  async loop(session) {
    // A fresh size, so no copy is cached from an earlier run.
    const width = 8 + Math.floor(Math.random() * 56);
    await run(session, {
      single: image(width, 8),
      shown: { class_type: "PreviewImage", inputs: { images: ["single", 0] } },
      start: {
        class_type: "StartLoop",
        inputs: { mode: "simple", "mode.num_iterations": 3, cache_iterations: false },
      },
      img: {
        class_type: "EmptyImage",
        inputs: { width, height: 8, batch_size: 1, color: ["start", 0] },
      },
      preview: { class_type: "PreviewImage", inputs: { images: ["img", 0] } },
      end: {
        class_type: "EndLoop",
        inputs: { accumulate: false, "terminations.termination0": ["preview", 0] },
      },
    });
  },
  /** Latent previews from a sampler; needs a checkpoint (pass --ckpt <name>). */
  async sampler(session) {
    const ckptFlag = args.indexOf("--ckpt");
    const ckpt = ckptFlag === -1 ? undefined : args[ckptFlag + 1];
    if (ckpt === undefined) throw new Error("sampler: pass --ckpt <checkpoint name>");
    const prompt: Prompt = {
      "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: ckpt } },
      "2": { class_type: "CLIPTextEncode", inputs: { clip: ["1", 1], text: "a lighthouse" } },
      "3": { class_type: "CLIPTextEncode", inputs: { clip: ["1", 1], text: "" } },
      "4": { class_type: "EmptyLatentImage", inputs: { width: 512, height: 512, batch_size: 1 } },
      "5": {
        class_type: "KSampler",
        inputs: {
          model: ["1", 0],
          positive: ["2", 0],
          negative: ["3", 0],
          latent_image: ["4", 0],
          seed: 18446744073709551615n,
          steps: 6,
          cfg: 6,
          sampler_name: "euler",
          scheduler: "normal",
          denoise: 1,
        },
      },
      "6": { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: ["1", 2] } },
      "7": { class_type: "PreviewImage", inputs: { images: ["6", 0] } },
    };
    await run(session, prompt, "latent2rgb", { preview_method: "latent2rgb" });
  },
};

/** Queues a prompt, waits for its end and reads its record. */
async function run(
  session: Session,
  prompt: Prompt,
  label = "run",
  extra: Record<string, unknown> = {},
): Promise<void> {
  const id = await queue(session, prompt, label, extra);
  if (id === undefined) return;
  await session.finished(id);
  await record(session, id);
}

/** Posts a prompt with a fresh prompt id; returns it when the server accepted the prompt. */
async function queue(
  session: Session,
  prompt: Prompt,
  label: string,
  extra: Record<string, unknown> = {},
): Promise<string | undefined> {
  const id = crypto.randomUUID();
  session.note(`queue ${label} ${id}`);
  const answer = await session.post("/prompt", {
    prompt,
    client_id: session.clientId,
    prompt_id: id,
    extra_data: extra,
  });
  return answer.status === 200 ? id : undefined;
}

/** Queues a prompt that must be accepted. */
async function accepted(session: Session, prompt: Prompt, label: string): Promise<string> {
  const id = await queue(session, prompt, label);
  if (id === undefined) throw new Error(`${label}: the server refused the prompt`);
  return id;
}

async function record(session: Session, id: string): Promise<void> {
  await session.get(`/api/jobs/${id}`);
  await session.get(`/history/${id}`);
}

async function waitForRecord(session: Session, id: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    // oxlint-disable-next-line no-await-in-loop -- polling: one read at a time
    const answer = await session.get(`/api/jobs/${id}`);
    if (!/"status": ?"(pending|in_progress)"/.test(answer.text)) return;
    // oxlint-disable-next-line no-await-in-loop -- polling: one read at a time
    await Bun.sleep(500);
  }
}

/** Big integers survive: the capture script writes them as JSON numbers. */
function body(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "bigint" ? `__bigint__${item.toString()}` : item,
  ).replaceAll(/"__bigint__(\d+)"/g, "$1");
}

async function openSession(): Promise<Session> {
  const clientId = crypto.randomUUID();
  const log: Entry[] = [];
  const start = performance.now();
  const at = (): number => Math.round(performance.now() - start);
  const waiters = new Set<(entry: Entry) => boolean>();
  const push = (entry: Entry): void => {
    log.push(entry);
    for (const waiter of waiters) if (waiter(entry)) waiters.delete(waiter);
  };
  const open = async (): Promise<WebSocket> => {
    const socket = new WebSocket(`${base.replace(/^http/, "ws")}/ws?clientId=${clientId}`);
    socket.binaryType = "arraybuffer";
    socket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        push({ at: at(), kind: "ws-text", data: event.data });
        return;
      }
      if (event.data instanceof ArrayBuffer) {
        push({ at: at(), kind: "ws-binary", ...describeFrame(event.data) });
      }
    });
    socket.addEventListener("close", () => {
      push({ at: at(), kind: "note", text: "socket closed" });
    });
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => {
        socket.send(
          JSON.stringify({ type: "feature_flags", data: { supports_preview_metadata: true } }),
        );
      });
      const check = (entry: Entry): boolean => {
        if (entry.kind === "ws-text" && String(entry["data"]).includes('"feature_flags"')) {
          resolve();
          return true;
        }
        return false;
      };
      waiters.add(check);
      socket.addEventListener("error", () => reject(new Error("websocket failed")));
    });
    return socket;
  };
  const exchange = async (method: string, path: string, payload?: unknown) => {
    const text = payload === undefined ? undefined : body(payload);
    const response = await fetch(`${base}${path}`, {
      method,
      ...(text === undefined
        ? {}
        : { body: text, headers: { "content-type": "application/json" } }),
    });
    const answer = { status: response.status, text: await response.text() };
    push({ at: at(), kind: "http", method, path, request: text, ...answer });
    return answer;
  };
  const waitFor = (test: (entry: Entry) => boolean, timeoutMs: number): Promise<void> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out")), timeoutMs);
      waiters.add((entry) => {
        if (!test(entry)) return false;
        clearTimeout(timer);
        resolve();
        return true;
      });
    });
  const textOf = (entry: Entry): string => (entry.kind === "ws-text" ? String(entry["data"]) : "");
  const session: Session = {
    url: base,
    clientId,
    log,
    start,
    socket: await open(),
    note: (text) => push({ at: at(), kind: "note", text }),
    post: (path, payload) => exchange("POST", path, payload),
    get: (path) => exchange("GET", path),
    finished: (id, timeoutMs = 120_000) =>
      waitFor((entry) => {
        const text = textOf(entry);
        return text.includes('"executing"') && text.includes(id) && text.includes('"node": null');
      }, timeoutMs),
    executing: (id, node) =>
      waitFor((entry) => {
        const text = textOf(entry);
        return (
          text.includes('"executing"') && text.includes(id) && text.includes(`"node": "${node}"`)
        );
      }, 120_000),
    reopen: async () => {
      const closed = new Promise((resolve) => session.socket.addEventListener("close", resolve));
      session.socket.close();
      await closed;
      session.socket = await open();
    },
    close: () => {
      session.socket.close();
    },
  };
  return session;
}

function describeFrame(data: ArrayBuffer): Record<string, unknown> {
  const view = new DataView(data);
  const type = view.getUint32(0);
  if (type === 4) {
    const length = view.getUint32(4);
    const metadata = new TextDecoder().decode(new Uint8Array(data, 8, length));
    return { type, metadata, imageBytes: data.byteLength - 8 - length };
  }
  if (type === 3) {
    const length = view.getUint32(4);
    const node = new TextDecoder().decode(new Uint8Array(data, 8, length));
    const text = new TextDecoder().decode(new Uint8Array(data, 8 + length));
    return { type, node, text };
  }
  return { type, bytes: data.byteLength };
}

const stats: unknown = await (await fetch(`${base}/system_stats`)).json();
const system: unknown =
  typeof stats === "object" && stats !== null ? Reflect.get(stats, "system") : undefined;
const version: unknown =
  typeof system === "object" && system !== null
    ? Reflect.get(system, "comfyui_version")
    : undefined;
await mkdir(out, { recursive: true });
for (const name of named.length === 0
  ? Object.keys(SCENARIOS).filter((n) => n !== "sampler")
  : named) {
  const scenario = SCENARIOS[name];
  if (scenario === undefined) throw new Error(`unknown scenario ${name}`);
  // Scenarios run one at a time, each on its own connection.
  // oxlint-disable-next-line no-await-in-loop -- one scenario at a time
  const session = await openSession();
  process.stdout.write(`${name}… `);
  try {
    // oxlint-disable-next-line no-await-in-loop -- one scenario at a time
    await scenario(session);
    // oxlint-disable-next-line no-await-in-loop -- one scenario at a time
    await Bun.sleep(300);
  } finally {
    session.close();
  }
  // oxlint-disable-next-line no-await-in-loop -- one scenario at a time
  await writeFile(
    join(out, `${name}.json`),
    JSON.stringify(
      {
        scenario: name,
        comfyVersion: typeof version === "string" ? version : "unknown",
        clientId: session.clientId,
        log: session.log,
      },
      undefined,
      1,
    ),
  );
  process.stdout.write(`${String(session.log.length)} entries\n`);
}
