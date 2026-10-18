/**
 * A ComfyUI server: where it is and how to talk to it. Plain data; every function that needs no
 * websocket takes one, and a {@link Connection} is one too.
 */
export interface Server {
  /**
   * The server's http(s) URL. It may have a path prefix and a query (a token, say), which every
   * request and the websocket URL keep: `http://host/comfy/?token=t` gives
   * `http://host/comfy/prompt?token=t`. Credentials (`user:password@`) are refused, because
   * runtimes disagree on them; send them in `headers`.
   */
  readonly url: string;
  /**
   * Headers for every HTTP request, such as `Authorization`. Not sent on the websocket
   * handshake, which browsers can't give headers; see {@link Server.webSocket}.
   */
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * Replaces the global `fetch`: the global itself, or a function wrapping it (to add a proxy, a
   * cookie, logging). It is called with a URL and an init.
   */
  readonly fetch?: (url: URL, init: RequestInit) => Promise<Response>;
  /**
   * Opens the websocket instead of `new WebSocket(url)`. Bun, Node and Deno accept handshake
   * headers this way: `(url) => new WebSocket(url, { headers })` (not standard, so not in the
   * types; browsers throw).
   */
  readonly webSocket?: (url: string) => WebSocket;
}
