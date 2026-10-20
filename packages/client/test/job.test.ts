import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  ClientError,
  type Connection,
  connect,
  type JobEvent,
  type Outcome,
  outputFiles,
  outputsOf,
  submit,
} from "@tscomfy/client";
import {
  type ApiPrompt,
  type Diagnostic,
  type JsonObject,
  type JsonValue,
  parse,
  ValidationError,
  workflow,
} from "@tscomfy/core";
import {
  FakeServer,
  type MockProtocolName,
  readMockObjectInfo,
  readMockProtocol,
  trace,
  type TraceRun,
} from "@tscomfy/fixtures";
import { looseSchema } from "./loose.ts";

let fake: FakeServer;
let comfy: Connection;

beforeEach(async () => {
  fake = FakeServer.start();
  comfy = await connect({ url: fake.url });
});

afterEach(async () => {
  await comfy.close();
  fake.stop();
});

async function collect(events: AsyncIterable<JobEvent>): Promise<JobEvent[]> {
  const seen: JobEvent[] = [];
  for await (const event of events) seen.push(event);
  return seen;
}

function isRecord(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isList(value: JsonValue | undefined): value is readonly JsonValue[] {
  return Array.isArray(value);
}

/** The prompt of a run, read losslessly from the mock (its seeds can pass 2^53). */
async function promptOf(name: MockProtocolName, index = 0): Promise<ApiPrompt> {
  const { value } = parse(await readMockProtocol(name));
  const runs = isRecord(value) ? value["runs"] : undefined;
  const run = isList(runs) ? runs[index] : undefined;
  const prompt = isRecord(run) ? run["prompt"] : undefined;
  if (!isRecord(prompt)) throw new Error("no prompt");
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the mocks hold prompts
  return prompt as ApiPrompt;
}

function runOf(runs: readonly TraceRun[], index = 0): TraceRun {
  const run = runs[index];
  if (run === undefined) throw new Error(`no run ${String(index)}`);
  return run;
}

const codes = (diagnostics: readonly Diagnostic[]): [string, readonly (string | number)[]][] =>
  diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.path]);

function expectStatus<S extends Outcome["status"]>(
  outcome: Outcome,
  status: S,
): Extract<Outcome, { status: S }> {
  expect(outcome.status).toBe(status);
  if (!hasStatus(outcome, status)) throw new Error(`expected ${status}`);
  return outcome;
}

function hasStatus<S extends Outcome["status"]>(
  outcome: Outcome,
  status: S,
): outcome is Extract<Outcome, { status: S }> {
  return outcome.status === status;
}

