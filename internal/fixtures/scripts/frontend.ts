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
// Needs a Chromium (or its headless shell): TSCOMFY_CHROME, or the one Playwright caches.
// Development tooling: not part of any package, and not run by `check` or `test:corpus`.

/* oxlint-disable no-await-in-loop -- it polls the browser, and loads one workflow at a time */
/* oxlint-disable typescript/no-unsafe-type-assertion -- DevTools protocol messages, read as such */

import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

interface Message {
  readonly id?: number;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly message: string };
}

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

/** A Chromium: TSCOMFY_CHROME, or the newest headless shell Playwright has cached. */
async function chrome(): Promise<string> {
  const given = process.env["TSCOMFY_CHROME"];
  if (given !== undefined) return given;
  const cache = join(homedir(), ".cache", "ms-playwright");
  const shells = (await readdir(cache).catch(() => []))
    .filter((name) => name.startsWith("chromium_headless_shell-"))
    .toSorted();
  const newest = shells.at(-1);
  if (newest === undefined) throw new Error("No Chromium: set TSCOMFY_CHROME.");
  return join(cache, newest, "chrome-headless-shell-linux64", "chrome-headless-shell");
}

const port = 9300 + Math.floor(Math.random() * 600);
const browser = Bun.spawn(
  [await chrome(), `--remote-debugging-port=${String(port)}`, "--no-sandbox", "about:blank"],
  { stdout: "ignore", stderr: "ignore" },
);

try {
  const socket = await connect(port);
  const pending = new Map<number, (message: Message) => void>();
  const listeners: ((message: Message) => void)[] = [];
  let next = 1;
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as Message;
    if (message.id === undefined) for (const listener of listeners) listener(message);
    else pending.get(message.id)?.(message);
  });
  const send = (method: string, params: object = {}): Promise<Message> => {
    const id = next++;
    socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve) => pending.set(id, resolve));
  };
  const evaluate = async (expression: string): Promise<unknown> => {
    const { result } = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    const details = result?.["exceptionDetails"];
    if (details !== undefined) throw new Error(JSON.stringify(details).slice(0, 1000));
    return (result?.["result"] as { value?: unknown } | undefined)?.value;
  };

  // Every request but a GET is answered here: the frontend thinks it saved, the server sees nothing.
  const answered: string[] = [];
  listeners.push((message) => {
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
  await send("Runtime.enable");
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
  socket.close();
} finally {
  browser.kill();
}

async function connect(debugPort: number): Promise<WebSocket> {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const targets = (await (
        await fetch(`http://127.0.0.1:${String(debugPort)}/json`)
      ).json()) as {
        readonly type: string;
        readonly webSocketDebuggerUrl: string;
      }[];
      const page = targets.find((each) => each.type === "page");
      if (page !== undefined) {
        const socket = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((resolve) => socket.addEventListener("open", resolve));
        return socket;
      }
    } catch {
      // Not listening yet.
    }
    await Bun.sleep(200);
  }
  throw new Error("Chromium didn't start");
}
