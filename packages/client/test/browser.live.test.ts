// The client in a browser against a real server (test:live only): browser-page.ts, bundled, runs
// in headless Chromium on an origin other than the server's. The server must allow it: start
// ComfyUI with `--enable-cors-header` (any origin, or the page's).

import { expect, test } from "bun:test";
import { join } from "node:path";
import { launchChromium } from "@tscomfy/fixtures";
import { LIVE_URL } from "./live.ts";

/** Why this test can't run here, if it can't: the server refuses other origins. */
async function blocker(): Promise<string | undefined> {
  const answer = await fetch(`${LIVE_URL}/system_stats`, {
    headers: { origin: "http://127.0.0.1:1" },
  }).catch(() => undefined);
  if (answer?.headers.get("access-control-allow-origin") === null) {
    return "the server sends no CORS headers: start ComfyUI with --enable-cors-header";
  }
  return undefined;
}

const skip = await blocker();
if (skip !== undefined) console.warn(`browser.live.test.ts skipped: ${skip}`);

test.skipIf(skip !== undefined)(
  "the client runs in a browser on another origin: a run, its preview, its files",
  async () => {
    const build = await Bun.build({
      entrypoints: [join(import.meta.dir, "browser-page.ts")],
      target: "browser",
      format: "esm",
      conditions: ["@tscomfy/source"],
    });
    expect(build.success).toBeTrue();
    const script = (await build.outputs[0]?.text()) ?? "";
    const page = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) =>
        new URL(request.url).pathname === "/page.js"
          ? new Response(script, { headers: { "content-type": "text/javascript" } })
          : new Response('<!doctype html><script type="module" src="/page.js"></script>', {
              headers: { "content-type": "text/html" },
            }),
    });
    const browser = await launchChromium();
    try {
      await browser.send("Page.navigate", { url: page.url.href });
      for (let attempt = 0; attempt < 50; attempt++) {
        // oxlint-disable-next-line no-await-in-loop -- polls the page until its script ran
        if ((await browser.evaluate('typeof runLive === "function"')) === true) break;
        // oxlint-disable-next-line no-await-in-loop
        await Bun.sleep(100);
      }
      const answer = await browser.evaluate(`runLive(${JSON.stringify(LIVE_URL)})`);
      const result: unknown = JSON.parse(String(answer));
      expect(result).toMatchObject({
        status: "success",
        preview: [40, 24],
        saved: [40, 24],
        mime: "image/png",
        loaded: 40,
      });
      const types: unknown =
        typeof result === "object" && result !== null ? Reflect.get(result, "types") : undefined;
      expect(types).toEqual(expect.arrayContaining(["started", "executing", "preview", "output"]));
      const uploaded: unknown =
        typeof result === "object" && result !== null ? Reflect.get(result, "uploaded") : undefined;
      expect(uploaded).toMatch(/^tscomfy-live\/browser.*\.png \[temp\]$/);
    } finally {
      browser.close();
      await page.stop(true);
    }
  },
  120_000,
);
