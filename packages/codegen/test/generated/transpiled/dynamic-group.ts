// Transpiled by @tscomfy/codegen 0.2.0.
// Regenerate with: bun run generate:fixtures

import { type NodesOf, type Workflow, workflow } from "@tscomfy/core";
import { mock } from "../dynamic-group/index.ts";

export const prompt: Workflow<NodesOf<typeof mock>> = workflow(mock, ({ n, raw }) => {
  const mockModelSource = raw("MockModelSource", {}, { id: "1" });
  n.MockDynamicGroup(
    {
      model: mockModelSource.output(0),
      loras: [
        { lora_name: "lora-a.safetensors" },
        { lora_name: "lora-b.safetensors", strength: 0.5, enabled: false },
      ],
    },
    { id: "2" },
  );
  n.MockDynamicGroupOptional({ text: "hello", replacements: [{ find: "l" }] }, { id: "3" });
  n.MockDynamicGroupOptionalMin({ rows: [{}] }, { id: "4" });
});
