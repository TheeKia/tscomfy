// Many jobs on one connection to a real server, with cancels, aborts and dropped connections
// (test:live only). The scenario runs in a process of its own, which must exit as soon as it
// closes: nothing the client started may keep it running.

import { expect, test } from "bun:test";
import { join } from "node:path";

test("forty jobs, cancels, aborts and two dropped connections: every outcome right", async () => {
  const child = Bun.spawn(
    [process.execPath, "--conditions=@tscomfy/source", join(import.meta.dir, "soak-scenario.ts")],
    { stdout: "pipe", stderr: "inherit" },
  );
  let output = "";
  let closedAt: number | undefined;
  const decoder = new TextDecoder();
  for await (const chunk of child.stdout) {
    output += decoder.decode(chunk);
    if (output.includes("\nclosed")) closedAt ??= performance.now();
  }
  expect(await child.exited).toBe(0);
  const exitedAfter = performance.now() - (closedAt ?? 0);
  const summary: unknown = JSON.parse(output.split("\n")[0] ?? "{}");
  expect(summary).toMatchObject({ jobs: 40, problems: [] });
  expect(closedAt).toBeDefined();
  expect(exitedAfter).toBeLessThan(1000);
}, 300_000);
