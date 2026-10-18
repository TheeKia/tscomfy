// Run by lifecycle.test.ts in a process of its own: a connection with every kind of pending wait
// (a reconnect backoff, a record poll chain after several reconnects, a record read retrying),
// then close(). The process must exit right after it prints that it closed.

import { connect, submit } from "@tscomfy/client";
import type { ApiPrompt } from "@tscomfy/core";
import { FakeServer, trace } from "@tscomfy/fixtures";

const prompt: ApiPrompt = {
  "1": { class_type: "EmptyImage", inputs: { width: 8, height: 8, batch_size: 1, color: 0 } },
  "2": { class_type: "PreviewImage", inputs: { images: ["1", 0] } },
};
const run = (await trace("success"))[0];
if (run === undefined) throw new Error("no run");

const fake = FakeServer.start();
let failReads = false;
const comfy = await connect({
  url: fake.url,
  fetch: (input, init) =>
    failReads && String(input).includes("/api/jobs/")
      ? Promise.reject(new TypeError("fetch failed"))
      : fetch(input, init),
});
fake.expect(run, { queued: true });
const job = submit(comfy, prompt);
job.outcome.catch(() => undefined);
await Bun.sleep(50);
// Reconnects start poll chains; failing reads start retries.
for (let drop = 0; drop < 3; drop++) {
  fake.dropSockets();
  // oxlint-disable-next-line no-await-in-loop -- one drop at a time, each reconnected
  await Bun.sleep(600);
}
failReads = true;
await Bun.sleep(1200);
// Then the server goes away: the client is in a reconnect backoff when it closes.
fake.stop();
await Bun.sleep(1500);
await comfy.close();
console.log("closed");
