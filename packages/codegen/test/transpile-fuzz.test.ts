import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { transpile, type TranspileOptions } from "@tscomfy/codegen";
import {
  type InputDef,
  type InputValue,
  isOutputRef,
  type Out,
  parse,
  stringify,
  exportApi,
  type TypedSchema,
  type Workflow,
  workflow,
} from "@tscomfy/core";
import { GENERATED_DIR } from "./generated-fixtures.ts";
import { mock as autogrow } from "./generated/autogrow/index.ts";
import { mock as basic } from "./generated/basic-pipeline/index.ts";
import { mock as combos } from "./generated/combos/index.ts";
import { mock as dynamicCombo } from "./generated/dynamic-combo/index.ts";
import { mock as dynamicGroup } from "./generated/dynamic-group/index.ts";
import { mock as matchType } from "./generated/match-type/index.ts";
import { mock as names } from "./generated/names/index.ts";
import { mock as outputs } from "./generated/outputs/index.ts";
import { mock as widgetTypes } from "./generated/widget-types/index.ts";

// Transpile output against the tools themselves: every module must be exactly what oxfmt writes,
// compile under the generated types, and rebuild its workflow's prompt. Crafted cases cover the
// layout rules one by one; a seeded fuzzer builds random workflows over the mock schemas.

const REPO = join(import.meta.dir, "../../..");
const BIN = join(REPO, "node_modules/.bin");
const directory = await mkdtemp(join(tmpdir(), "tscomfy-transpile-"));

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

interface Case {
  readonly name: string;
  readonly built: Workflow;
  readonly schema: string;
  readonly options?: Partial<TranspileOptions>;
}

const SCHEMAS: readonly (readonly [string, TypedSchema<unknown>])[] = [
  ["basic-pipeline", basic],
  ["combos", combos],
  ["dynamic-combo", dynamicCombo],
  ["dynamic-group", dynamicGroup],
  ["autogrow", autogrow],
  ["match-type", matchType],
  ["names", names],
  ["outputs", outputs],
  ["widget-types", widgetTypes],
];

/** A node function of `n` by class, untyped: the fuzzer builds whatever the runtime takes. */
function call(n: unknown, classType: string, inputs: object, id: string): unknown {
  const node: unknown = Reflect.get(Object(n), classType);
  if (typeof node !== "function") throw new Error(`no node ${classType}`);
  return Reflect.apply(node, undefined, [inputs, { id }]);
}

const LONG =
  "a photograph of a cat wearing a tiny hat, sitting on a velvet cushion in a sunlit room";

