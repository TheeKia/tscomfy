// Run by soak.live.test.ts in a process of its own (test:live only): about forty jobs of every
// kind on one connection to a real server, through a TCP proxy that cuts the websocket twice
// (once so the server notices late). Every outcome is checked against what was asked and against
// the server's record. Prints a JSON summary, then "closed"; the process must exit right after.

/* oxlint-disable no-await-in-loop -- jobs go in over a few seconds; records are read one by one */

import { connect, type Job, type Outcome, submit } from "@tscomfy/client";
import type { ApiPrompt } from "@tscomfy/core";
import { workflow } from "@tscomfy/core";
import { TcpProxy } from "@tscomfy/fixtures";
import { fresh, LIVE_URL, liveSchema, quick, slow } from "./live.ts";

type Kind = "quick" | "failing" | "rejected" | "slow" | "cancelled" | "aborted";

interface Submitted {
  readonly kind: Kind;
  readonly job: Job;
  readonly reason?: Error;
  /** For an abort: whether it came while the job was still open (it does nothing after). */
  aborted?: boolean;
}

const schema = await liveSchema();
const proxy = TcpProxy.start(LIVE_URL);
const comfy = await connect({ url: proxy.url });
const problems: string[] = [];
const submitted: Submitted[] = [];
/** The scenario's own timers, cleared at the end, so only the client's could keep it running. */
const timers: ReturnType<typeof setTimeout>[] = [];

const failing = (): ReturnType<typeof workflow> =>
  workflow(schema, ({ n }) => {
    const value = n["PrimitiveInt"]!({ value: fresh() });
    const math = n["ComfyMathExpression"]!({ expression: "a / 0", values: [value] });
    n["PreviewAny"]!({ source: math[0] });
  });
const rejected = (): ApiPrompt => ({
  "1": { class_type: "EmptyImage", inputs: { width: 8, height: 8, batch_size: 1, color: 0 } },
  "2": { class_type: "ImageBlur", inputs: { image: ["1", 0], blur_radius: 99, sigma: 1 } },
  "3": { class_type: "PreviewImage", inputs: { images: ["2", 0] } },
});

const plan: Kind[] = [
  ...Array.from({ length: 20 }, (): Kind => "quick"),
  ...Array.from({ length: 5 }, (): Kind => "failing"),
  ...Array.from({ length: 4 }, (): Kind => "rejected"),
  ...Array.from({ length: 4 }, (): Kind => "slow"),
  ...Array.from({ length: 4 }, (): Kind => "cancelled"),
  ...Array.from({ length: 3 }, (): Kind => "aborted"),
].toSorted(() => Math.random() - 0.5);

for (const [index, kind] of plan.entries()) {
  if (kind === "aborted") {
    const controller = new AbortController();
    const reason = new Error(`aborted ${String(index)}`);
    const job = submit(comfy, slow(schema), { signal: controller.signal });
    const entry: Submitted = { kind, job, reason };
    let open = true;
    job.outcome.then(
      () => (open = false),
      () => (open = false),
    );
    timers.push(
      setTimeout(
        () => {
          entry.aborted = open;
          controller.abort(reason);
        },
        200 + Math.random() * 3000,
      ),
    );
    submitted.push(entry);
  } else {
    const input =
      kind === "quick"
        ? quick(schema)
        : kind === "failing"
          ? failing()
          : kind === "rejected"
            ? rejected()
            : slow(schema);
    const job = submit(comfy, input, { signal: AbortSignal.timeout(180_000) });
    if (kind === "cancelled") {
      timers.push(setTimeout(() => void job.cancel(), 100 + Math.random() * 4000));
    }
    submitted.push({ kind, job });
  }
  // A few at a time, so some are queued and some run while the connection drops.
  if (index % 5 === 4) await Bun.sleep(150);
}

// Two cuts while jobs run: one the server sees at once, one it notices two seconds later.
timers.push(
  setTimeout(() => proxy.cutWebSockets(), 1000),
  setTimeout(() => proxy.cutWebSockets(2000), 4000),
);

const settled = await Promise.allSettled(submitted.map((each) => each.job.outcome));
const counts: Record<string, number> = {};
for (const [index, result] of settled.entries()) {
  const entry = submitted[index];
  if (entry === undefined) continue;
  const { kind, job, reason } = entry;
  const status = result.status === "fulfilled" ? result.value.status : "rejected-promise";
  counts[`${kind}:${status}`] = (counts[`${kind}:${status}`] ?? 0) + 1;
  if (kind === "aborted" && entry.aborted === true) {
    if (result.status !== "rejected" || result.reason !== reason) {
      problems.push(`${job.id} (aborted) settled ${status}, not with its reason`);
    }
    continue;
  }
  if (result.status === "rejected") {
    problems.push(`${job.id} (${kind}) rejected: ${String(result.reason)}`);
    continue;
  }
  const outcome = result.value;
  const expected: Record<Kind, readonly Outcome["status"][]> = {
    quick: ["success"],
    // Aborted after it had finished: the abort did nothing.
    aborted: ["success"],
    failing: ["failed"],
    rejected: ["rejected"],
    slow: ["success"],
    // A cancel that comes after the last node can't stop it.
    cancelled: ["cancelled", "success"],
  };
  if (!expected[kind].includes(outcome.status)) {
    problems.push(`${job.id} (${kind}) settled ${outcome.status}`);
  }
  if (outcome.status === "failed" && outcome.error.exceptionType !== "ZeroDivisionError") {
    problems.push(`${job.id} failed with ${outcome.error.exceptionType}`);
  }
  if (outcome.status === "rejected") continue;
  // The server's record agrees.
  const response = await fetch(`${LIVE_URL}/api/jobs/${job.id}`);
  const record: unknown = response.status === 404 ? { status: "gone" } : await response.json();
  const recorded: unknown =
    typeof record === "object" && record !== null ? Reflect.get(record, "status") : "";
  const agrees =
    (outcome.status === "success" && recorded === "completed") ||
    (outcome.status === "failed" && recorded === "failed") ||
    (outcome.status === "cancelled" && (recorded === "cancelled" || recorded === "gone"));
  if (!agrees)
    problems.push(
      `${job.id} (${kind}) settled ${outcome.status}, the record says ${String(recorded)}`,
    );
}

// Aborted jobs were cancelled on the server: none is left running or queued.
await Bun.sleep(1500);
for (const { kind, job, aborted } of submitted) {
  if (kind !== "aborted" || aborted !== true) continue;
  const response = await fetch(`${LIVE_URL}/api/jobs/${job.id}`);
  const record: unknown = response.status === 404 ? { status: "gone" } : await response.json();
  const recorded: unknown =
    typeof record === "object" && record !== null ? Reflect.get(record, "status") : "";
  if (recorded === "pending" || recorded === "in_progress") {
    problems.push(`${job.id} (aborted) is still ${recorded} on the server`);
  }
}

for (const timer of timers) clearTimeout(timer);
await comfy.close();
proxy.stop();
console.log(JSON.stringify({ jobs: submitted.length, counts, problems }));
console.log("closed");
