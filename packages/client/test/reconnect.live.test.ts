// Dropped connections on a real server (test:live only). A clean close, a network cut, and a
// network cut the server only notices later: the case where ComfyUI, closing the old socket,
// unregisters the client's new one if it reused the old client id.

import { afterEach, describe, expect, test } from "bun:test";
import { type Connection, connect, submit } from "@tscomfy/client";
import { TcpProxy } from "@tscomfy/fixtures";
import { collect, LIVE_URL, liveSchema, quick, slow } from "./live.ts";

let proxy: TcpProxy | undefined;
let comfy: Connection | undefined;

afterEach(async () => {
  await comfy?.close();
  proxy?.stop();
  comfy = undefined;
  proxy = undefined;
});

/** Waits for the job to start running its first blur, then calls `act`. */
async function midRun(events: AsyncIterable<{ type: string }>, act: () => void): Promise<void> {
  for await (const event of events) {
    if (event.type === "executing") {
      act();
      return;
    }
  }
}

describe("a dropped websocket on a real server", () => {
  test("a clean close mid-run: the job settles from its record", async () => {
    const sockets: WebSocket[] = [];
    comfy = await connect({
      url: LIVE_URL,
      webSocket: (url) => {
        const socket = new WebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });
    const job = submit(comfy, slow(await liveSchema()));
    await midRun(job.events, () => sockets.at(-1)?.close());
    const outcome = await job.outcome;
    expect(outcome.status).toBe("success");
    expect(sockets.length).toBeGreaterThanOrEqual(2);
  }, 60_000);

  test("a network cut the server notices at once", async () => {
    proxy = TcpProxy.start(LIVE_URL);
    comfy = await connect({ url: proxy.url });
    const job = submit(comfy, slow(await liveSchema()));
    const cut = proxy;
    await midRun(job.events, () => cut.cutWebSockets());
    expect((await job.outcome).status).toBe("success");
  }, 60_000);

  test("a network cut the server notices later: this job and the next still settle, with events", async () => {
    proxy = TcpProxy.start(LIVE_URL);
    comfy = await connect({ url: proxy.url });
    const schema = await liveSchema();
    const first = submit(comfy, slow(schema), { signal: AbortSignal.timeout(30_000) });
    const cut = proxy;
    // The server keeps the old connection two seconds after the client has reconnected.
    await midRun(first.events, () => cut.cutWebSockets(2000));
    expect((await first.outcome).status).toBe("success");
    // By now the server has dropped the old connection. The connection must still work.
    await Bun.sleep(2500);
    const next = submit(comfy, quick(schema), { signal: AbortSignal.timeout(30_000) });
    const events = await collect(next.events);
    expect((await next.outcome).status).toBe("success");
    expect(events.map((event) => event.type)).toContain("output");
  }, 90_000);
});
