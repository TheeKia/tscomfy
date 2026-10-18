// Transpiled by @tscomfy/codegen 0.1.0.
// Regenerate with: bun run generate:fixtures

import { type NodesOf, type Workflow, workflow } from "@tscomfy/core";
import { mock } from "../combos/index.ts";

export const prompt: Workflow<NodesOf<typeof mock>> = workflow(mock, ({ n, raw }) => {
  n.MockComboMultiselect({ tags: ["red", "blue"] }, { id: "1" });
  n.MockComboMultiselect({}, { id: "2" });
  n.MockComboBoolean({ mode: "auto" }, { id: "3" });
  raw("MockRawLists", { values: [1, 2, 3], label: "raw" }, { id: "4" });
});
