// Transpiled by @tscomfy/codegen 0.1.1.
// Regenerate with: bun run generate:fixtures

import { type NodesOf, type Workflow, workflow } from "@tscomfy/core";
import { mock } from "../autogrow/index.ts";

export const prompt: Workflow<NodesOf<typeof mock>> = workflow(mock, ({ n, raw }) => {
  const mockSources = raw("MockSources", {}, { id: "1" });
  const image = n.MockAutogrowPrefix(
    { images: [mockSources.output(0), mockSources.output(0)] },
    { id: "2" },
  );
  n.MockAutogrowPrefixOptional({ prompt: "a cat", ref_images: [image] }, { id: "3" });
  n.MockAutogrowNames(
    { values: { a: mockSources.output(1), b: mockSources.output(2) } },
    { id: "4" },
  );
  n.MockAutogrowMatchType({ values: [image, mockSources.output(0)] }, { id: "5" });
  n.MockAutogrowOptionalTemplate({}, { id: "6" });
});
