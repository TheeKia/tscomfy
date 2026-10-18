import { describe, expect, test } from "bun:test";
import { importUi, parse, stringify, toApi, toUi } from "@tscomfy/core";
import {
  MOCK_UI_EXTENSION_WORKFLOW_NAMES,
  readMockObjectInfo,
  readMockUiExtensionApiWorkflow,
  readMockUiExtensionExportPrompt,
  readMockUiExtensionWorkflow,
} from "@tscomfy/fixtures";
import { isJsonObject, type JsonValue } from "../src/json/value.ts";
import { looseSchema } from "./loose.ts";
import { found } from "./ui-helpers.ts";

// Core classes whose widgets the frontend's core extensions make (docs/plan.md §11), against the
// prompts frontend 1.55.17 itself builds (captured with internal/fixtures/scripts/frontend.ts).

const extensions = looseSchema(await readMockObjectInfo("ui-extensions"));

/**
 * The frontend's prompt without what `importUi` leaves out, each a documented difference: keys
 * the class doesn't declare, which the backend ignores (the 3D loader's buttons, a remote combo's
 * refresh button, the 3D previews' `image`, CustomCombo's scripted widgets), and values the
 * frontend computes when it queues, which `importUi` reports (`W_QUEUE_TIME_VALUE`).
 */
function comparable(
  prompt: JsonValue | undefined,
  computed: readonly (readonly (string | number)[])[],
): string {
  if (!isJsonObject(prompt)) throw new Error("expected a prompt");
  const kept = Object.entries(prompt).map(([id, node]): [string, JsonValue] => {
    if (!isJsonObject(node) || !isJsonObject(node["inputs"])) throw new Error("expected a node");
    const classType = node["class_type"];
    const definition = typeof classType === "string" ? extensions.nodes[classType] : undefined;
    const declared = new Set(definition?.inputs.map((input) => input.name));
    const inputs = Object.entries(node["inputs"]).filter(
      ([key]) =>
        declared.has(key.split(".")[0] ?? key) &&
        !computed.some((path) => path[0] === id && path[2] === key),
    );
    const sent: JsonValue = { ...node, inputs: Object.fromEntries(inputs) };
    return [id, sent];
  });
  return stringify(Object.fromEntries(kept));
}

describe("core extension classes against the frontend", () => {
  test.each(MOCK_UI_EXTENSION_WORKFLOW_NAMES)(
    "%s imports to the frontend's prompt",
    async (name) => {
      const { workflow: imported, diagnostics } = importUi(
        await readMockUiExtensionWorkflow(name),
        extensions,
      );
      const computed = diagnostics
        .filter((each) => each.code === "W_QUEUE_TIME_VALUE")
        .map((each) => each.path);
      expect(found(diagnostics)).toEqual([
        ["W_QUEUE_TIME_VALUE", ["5", "inputs", "image"]],
        ["W_QUEUE_TIME_VALUE", ["6", "inputs", "viewport_state"]],
        ["W_EXTENSION_WIDGETS", ["12"]],
        ["W_QUEUE_TIME_VALUE", ["15", "inputs", "audio"]],
      ]);
      const frontend = parse(await readMockUiExtensionApiWorkflow(name)).value;
      expect(stringify(toApi(imported, { validate: false }))).toBe(comparable(frontend, computed));
    },
  );

  test.each(MOCK_UI_EXTENSION_WORKFLOW_NAMES)(
    "%s: toUi's export loads in the frontend to the same prompt",
    async (name) => {
      const { workflow: imported } = importUi(await readMockUiExtensionWorkflow(name), extensions);
      const exported = toUi(imported);
      expect(found(exported.diagnostics)).toEqual([["W_EXTENSION_WIDGETS", ["12"]]]);
      const { workflow: again, diagnostics } = importUi(stringify(exported.workflow), extensions);
      const computed = diagnostics
        .filter((each) => each.code === "W_QUEUE_TIME_VALUE")
        .map((each) => each.path);
      const frontend = parse(await readMockUiExtensionExportPrompt(name)).value;
      expect(stringify(toApi(again, { validate: false }))).toBe(comparable(frontend, computed));
    },
  );
});
