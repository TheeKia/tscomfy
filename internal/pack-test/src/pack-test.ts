// test:pack — the packages as a user gets them. Packs each publishable package with `bun pm pack`
// (as `bun publish` would, rewriting `workspace:` specifiers), checks what each tarball holds,
// installs them all into a fresh project with npm (offline: only the tarballs), runs the
// installed `tscomfy` under Node and Bun, and type-checks and runs a consumer of every package
// under `nodenext` and `bundler` with `skipLibCheck: false` and no ambient types. Not part of
// `check`: it builds, packs and installs. Expects `tsc -b` to have built `dist/`.
//
// TEST_PACK_NODES lists the Node binaries to run under, separated by `:` (default: `node`).

import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { parse, stringify } from "@tscomfy/core";
import {
  exec,
  type ExecOptions,
  type Executed,
  MOCK_API_WORKFLOW_DIR,
  MOCK_OBJECT_INFO_DIR,
  MOCK_UI_API_WORKFLOW_DIR,
  MOCK_UI_WORKFLOW_DIR,
  REPO_DIR,
  TOOLS,
} from "@tscomfy/fixtures";

/** The publishable packages, in dependency order, by folder under `packages/`. */
const PACKAGES = ["core", "codegen", "layout", "cli"] as const;
type Package = (typeof PACKAGES)[number];

const NODES = (process.env["TEST_PACK_NODES"] ?? "node").split(":").filter((each) => each !== "");
const OBJECT_INFO = join(MOCK_OBJECT_INFO_DIR, "basic-pipeline.json");
const PROMPT = join(MOCK_API_WORKFLOW_DIR, "txt2img.json");
const UI_WORKFLOW = join(MOCK_UI_WORKFLOW_DIR, "txt2img.json");
const UI_PROMPT = join(MOCK_UI_API_WORKFLOW_DIR, "txt2img.json");

class PackTestError extends Error {
  override name = "PackTestError";
}

function fail(message: string): never {
  throw new PackTestError(message);
}

/** Runs a command and fails unless it exits 0; returns what it printed. */
async function run(
  what: string,
  command: readonly string[],
  options: ExecOptions = {},
): Promise<Executed> {
  const result = await exec(command, options);
  if (result.code !== 0) {
    fail(`${what} exited with ${String(result.code)}:\n${result.output}`);
  }
  return result;
}

/** `[name, value]` of the JSON object at `path` in `value`, or fails. */
function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${what} is not an object`);
  }
  return Object.fromEntries(Object.entries(value));
}

/** What a tarball holds: its files, and its package.json. */
interface Packed {
  readonly tarball: string;
  readonly files: readonly string[];
  readonly manifest: Record<string, unknown>;
  /** Where it was unpacked, to read its files. */
  readonly root: string;
}

async function pack(name: Package, into: string): Promise<Packed> {
  const directory = join(REPO_DIR, "packages", name);
  const { stdout } = await run(
    `bun pm pack (${name})`,
    [process.execPath, "pm", "pack", "--quiet", "--destination", into],
    { cwd: directory },
  );
  const tarball = stdout.trim().split("\n").at(-1) ?? "";
  const listed = await run(`tar (${name})`, ["tar", "-tzf", tarball]);
  const files = listed.stdout
    .split("\n")
    .filter((line) => line !== "" && !line.endsWith("/"))
    .map((line) => line.replace(/^package\//, ""))
    .toSorted();
  const root = join(into, `unpacked-${name}`);
  await mkdir(root, { recursive: true });
  await run(`tar -x (${name})`, ["tar", "-xzf", tarball, "-C", root, "--strip-components=1"]);
  const manifest = record(
    await Bun.file(join(root, "package.json")).json(),
    `${name}'s package.json`,
  );
  return { tarball, files, manifest, root };
}

