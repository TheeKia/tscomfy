// A headless Chromium driven over the DevTools protocol, for the frontend capture script and the
// client's browser test. Needs a Chromium (or its headless shell): TSCOMFY_CHROME, or the newest
// one Playwright has cached. No dependency: the protocol is JSON over a websocket.

/* oxlint-disable typescript/no-unsafe-type-assertion -- DevTools protocol messages, read as such */
/* oxlint-disable no-await-in-loop -- it polls the browser until it listens */

import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** A DevTools protocol message: an answer (`id`) or an event (`method`). */
export interface DevToolsMessage {
  readonly id?: number;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly result?: Record<string, unknown>;
}

/** A running browser, with one page. */
export interface Chromium {
  /** Sends a protocol command to the page and waits for its answer. */
  readonly send: (method: string, params?: object) => Promise<DevToolsMessage>;
  /** Evaluates an expression in the page, awaiting a promise; throws what the page throws. */
  readonly evaluate: (expression: string) => Promise<unknown>;
  /** Calls `listener` with every protocol event. */
  readonly on: (listener: (message: DevToolsMessage) => void) => void;
  /** What the page logged to its console, in order. */
  readonly console: readonly string[];
  readonly close: () => void;
}

/** The Chromium binary: TSCOMFY_CHROME, or the newest headless shell Playwright has cached. */
async function binary(): Promise<string> {
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

/** Starts a headless Chromium on `about:blank` and connects to its page. */
export async function launchChromium(): Promise<Chromium> {
  const port = 9300 + Math.floor(Math.random() * 600);
  const child = Bun.spawn(
    [await binary(), `--remote-debugging-port=${String(port)}`, "--no-sandbox", "about:blank"],
    { stdout: "ignore", stderr: "ignore" },
  );
  try {
    const socket = await pageSocket(port);
    const pending = new Map<number, (message: DevToolsMessage) => void>();
    const listeners: ((message: DevToolsMessage) => void)[] = [];
    const logged: string[] = [];
    let next = 1;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as DevToolsMessage;
      if (message.id === undefined) {
        if (message.method === "Runtime.consoleAPICalled") {
          const args = (message.params?.["args"] ?? []) as { value?: unknown }[];
          logged.push(args.map((arg) => String(arg.value)).join(" "));
        }
        for (const listener of listeners) listener(message);
      } else {
        pending.get(message.id)?.(message);
        pending.delete(message.id);
      }
    });
    const send = (method: string, params: object = {}): Promise<DevToolsMessage> => {
      const id = next++;
      socket.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve) => pending.set(id, resolve));
    };
    await send("Runtime.enable");
    return {
      send,
      evaluate: async (expression) => {
        const { result } = await send("Runtime.evaluate", {
          expression,
          awaitPromise: true,
          returnByValue: true,
        });
        const details = result?.["exceptionDetails"];
        if (details !== undefined) throw new Error(JSON.stringify(details).slice(0, 2000));
        return (result?.["result"] as { value?: unknown } | undefined)?.value;
      },
      on: (listener) => {
        listeners.push(listener);
      },
      console: logged,
      close: () => {
        socket.close();
        child.kill();
      },
    };
  } catch (error) {
    child.kill();
    throw error;
  }
}

/** The DevTools websocket of the browser's page, once it listens. */
async function pageSocket(port: number): Promise<WebSocket> {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const targets = (await (await fetch(`http://127.0.0.1:${String(port)}/json`)).json()) as {
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
