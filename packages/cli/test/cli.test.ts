import { describe, expect, test } from "bun:test";
import { CLI_VERSION, run } from "@tscomfy/cli";
import { CODEGEN_VERSION } from "@tscomfy/codegen";
import { readMockApiWorkflow, readMockObjectInfo, readMockUiWorkflow } from "@tscomfy/fixtures";
import { type MemoryIo, memoryIo, rawNode } from "./memory-io.ts";

const basic = await readMockObjectInfo("basic-pipeline");
const SERVER = "http://127.0.0.1:8188";
const sha256 = (text: string): string =>
  `sha256:${new Bun.CryptoHasher("sha256").update(text).digest("hex")}`;
const SYSTEM_STATS = JSON.stringify({ system: { comfyui_version: "0.41.0" } });

describe("tscomfy", () => {
  test.each(["--help", "help"])("prints usage to stdout for %p", async (arg) => {
    const io = memoryIo();
    expect(await run([arg], io)).toBe(0);
    expect(io.stdout()).toStartWith("Usage: tscomfy <command>");
  });

  test("prints usage to stderr and exits 2 when no command is given", async () => {
    const io = memoryIo();
    expect(await run([], io)).toBe(2);
    expect(io.stdout()).toBe("");
    expect(io.stderr()).toStartWith("Usage: tscomfy <command>");
  });

  test("prints its version, which matches package.json and codegen's", async () => {
    const io = memoryIo();
    expect(await run(["--version"], io)).toBe(0);
    expect(io.stdout()).toBe(`${CLI_VERSION}\n`);
    const manifest: unknown = await Bun.file(new URL("../package.json", import.meta.url)).json();
    expect(manifest).toMatchObject({ version: CLI_VERSION });
    expect(CODEGEN_VERSION).toBe(CLI_VERSION);
  });

  test("rejects an unknown command with exit 2 and the usage", async () => {
    const io = memoryIo();
    expect(await run(["generat"], io)).toBe(2);
    expect(io.stderr()).toStartWith(
      'tscomfy: Unknown command "generat".\n\nUsage: tscomfy <command>',
    );
  });

  test.each(["-h", "--help"])("%s is listed in every usage", async (flag) => {
    for (const command of [[], ["generate"], ["check"], ["transpile"]]) {
      const io = memoryIo();
      // oxlint-disable-next-line no-await-in-loop -- one command at a time
      expect(await run([...command, flag], io)).toBe(0);
      expect(io.stdout()).toContain("  -h, --help ");
    }
  });

  test.each(["-v", "--version"])(
    "%s prints the version and is listed in the usage",
    async (flag) => {
      const io = memoryIo();
      expect(await run([flag], io)).toBe(0);
      expect(io.stdout()).toBe(`${CLI_VERSION}\n`);
      const usage = memoryIo();
      expect(await run(["--help"], usage)).toBe(0);
      expect(usage.stdout()).toContain("  -v, --version ");
    },
  );

  test.each([
    ["generate", "Usage: tscomfy generate (--url <server> | --from"],
    ["check", "Usage: tscomfy check (--url <server> | --from"],
    ["transpile", "Usage: tscomfy transpile (--prompt <prompt.json> | --workflow"],
  ])("%s's usage, by --help, -h or help %s", async (command, usage) => {
    for (const args of [
      [command, "--help", "--out", "x"],
      [command, "-h"],
      ["help", command],
    ]) {
      const io = memoryIo();
      // oxlint-disable-next-line no-await-in-loop -- one command at a time
      expect(await run(args, io)).toBe(0);
      expect(io.stdout()).toStartWith(usage);
      expect(io.stderr()).toBe("");
    }
  });

  test.each([
    [["help", "generat"], 'Unknown command "generat".'],
    [["help", "generate", "check"], 'Unexpected argument "check".'],
    [["--version", "x"], 'Unexpected argument "x".'],
    [["-h", "generate"], 'Unexpected argument "generate".'],
    [["-x"], 'Unknown command "-x".'],
  ])("%p is a usage error", async (args, message) => {
    const io = memoryIo();
    expect(await run(args, io)).toBe(2);
    expect(io.stderr()).toStartWith(`tscomfy: ${message}\n\nUsage: tscomfy <command>`);
  });
});

