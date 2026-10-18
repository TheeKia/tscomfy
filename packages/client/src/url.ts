import type { Server } from "./server.ts";

/**
 * The server's base URL, checked. Throws a `TypeError` for a URL that isn't http(s), has
 * credentials or a fragment. The URL isn't echoed: it may hold a token.
 */
export function baseUrl(server: Server): URL {
  if (typeof server.url !== "string" || !URL.canParse(server.url)) {
    throw new TypeError("server.url is not a valid URL");
  }
  const url = new URL(server.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("server.url must be an http(s) URL");
  }
  if (url.username !== "" || url.password !== "") {
    throw new TypeError("server.url can't hold credentials; send them in server.headers");
  }
  if (url.hash !== "") {
    throw new TypeError("server.url can't have a #fragment: it never reaches the server");
  }
  return url;
}

/** An endpoint under the server's path, keeping its query: `http://h/api/?t=1` → `…/api/x?t=1`. */
export function endpoint(base: URL, path: string, query?: Readonly<Record<string, string>>): URL {
  const url = new URL(base.href);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${path}`;
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
  return url;
}

/**
 * A URL fit for messages: without query or fragment, which is where servers expect tokens.
 * `http://host/api?token=t` → `http://host/api`.
 */
export function shownUrl(url: URL): string {
  const shown = new URL(url.href);
  shown.search = "";
  shown.hash = "";
  return shown.href;
}
