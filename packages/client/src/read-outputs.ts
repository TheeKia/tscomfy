import { isOutputRef, type JsonObject, type JsonValue, type NodeId } from "@tscomfy/core";
import { isList, isObject } from "./http.ts";
import type { FileKind, FolderType, NodeOutput, NodeRef, OutputFile, Outputs } from "./outputs.ts";

/** The id of a node given by id, handle or output. */
export function nodeIdOf(node: NodeRef): NodeId {
  if (typeof node === "string") return node;
  if (isOutputRef(node)) return node.node;
  return node.id;
}

/**
 * A run's UI output read leniently: anything unrecognized stays in `ui` only. `node` is the node
 * the run is displayed as, `id` the server's id for the run.
 */
export function readNodeOutput(node: NodeId, id: string, ui: JsonObject): NodeOutput {
  const flags = ui["animated"];
  const animated = isList(flags) && flags.includes(true);
  const files: OutputFile[] = [];
  for (const [key, value] of Object.entries(ui)) {
    if (!isList(value)) continue;
    for (const item of value) {
      const file = readFile(key, item, animated);
      if (file !== undefined) files.push(file);
    }
  }
  const texts = ui["text"];
  const text = isList(texts)
    ? texts.filter((item): item is string => typeof item === "string")
    : [];
  return Object.freeze({
    node,
    id,
    files: Object.freeze(files),
    text: Object.freeze(text),
    ui: deepFreeze(ui),
  });
}

/**
 * Builds the outputs map from runs in the order they ran: grouped by node, the nodes in the order
 * of `order` (the prompt's node order), unknown ids last.
 */
export function outputsInOrder(runs: Iterable<NodeOutput>, order: readonly NodeId[]): Outputs {
  const byNode = new Map<NodeId, NodeOutput[]>();
  for (const run of runs) {
    const known = byNode.get(run.node);
    if (known === undefined) byNode.set(run.node, [run]);
    else known.push(run);
  }
  const position = new Map(order.map((id, index) => [id, index]));
  // Stable: unknown ids keep the order they ran in.
  const sorted = [...byNode].toSorted(
    ([a], [b]) =>
      (position.get(a) ?? Number.MAX_SAFE_INTEGER) - (position.get(b) ?? Number.MAX_SAFE_INTEGER),
  );
  return new FrozenMap(sorted.map(([node, list]) => [node, Object.freeze(list)]));
}

/** A map nobody can change: what `outcome.outputs` is. */
class FrozenMap<K, V> implements ReadonlyMap<K, V> {
  readonly #map: ReadonlyMap<K, V>;

  constructor(entries: Iterable<readonly [K, V]>) {
    this.#map = new Map(entries);
    Object.freeze(this);
  }

  get size(): number {
    return this.#map.size;
  }

  get(key: K): V | undefined {
    return this.#map.get(key);
  }

  has(key: K): boolean {
    return this.#map.has(key);
  }

  forEach(callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    for (const [key, value] of this.#map) callback.call(thisArg, value, key, this);
  }

  entries(): MapIterator<[K, V]> {
    return this.#map.entries();
  }

  keys(): MapIterator<K> {
    return this.#map.keys();
  }

  values(): MapIterator<V> {
    return this.#map.values();
  }

  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.#map[Symbol.iterator]();
  }
}

/** Freezes a JSON value and everything in it. */
function deepFreeze<T extends JsonValue>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

/** One of the server's folder names. */
export function isFolderType(value: JsonValue | undefined): value is FolderType {
  return value === "output" || value === "temp" || value === "input";
}

/** A file entry: `{ filename, subfolder, type }` and maybe `metadata`. */
function readFile(key: string, item: JsonValue, animated: boolean): OutputFile | undefined {
  if (!isObject(item)) return undefined;
  const { filename, subfolder, type } = item;
  if (typeof filename !== "string" || filename === "") return undefined;
  if (!isFolderType(type)) return undefined;
  const metadata = isObject(item["metadata"]) ? item["metadata"] : {};
  const kind = kindOf(key, filename, metadata["kind"], animated);
  const file: OutputFile = {
    filename,
    subfolder: typeof subfolder === "string" ? subfolder : "",
    type,
    kind,
    animated: animated && (kind === "image" || kind === "video"),
    key,
    ...dimension("width", metadata["width"]),
    ...dimension("height", metadata["height"]),
  };
  return Object.freeze(file);
}

function dimension(
  name: "width" | "height",
  value: JsonValue | undefined,
): { readonly width?: number; readonly height?: number } {
  return typeof value === "number" && Number.isFinite(value) ? { [name]: value } : {};
}

const EXTENSIONS: ReadonlyMap<string, FileKind> = new Map([
  ...["png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff", "avif", "svg"].map(
    (extension) => [extension, "image"] as const,
  ),
  ...["mp4", "webm", "mov", "mkv", "avi", "m4v"].map((extension) => [extension, "video"] as const),
  ...["flac", "mp3", "wav", "ogg", "opus", "m4a", "aac"].map(
    (extension) => [extension, "audio"] as const,
  ),
  ...["glb", "gltf", "obj", "fbx", "stl", "ply", "splat", "spz", "usdz"].map(
    (extension) => [extension, "3d"] as const,
  ),
]);

const KEYS: ReadonlyMap<string, FileKind> = new Map([
  ["images", "image"],
  ["audio", "audio"],
  ["3d", "3d"],
]);

/** The server's own `metadata.kind` first, then the extension, then the key. */
function kindOf(
  key: string,
  filename: string,
  metadataKind: JsonValue | undefined,
  animated: boolean,
): FileKind {
  if (metadataKind === "image" || metadataKind === "video" || metadataKind === "audio") {
    return metadataKind;
  }
  const dot = filename.lastIndexOf(".");
  const extension = dot === -1 ? "" : filename.slice(dot + 1).toLowerCase();
  const byExtension = EXTENSIONS.get(extension);
  if (byExtension !== undefined) return byExtension;
  const byKey = KEYS.get(key);
  // An animated entry with an unknown extension under `images` is a video (core's video nodes).
  if (byKey === "image" && animated) return "video";
  return byKey ?? "file";
}