const CRAFTED: readonly Case[] = [
  {
    name: "long strings under short and long keys",
    schema: "basic-pipeline",
    built: workflow(basic, ({ n }) => {
      const [, clip, vae] = n.CheckpointLoaderSimple({ ckpt_name: "model-a.safetensors" });
      n.CLIPTextEncode({ clip, text: LONG });
      const samples = n.EmptyLatentImage({});
      n.SaveImage(
        { images: n.VAEDecode({ samples, vae }), filename_prefix: `${LONG} and a filename prefix` },
        { title: LONG },
      );
    }),
  },
  {
    name: "a header that hugs",
    schema: "basic-pipeline",
    built: workflow(basic, () => {}),
    options: { name: "averyveryveryveryveryverylongname" },
  },
  {
    name: "a header that breaks after =",
    schema: "basic-pipeline",
    built: workflow(basic, ({ n }) => {
      n.VAELoader({ vae_name: "pixel_space" });
    }),
    options: { name: "aVeryLongWorkflowNameThatKeepsGoingAndGoing", schemaName: "local" },
  },
  {
    name: "an empty header near the width",
    schema: "basic-pipeline",
    built: workflow(basic, () => {}),
    options: { name: "aNameOfTwentySevenCharacter" },
  },
  {
    name: "many outputs",
    schema: "outputs",
    built: workflow(outputs, ({ n, raw }) => {
      const all = n.MockManyOutputs();
      raw(
        "MockSink",
        Object.fromEntries(all.map((output, index) => [`in_${String(index)}`, output])),
      );
    }),
  },
  {
    name: "many outputs inside an expanded declaration",
    schema: "outputs",
    built: workflow(outputs, ({ n, raw }) => {
      const all = n.MockManyOutputs();
      raw("MockSink", { first: all[0], second: all[1], third: all[2], fourth: all[3] });
      const again = n.MockManyOutputs();
      raw("MockSink", { first: again[0], second: again[1], third: again[2], fourth: again[3] });
    }),
    options: { name: "aWorkflowWithAQuiteLongNameThatNeedsMoreRoom" },
  },
  {
    name: "bypassed and muted nodes",
    schema: "basic-pipeline",
    built: workflow(basic, ({ n }) => {
      const [, clip, vae] = n.CheckpointLoaderSimple({ ckpt_name: "model-a.safetensors" });
      n.CLIPTextEncode({ clip, text: "muted" }, { mode: "mute" });
      const latent = n.EmptyLatentImage({}, { mode: "bypass", title: "Skipped" });
      n.SaveImage({ images: n.VAEDecode({ samples: latent, vae }) });
    }),
  },
  {
    name: "numbers and keys",
    schema: "widget-types",
    built: workflow(widgetTypes, ({ n }) => {
      call(
        n,
        "MockValueWidgets",
        {
          compare: ["a", "b"],
          curve_value: Array.from({ length: 40 }, (_, index) => index * 1.5),
          color: parse(
            '{"__proto__": 1, "big": 1e21, "small": 5e-7, "nested": [[1, 2], [3, 4]], "list": [{"a": 1, "b": 2}, {"a": 3, "b": 4}]}',
          ).value,
        },
        "1",
      );
    }),
  },
];

/** A seeded pseudo-random generator (mulberry32), so failures reproduce. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  "cat",
  "hat",
  '"quoted"',
  "it's",
  "日本語",
  "emoji 🎩",
  "a\\b",
  "*/",
  "x".repeat(70),
];

/** A random workflow over one mock schema: random classes, values and links to earlier nodes. */
function fuzz(seed: number): Case {
  const next = random(seed);
  const pick = <T>(items: readonly T[]): T => {
    const item = items[Math.floor(next() * items.length)];
    if (item === undefined) throw new Error("pick from an empty list");
    return item;
  };
  const [schemaName, schema] = pick(SCHEMAS);
  const classes = Object.keys(schema.nodes);
  const built = workflow(schema, ({ n }) => {
    const sources: Out<string>[] = [];
    const count = 1 + Math.floor(next() * 8);
    for (let index = 0; index < count; index++) {
      const classType = pick(classes);
      const definition = schema.nodes[classType];
      if (definition === undefined) continue;
      const value = (input: InputDef, depth: number): InputValue | undefined => {
        if (next() < 0.25) return undefined;
        if (sources.length > 0 && next() < 0.3) return pick(sources);
        switch (input.kind) {
          case "int":
            return Math.floor(next() * 100);
          case "float":
            return Math.round(next() * 1000) / 100;
          case "string":
            return Array.from({ length: Math.floor(next() * 6) }, () => pick(WORDS)).join(" ");
          case "boolean":
            return next() < 0.5;
          case "combo":
            return input.options.length > 0 ? pick(input.options) : "file.png";
          case "dynamicCombo": {
            if (input.options.length === 0) return undefined;
            const option = pick(input.options);
            if (option.inputs.length === 0 || depth > 2) return option.key;
            const children = Object.fromEntries(
              option.inputs.flatMap((child): [string, InputValue][] => {
                const child_value = value(child, depth + 1);
                return child_value === undefined ? [] : [[child.name, child_value]];
              }),
            );
            return { option: option.key, inputs: children };
          }
          case "autogrow":
            return sources.length === 0
              ? undefined
              : Array.from({ length: 1 + Math.floor(next() * 3) }, () => pick(sources));
          case "dynamicGroup":
            return Array.from({ length: Math.floor(next() * 3) }, () =>
              Object.fromEntries(
                input.fields.flatMap((field): [string, InputValue][] => {
                  const field_value = value(field, depth + 1);
                  return field_value === undefined || isOutputRef(field_value)
                    ? []
                    : [[field.name, field_value]];
                }),
              ),
            );
          case "value":
            return next() < 0.5
              ? pick([null, "#ff0000", [1, 2, 3], { x: 1, y: [0.5, 1e21] }])
              : // Number lists of every length and width, for the fill layout's line ends.
                Array.from(
                  { length: 2 + Math.floor(next() * 60) },
                  () => Math.round(next() * 10 ** Math.floor(next() * 7)) / 10,
                );
          case "socket":
          case "matchType":
          case "unknown":
            return undefined;
        }
      };
      const inputs = Object.fromEntries(
        definition.inputs.flatMap((input): [string, InputValue][] => {
          const given = value(input, 0);
          return given === undefined ? [] : [[input.name, given]];
        }),
      );
      const result = call(n, classType, inputs, String(index + 1));
      if (isOutputRef(result)) sources.push(result);
      else if (Array.isArray(result)) sources.push(...result.filter(isOutputRef));
    }
  });
  return { name: `fuzz ${String(seed)}`, built, schema: schemaName };
}