describe("usage errors exit with 2 and show the command's usage", () => {
  test.each([
    [["--out", "gen", "stray"], 'Unexpected argument "stray".'],
    [["--out", "gen", "--colour"], "Unknown option --colour."],
    [["--out", "gen", "--out=other"], "--out is given twice."],
    [["--out"], "--out needs a value."],
    [["--out", "--from", "x.json"], "--out needs a value; for one that starts with -, write"],
    [["--out", "-x", "--from", "x.json"], "--out needs a value; for one that starts with -, write"],
    [["--out", "gen", "-x"], "Unknown option -x."],
    [["--out", "gen", "-h", "--help"], "--help is given twice."],
    [["--out="], "--out needs a value."],
    [["--out", "gen", "--quiet=yes"], "--quiet takes no value."],
    [["--from", "x.json"], "--out is required."],
    [["--out", "gen"], "Give either --url <server> or --from <object_info.json>."],
    [["--out", "gen", "--from", "x", "--url", SERVER], "Give either --url <server> or"],
    [["--out", "gen", "--url", "localhost:8188"], "localhost:8188 is not an http(s) URL."],
    [["--out", "gen", "--url", "not a url"], "--url is not a valid URL."],
    [["--out", "gen", "--url", "ftp://user:hunter2@host/"], "ftp://host/ is not an http(s) URL."],
    [["--out", "gen", "--url", `${SERVER}/#top`], "--url can't have a #fragment"],
    [["--out", "a\nb", "--from", "x"], "--out has a control character"],
    [["--out", "gen", "--from", "x\ty"], "--from has a control character"],
    [["--out", "gen", "--from", "x", "--comfy-version", "1\n2"], "--comfy-version has a control"],
    [["--out", "gen", "--from", "x", "--name", "foo-bar"], '--name "foo-bar" isn\'t usable'],
    [["--out", "gen", "--from", "x", "--name", "new"], '--name "new" isn\'t usable'],
    [
      ["--out", "gen", "--from", "x", "--name", "raw"],
      '--name "raw" isn\'t usable: the generated modules declare it themselves (defineSchema,',
    ],
    [["--out", "src/default", "--from", "x"], 'Can\'t make an export name from "src/default"'],
    [
      ["--out", "src/workflow", "--from", "x"],
      'Can\'t make an export name from "src/workflow": "workflow" won\'t do, the generated modules',
    ],
    [["--out", "gen", "--from", "x", "--verbose", "--quiet"], "--verbose and --quiet don't go"],
    [["--out", "gen", "--from", "x", "--import-extension", "mjs"], "--import-extension is .js"],
    [["--out", "gen", "--url", SERVER, "--comfy-version", "1"], "--comfy-version goes with"],
    [
      ["--out", "123", "--from", "x"],
      'Can\'t make an export name from "123": "123" won\'t do, it isn\'t an identifier',
    ],
    [["--out=---", "--from", "x"], 'Can\'t make an export name from "---"; pass --name.'],
  ])("generate %p", async (args, message) => {
    const io = memoryIo();
    expect(await run(["generate", ...args], io)).toBe(2);
    expect(io.stderr()).toStartWith(`tscomfy: ${message}`);
    expect(io.stderr()).toContain("\n\nUsage: tscomfy generate");
    expect(io.stderr()).not.toContain("hunter2");
    expect(io.files.size).toBe(0);
  });

  test("check", async () => {
    const io = memoryIo();
    expect(await run(["check", "--from", "x"], io)).toBe(2);
    expect(io.stderr()).toStartWith("tscomfy: --out is required.\n\nUsage: tscomfy check");
  });
});

