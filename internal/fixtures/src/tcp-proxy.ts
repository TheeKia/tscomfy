// A TCP proxy in front of a server, for live tests: it forwards bytes both ways and can cut the
// websocket connections the way a network does (no close handshake), optionally keeping the
// server's side open for a while, as a half-open connection the server hasn't noticed.

import type { Socket, TCPSocketListener } from "bun";

interface Pair {
  /** The upstream connection, once open. */
  upstream: Socket<Pair> | undefined;
  /** What the client sent before the upstream connection opened. */
  readonly early: Uint8Array[];
  /** Bytes waiting for each side to drain. */
  readonly toClient: Uint8Array[];
  readonly toServer: Uint8Array[];
  websocket: boolean;
  /** The client side was cut; the server side stays until `releaseAt`. */
  held: boolean;
  client: Socket<Pair> | undefined;
}

/** A running proxy. Stop it after the test. */
export class TcpProxy {
  readonly #listener: TCPSocketListener<Pair>;
  /** The connections open now, each a client side and its server side. */
  readonly #pairs: ReadonlySet<Pair>;
  /** Server sides held open by `cutWebSockets`, to close later. */
  readonly #timers = new Set<ReturnType<typeof setTimeout>>();

  private constructor(listener: TCPSocketListener<Pair>, pairs: ReadonlySet<Pair>) {
    this.#listener = listener;
    this.#pairs = pairs;
  }

  /** Proxies `127.0.0.1:<random port>` to `target` (`http://host:port`). */
  static start(target: string): TcpProxy {
    const { hostname, port } = new URL(target);
    const pairs = new Set<Pair>();
    const listener = Bun.listen<Pair>({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open(client) {
          const pair: Pair = {
            upstream: undefined,
            early: [],
            toClient: [],
            toServer: [],
            websocket: false,
            held: false,
            client,
          };
          client.data = pair;
          pairs.add(pair);
          void Bun.connect<Pair>({
            hostname,
            port: Number(port),
            data: pair,
            socket: {
              open(upstream) {
                pair.upstream = upstream;
                for (const chunk of pair.early.splice(0)) write(upstream, pair.toServer, chunk);
              },
              data(_upstream, chunk) {
                if (!pair.held && pair.client !== undefined)
                  write(pair.client, pair.toClient, chunk);
              },
              drain(upstream) {
                flush(upstream, pair.toServer);
              },
              close() {
                pairs.delete(pair);
                if (!pair.held) pair.client?.end();
              },
            },
          }).catch(() => {
            client.end();
          });
        },
        data(client, chunk) {
          const pair = client.data;
          if (
            !pair.websocket &&
            new TextDecoder().decode(chunk.subarray(0, 8)).startsWith("GET /ws")
          ) {
            pair.websocket = true;
          }
          if (pair.upstream === undefined) pair.early.push(new Uint8Array(chunk));
          else write(pair.upstream, pair.toServer, chunk);
        },
        drain(client) {
          flush(client, client.data.toClient);
        },
        close(client) {
          const pair = client.data;
          pair.client = undefined;
          if (!pair.held) pair.upstream?.end();
        },
      },
    });
    return new TcpProxy(listener, pairs);
  }

  /** The proxy's URL, to give the client in place of the server's. */
  get url(): string {
    return `http://127.0.0.1:${String(this.#listener.port)}`;
  }

  /**
   * Cuts every websocket connection on the client's side, abruptly. The server's side stays
   * open for `holdMs` (0: closed at once), then closes, as when the server finally notices a dead
   * peer.
   */
  cutWebSockets(holdMs = 0): void {
    for (const pair of this.#live()) {
      if (!pair.websocket) continue;
      pair.held = true;
      pair.client?.terminate();
      pair.client = undefined;
      const upstream = pair.upstream;
      if (holdMs === 0) {
        upstream?.end();
      } else {
        const timer = setTimeout(() => {
          this.#timers.delete(timer);
          upstream?.end();
        }, holdMs);
        this.#timers.add(timer);
      }
    }
  }

  /** Closes every connection, held ones included, and stops listening. */
  stop(): void {
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    for (const pair of this.#live()) {
      pair.client?.terminate();
      pair.upstream?.end();
    }
    this.#listener.stop(true);
  }

  #live(): Pair[] {
    return [...this.#pairs];
  }
}

/** Writes what the socket takes now, and queues the rest for its `drain`. */
function write(socket: Socket<Pair>, queue: Uint8Array[], chunk: Uint8Array): void {
  if (queue.length > 0) {
    queue.push(new Uint8Array(chunk));
    return;
  }
  const written = socket.write(chunk);
  if (written < chunk.length) queue.push(new Uint8Array(chunk.subarray(Math.max(written, 0))));
}

function flush(socket: Socket<Pair>, queue: Uint8Array[]): void {
  while (queue.length > 0) {
    const chunk = queue[0];
    if (chunk === undefined) return;
    const written = socket.write(chunk);
    if (written < chunk.length) {
      queue[0] = chunk.subarray(Math.max(written, 0));
      return;
    }
    queue.shift();
  }
}
