import { describe, expect, test } from "bun:test";
import { CLI_VERSION, run } from "@tscomfy/cli";
import { CODEGEN_VERSION } from "@tscomfy/codegen";
import { readMockObjectInfo } from "@tscomfy/fixtures";
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

  test.each(["generate", "check"])("%s --help prints the command's usage", async (command) => {
    const io = memoryIo();
    expect(await run([command, "--help", "--out", "x"], io)).toBe(0);
    expect(io.stdout()).toStartWith(`Usage: tscomfy ${command} (--url <server> | --from`);
  });
});

describe("usage errors exit with 2 and show the command's usage", () => {
  test.each([
    [["--out", "gen", "stray"], 'Unexpected argument "stray".'],
    [["--out", "gen", "--colour"], "Unknown option --colour."],
    [["--out", "gen", "--out=other"], "--out is given twice."],
    [["--out"], "--out needs a value."],
    [["--out", "--from", "x.json"], "--out needs a value."],
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
    [["--out", "gen", "--from", "x", "--name", "foo-bar"], '--name "foo-bar" isn\'t usable'],
    [["--out", "gen", "--from", "x", "--name", "new"], '--name "new" isn\'t usable'],
    [["--out", "src/default", "--from", "x"], 'Can\'t make an export name from "src/default"'],
    [["--out", "gen", "--from", "x", "--verbose", "--quiet"], "--verbose and --quiet don't go"],
    [["--out", "gen", "--from", "x", "--import-extension", "mjs"], "--import-extension is .js"],
    [["--out", "gen", "--url", SERVER, "--comfy-version", "1"], "--comfy-version goes with"],
    [["--out", "123", "--from", "x"], 'Can\'t make an export name from "123"; pass --name.'],
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
      codegen: "0.0.0",
      schema: "sha256:35783d14e93453b9508b252e19e9be14c98482c96ee8db46554e506efc169cb1",
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
      "// Generated by @tscomfy/codegen 0.0.0. Do not edit: regenerate instead.\n// Schema sha256:",
    );
    expect(io.stdout()).toMatch(
      /^Generated 8 node types from info\.json into src\/my-server:\n {2}nodes\.ts \d+\.\d KB · index\.ts \d+\.\d KB · object_info\.json \d+\.\d KB\n$/,
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
      "// Schema sha256:35783d14e93453b9508b252e19e9be14c98482c96ee8db46554e506efc169cb1, ComfyUI 0.41.0.\n" +
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
      "Generated 8 node types from http://comfy.local:8188/api (ComfyUI 0.41.0) into gen:\n",
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
    expect(io.stdout()).toStartWith(`Generated 8 node types from ${SERVER} into gen:\n`);
    expect(io.files.get("gen/nodes.ts")).toContain("cb1.\n");
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
    ["an error body", '{"detail": "Not authenticated"}', "Expected a node definition object"],
    ["empty", "{}", ""],
  ])("fails with exit 1, writing nothing, for a response that is %s", async (_name, text, why) => {
    const io = memoryIo({ "info.json": text });
    expect(await run(["generate", "--from", "info.json", "--out", "gen"], io)).toBe(1);
    expect(io.stderr()).toStartWith("tscomfy: info.json doesn't hold node definitions");
    if (why.startsWith("E_")) expect(io.stderr()).not.toContain(why);
    else expect(io.stderr()).toContain(why);
    expect(io.files.size).toBe(1);
  });

  test("reports diagnostics grouped by pack, a few per pack unless verbose", async () => {
    const malformed = await readMockObjectInfo("malformed");
    const io = memoryIo({ "info.json": malformed });
    expect(await run(["generate", "--from", "info.json", "--out", "gen"], io)).toBe(0);
    const report = io.stdout().split("\n").slice(2);
    expect(report[0]).toBe("6 errors and 36 warnings in the node definitions:");
    expect(report.filter((line) => /^ {2}\S/.test(line))).toEqual([
      "  (no pack): 6",
      "  custom_nodes.mock-pack: 36",
    ]);
    expect(report).toContain("    … and 31 more (--verbose shows all)");
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
    ).toHaveLength(42);
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
        '      many: + "beta", "gamma", "delta", "epsilon", "zeta", … 1 more',
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
    io.files.set("gen/tscomfy.json", manifest.replace('"codegen": "0.0.0"', '"codegen": "9.9.9"'));
    expect(await run(["check", "--from", "before.json", "--out", "gen"], io)).toBe(1);
    expect(io.stdout()).toStartWith(
      "gen was generated by @tscomfy/codegen 9.9.9; this is 0.0.0.\n",
    );
  });

  test.each(["not json", "[]", '{"codegen": 1}'])(
    "fails for a manifest that isn't one: %p",
    async (text) => {
      const io = await generated(basic);
      io.files.set("gen/tscomfy.json", text);
      expect(await run(["check", "--from", "before.json", "--out", "gen"], io)).toBe(1);
      expect(io.stderr()).toMatch(/^tscomfy: gen\/tscomfy\.json is not (JSON|a tscomfy manifest)/);
    },
  );

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
      "Up to date: 1 node type matches gen/object_info.json (new files in 1 upload or remote combo aren't drift: Load.image).\n",
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
    expect(io.stderr()).toStartWith("tscomfy: after.json doesn't hold node definitions");
  });
});