describe("a successful run", () => {
  test("streams events and settles from the record, outputs in prompt order", async () => {
    const run = runOf(await trace("success"));
    const prompt = await promptOf("success");
    fake.expect(run);
    const job = submit(comfy, prompt);
    const events = await collect(job.events);
    const outcome = expectStatus(await job.outcome, "success");

    expect(events.map((event) => event.type)).toEqual([
      "started",
      "cached",
      "progress",
      "executing",
      "progress",
      "progress",
      "executing",
      "output",
      "progress",
      "progress",
      "executing",
      "progress",
      "progress",
      "executing",
      "output",
      "progress",
    ]);
    expect([...outcome.outputs.keys()]).toEqual(["3", "4"]);
    expect(outputFiles(outcome, "3")).toEqual([
      {
        filename: "run_00001_.png",
        subfolder: "tscomfy-capture",
        type: "output",
        kind: "image",
        animated: false,
        key: "images",
        width: 64,
        height: 64,
      },
    ]);
    expect(outputFiles(outcome).map((file) => file.type)).toEqual(["output", "temp"]);
    expect(outcome.diagnostics).toEqual([]);
    expect(Object.isFrozen(outcome)).toBeTrue();
  });

  test("sends the client id, a fresh UUID prompt id and the prompt, losslessly", async () => {
    const run = runOf(await trace("sampler"));
    const prompt = await promptOf("sampler");
    fake.expect(run);
    const job = submit(comfy, prompt, { previews: "latent2rgb", front: true });
    await job.outcome;
    const posted = fake.received.find((request) => request.path === "/prompt");
    expect(posted?.body).toContain('"seed":18446744073709551615');
    const body = parse(posted?.body ?? "").value;
    expect(body).toMatchObject({
      client_id: comfy.clientId,
      prompt_id: job.id,
      extra_data: { preview_method: "latent2rgb" },
      front: true,
    });
    expect(job.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test("a cached rerun reports its outputs again", async () => {
    const run = runOf(await trace("success"), 1);
    const prompt = await promptOf("success", 1);
    fake.expect(run);
    const job = submit(comfy, prompt);
    const events = await collect(job.events);
    const outcome = expectStatus(await job.outcome, "success");
    expect(events[1]).toEqual({ type: "cached", nodes: ["1", "2", "3", "4"] });
    expect(events.filter((event) => event.type === "output").map((event) => event.node)).toEqual([
      "4",
      "3",
    ]);
    expect([...outcome.outputs.keys()]).toEqual(["3", "4"]);
  });

  test("a loop keeps every run: nodes in prompt order, each node's runs in the order they ran", async () => {
    const run = runOf(await trace("loop"));
    const prompt = await promptOf("loop");
    fake.expect(run);
    const job = submit(comfy, prompt);
    const events = await collect(job.events);
    const outcome = expectStatus(await job.outcome, "success");

    expect([...outcome.outputs.keys()]).toEqual(["shown", "preview"]);
    expect(outputsOf(outcome, "preview").map((output) => [output.node, output.id])).toEqual([
      ["preview", "start.0.0.0_preview"],
      ["preview", "start.0.0.1_preview"],
      ["preview", "start.0.0.2_preview"],
    ]);
    expect(outputFiles(outcome).map((file) => file.filename)).toEqual([
      "ComfyUI_temp_xxruu_00001_.png",
      "ComfyUI_temp_kvond_00001_.png",
      "ComfyUI_temp_uymei_00001_.png",
      "ComfyUI_temp_yxlkm_00001_.png",
    ]);
    expect(events.filter((event) => event.type === "output").map((event) => event.node)).toEqual([
      "shown",
      "preview",
      "preview",
      "preview",
    ]);
    // Each copy's progress once per change, under the node it is displayed as: the copies don't
    // undo each other's.
    const progress = (node: string): string[] =>
      events.flatMap((event) =>
        event.type === "progress" && event.node === node
          ? [`${String(event.value)}/${String(event.max)}`]
          : [],
      );
    expect(progress("preview")).toEqual(["0/1", "1/1", "0/1", "1/1", "0/1", "1/1"]);
    // `start` and the seven nodes it expands into (iteration_<i>, progress_<i>, result).
    expect(progress("start")).toHaveLength(16);
  });

  test("events that arrive before the answer to the POST are kept", async () => {
    const run = runOf(await trace("success"));
    const prompt = await promptOf("success");
    fake.expect(run, { eventsBeforeAnswer: run.events.length });
    const job = submit(comfy, prompt);
    const events = await collect(job.events);
    expect(events[0]).toEqual({ type: "started" });
    expect(expectStatus(await job.outcome, "success").outputs.size).toBe(2);
  });

  test("outputs are found by the workflow's own handles", async () => {
    const schema = looseSchema(await readMockObjectInfo("basic-pipeline"));
    // Node "3" is the trace's SaveImage; the other nodes get names, so no id collides with it.
    const built = workflow(schema, ({ n }) => {
      const [model, clip, vae] = n["CheckpointLoaderSimple"]!(
        { ckpt_name: "model-a.safetensors" },
        { id: "ckpt" },
      );
      const latent = n["KSampler"]!(
        {
          model,
          positive: n["CLIPTextEncode"]!({ clip, text: "a cat" }, { id: "pos" }),
          negative: n["CLIPTextEncode"]!({ clip, text: "" }, { id: "neg" }),
          latent_image: n["EmptyLatentImage"]!({}, { id: "latent" }),
          seed: 1,
          sampler_name: "euler",
          scheduler: "normal",
        },
        { id: "sample" },
      );
      const images = n["VAEDecode"]!({ samples: latent, vae }, { id: "decode" });
      const save = n["SaveImage"]!({ images }, { id: "3" });
      return { save };
    });
    fake.expect(runOf(await trace("success")));
    const outcome = await submit(comfy, built).outcome;
    expect(outputFiles(outcome, built.handles.save).map((file) => file.filename)).toEqual([
      "run_00001_.png",
    ]);
    const posted = parse(fake.received.find((request) => request.path === "/prompt")?.body ?? "");
    expect(posted.value).toMatchObject({ prompt: { "3": { class_type: "SaveImage" } } });
  });
});

describe("previews and progress", () => {
  test("type-4 frames become previews of their node", async () => {
    const run = runOf(await trace("websocket"));
    const prompt = await promptOf("websocket");
    fake.expect(run);
    const job = submit(comfy, prompt);
    const events = await collect(job.events);
    const preview = events.find((event) => event.type === "preview");
    expect(preview).toMatchObject({ type: "preview", node: "2", mime: "image/png" });
    expect(preview?.type === "preview" ? Array.from(preview.bytes.subarray(1, 4)) : []).toEqual([
      80, 78, 71,
    ]);
    const outcome = expectStatus(await job.outcome, "success");
    expect(outputsOf(outcome, "3").map((output) => output.text)).toEqual([
      ["tensor([[[[0.2000, 0.4000, 0.8000]]]])"],
    ]);
  });

  test("a real sampler run: step progress and a latent preview per step", async () => {
    const run = runOf(await trace("sampler"));
    const prompt = await promptOf("sampler");
    fake.expect(run);
    const job = submit(comfy, prompt, { previews: "latent2rgb" });
    const events = await collect(job.events);
    expect(
      events
        .filter((event) => event.type === "progress" && event.node === "5")
        .map((event) => (event.type === "progress" ? [event.value, event.max] : [])),
    ).toEqual([
      [0, 1],
      [1, 6],
      [2, 6],
      [3, 6],
      [4, 6],
      [5, 6],
      [6, 6],
    ]);
    const previews = events.filter((event) => event.type === "preview");
    expect(previews).toHaveLength(6);
    expect(previews.every((event) => event.node === "5" && event.mime === "image/jpeg")).toBeTrue();
    const outcome = expectStatus(await job.outcome, "success");
    expect(outputFiles(outcome)).toMatchObject([{ kind: "image", type: "temp", width: 512 }]);
  });

  test("progress text and a blocked node", async () => {
    const run = runOf(await trace("blocked"));
    const prompt = await promptOf("blocked");
    fake.expect(run);
    const job = submit(comfy, prompt);
    const events = await collect(job.events);
    expect(events).toContainEqual({ type: "text", node: "5", text: "sampling done" });
    expect(events).toContainEqual({
      type: "blocked",
      node: "8",
      message: "Execution Blocked: no faces found",
    });
    const outcome = expectStatus(await job.outcome, "success");
    expect(codes(outcome.diagnostics)).toEqual([["W_NODE_BLOCKED", ["8"]]]);
  });

  test("a consumer that lags gets the latest preview and progress per node", async () => {
    const run = runOf(await trace("sampler"));
    const prompt = await promptOf("sampler");
    fake.expect(run);
    const job = submit(comfy, prompt);
    await job.outcome;
    const events = await collect(job.events);
    expect(events.filter((event) => event.type === "preview")).toHaveLength(1);
    expect(events.filter((event) => event.type === "progress" && event.node === "5")).toEqual([
      { type: "progress", node: "5", value: 6, max: 6 },
    ]);
    expect(events.filter((event) => event.type === "output")).toHaveLength(1);
  });

  test("events can be read once", async () => {
    fake.expect(runOf(await trace("success")));
    const job = submit(comfy, await promptOf("success"));
    await collect(job.events);
    expect(() => job.events[Symbol.asyncIterator]()).toThrow(TypeError);
  });
});

describe("what the server decides is data", () => {
  test("rejections become diagnostics at the prompt, node or input", async () => {
    const runs = await trace("rejected");
    const outcomes: Outcome[] = [];
    for (const [index, run] of runs.entries()) {
      fake.expect(run);
      // oxlint-disable-next-line no-await-in-loop -- one after another, like the capture
      outcomes.push(await submit(comfy, await promptOf("rejected", index)).outcome);
    }
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["rejected", "rejected", "rejected"]);
    expect(outcomes.map((outcome) => codes(outcome.diagnostics))).toEqual([
      [["E_PROMPT_REJECTED", []]],
      [["E_PROMPT_REJECTED", ["1"]]],
      [
        ["E_PROMPT_REJECTED", []],
        ["E_SERVER_VALIDATION", ["2", "inputs", "blur_radius"]],
      ],
    ]);
    expect(outcomes[2]?.diagnostics[1]?.message).toBe(
      "value_bigger_than_max: Value 99 bigger than max of 31: blur_radius",
    );
  });

  test("a partial acceptance runs the valid output and reports the other", async () => {
    const run = runOf(await trace("partial"));
    const prompt = await promptOf("partial");
    fake.expect(run);
    const outcome = expectStatus(await submit(comfy, prompt).outcome, "success");
    expect([...outcome.outputs.keys()]).toEqual(["2"]);
    expect(codes(outcome.diagnostics)).toEqual([
      ["E_SERVER_VALIDATION", ["3", "inputs", "blur_radius"]],
    ]);
  });

  test("a node error fails the job, with what finished before it", async () => {
    const run = runOf(await trace("error"));
    const prompt = await promptOf("error");
    fake.expect(run);
    const outcome = expectStatus(await submit(comfy, prompt).outcome, "failed");
    expect(outcome.error).toMatchObject({
      node: "4",
      classType: "ComfyMathExpression",
      exceptionType: "ZeroDivisionError",
      message: "division by zero\n",
      executed: ["1", "2", "3"],
    });
    expect(outcome.error.traceback).toHaveLength(2);
    expect([...outcome.outputs.keys()]).toEqual(["2"]);
  });
});

describe("cancelling", () => {
  test("cancel() stops a running job; the outcome is cancelled", async () => {
    const run = runOf(await trace("cancel"));
    const prompt = await promptOf("cancel");
    fake.expect(run, { holdUntilCancel: true });
    const job = submit(comfy, prompt);
    for await (const event of job.events) {
      if (event.type === "executing" && event.node === "3") await job.cancel();
    }
    const outcome = expectStatus(await job.outcome, "cancelled");
    expect(outcome.outputs.size).toBe(0);
    expect(fake.received.map((request) => request.path)).toContain(`/api/jobs/${job.id}/cancel`);
  });

  test("a job cancelled while queued settles from its missing record", async () => {
    const runs = await trace("pending");
    fake.expect(runOf(runs, 0), { queued: true });
    fake.expect(runOf(runs, 1), { queued: true });
    const running = submit(comfy, await promptOf("pending", 0));
    const waiting = submit(comfy, await promptOf("pending", 1));
    await waiting.cancel();
    expectStatus(await waiting.outcome, "cancelled");
    fake.start(running.id);
    expectStatus(await running.outcome, "success");
  });

  test("a job another client cancels while queued settles too", async () => {
    fake.expect(runOf(await trace("pending"), 1), { queued: true });
    const job = submit(comfy, await promptOf("pending", 1));
    await Bun.sleep(20);
    // Another client cancels it: the server sends only a status broadcast.
    await fetch(`${fake.url}/api/jobs/${job.id}/cancel`, { method: "POST", body: "{}" });
    expectStatus(await job.outcome, "cancelled");
  });

  test("aborting the signal cancels on the server and rejects with the reason", async () => {
    const run = runOf(await trace("cancel"));
    const prompt = await promptOf("cancel");
    fake.expect(run, { holdUntilCancel: true });
    const controller = new AbortController();
    const job = submit(comfy, prompt, { signal: controller.signal });
    for await (const event of job.events) {
      if (event.type === "executing" && event.node === "3") controller.abort(new Error("enough"));
    }
    expect(job.outcome).rejects.toThrow("enough");
    await Bun.sleep(50);
    expect(fake.received.map((request) => request.path)).toContain(`/api/jobs/${job.id}/cancel`);
  });

  test("aborting while the POST is in flight still cancels the job once it is accepted", async () => {
    const run = runOf(await trace("cancel"));
    const prompt = await promptOf("cancel");
    fake.expect(run, { holdUntilCancel: true, answerDelayMs: 50 });
    const controller = new AbortController();
    const job = submit(comfy, prompt, { signal: controller.signal });
    await Bun.sleep(20);
    controller.abort(new Error("changed my mind"));
    expect(job.outcome).rejects.toThrow("changed my mind");
    await Bun.sleep(100);
    expect(fake.received.map((request) => request.path)).toContain(`/api/jobs/${job.id}/cancel`);
  });

  test("an aborted signal sends nothing", async () => {
    const job = submit(comfy, await promptOf("success"), {
      signal: AbortSignal.abort(new Error("never")),
    });
    expect(job.outcome).rejects.toThrow("never");
    expect(await collect(job.events)).toEqual([]);
    expect(fake.received.filter((request) => request.path === "/prompt")).toEqual([]);
  });

  test("a hung server ends at the caller's timeout", async () => {
    const run = runOf(await trace("success"));
    const prompt = await promptOf("success");
    fake.expect(run, { hangBefore: 6 });
    const job = submit(comfy, prompt, { signal: AbortSignal.timeout(100) });
    expect(job.outcome).rejects.toMatchObject({ name: "TimeoutError" });
  });
});

describe("a dropped websocket", () => {
  test("reconnects with a fresh client id and settles from the record", async () => {
    const run = runOf(await trace("success"));
    const prompt = await promptOf("success");
    const before = comfy.clientId;
    fake.expect(run, { dropSocketBefore: 6, gapMs: 5 });
    const job = submit(comfy, prompt);
    const outcome = expectStatus(await job.outcome, "success");
    expect(outcome.outputs.size).toBe(2);
    expect(fake.connections).toBe(2);
    const ids = fake.sockets.map((query) => new URLSearchParams(query).get("clientId"));
    expect(new Set(ids).size).toBe(2);
    expect(comfy.clientId).not.toBe(before);
    expect(comfy.clientId).toBe(ids.at(-1) ?? "");
  });

  test("settles even when the server stops sending to the new socket (same-id hazard)", async () => {
    const run = runOf(await trace("success"));
    const prompt = await promptOf("success");
    fake.expect(run, { dropSocketBefore: 6, hazard: true, gapMs: 5 });
    const job = submit(comfy, prompt);
    expectStatus(await job.outcome, "success");
  });

  test("a socket the server closes between jobs reopens for the next one", async () => {
    fake.dropSockets();
    await Bun.sleep(20);
    const run = runOf(await trace("success"));
    const prompt = await promptOf("success");
    fake.expect(run);
    expectStatus(await submit(comfy, prompt).outcome, "success");
    expect(fake.connections).toBe(2);
  });
});

describe("misuse and failures", () => {
  test("closing the connection rejects open jobs; the job keeps running on the server", async () => {
    const run = runOf(await trace("success"));
    const prompt = await promptOf("success");
    fake.expect(run, { hangBefore: 6 });
    const job = submit(comfy, prompt);
    await Bun.sleep(30);
    await comfy.close();
    expect(job.outcome).rejects.toBeInstanceOf(ClientError);
    expect(await collect(job.events)).not.toContainEqual({ type: "output" });
    expect(() => submit(comfy, prompt)).toThrow(TypeError);
  });

  test("an invalid workflow throws before anything is sent", async () => {
    const schema = looseSchema(await readMockObjectInfo("basic-pipeline"));
    const built = workflow(schema, ({ raw }) => {
      raw("NoSuchClass");
    });
    expect(() => submit(comfy, built)).toThrow(ValidationError);
  });

  test("invalid options throw", async () => {
    const prompt = await promptOf("success");
    expect(() => submit(comfy, prompt, { extraData: { client_id: "x" } })).toThrow(TypeError);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- what untyped callers can pass
    expect(() => submit(comfy, prompt, { previews: "fast" as "auto" })).toThrow(TypeError);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- not a connection
    expect(() => submit({ url: fake.url } as Connection, prompt)).toThrow(TypeError);
  });

  test("a server without the job API is refused at connect", async () => {
    const old = FakeServer.start({ noJobApi: true });
    try {
      expect(connect({ url: old.url })).rejects.toThrow(/ComfyUI 0.26/);
    } finally {
      old.stop();
    }
  });

  test("an unreachable server is a ClientError; a bad URL a TypeError", async () => {
    expect(connect({ url: "http://127.0.0.1:9" })).rejects.toBeInstanceOf(ClientError);
    expect(connect({ url: "ftp://host" })).rejects.toBeInstanceOf(TypeError);
    expect(connect({ url: "http://user:pw@host" })).rejects.toThrow(/credentials/);
  });

  test("headers go on every HTTP request; the URL's query on every request and the socket", async () => {
    const other = await connect({
      url: `${fake.url}/?token=t`,
      headers: { authorization: "Bearer x" },
    });
    fake.received.splice(0);
    try {
      const run = runOf(await trace("success"));
      const prompt = await promptOf("success");
      fake.expect(run);
      await submit(other, prompt).outcome;
      const [post, ...reads] = fake.received.map((request) => request.path);
      expect(post).toBe("/prompt");
      expect(new Set(reads)).toEqual(new Set([`/api/jobs/${fake.jobIds.at(-1) ?? ""}`]));
      expect(
        fake.received.every((request) => request.headers.get("authorization") === "Bearer x"),
      ).toBeTrue();
      expect(fake.received.every((request) => request.search === "?token=t")).toBeTrue();
      expect(fake.sockets.at(-1)).toBe(`?token=t&clientId=${other.clientId}`);
    } finally {
      await other.close();
    }
  });
});