const CASES: readonly Case[] = [
  ...CRAFTED,
  ...Array.from({ length: 300 }, (_, seed) => fuzz(seed + 1)),
];

interface Written {
  readonly test: Case;
  readonly file: string;
  readonly code: string;
}

async function exec(command: readonly string[]): Promise<{ code: number; output: string }> {
  const child = Bun.spawn([...command], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, output: stdout + stderr };
}

const written: Written[] = await Promise.all(
  CASES.map(async (each, index) => {
    // Relative, as real output is: oxfmt sorts absolute specifiers before packages.
    const fixture = relative(directory, join(GENERATED_DIR, each.schema, "index.ts"));
    const schemaName = each.options?.schemaName ?? "mock";
    let schemaModule = fixture;
    if (schemaName !== "mock") {
      // The fixtures export `mock`; another name needs a module that renames it.
      schemaModule = `./schema${String(index)}.ts`;
      await Bun.write(
        join(directory, schemaModule),
        `export { mock as ${schemaName} } from ${JSON.stringify(fixture)};\n`,
      );
    }
    const { code } = transpile(each.built, {
      name: "prompt",
      ...each.options,
      schemaModule,
      schemaName,
    });
    const file = join(directory, `case${String(index)}.ts`);
    await Bun.write(file, code);
    return { test: each, file, code };
  }),
);
await Bun.write(join(directory, "package.json"), JSON.stringify({ type: "module" }));
await Bun.write(
  join(directory, "tsconfig.json"),
  JSON.stringify({
    extends: join(REPO, "tsconfig.base.json"),
    compilerOptions: {
      noEmit: true,
      allowImportingTsExtensions: true,
      paths: { "@tscomfy/core": [join(REPO, "packages/core/src/index.ts")] },
    },
    include: ["*.ts"],
  }),
);

describe("transpiled modules", () => {
  test("are exactly what oxfmt writes", async () => {
    const formatted = await exec([
      join(BIN, "oxfmt"),
      "-c",
      join(REPO, ".oxfmtrc.json"),
      directory,
    ]);
    expect(formatted.code).toBe(0);
    const changed: string[] = [];
    for (const { test: each, file, code } of written) {
      // oxlint-disable-next-line no-await-in-loop -- a small file each, in order
      if ((await Bun.file(file).text()) !== code) changed.push(each.name);
    }
    expect(changed).toEqual([]);
  }, 60_000);

  test("type-check under the generated types", async () => {
    const tsc = await exec([join(BIN, "tsc"), "-p", directory]);
    expect(tsc.output).toBe("");
  }, 60_000);

  test.each(written.map((each) => [each.test.name, each] as const))(
    "%s rebuilds its prompt",
    async (_name, { test: each, file }) => {
      const module: unknown = await import(file);
      const prompt: unknown = Reflect.get(Object(module), each.options?.name ?? "prompt");
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the module's export
      const rebuilt = exportApi(prompt as Workflow, { validate: false }).prompt;
      // exportApi, not toApi: random workflows may hold errors the exporter reports.
      expect(stringify(rebuilt)).toBe(stringify(exportApi(each.built, { validate: false }).prompt));
    },
  );
});