describe("generate", () => {
  test("writes the types, the schema module and the raw snapshot from a file", async () => {
    const io = memoryIo({ "info.json": basic });
    expect(await run(["generate", "--from", "info.json", "--out", "src/my-server"], io)).toBe(0);
    expect([...io.files.keys()].toSorted()).toEqual([
      "info.json",
      "src/my-server/index.ts",
      "src/my-server/nodes.ts",
      "src/my-server/object_info.json",
      "src/my-server/tscomfy.json",
    ]);
    const manifest: unknown = JSON.parse(io.files.get("src/my-server/tscomfy.json") ?? "");
    expect(manifest).toEqual({
      codegen: CODEGEN_VERSION,
      schema: "sha256:98d52ff4d986ea41c24120212abb64697b7b584893c439020b621e5085bb5bec",
      exportName: "myServer",
      importExtension: ".js",
      files: {
        "nodes.ts": sha256(io.files.get("src/my-server/nodes.ts") ?? ""),
        "index.ts": sha256(io.files.get("src/my-server/index.ts") ?? ""),
        "object_info.json": sha256(basic),
      },
    });
    expect(io.files.get("src/my-server/object_info.json")).toBe(basic);
    const index = io.files.get("src/my-server/index.ts") ?? "";
    expect(index).toContain(
      "// Regenerate with: tscomfy generate --from info.json --out src/my-server\n",
    );
    expect(index).toContain('from "./nodes.js";');
    expect(index).toContain("export const myServer: TypedSchema<Nodes>");
    expect(io.files.get("src/my-server/nodes.ts")).toStartWith(
      `// Generated by @tscomfy/codegen ${CODEGEN_VERSION}. Do not edit: regenerate instead.\n// Schema sha256:`,
    );
    expect(io.stdout()).toMatch(
      /^Generated 11 node types from info\.json into src\/my-server:\n {2}nodes\.ts \d+\.\d KB · index\.ts \d+\.\d KB · object_info\.json \d+\.\d KB\n$/,
    );
    expect(io.stderr()).toBe("");
  });

  test("records the options it was given in the regenerate command, quoted for a shell", async () => {
    const io = memoryIo({ "my info.json": basic });
    const args = ["--from", "my info.json", "--out", "it's", "--name", "comfy"];
    const options = ["--import-extension", ".ts", "--comfy-version", "0.41.0"];
    expect(await run(["generate", ...args, ...options], io)).toBe(0);
    const index = io.files.get("it's/index.ts") ?? "";
    expect(index).toContain(
      "// Schema sha256:98d52ff4d986ea41c24120212abb64697b7b584893c439020b621e5085bb5bec, ComfyUI 0.41.0.\n" +
        `// Regenerate with: tscomfy generate --from 'my info.json' --out 'it'\\''s' --name comfy --import-extension .ts --comfy-version 0.41.0\n`,
    );
    expect(index).toContain('from "./nodes.ts";');
    expect(index).toContain("export const comfy: TypedSchema<Nodes>");
  });

  test("fetches /object_info and the version from a server, and keeps credentials out", async () => {
    const io = memoryIo(
      {},
      {
        "http://user:secret@comfy.local:8188/api/object_info": basic,
        "http://user:secret@comfy.local:8188/api/system_stats": SYSTEM_STATS,
      },
    );
    const url = "http://user:secret@comfy.local:8188/api/";
    expect(await run(["generate", "--url", url, "--out", "gen"], io)).toBe(0);
    expect(io.requests).toEqual([
      "http://user:secret@comfy.local:8188/api/object_info",
      "http://user:secret@comfy.local:8188/api/system_stats",
    ]);
    expect(io.stdout()).toStartWith(
      "Generated 11 node types from http://comfy.local:8188/api (ComfyUI 0.41.0) into gen:\n",
    );
    const written = [...io.files.values()].join("\n");
    expect(written).not.toContain("secret");
    expect(written).toContain(
      "// Regenerate with: tscomfy generate --url http://comfy.local:8188/api --out gen\n",
    );
  });

  test.each([
    ["fails", undefined],
    ["isn't JSON", "not json"],
    ["has no version string", JSON.stringify({ system: { comfyui_version: 1 } })],
  ])("generates without a version when /system_stats %s", async (_name, stats) => {
    const io = memoryIo(
      {},
      {
        [`${SERVER}/object_info`]: basic,
        ...(stats === undefined ? {} : { [`${SERVER}/system_stats`]: stats }),
      },
    );
    expect(await run(["generate", "--url", SERVER, "--out", "gen"], io)).toBe(0);
    expect(io.stdout()).toStartWith(`Generated 11 node types from ${SERVER} into gen:\n`);
    expect(io.files.get("gen/nodes.ts")).toContain("5bec.\n");
  });

  test("fails with exit 1 when the server can't be reached or the file is missing", async () => {
    let io = memoryIo();
    expect(await run(["generate", "--url", SERVER, "--out", "gen"], io)).toBe(1);
    expect(io.stderr()).toBe(`tscomfy: Could not reach ${SERVER}/object_info: refused\n`);
    io = memoryIo();
    expect(await run(["generate", "--from", "missing.json", "--out", "gen"], io)).toBe(1);
    expect(io.stderr()).toBe("tscomfy: There is no file at missing.json.\n");
    expect(io.files.size).toBe(0);
  });

  test("sends the query of the server URL with each request, and never shows it", async () => {
    const io = memoryIo(
      {},
      {
        "http://comfy.local/api/object_info?token=SECRET": basic,
        "http://comfy.local/api/system_stats?token=SECRET": SYSTEM_STATS,
      },
    );
    const url = "http://comfy.local/api?token=SECRET";
    expect(await run(["generate", "--url", url, "--out", "gen"], io)).toBe(0);
    expect(io.requests).toEqual([
      "http://comfy.local/api/object_info?token=SECRET",
      "http://comfy.local/api/system_stats?token=SECRET",
    ]);
    expect([...io.files.values(), io.stdout()].join("\n")).not.toContain("SECRET");
  });

  test.each([
    ["not JSON", "{", "E_INVALID_JSON"],
    ["not node definitions", "[1, 2]", "Expected /object_info to be an object"],
    ["empty", "{}", ""],
  ])("fails with exit 1, writing nothing, for a response that is %s", async (_name, text, why) => {
    const io = memoryIo({ "info.json": text });
    expect(await run(["generate", "--from", "info.json", "--out", "gen"], io)).toBe(1);
    expect(io.stderr()).toStartWith("tscomfy: info.json doesn't hold node definitions");
    if (why.startsWith("E_")) expect(io.stderr()).not.toContain(why);
    else expect(io.stderr()).toContain(why);
    expect(io.files.size).toBe(1);
  });

  test.each([
    ['{"detail": "Not authenticated"}', '"Not authenticated"'],
    ['{"error": {"type": "auth", "message": "no"}}', '{"type":"auth","message":"no"}'],
    ['{"message": "Forbidden"}', '"Forbidden"'],
    // Control characters are escaped, and a long message is cut.
    [
      JSON.stringify({ detail: `\u001b[31mred\u009b${"x".repeat(300)}` }),
      String.raw`"\u001b[31mred\u009b`,
    ],
  ])("names an error body as one: %s", async (text, shown) => {
    const io = memoryIo({ "info.json": text });
    expect(await run(["generate", "--from", "info.json", "--out", "gen"], io)).toBe(1);
    expect(io.stderr()).toStartWith(
      `tscomfy: info.json is an error response, not node definitions: ${shown}`,
    );
    expect(io.stderr()).not.toContain("\u001b");
    expect(io.stderr()).not.toContain("\u009b");
    expect(io.stderr().length).toBeLessThan(300);
    expect(io.files.size).toBe(1);
  });

  test("names an error body a server answers with 200 as one", async () => {
    const io = memoryIo(
      {},
      {
        [`${SERVER}/object_info`]: '{"detail": "Not authenticated"}',
        [`${SERVER}/system_stats`]: "{}",
      },
    );
    expect(await run(["generate", "--url", SERVER, "--out", "gen"], io)).toBe(1);
    expect(io.stderr()).toBe(
      `tscomfy: ${SERVER} is an error response, not node definitions: "Not authenticated".\n`,
    );
  });

  test("takes a node class named error or detail for a node, not an error body", async () => {
    const io = memoryIo({ "info.json": JSON.stringify({ error: rawNode("error", {}) }) });
    expect(await run(["generate", "--from", "info.json", "--out", "gen", "--quiet"], io)).toBe(0);
  });

  test("names the export after --out, camelCased like transpile's", async () => {
    for (const [out, name] of [
      ["src/My_Server", "myServer"],
      ["LOCAL", "local"],
      ["comfy-UI.v2", "comfyUiV2"],
    ] as const) {
      const io = memoryIo({ "info.json": basic });
      // oxlint-disable-next-line no-await-in-loop -- one run at a time
      expect(await run(["generate", "--from", "info.json", "--out", out, "--quiet"], io)).toBe(0);
      expect(io.files.get(`${out}/index.ts`)).toContain(`export const ${name}: TypedSchema<Nodes>`);
    }
  });

  test("records the server's version, and keeps it when regenerating from the snapshot", async () => {
    const io = memoryIo(
      {},
      { [`${SERVER}/object_info`]: basic, [`${SERVER}/system_stats`]: SYSTEM_STATS },
    );
    expect(await run(["generate", "--url", SERVER, "--out", "gen", "--quiet"], io)).toBe(0);
    expect(JSON.parse(io.files.get("gen/tscomfy.json") ?? "")).toMatchObject({
      comfyVersion: "0.41.0",
    });
    // The server says again: not part of the command.
    expect(io.files.get("gen/index.ts")).toContain(
      `// Regenerate with: tscomfy generate --url ${SERVER} --out gen\n`,
    );

    expect(await run(["generate", "--from", "gen/object_info.json", "--out", "copy"], io)).toBe(0);
    expect(io.stdout()).toStartWith(
      "Generated 11 node types from gen/object_info.json (ComfyUI 0.41.0) into copy:\n",
    );
    expect(io.files.get("copy/index.ts")).toContain(
      "// Regenerate with: tscomfy generate --from gen/object_info.json --out copy --comfy-version 0.41.0\n",
    );
    expect(JSON.parse(io.files.get("copy/tscomfy.json") ?? "")).toMatchObject({
      comfyVersion: "0.41.0",
    });

    // Not the recorded snapshot (edited, or another file): the version is unknown.
    for (const [file, text] of [
      ["gen/object_info.json", `${basic} `],
      ["other/object_info.json", basic],
      ["gen/info.json", basic],
    ] as const) {
      const other = memoryIo({ ...Object.fromEntries(io.files), [file]: text });
      // oxlint-disable-next-line no-await-in-loop -- one run at a time
      expect(await run(["generate", "--from", file, "--out", "x", "--quiet"], other)).toBe(0);
      expect(JSON.parse(other.files.get("x/tscomfy.json") ?? "")).not.toHaveProperty(
        "comfyVersion",
      );
    }

    // A --comfy-version given wins.
    const given = ["--from", "gen/object_info.json", "--out", "y", "--comfy-version", "0.42.0"];
    expect(await run(["generate", ...given, "--quiet"], io)).toBe(0);
    expect(JSON.parse(io.files.get("y/tscomfy.json") ?? "")).toMatchObject({
      comfyVersion: "0.42.0",
    });
  });

  test("records values that start with - as --flag=value, and the command runs again", async () => {
    const io = memoryIo({ "-info.json": basic });
    const args = ["generate", "--from=-info.json", "--out=--weird", "--comfy-version=-1"];
    expect(await run([...args, "--name", "flow"], io)).toBe(0);
    const index = io.files.get("--weird/index.ts") ?? "";
    const recorded =
      "tscomfy generate --from=-info.json --out=--weird --name flow --comfy-version=-1";
    expect(index).toContain(`// Regenerate with: ${recorded}\n`);
    const again = memoryIo({ "-info.json": basic });
    // No word needs quotes, so splitting at spaces is what a shell does.
    expect(await run(recorded.split(" ").slice(1), again)).toBe(0);
    expect(again.files).toEqual(io.files);
  });

  test("reports diagnostics grouped by pack, a few per pack unless verbose", async () => {
    const malformed = await readMockObjectInfo("malformed");
    const io = memoryIo({ "info.json": malformed });
    expect(await run(["generate", "--from", "info.json", "--out", "gen"], io)).toBe(0);
    const report = io.stdout().split("\n").slice(2);
    expect(report[0]).toBe("6 errors and 44 warnings in the node definitions:");
    expect(report.filter((line) => /^ {2}\S/.test(line))).toEqual([
      "  (no pack): 6",
      "  custom_nodes.mock-pack: 44",
    ]);
    expect(report).toContain("    … and 39 more (--verbose shows all)");
    expect(
      report.filter((line) => line.startsWith("    E_") || line.startsWith("    W_")),
    ).toHaveLength(10);

    const verbose = memoryIo({ "info.json": malformed });
    expect(
      await run(["generate", "--from", "info.json", "--out", "gen", "--verbose"], verbose),
    ).toBe(0);
    const lines = verbose.stdout().split("\n");
    expect(
      lines.filter((line) => line.startsWith("    E_") || line.startsWith("    W_")),
    ).toHaveLength(50);
    expect(lines.some((line) => line.includes("more (--verbose"))).toBeFalse();
  });

  test("prints only errors, to stderr, when quiet", async () => {
    const io = memoryIo({ "info.json": await readMockObjectInfo("malformed") });
    expect(await run(["generate", "--from", "info.json", "--out", "gen", "--quiet"], io)).toBe(0);
    expect(io.stdout()).toBe("");
    const lines = io.stderr().trimEnd().split("\n");
    expect(lines).toHaveLength(6);
    expect(lines.every((line) => line.startsWith("E_"))).toBeTrue();
    expect(lines).toContain(
      "E_INVALID_NODE MockNotAnObject: Expected a node definition object, got a number; dropping the node.",
    );
  });
});

