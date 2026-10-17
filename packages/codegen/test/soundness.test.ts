import { describe, expect, test } from "bun:test";
import { type Diagnostic, validate, type Workflow, workflow } from "@tscomfy/core";
import { mock as autogrow } from "./generated/autogrow/index.ts";
import { mock as dynamicGroup } from "./generated/dynamic-group/index.ts";
import { mock as matchType } from "./generated/match-type/index.ts";
import { mock as widgetTypes } from "./generated/widget-types/index.ts";

// The soundness ordering (AGENTS.md): what compiles passes validation. Each workflow type-checks
// against the generated fixtures (this file is under `tsc -b`) and must validate without an
// error, apart from the ones a fragment can't avoid: raw nodes of classes the mock schema
// doesn't have, and no output node in a schema without one. Sources are typed nodes wherever
// the mock has them, so link types are really checked. A `@ts-expect-error` marks what the
// types refuse because validation would.

const WORKFLOWS: Record<string, () => Workflow> = {
  // ComfyUI's own switch with only on_true linked: the types give Out<"*">, which fits anywhere.
  "MatchType output with its inferring input empty": () =>
    workflow(matchType, ({ n }) => {
      const loop = n.MockMatchMultiOutput({ count: 2 });
      const picked = n.MockSwitch({ switch: true, on_true: loop.index });
      n.MockMatchConstrained({ input: picked });
    }),
  "MatchType inferring from a `*` output": () =>
    workflow(matchType, ({ n }) => {
      const loop = n.MockMatchMultiOutput({ count: 2 });
      const any = n.MockSwitch({ switch: false });
      const picked = n.MockSwitch({ switch: true, on_false: any, on_true: loop.index });
      n.MockMatchConstrained({ input: picked });
    }),
  "MatchType agreeing with its inferring input": () =>
    workflow(matchType, ({ n }) => {
      const loop = n.MockMatchMultiOutput({ count: 2 });
      const picked = n.MockSwitch({ switch: true, on_false: loop.index, on_true: loop[1] });
      const carried = n.MockMatchMultiOutput({ initial_value: picked, items: loop.flow_control });
      n.MockSwitch({ switch: true, on_false: carried.value, on_true: loop.index });
    }),
  "MatchType Autogrow whose first slot is `*`": () =>
    workflow(autogrow, ({ n, raw }) => {
      const images = n.MockAutogrowPrefix({ images: [raw("MockImages").output(0)] });
      const any = n.MockAutogrowMatchType({ values: [raw("MockAny").output(0)] });
      n.MockAutogrowMatchType({ values: [any, images, n.MockAutogrowOptionalTemplate()] });
    }),
  "DynamicGroup rows with no field required": () =>
    workflow(dynamicGroup, ({ n }) => {
      n.MockDynamicGroupNoDefaults({ rows: [{ tag: "a" }, { tag: "b", weight: 0.5 }] });
    }),
  "an INT widget on a pack type, fractional": () =>
    workflow(widgetTypes, ({ n }) => {
      n.MockIntWidgetOnPackType({ level: 3.5, ratio: 0.25 });
    }),
};

const ALLOWED = new Set(["E_UNKNOWN_CLASS_TYPE", "E_NO_OUTPUT_NODE"]);

function errors(diagnostics: readonly Diagnostic[]): string[] {
  return diagnostics
    .filter((diagnostic) => diagnostic.severity === "error" && !ALLOWED.has(diagnostic.code))
    .map((diagnostic) => `${diagnostic.code} ${diagnostic.path.join(" › ")}`);
}

describe("what compiles passes validation", () => {
  test.each(Object.keys(WORKFLOWS))("%s", (name) => {
    expect(errors(validate(WORKFLOWS[name]?.() ?? workflow(matchType, () => {})))).toEqual([]);
  });
});

describe("what validation rejects, the types reject", () => {
  test("a DynamicGroup row that would send no key", () => {
    const built = workflow(dynamicGroup, ({ n }) => {
      // @ts-expect-error -- `tag` is required: an empty row sends nothing, so it isn't a row
      n.MockDynamicGroupNoDefaults({ rows: [{}] });
    });
    expect(errors(validate(built))).toEqual(["E_TOO_FEW_DYNAMIC_INPUTS 1 › inputs › rows"]);
  });

  test("a MatchType input that disagrees with the inferring one", () => {
    const built = workflow(matchType, ({ n }) => {
      const loop = n.MockMatchMultiOutput({ count: 2 });
      // @ts-expect-error -- on_false infers INT, so on_true can't be FLOW_CONTROL
      n.MockSwitch({ switch: true, on_false: loop.index, on_true: loop.flow_control });
    });
    expect(errors(validate(built))).toEqual(["E_MATCH_TYPE_MISMATCH 2 › inputs › on_true"]);
  });
});
