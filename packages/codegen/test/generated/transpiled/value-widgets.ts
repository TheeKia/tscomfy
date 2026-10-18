// Transpiled by @tscomfy/codegen 0.1.0.
// Regenerate with: bun run generate:fixtures

import { type NodesOf, type Workflow, workflow } from "@tscomfy/core";
import { mock } from "../widget-types/index.ts";

export const prompt: Workflow<NodesOf<typeof mock>> = workflow(mock, ({ n, raw }) => {
  const mockStateSource = raw("MockStateSource", {}, { id: "1" });
  n.MockValueWidgets({ compare: ["before.png", "after.png"] }, { id: "2" });
  n.MockWidgetTypeOverrides({ custom: mockStateSource.output(0) }, { id: "3" });
});