/** An Io holding `before.json` and what `generate --from before.json --out gen` wrote. */
async function generated(text: string, extra: readonly string[] = []): Promise<MemoryIo> {
  const io = memoryIo({ "before.json": text });
  const args = ["generate", "--from", "before.json", "--out", "gen", "--quiet", ...extra];
  expect(await run(args, io)).toBe(0);
  expect(io.stdout() + io.stderr()).toBe("");
  return io;
}

/** `Prefix00`, `Prefix01`, …: `count` names that sort in order. */
const names = (prefix: string, count: number): string[] =>
  Array.from({ length: count }, (_, index) => `${prefix}${String(index).padStart(2, "0")}`);

/** Raw nodes of the given classes, each with INT inputs of the given names. */
const nodesWith = (classes: readonly string[], inputs: readonly string[]): string =>
  JSON.stringify(
    Object.fromEntries(
      classes.map((name) => [
        name,
        rawNode(name, Object.fromEntries(inputs.map((input) => [input, ["INT", {}]]))),
      ]),
    ),
  );

/** A raw loader whose upload combo lists `files`. */
const uploadNode = (name: string, files: readonly string[]): Record<string, unknown> =>
  rawNode(name, { image: [files, { image_upload: true }] });

describe("check", () => {
  test("reports up to date when the schemas match, ignoring fields the schema drops", async () => {
    const node = rawNode("Node", { mode: [["a", "b"]] });
    const io = await generated(JSON.stringify({ Node: node }));
    // Reformatted, with a field the normalizer doesn't read: the same schema.
    io.files.set("after.json", JSON.stringify({ Node: { ...node, extra_field: 1 } }, null, 4));
    expect(await run(["check", "--from", "after.json", "--out", "gen"], io)).toBe(0);
    expect(io.stdout()).toBe("Up to date: 1 node type matches gen/object_info.json.\n");
  });

  test("fetches from a server like generate does", async () => {
    const io = await generated(basic);
    const server = memoryIo(Object.fromEntries(io.files), { [`${SERVER}/object_info`]: basic });
    expect(await run(["check", "--url", SERVER, "--out", "gen"], server)).toBe(0);
    expect(server.requests).toEqual([`${SERVER}/object_info`, `${SERVER}/system_stats`]);
  });

  test("lists what changed and exits 1 on drift, suggesting the recorded command", async () => {
    const options = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta"];
    const before = {
      Changed: rawNode("Changed", {
        mode: [["a", "b"]],
        many: [options.slice(0, 1)],
        old: ["INT", { default: 1 }],
        kept: ["INT", { default: 1 }],
      }),
      Removed: rawNode("Removed", {}),
      Same: rawNode("Same", {}),
    };
    const after = {
      Added: rawNode("Added", {}),
      Changed: {
        ...rawNode("Changed", {
          mode: [["b", "c"]],
          many: [options],
          kept: ["INT", { default: 2 }],
          new: ["IMAGE"],
        }),
        output: ["LATENT"],
        category: "moved",
      },
      Same: rawNode("Same", {}),
    };
    const io = await generated(JSON.stringify(before), ["--name", "comfy"]);
    io.files.set("after.json", JSON.stringify(after));
    expect(await run(["check", "--from", "after.json", "--out", "gen"], io)).toBe(1);
    expect(io.stdout()).toBe(
      [
        "after.json differs from gen/object_info.json:",
        "  + 1 node added: Added",
        "  - 1 node removed: Removed",
        "  ~ 1 node changed:",
        "    Changed",
        "      inputs added: new",
        "      inputs removed: old",
        '      mode: + "c"; - "a"',
        '      many: + "beta", "gamma", "delta", "epsilon", "zeta", … and 1 more (--verbose shows all)',
        "      kept: spec changed",
        "      outputs changed",
        "      details changed (name, category, description, flags or order)",
        "Run tscomfy generate --from after.json --out gen --name comfy to update.",
        "",
      ].join("\n"),
    );

    const verbose = memoryIo(Object.fromEntries(io.files));
    expect(await run(["check", "--from", "after.json", "--out", "gen", "--verbose"], verbose)).toBe(
      1,
    );
    expect(verbose.stdout()).toContain(
      '      many: + "beta", "gamma", "delta", "epsilon", "zeta", "eta"\n',
    );
  });

  test.each([
    ["truncated", "nodes.ts", (text: string) => text.split("\n").slice(0, 3).join("\n")],
    ["edited", "index.ts", (text: string) => `${text}export const injected = 1;\n`],
    ["removed", "nodes.ts", undefined],
    ["edited", "object_info.json", (text: string) => text.replace("model-a", "model-z")],
  ])("exits 1 when a generated file was %s (%s)", async (_how, file, edit) => {
    const io = await generated(basic);
    const path = `gen/${file}`;
    if (edit === undefined) io.files.delete(path);
    else io.files.set(path, edit(io.files.get(path) ?? ""));
    expect(await run(["check", "--from", "before.json", "--out", "gen"], io)).toBe(1);
    expect(io.stdout()).toStartWith(
      `${file} in gen isn't what tscomfy generate wrote: edited, missing, or from an interrupted run.\n`,
    );
    expect(io.stdout()).toEndWith("Run tscomfy generate --from before.json --out gen to update.\n");
  });

  test("exits 1 for output of another codegen version", async () => {
    const io = await generated(basic);
    const manifest = io.files.get("gen/tscomfy.json") ?? "";
    io.files.set(
      "gen/tscomfy.json",
      manifest.replace(`"codegen": "${CODEGEN_VERSION}"`, '"codegen": "9.9.9"'),
    );
    expect(await run(["check", "--from", "before.json", "--out", "gen"], io)).toBe(1);
    expect(io.stdout()).toStartWith(
      `gen was generated by @tscomfy/codegen 9.9.9; this is ${CODEGEN_VERSION}.\n`,
    );
  });

  test("exits 1 when the snapshot was read by another version of tscomfy", async () => {
    const io = await generated(basic);
    const manifest = io.files.get("gen/tscomfy.json") ?? "";
    io.files.set(
      "gen/tscomfy.json",
      manifest.replace(/"schema": "sha256:[0-9a-f]+"/, '"schema": "sha256:0"'),
    );
    expect(await run(["check", "--from", "before.json", "--out", "gen"], io)).toBe(1);
    expect(io.stdout()).toStartWith(
      "gen was generated by another version of tscomfy, which read the snapshot differently.\n",
    );
  });

  test("suggests the server's recorded version with --from, not with --url", async () => {
    const io = memoryIo(
      {},
      { [`${SERVER}/object_info`]: basic, [`${SERVER}/system_stats`]: SYSTEM_STATS },
    );
    expect(await run(["generate", "--url", SERVER, "--out", "gen", "--quiet"], io)).toBe(0);
    io.files.set("gen/nodes.ts", "");
    expect(await run(["check", "--from", "gen/object_info.json", "--out", "gen"], io)).toBe(1);
    expect(io.stdout()).toEndWith(
      "Run tscomfy generate --from gen/object_info.json --out gen --comfy-version 0.41.0 to update.\n",
    );
    const server = memoryIo(Object.fromEntries(io.files), {
      [`${SERVER}/object_info`]: basic,
      [`${SERVER}/system_stats`]: SYSTEM_STATS,
    });
    expect(await run(["check", "--url", SERVER, "--out", "gen"], server)).toBe(1);
    expect(server.stdout()).toEndWith(
      `Run tscomfy generate --url ${SERVER} --out gen to update.\n`,
    );
  });

  test("suggests the recorded --comfy-version again with --from", async () => {
    const io = await generated(basic, ["--comfy-version", "0.41.0"]);
    io.files.set("gen/nodes.ts", "");
    expect(await run(["check", "--from", "before.json", "--out", "gen"], io)).toBe(1);
    expect(io.stdout()).toEndWith(
      "Run tscomfy generate --from before.json --out gen --comfy-version 0.41.0 to update.\n",
    );
  });

  test.each([
    "not json",
    "[]",
    '{"codegen": 1}',
    '{"codegen": "0.0.0", "schema": "x", "exportName": "gen", "importExtension": ".js", "files": {}}',
    '{"codegen": "0.0.0", "schema": "x", "exportName": "gen", "importExtension": ".js", "files": {"nodes.ts": "a", "index.ts": "b", "object_info.json": "c", "../x": "d"}}',
  ])("fails for a manifest that isn't one: %p", async (text) => {
    const io = await generated(basic);
    io.files.set("gen/tscomfy.json", text);
    expect(await run(["check", "--from", "before.json", "--out", "gen"], io)).toBe(1);
    expect(io.stderr()).toMatch(/^tscomfy: gen\/tscomfy\.json is not (JSON|a tscomfy manifest)/);
  });

  test("counts new files in upload and remote combos as runtime state, not drift", async () => {
    const node = rawNode("Load", {
      image: [["a.png", "b.png"], { image_upload: true }],
      fixed: [["x", "y"]],
    });
    const io = await generated(JSON.stringify({ Load: node }));
    const uploaded = rawNode("Load", {
      image: [["a.png", "b.png", "new.png"], { image_upload: true }],
      fixed: [["x", "y"]],
    });
    io.files.set("after.json", JSON.stringify({ Load: uploaded }));
    expect(await run(["check", "--from", "after.json", "--out", "gen"], io)).toBe(0);
    expect(io.stdout()).toBe(
      "Up to date: 1 node type matches gen/object_info.json (changed files in 1 upload or remote combo aren't drift: Load.image).\n",
    );
    const both = rawNode("Load", {
      image: [["a.png", "new.png"], { image_upload: true }],
      fixed: [["x", "y", "z"]],
    });
    io.files.set("after.json", JSON.stringify({ Load: both }));
    const drift = memoryIo(Object.fromEntries(io.files));
    expect(await run(["check", "--from", "after.json", "--out", "gen"], drift)).toBe(1);
    expect(drift.stdout()).toContain('    Load\n      fixed: + "z"\n');
    expect(drift.stdout()).not.toContain("image:");
  });

  test("exits 1 when nothing was generated", async () => {
    const io = memoryIo({ "after.json": basic });
    expect(await run(["check", "--from", "after.json", "--out", "gen"], io)).toBe(1);
    expect(io.stderr()).toBe(
      "tscomfy: There is no tscomfy.json in gen; run tscomfy generate first.\n",
    );
  });

  test("fails, rather than reporting drift, when the server answers without nodes", async () => {
    const io = await generated(basic);
    io.files.set("after.json", '{"detail": "Not authenticated"}');
    expect(await run(["check", "--from", "after.json", "--out", "gen"], io)).toBe(1);
    expect(io.stderr()).toBe(
      'tscomfy: after.json is an error response, not node definitions: "Not authenticated".\n',
    );
    const array = memoryIo({ ...Object.fromEntries(io.files), "after.json": "[]" });
    expect(await run(["check", "--from", "after.json", "--out", "gen"], array)).toBe(1);
    expect(array.stderr()).toStartWith(
      "tscomfy: after.json doesn't hold node definitions: Expected /object_info to be an object",
    );
  });

  test("lists at most a few nodes and inputs unless verbose", async () => {
    const changed = names("Changed", 12);
    const io = await generated(nodesWith([...changed, ...names("Removed", 11)], ["kept"]));
    io.files.set(
      "after.json",
      nodesWith([...changed, ...names("Added", 15)], ["kept", ...names("input", 13)]),
    );
    expect(await run(["check", "--from", "after.json", "--out", "gen"], io)).toBe(1);
    const lines = io.stdout().split("\n");
    expect(lines.slice(1, 6)).toEqual([
      `  + 15 nodes added: ${names("Added", 10).join(", ")}, … and 5 more (--verbose shows all)`,
      `  - 11 nodes removed: ${names("Removed", 10).join(", ")}, … and 1 more (--verbose shows all)`,
      "  ~ 12 nodes changed:",
      "    Changed00",
      `      inputs added: ${names("input", 10).join(", ")}, … and 3 more (--verbose shows all)`,
    ]);
    expect(lines.filter((line) => line.startsWith("    Changed"))).toHaveLength(10);
    expect(lines).toContain("    … and 2 more (--verbose shows all)");
    expect(Math.max(...lines.map((line) => line.length))).toBeLessThan(200);

    const verbose = memoryIo(Object.fromEntries(io.files));
    expect(await run(["check", "--from", "after.json", "--out", "gen", "--verbose"], verbose)).toBe(
      1,
    );
    const all = verbose.stdout();
    expect(all).toContain(`  + 15 nodes added: ${names("Added", 15).join(", ")}\n`);
    expect(all).toContain(`  - 11 nodes removed: ${names("Removed", 11).join(", ")}\n`);
    expect(all).toContain(`      inputs added: ${names("input", 13).join(", ")}\n`);
    expect(all.split("\n").filter((line) => line.startsWith("    Changed"))).toHaveLength(12);
    expect(all).not.toContain("more (--verbose");
  });

  test("lists at most a few upload combos it ignores unless verbose", async () => {
    const loaders = Array.from(
      { length: 12 },
      (_, index) => `Load${String(index).padStart(2, "0")}`,
    );
    const io = await generated(
      JSON.stringify(
        Object.fromEntries(loaders.map((name) => [name, uploadNode(name, ["a.png"])])),
      ),
    );
    io.files.set(
      "after.json",
      JSON.stringify(
        Object.fromEntries(loaders.map((name) => [name, uploadNode(name, ["a.png", "b.png"])])),
      ),
    );
    expect(await run(["check", "--from", "after.json", "--out", "gen"], io)).toBe(0);
    expect(io.stdout()).toBe(
      `Up to date: 12 node types match gen/object_info.json (changed files in 12 upload or remote combos aren't drift: ${loaders
        .slice(0, 10)
        .map((name) => `${name}.image`)
        .join(", ")}, … and 2 more (--verbose shows all)).\n`,
    );
  });
});

