// Lifecycle edge cases from the Phase 10 review: closing while the socket is down or reopening,
// concurrent opens, servers that answer oddly, and nothing left running after close().

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ClientError, type Connection, connect, outputFiles, submit } from "@tscomfy/client";
import type { ApiPrompt, JsonObject, JsonValue } from "@tscomfy/core";
import { FakeServer, trace, type TraceRun } from "@tscomfy/fixtures";

let fake: FakeServer;
let comfy: Connection;

const PROMPT: ApiPrompt = {
  "1": { class_type: "EmptyImage", inputs: { width: 8, height: 8, batch_size: 1, color: 0 } },
  "2": { class_type: "PreviewImage", inputs: { images: ["1", 0] } },
};

async function success(): Promise<TraceRun> {
  const run = (await trace("success"))[0];
  if (run === undefined) throw new Error("no run");
  return run;
}

function isRecord(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const posts = (): number => fake.received.filter((each) => each.path === "/prompt").length;

beforeEach(async () => {
  fake = FakeServer.start();
  comfy = await connect({ url: fake.url });
});

afterEach(async () => {
  await comfy.close();
  fake.stop();
});

describe("closing", () => {
  test("close() while the socket is down: nothing is posted, the job fails, no socket stays", async () => {
    fake.dropSockets();
    await Bun.sleep(20);
    fake.expect(await success());
    const job = submit(comfy, PROMPT);
    await comfy.close();
    expect(job.outcome).rejects.toBeInstanceOf(ClientError);
    await Bun.sleep(50);
    expect(posts()).toBe(0);
    expect(fake.openSockets).toBe(0);
  });

  test("submits that find the socket down share one reopening", async () => {
    fake.dropSockets();
    await Bun.sleep(20);
    const run = await success();
    fake.expect(run);
    fake.expect(run);
    const outcomes = await Promise.all([
      submit(comfy, PROMPT).outcome,
      submit(comfy, PROMPT).outcome,
    ]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["success", "success"]);
    expect(fake.connections).toBe(2);
    await comfy.close();
    await Bun.sleep(50);
    expect(fake.openSockets).toBe(0);
  });

  test("close() twice waits for the sockets both times", async () => {
    await Promise.all([comfy.close(), comfy.close()]);
    await Bun.sleep(20);
    expect(fake.openSockets).toBe(0);
  });

  test("nothing keeps the process running after close(): reconnects, polls, retries", async () => {
    // In a process of its own, which must exit as soon as it says it closed. Timed from that
    // line, so the runtime's start-up doesn't count.
    const script = join(import.meta.dir, "exit-scenario.ts");
    const child = Bun.spawn([process.execPath, "--conditions=@tscomfy/source", script], {
      stdout: "pipe",
      stderr: "inherit",
    });
    let closedAt: number | undefined;
    const decoder = new TextDecoder();
    for await (const chunk of child.stdout) {
      if (decoder.decode(chunk).includes("closed")) closedAt ??= performance.now();
    }
    expect(await child.exited).toBe(0);
    expect(closedAt).toBeDefined();
    expect(performance.now() - (closedAt ?? 0)).toBeLessThan(1000);
  }, 20_000);
});

describe("servers that answer oddly", () => {
  test("a server older than 0.26 is refused at connect, and nothing stays open", async () => {
    const old = FakeServer.start({ version: "0.25.3" });
    try {
      expect(connect({ url: old.url })).rejects.toThrow(/ComfyUI 0.25.3.*0.26.0/);
      await Bun.sleep(50);
      expect(old.openSockets).toBe(0);
    } finally {
      old.stop();
    }
  });

  test("a 200 whose body isn't JSON still counts as queued", async () => {
    const weird = await connect({
      url: fake.url,
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        return String(input).includes("/prompt")
          ? new Response("<html>queued</html>", { status: 200 })
          : response;
      },
    });
    try {
      fake.expect(await success());
      const outcome = await submit(weird, PROMPT).outcome;
      expect(outcome.status).toBe("success");
    } finally {
      await weird.close();
    }
  });

  test("a server that ignores the prompt id fails the job, and is asked to cancel its own", async () => {
    const ignoring = await connect({
      url: fake.url,
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        return String(input).includes("/prompt")
          ? Response.json({
              prompt_id: "f00f0000-0000-4000-8000-000000000000",
              number: 1,
              node_errors: {},
            })
          : response;
      },
    });
    try {
      fake.expect(await success(), { hangBefore: 2 });
      const job = submit(ignoring, PROMPT);
      expect(job.outcome).rejects.toThrow(/not as the id the client chose/);
      await Bun.sleep(30);
      expect(fake.received.map((each) => each.path)).toContain(
        "/api/jobs/f00f0000-0000-4000-8000-000000000000/cancel",
      );
    } finally {
      await ignoring.close();
    }
  });

  test("a job whose record vanishes after it started is a ClientError, not a cancel", async () => {
    fake.expect(await success(), { dropSocketBefore: 6, forget: true, gapMs: 5 });
    const job = submit(comfy, PROMPT);
    expect(job.outcome).rejects.toThrow(/no record of job/);
  });

  test("outputs seen live win over the record's rewriting of them", async () => {
    const run = await success();
    const record = run.record?.body;
    if (!isRecord(record)) throw new Error("no record");
    const rewritten: TraceRun = {
      ...run,
      record: {
        status: 200,
        body: {
          ...record,
          outputs: {
            "4": { images: [{ filename: "rewritten.png", subfolder: "", type: "temp" }] },
          },
        },
      },
    };
    fake.expect(rewritten);
    const outcome = await submit(comfy, PROMPT).outcome;
    expect(outputFiles(outcome).map((file) => file.filename)).toEqual([
      "ComfyUI_temp_vkgbr_00001_.png",
    ]);
    if (outcome.status === "rejected") throw new Error();
    expect(Reflect.get(outcome.outputs, "set")).toBeUndefined();
    expect(Object.isFrozen(outcome.outputs.get("4")?.ui)).toBeTrue();
    expect(Object.isFrozen(outcome.outputs.get("4")?.ui["images"])).toBeTrue();
  });
});
