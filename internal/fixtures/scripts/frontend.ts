// Asks the ComfyUI frontend itself what it would queue: loads the server's own frontend in a
// headless Chromium, loads UI workflows into it, and writes the API prompt `graphToPrompt` builds
// for each (that call only builds the prompt; nothing is queued). Read-only for the server: every
// request that isn't a GET is answered here with an empty success and never reaches it.
//
//   bun internal/fixtures/scripts/frontend.ts [--server URL] [--object-info FILE] [--remote-files JSON] --out DIR UI.json…
//
// `--object-info` registers the node definitions of an /object_info file in the page first, as
// the server's would be (`app.registerNodesFromDefs`, which runs the core extensions' hooks), so
// mock classes, or mock definitions of real ones, load as nodes rather than as missing ones.
//
// The server's file lists (`/internal/files/…`, which remote combos fetch) are answered here, so a
// capture never depends on, or holds, the files on the server: with `--remote-files '["a.png"]'`,
// or an empty list. The frontend replaces a saved remote-combo value the list lacks.
//
// Needs a Chromium (or its headless shell): TSCOMFY_CHROME, or the one Playwright caches
// (`src/chromium.ts`).
// Development tooling: not part of any package, and not run by `check` or `test:corpus`.

/* oxlint-disable no-await-in-loop -- it polls the browser, and loads one workflow at a time */
/* oxlint-disable typescript/no-unsafe-type-assertion -- DevTools protocol messages, read as such */

import { basename, join } from "node:path";
import { launchChromium } from "../src/chromium.ts";

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const server = (option("--server") ?? "http://127.0.0.1:8188").replace(/\/+$/, "");
const out = option("--out");
const objectInfo = option("--object-info");
const remoteFiles = option("--remote-files") ?? "[]";
const files = args.filter(
  (arg, index) => !arg.startsWith("--") && args[index - 1]?.startsWith("--") !== true,
);
if (out === undefined || files.length === 0) {
  console.error(
    "Usage: bun frontend.ts [--server URL] [--object-info FILE] [--remote-files JSON] --out DIR UI.json…",
  );
  process.exit(2);
}

const browser = await launchChromium();

try {
  const { send, evaluate } = browser;

  // Every request but a GET is answered here: the frontend thinks it saved, the server sees nothing.
  const answered: string[] = [];
  browser.on((message) => {
    if (message.method !== "Fetch.requestPaused") return;
    const { requestId, request } = message.params as {
      requestId: string;
      request: { method: string; url: string };
    };
    if (request.method === "GET" && new URL(request.url).pathname.startsWith("/internal/files/")) {
      answered.push(`${request.method} ${request.url}`);
      void send("Fetch.fulfillRequest", {
        requestId,
        responseCode: 200,
        responseHeaders: [{ name: "Content-Type", value: "application/json" }],
        body: btoa(remoteFiles),
      });
      return;
    }
    if (request.method === "GET" || request.method === "OPTIONS") {
      void send("Fetch.continueRequest", { requestId });
      return;
    }
    answered.push(`${request.method} ${request.url}`);
    void send("Fetch.fulfillRequest", {
      requestId,
      responseCode: 200,
      responseHeaders: [{ name: "Content-Type", value: "application/json" }],
      body: btoa("{}"),
    });
  });
  await send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
  await send("Page.navigate", { url: server });

  const app = "window.comfyAPI?.app?.app";
  for (let attempt = 0; attempt < 300; attempt++) {
    if ((await evaluate(`Boolean(${app}?.rootGraphInternal)`)) === true) break;
    await Bun.sleep(200);
  }
  // The frontend restores the last workflow on start; let that finish before loading ours.
  await Bun.sleep(3000);
  if (objectInfo !== undefined) {
    const definitions = await Bun.file(objectInfo).text();
    await evaluate(`${app}.registerNodesFromDefs(JSON.parse(${JSON.stringify(definitions)}))`);
  }

  for (const file of files) {
    const text = await Bun.file(file).text();
    let prompt: unknown;
    for (let attempt = 0; attempt < 5 && typeof prompt !== "string"; attempt++) {
      prompt = await evaluate(`(async () => {
        const app = ${app};
        const data = JSON.parse(${JSON.stringify(text)});
        await app.loadGraphData(data, true, false);
        if (app.rootGraph.nodes.length !== data.nodes.length) return undefined;
        const { output } = await app.graphToPrompt(app.rootGraph);
        return JSON.stringify(output);
      })()`);
      if (typeof prompt !== "string") await Bun.sleep(1000);
    }
    if (typeof prompt !== "string") throw new Error(`${file}: the frontend didn't load it`);
    const target = join(out, basename(file));
    await Bun.write(target, prompt);
    console.error(`${file} → ${target}`);
  }
  console.error(
    `Answered without sending: ${answered.length === 0 ? "nothing" : answered.join(", ")}`,
  );
} finally {
  browser.close();
}