/** {@link generated} from basic-pipeline, plus a prompt at `prompts/My Txt2Img.json`. */
async function withPrompt(prompt: string): Promise<MemoryIo> {
  const io = await generated(basic);
  io.files.set("prompts/My Txt2Img.json", prompt);
  return io;
}

describe("transpile", () => {
  test("prints a module over the generated types, importing them relative to the output", async () => {
    const io = await withPrompt(await readMockApiWorkflow("txt2img"));
    expect(
      await run(["transpile", "--prompt", "prompts/My Txt2Img.json", "--schema", "gen"], io),
    ).toBe(0);
    expect(io.stderr()).toBe("");
    expect(io.stdout()).toContain('import { gen } from "./gen/index.js";\n');
    expect(io.stdout()).toContain(
      "export const myTxt2Img: Workflow<NodesOf<typeof gen>> = workflow(gen, ({ n }) => {",
    );
    expect(io.stdout()).toContain(
      "// Regenerate with: tscomfy transpile --prompt 'prompts/My Txt2Img.json' --schema gen\n",
    );
  });

  test("writes the module to --out, with --name and --no-inline", async () => {
    const io = await withPrompt(await readMockApiWorkflow("txt2img"));
    const args = [
      "--prompt",
      "prompts/My Txt2Img.json",
      "--schema",
      "gen",
      "--out",
      "src/flows/t.ts",
    ];
    expect(await run(["transpile", ...args, "--name", "txt2img", "--no-inline"], io)).toBe(0);
    expect(io.stdout()).toBe(
      "Transpiled 8 nodes from prompts/My Txt2Img.json into src/flows/t.ts.\n",
    );
    const code = io.files.get("src/flows/t.ts") ?? "";
    expect(code).toContain('import { gen } from "../../gen/index.js";\n');
    expect(code).toContain("export const txt2img: ");
    expect(code).toContain("const seed = n.MockSeed(");
  });

  test("reports what it writes as raw on stderr", async () => {
    const prompt = JSON.stringify({
      "1": { class_type: "VAELoader", inputs: { vae_name: "pixel_space", x: 1 } },
    });
    const io = await withPrompt(prompt);
    expect(
      await run(["transpile", "--prompt", "prompts/My Txt2Img.json", "--schema", "gen"], io),
    ).toBe(0);
    expect(io.stderr()).toStartWith(
      "W_TRANSPILED_AS_RAW 1: Node 1 (VAELoader) is written as raw(…)",
    );
    expect(io.stdout()).toContain(
      'raw("VAELoader", { vae_name: "pixel_space", x: 1 }, { id: "1" });',
    );
  });

  test.each([
    [["--schema", "gen"], 2, "--prompt or --workflow is required."],
    [
      ["--prompt", "p.json", "--workflow", "w.json", "--schema", "gen"],
      2,
      "Pass --prompt or --workflow, not both.",
    ],
    [["--prompt", "p.json"], 2, "--schema is required."],
    [
      ["--prompt", "prompts/My Txt2Img.json", "--schema", "gen", "--name", "gen"],
      2,
      '--name "gen" isn\'t usable',
    ],
    [["--prompt", "1.json", "--schema", "gen"], 2, 'Can\'t name the export "1", after "1.json"'],
    [["--prompt", "workflow.json", "--schema", "gen"], 2, 'Can\'t name the export "workflow"'],
    [["--prompt", `${"a".repeat(60)}.json`, "--schema", "gen"], 2, "Can't name the export"],
    [["--prompt", "missing.json", "--schema", "gen"], 1, "There is no file at missing.json."],
    [
      ["--prompt", "prompts/My Txt2Img.json", "--schema", "nowhere"],
      1,
      "There is no tscomfy.json in nowhere",
    ],
  ])("fails for %p", async (args, exit, message) => {
    const io = await withPrompt("{}");
    expect(await run(["transpile", ...args], io)).toBe(exit);
    expect(io.stderr()).toStartWith(`tscomfy: ${message}`);
  });

  test("transpiles a UI workflow, as the frontend would queue it", async () => {
    const io = await withPrompt(await readMockUiWorkflow("txt2img"));
    const args = ["--workflow", "prompts/My Txt2Img.json", "--schema", "gen"];
    expect(await run(["transpile", ...args], io)).toBe(0);
    expect(io.stderr()).toBe("");
    // The Reroute, the PrimitiveNode and the Note are resolved away.
    expect(io.stdout()).toContain('text: "a cat"');
    expect(io.stdout()).not.toContain("Reroute");
    expect(io.stdout()).toContain(
      "// Regenerate with: tscomfy transpile --workflow 'prompts/My Txt2Img.json' --schema gen\n",
    );
  });

  test.each([
    ["--prompt", "ui", "isn't a prompt: it is a UI workflow; pass it with --workflow instead."],
    [
      "--workflow",
      "api",
      "isn't a UI workflow: it is an API prompt; pass it with --prompt instead.",
    ],
    ["--workflow", "[]", "isn't a UI workflow: Expected a UI workflow"],
  ] as const)("%s refuses the other format (%s)", async (flag, given, message) => {
    const text =
      given === "ui"
        ? await readMockUiWorkflow("txt2img")
        : given === "api"
          ? await readMockApiWorkflow("txt2img")
          : given;
    const io = await withPrompt(text);
    expect(await run(["transpile", flag, "prompts/My Txt2Img.json", "--schema", "gen"], io)).toBe(
      1,
    );
    expect(io.stderr()).toStartWith(`tscomfy: prompts/My Txt2Img.json ${message}`);
  });

  test("fails for a file that isn't a prompt", async () => {
    const io = await withPrompt("[1]");
    expect(
      await run(["transpile", "--prompt", "prompts/My Txt2Img.json", "--schema", "gen"], io),
    ).toBe(1);
    expect(io.stderr()).toStartWith("tscomfy: prompts/My Txt2Img.json isn't a prompt: ");
  });
});