/** The checks on one tarball's contents and manifest. */
async function checkPacked(name: Package, packed: Packed): Promise<void> {
  const { files, manifest } = packed;
  const has = (file: string): boolean => files.includes(file);
  for (const file of [
    "package.json",
    "README.md",
    "LICENSE",
    "dist/index.js",
    "dist/index.d.ts",
    "src/index.ts",
  ]) {
    if (!has(file)) fail(`${name}'s tarball has no ${file}`);
  }
  const unwanted = files.filter(
    (file) => file.endsWith(".tsbuildinfo") || file.startsWith("test/") || file.includes("/test/"),
  );
  if (unwanted.length > 0) fail(`${name}'s tarball has ${unwanted.join(", ")}`);
  // Source and declaration maps point at files the tarball has.
  for (const map of files.filter((file) => file.endsWith(".map"))) {
    // oxlint-disable-next-line no-await-in-loop -- small files, in order
    const sources: unknown = Reflect.get(await Bun.file(join(packed.root, map)).json(), "sources");
    for (const source of Array.isArray(sources) ? sources : []) {
      const target = relative(packed.root, join(packed.root, dirname(map), String(source)));
      if (!has(target)) fail(`${name}'s ${map} points at ${target}, which isn't packed`);
    }
  }
  const text = JSON.stringify(manifest);
  if (text.includes("workspace:")) fail(`${name}'s packed package.json keeps a workspace: range`);
  for (const field of ["repository", "homepage", "bugs", "keywords", "engines", "publishConfig"]) {
    if (manifest[field] === undefined) fail(`${name}'s package.json has no ${field}`);
  }
  if (manifest["license"] !== "MIT") fail(`${name}'s license isn't MIT`);
  const dependencies = record(manifest["dependencies"] ?? {}, `${name}'s dependencies`);
  const peers = record(manifest["peerDependencies"] ?? {}, `${name}'s peerDependencies`);
  // One core per project: isOutputRef is an instanceof check.
  if (dependencies["@tscomfy/core"] !== undefined) {
    fail(`${name} depends on @tscomfy/core rather than taking it as a peer`);
  }
  if (name !== "core" && peers["@tscomfy/core"] !== "^0.0.0") {
    fail(`${name} doesn't take @tscomfy/core ^0.0.0 as a peer`);
  }
  const external = Object.keys(dependencies).filter((each) => !each.startsWith("@tscomfy/"));
  if (external.length > 0) fail(`${name} has runtime dependencies: ${external.join(", ")}`);
  if (name === "cli") {
    const bin = record(manifest["bin"], "cli's bin");
    if (bin["tscomfy"] !== "dist/main.js") fail("cli's bin isn't dist/main.js");
    if (!has("dist/main.js")) fail("cli's tarball has no dist/main.js");
    const executable = await Bun.file(join(packed.root, "dist", "main.js")).text();
    if (!executable.startsWith("#!/usr/bin/env node\n")) {
      fail("cli's dist/main.js has no node shebang");
    }
  }
}

/** The consumer's program: every package, as a user imports it. */
const MAIN = `import { CLI_VERSION } from "@tscomfy/cli";
import { CODEGEN_VERSION, generate, transpile } from "@tscomfy/codegen";
import { stringify, toApi, toUi, workflow } from "@tscomfy/core";
import { layout } from "@tscomfy/layout";
import { comfy } from "./comfy/index.js";
import { fromUi } from "./from-ui.js";
import { txt2img } from "./txt2img.js";

// No ambient types: the packages' declarations must not need DOM or Node types.
declare const console: { log(text: string): void };

const built = workflow(comfy, ({ n }) => {
  const [model, clip, vae] = n.CheckpointLoaderSimple({ ckpt_name: "model-a.safetensors" });
  const latent = n.KSampler({
    model,
    positive: n.CLIPTextEncode({ clip, text: "a cat" }),
    negative: n.CLIPTextEncode({ clip, text: "" }),
    latent_image: n.EmptyLatentImage({}),
    seed: 2n ** 64n - 1n,
    sampler_name: "euler",
    scheduler: "normal",
  });
  n.SaveImage({ images: n.VAEDecode({ samples: latent, vae }) }, { title: "Result" });
});

/** Never run: the types must refuse it. */
export const wrong = (): unknown =>
  workflow(comfy, ({ n }) => {
    const latent = n.EmptyLatentImage({});
    // @ts-expect-error -- a LATENT where a VAE goes
    n.VAEDecode({ samples: latent, vae: latent });
  });

const { workflow: ui } = toUi(built, { positions: layout(built) });
const nodes = ui["nodes"];
console.log(\`versions \${CLI_VERSION} \${CODEGEN_VERSION}\`);
console.log(\`built \${stringify(toApi(built))}\`);
console.log(\`ui \${String(Array.isArray(nodes) ? nodes.length : -1)}\`);
console.log(\`transpiled \${stringify(toApi(txt2img))}\`);
console.log(\`ui-transpiled \${stringify(toApi(fromUi))}\`);
console.log(\`generated \${generate(comfy, { exportName: "again" }).files.map((file) => file.path).join(",")}\`);
const code = transpile(built, { name: "again", schemaModule: "./comfy/index.js", schemaName: "comfy" }).code;
console.log(\`transpile \${String(code.includes("export const again"))}\`);
`;

