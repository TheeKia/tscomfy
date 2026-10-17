// The `accepts` table (docs/plan.md §5.2), each case taken from the backend's non-strict
// `validate_node_input` in comfy_execution/validation.py. The runtime suite runs it now; the
// type-level suite (Phase 2) checks the generated types against the same rows, where the types
// may only be stricter.

import type { InputDef, OutputDef, OutputType, SocketType } from "@tscomfy/core";

/** One row: can `output` be linked into `input`? */
export interface AcceptsCase {
  readonly name: string;
  readonly input: InputDef;
  readonly output: OutputDef;
  readonly expected: boolean;
}

const base = { required: true, lazy: false, rawLink: false } as const;

function socket(type: SocketType): InputDef {
  return { kind: "socket", name: "in", ...base, type };
}

function output(type: OutputType, matchTemplate?: string): OutputDef {
  return {
    index: 0,
    name: "out",
    type,
    isList: false,
    ...(matchTemplate === undefined ? {} : { matchTemplate }),
  };
}

const named = (name: string): SocketType => ({ kind: "named", name });
const union = (...names: string[]): SocketType => ({ kind: "union", names });
const ANY: SocketType = { kind: "any" };

function combo(
  form: "legacy" | "combo",
  options: readonly (string | number | boolean)[],
): InputDef {
  return {
    kind: "combo",
    name: "in",
    ...base,
    form,
    options,
    multiselect: false,
    upload: false,
    remote: false,
    socketless: false,
  };
}

const int: InputDef = { kind: "int", name: "in", ...base, type: named("INT"), socketless: false };

export const ACCEPTS_CASES: readonly AcceptsCase[] = [
  {
    name: "equal names",
    input: socket(named("MODEL")),
    output: output(named("MODEL")),
    expected: true,
  },
  {
    name: "different names",
    input: socket(named("MODEL")),
    output: output(named("CLIP")),
    expected: false,
  },
  { name: "any input", input: socket(ANY), output: output(named("LATENT")), expected: true },
  { name: "any output", input: socket(named("MODEL")), output: output(ANY), expected: true },
  {
    name: "union input contains the output",
    input: socket(union("IMAGE", "MASK")),
    output: output(named("MASK")),
    expected: true,
  },
  {
    name: "union input misses the output",
    input: socket(union("IMAGE", "MASK")),
    output: output(named("LATENT")),
    expected: false,
  },
  {
    name: "union output overlaps the input (non-strict)",
    input: socket(named("INT")),
    output: output(union("INT", "FLOAT")),
    expected: true,
  },
  {
    name: "disjoint unions",
    input: socket(union("IMAGE", "MASK")),
    output: output(union("LATENT", "MODEL")),
    expected: false,
  },
  {
    name: "* inside an input union",
    input: socket(union("*", "IMAGE")),
    output: output(named("LATENT")),
    expected: true,
  },
  {
    name: "* inside an output union",
    input: socket(named("MODEL")),
    output: output(union("*", "IMAGE")),
    expected: true,
  },
  {
    name: "widget input takes a matching link",
    input: int,
    output: output(named("INT")),
    expected: true,
  },
  {
    name: "widget input rejects another type",
    input: int,
    output: output(named("FLOAT")),
    expected: false,
  },
  {
    name: "TYPE:name is its own type",
    input: socket(named("INT:seed")),
    output: output(named("INT")),
    expected: false,
  },
  {
    name: "MatchType output passes",
    input: socket(named("MODEL")),
    output: output(ANY, "t"),
    expected: true,
  },
  {
    name: "MatchType input passes",
    input: {
      kind: "matchType",
      name: "in",
      ...base,
      templateId: "t",
      allowed: union("IMAGE", "MASK"),
    },
    output: output(named("LATENT")),
    expected: true,
  },
  {
    name: "option list into a COMBO-form combo",
    input: combo("combo", ["a", "b"]),
    output: output({ kind: "combo", options: ["x"] }),
    expected: true,
  },
  {
    name: "COMBO output into a COMBO-form combo",
    input: combo("combo", ["a"]),
    output: output(named("COMBO")),
    expected: true,
  },
  {
    name: "STRING output into a combo",
    input: combo("combo", ["a"]),
    output: output(named("STRING")),
    expected: false,
  },
  {
    name: "identical option list into a legacy combo",
    input: combo("legacy", ["a", 1, true]),
    output: output({ kind: "combo", options: ["a", 1, true] }),
    expected: true,
  },
  {
    name: "different option list into a legacy combo",
    input: combo("legacy", ["a", "b"]),
    output: output({ kind: "combo", options: ["a"] }),
    expected: false,
  },
  {
    name: "COMBO output into a legacy combo",
    input: combo("legacy", ["a"]),
    output: output(named("COMBO")),
    expected: false,
  },
  {
    name: "any output into a legacy combo",
    input: combo("legacy", ["a"]),
    output: output(ANY),
    expected: true,
  },
  {
    name: "option list into a plain socket",
    input: socket(named("STRING")),
    output: output({ kind: "combo", options: ["a"] }),
    expected: false,
  },
  {
    name: "option list into *",
    input: socket(ANY),
    output: output({ kind: "combo", options: ["a"] }),
    expected: true,
  },
  {
    name: "option list into a union containing *",
    input: socket(union("*", "STRING")),
    output: output({ kind: "combo", options: ["a"] }),
    expected: false,
  },
  {
    name: "Autogrow answers for its slots",
    input: {
      kind: "autogrow",
      name: "in",
      ...base,
      form: "prefix",
      slots: ["image0"],
      min: 1,
      template: socket(named("IMAGE")),
    },
    output: output(named("IMAGE")),
    expected: true,
  },
  {
    name: "Autogrow slot rejects another type",
    input: {
      kind: "autogrow",
      name: "in",
      ...base,
      form: "prefix",
      slots: ["image0"],
      min: 1,
      template: socket(named("IMAGE")),
    },
    output: output(named("MASK")),
    expected: false,
  },
  {
    name: "list outputs are mapped, not rejected",
    input: socket(named("IMAGE")),
    output: { ...output(named("IMAGE")), isList: true },
    expected: true,
  },
  {
    name: "unknown specs accept nothing",
    input: { kind: "unknown", name: "in", ...base, spec: null },
    output: output(named("IMAGE")),
    expected: false,
  },
];
