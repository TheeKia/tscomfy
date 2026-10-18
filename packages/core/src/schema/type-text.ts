import type { OutputType, SocketType } from "./types.ts";

/** A socket type as ComfyUI writes it: `*`, a name, or a comma list. */
export function typeText(type: SocketType): string {
  switch (type.kind) {
    case "any":
      return "*";
    case "named":
      return type.name;
    case "union":
      return type.names.join(",");
  }
}

/** An output type as the frontend types its slot: an option list is `COMBO`. */
export function outputTypeText(type: OutputType): string {
  return type.kind === "combo" ? "COMBO" : typeText(type);
}
