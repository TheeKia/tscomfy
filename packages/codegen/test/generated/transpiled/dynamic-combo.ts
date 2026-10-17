// Transpiled by @tscomfy/codegen 0.0.0.
// Regenerate with: bun run generate:fixtures

import { type NodesOf, type Workflow, workflow } from "@tscomfy/core";
import { mock } from "../dynamic-combo/index.ts";

export const prompt: Workflow<NodesOf<typeof mock>> = workflow(mock, ({ n, raw }) => {
  const mockVideoSource = raw("MockVideoSource", { file: "clip.mp4" }, { id: "1" });
  const mockImageSource = raw("MockImageSource", {}, { id: "2" });
  const mockAudioSource = raw("MockAudioSource", {}, { id: "3" });
  n.MockDynamicComboNested(
    {
      video: mockVideoSource.output(0),
      format: {
        option: "mp4",
        inputs: { codec: { option: "h264", inputs: { encoding: "custom" } } },
      },
    },
    { id: "4" },
  );
  n.MockDynamicComboSimple({ image: mockImageSource.output(0), mode: "keep" }, { id: "5" });
  n.MockDynamicComboSimple(
    {
      image: mockImageSource.output(0),
      mode: { option: "scale dimensions", inputs: { width: 768 } },
    },
    { id: "6" },
  );
  n.MockDynamicComboMixed(
    {
      model: {
        option: "Model [pro]",
        inputs: { prompt: "a cat", images: { image_1: mockImageSource.output(0) } },
      },
    },
    { id: "7" },
  );
  n.MockDynamicComboOptional({ audio: mockAudioSource.output(0) }, { id: "8" });
  n.MockDynamicComboOptional({ audio: mockAudioSource.output(0), format: "flac" }, { id: "9" });
});