/** Strict options a consumer may have, with no ambient types and every declaration checked. */
const STRICT = {
  target: "es2024",
  lib: ["es2024"],
  strict: true,
  exactOptionalPropertyTypes: true,
  noUncheckedIndexedAccess: true,
  skipLibCheck: false,
  types: [],
};

async function main(): Promise<void> {
  const temp = await mkdtemp(join(tmpdir(), "tscomfy-pack-"));
  try {
    const tarballs = join(temp, "tarballs");
    await mkdir(tarballs);
    const packed = new Map<Package, Packed>();
    for (const name of PACKAGES) {
      // oxlint-disable-next-line no-await-in-loop -- one pack at a time, in order
      const result = await pack(name, tarballs);
      // oxlint-disable-next-line no-await-in-loop
      await checkPacked(name, result);
      packed.set(name, result);
      console.log(`packed ${name}: ${String(result.files.length)} files`);
    }

    const project = join(temp, "consumer");
    await mkdir(join(project, "src"), { recursive: true });
    await Bun.write(
      join(project, "package.json"),
      JSON.stringify({
        name: "consumer",
        private: true,
        type: "module",
        dependencies: Object.fromEntries(
          PACKAGES.map((name) => [`@tscomfy/${name}`, `file:${packed.get(name)?.tarball ?? ""}`]),
        ),
      }),
    );
    // Offline: everything comes from the tarballs, which have no other dependencies.
    await run("npm install", ["npm", "install", "--offline", "--no-audit", "--no-fund"], {
      cwd: project,
    });
    console.log("installed the tarballs with npm");

    const bin = join(project, "node_modules", ".bin", "tscomfy");
    const entry = join(project, "node_modules", "@tscomfy", "cli", "dist", "main.js");
    const runtimes: {
      readonly label: string;
      readonly command: readonly string[];
      readonly env?: ExecOptions["env"];
    }[] = [
      // The installed bin itself, so its shebang finds this Node on PATH.
      ...(await Promise.all(
        NODES.map(async (node) => {
          const path = Bun.which(node) ?? fail(`no ${node} on PATH`);
          const version = (await run(`${node} --version`, [path, "--version"])).stdout.trim();
          return {
            label: `Node ${version}`,
            command: [bin],
            env: { ...process.env, PATH: `${dirname(path)}:${process.env["PATH"] ?? ""}` },
          };
        }),
      )),
      { label: `Bun ${Bun.version}`, command: [process.execPath, entry] },
    ];
    for (const runtime of runtimes) {
      const cli = (args: readonly string[]): Promise<Executed> =>
        run(`tscomfy ${args[0] ?? ""} under ${runtime.label}`, [...runtime.command, ...args], {
          cwd: project,
          ...(runtime.env === undefined ? {} : { env: runtime.env }),
        });
      // oxlint-disable-next-line no-await-in-loop -- one runtime at a time
      const version = await cli(["--version"]);
      if (version.stdout !== "0.0.0\n") fail(`tscomfy --version printed ${version.stdout}`);
      // oxlint-disable-next-line no-await-in-loop
      await cli(["generate", "--from", OBJECT_INFO, "--out", "src/comfy", "--quiet"]);
      // oxlint-disable-next-line no-await-in-loop
      const check = await cli(["check", "--from", OBJECT_INFO, "--out", "src/comfy"]);
      if (!check.stdout.startsWith("Up to date: 11 node types match")) {
        fail(`tscomfy check printed ${check.output}`);
      }
      // oxlint-disable-next-line no-await-in-loop
      await cli([
        "transpile",
        "--prompt",
        PROMPT,
        "--schema",
        "src/comfy",
        "--out",
        "src/txt2img.ts",
      ]);
      // oxlint-disable-next-line no-await-in-loop
      await cli([
        "transpile",
        "--workflow",
        UI_WORKFLOW,
        "--schema",
        "src/comfy",
        "--out",
        "src/from-ui.ts",
        "--name",
        "fromUi",
      ]);
      console.log(`ran generate, check and transpile under ${runtime.label}`);
    }

    await Bun.write(join(project, "src", "main.ts"), MAIN);
    const configs = {
      nodenext: { module: "nodenext", rootDir: "src", outDir: "dist" },
      bundler: { module: "preserve", moduleResolution: "bundler", noEmit: true },
    };
    for (const [label, options] of Object.entries(configs)) {
      const config = join(project, `tsconfig.${label}.json`);
      // oxlint-disable-next-line no-await-in-loop -- one configuration at a time
      await Bun.write(
        config,
        JSON.stringify({ compilerOptions: { ...STRICT, ...options }, include: ["src"] }),
      );
      // oxlint-disable-next-line no-await-in-loop
      await run(`tsc (${label})`, [TOOLS.tsc, "-p", config], { cwd: project });
      console.log(`type-checked the consumer under ${label}`);
    }

    const expected = {
      transpiled: stringify(parse(await Bun.file(PROMPT).text()).value ?? null),
      "ui-transpiled": stringify(parse(await Bun.file(UI_PROMPT).text()).value ?? null),
    };
    for (const node of NODES) {
      // oxlint-disable-next-line no-await-in-loop -- one runtime at a time
      const { stdout } = await run(`the consumer under ${node}`, [node, join("dist", "main.js")], {
        cwd: project,
      });
      const lines = new Map(
        stdout
          .trimEnd()
          .split("\n")
          .map((line) => [line.slice(0, line.indexOf(" ")), line.slice(line.indexOf(" ") + 1)]),
      );
      const built = lines.get("built") ?? "";
      const checks: [string, boolean][] = [
        ["versions", lines.get("versions") === "0.0.0 0.0.0"],
        [
          "built",
          built.includes('"seed":18446744073709551615') && built.includes('"title":"Result"'),
        ],
        ["ui", lines.get("ui") === "7"],
        ["transpiled", lines.get("transpiled") === expected.transpiled],
        ["ui-transpiled", lines.get("ui-transpiled") === expected["ui-transpiled"]],
        ["generated", lines.get("generated") === "nodes.ts,index.ts"],
        ["transpile", lines.get("transpile") === "true"],
      ];
      const failed = checks.filter(([, ok]) => !ok).map(([what]) => what);
      if (failed.length > 0)
        fail(`the consumer under ${node} got ${failed.join(", ")} wrong:\n${stdout}`);
      console.log(`ran the consumer under ${node}`);
    }
    const left = await readdir(join(project, "src", "comfy"));
    if (left.toSorted().join(",") !== "index.ts,nodes.ts,object_info.json,tscomfy.json") {
      fail(`generate left ${left.join(", ")}`);
    }
    console.log("test:pack passed");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  if (!(error instanceof PackTestError)) throw error;
  console.error(`test:pack failed: ${error.message}`);
  process.exitCode = 1;
}