test("transpile refuses a schema whose export name the module declares itself", async () => {
  // generate refuses such a name; a manifest is a file anyone can edit.
  const io = await withPrompt(await readMockApiWorkflow("txt2img"));
  const manifest = io.files.get("gen/tscomfy.json") ?? "";
  io.files.set("gen/tscomfy.json", manifest.replace('"exportName": "gen"', '"exportName": "raw"'));
  expect(
    await run(["transpile", "--prompt", "prompts/My Txt2Img.json", "--schema", "gen"], io),
  ).toBe(1);
  expect(io.stderr()).toBe(
    "tscomfy: The schema's export name, raw, won't do: the generated modules declare it themselves (defineSchema, TypedSchema, Nodes, workflow, Workflow, NodesOf, n, raw). Run tscomfy generate again with another --name.\n",
  );
});

test("transpile records values that start with - as --flag=value", async () => {
  const io = await withPrompt(await readMockApiWorkflow("txt2img"));
  io.files.set("-p.json", io.files.get("prompts/My Txt2Img.json") ?? "");
  const args = ["--prompt=-p.json", "--schema", "gen", "--out=-t.ts", "--name", "flow"];
  expect(await run(["transpile", ...args], io)).toBe(0);
  expect(io.files.get("-t.ts")).toContain(
    "// Regenerate with: tscomfy transpile --prompt=-p.json --schema gen --out=-t.ts --name flow\n",
  );
});

test("transpile refuses a name whose declaration is wider than a line", async () => {
  const io = await withPrompt(await readMockApiWorkflow("txt2img"));
  const name = "a".repeat(60);
  const args = ["--prompt", "prompts/My Txt2Img.json", "--schema", "gen", "--name", name];
  expect(await run(["transpile", ...args], io)).toBe(2);
  expect(io.stderr()).toStartWith(
    `tscomfy: --name "${name}" isn't usable: the declaration \`export const ${name}: Workflow<NodesOf<typeof gen>> =\` is wider than 100 columns.\n`,
  );
});

test("transpile takes a prompt with a node named prompt", async () => {
  const io = await withPrompt(
    JSON.stringify({ prompt: { class_type: "VAELoader", inputs: { vae_name: "pixel_space" } } }),
  );
  expect(
    await run(["transpile", "--prompt", "prompts/My Txt2Img.json", "--schema", "gen"], io),
  ).toBe(0);
  expect(io.stdout()).toContain('n.VAELoader({ vae_name: "pixel_space" }, { id: "prompt" });');
});
