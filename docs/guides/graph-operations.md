# Graph operations

Bypass and mute switch nodes off without rewiring, as in the frontend. `prune` and `splitOutputs`
reshape a built workflow. All of them work on immutable workflows and return new ones.

## Bypass and mute

```ts
const optional = (enabled: boolean) => (enabled ? {} : { mode: "bypass" as const });

workflow(local, ({ n }) => {
  const [model, clip, vae] = n.CheckpointLoaderSimple({ ckpt_name: "sd_xl_base_1.0.safetensors" });
  const [styled, styledClip] = n.LoraLoader(
    { model, clip, lora_name: "watercolor.safetensors", strength_model: 0.8, strength_clip: 0.8 },
    optional(useStyle),
  );
  // …
  n.PreviewImage({ images }, { mode: "mute" });
});
```

The node options `mode: "bypass"` and `mode: "mute"` keep a node in the workflow (and in a UI
export, where it shows as bypassed or muted) but leave it out of the prompt, exactly as the
frontend's `graphToPrompt` does:

- **Mute**: the node isn't sent, and inputs linked to it are left out. Downstream nodes that
  require such an input then fail validation, as they would fail in ComfyUI.
- **Bypass**: the node isn't sent, and each link from it is rerouted to one of its inputs: the
  input at the same index when its type fits, else the first input of exactly the type the
  consumer wants, else the first that fits both. Above, the bypassed `LoraLoader` passes `model`
  and `clip` straight through. Chains of bypassed nodes resolve the same way, step by step.

A link that resolves to nothing is reported as `W_LINK_DROPPED`. A widget input then sends its
own value, as in the frontend, where the link only replaced it; another input is left out.

`exportApi(built, { modes: false })` (or `toApi`) ignores modes and sends every node as if it
ran, which tools that rewrite workflows need.

## Prune

```ts
import { prune } from "@tscomfy/core";

const lean = prune(built);
```

The output nodes that run (save, preview, … not bypassed or muted) and everything they depend
on, directly or through bypassed and muted nodes. Nodes nothing needs are dropped. The backend
only runs output nodes and their ancestors anyway, so this is for what you keep or show: a
smaller UI file, a transpiled module without dead ends.

## Split per output

```ts
import { splitOutputs, toApi } from "@tscomfy/core";

for (const part of splitOutputs(built)) queue(toApi(part));
```

One workflow per output node that runs, in graph order, each with what that output needs. Nodes
several outputs share are in each part; node ids are kept, so the parts can be told apart and
compared.
