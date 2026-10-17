import { CliError, type Io } from "@tscomfy/cli";

/** An {@link Io} over an in-memory file system and canned responses, recording what it does. */
export interface MemoryIo extends Io {
  readonly files: Map<string, string>;
  readonly requests: string[];
  readonly stdout: () => string;
  readonly stderr: () => string;
}

export function memoryIo(
  files: Readonly<Record<string, string>> = {},
  responses: Readonly<Record<string, string>> = {},
): MemoryIo {
  const stored = new Map(Object.entries(files));
  const requests: string[] = [];
  let stdout = "";
  let stderr = "";
  return {
    files: stored,
    requests,
    stdout: () => stdout,
    stderr: () => stderr,
    out: (text) => {
      stdout += text;
    },
    err: (text) => {
      stderr += text;
    },
    fetchText: (url) => {
      requests.push(url);
      const body = responses[url];
      return body === undefined
        ? Promise.reject(new CliError(`Could not reach ${url}: refused`))
        : Promise.resolve(body);
    },
    readText: (path) => Promise.resolve(stored.get(path)),
    writeText: (path, text) => {
      stored.set(path, text);
      return Promise.resolve();
    },
  };
}

/** A raw `/object_info` node with the given required inputs, in the server's shape. */
export function rawNode(
  name: string,
  required: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    input: { required },
    input_order: { required: Object.keys(required) },
    output: ["IMAGE"],
    output_is_list: [false],
    output_name: ["IMAGE"],
    name,
    display_name: name,
    description: "",
    python_module: "custom_nodes.test-pack",
    category: "test",
    output_node: false,
  };
}
