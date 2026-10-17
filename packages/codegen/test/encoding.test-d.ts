// Type tests for the generated encoding (docs/plan.md §6.2–6.4), against the committed fixtures
// in ./generated. Each `@ts-expect-error` is a negative test: tsc fails if the error goes away.

import type { In, JsonValue, NodeHandle, OptionList, Out, TypedSchema } from "@tscomfy/core";
import { expectTypeOf } from "expect-type";
import type { Nodes as Autogrow } from "./generated/autogrow/nodes.ts";
import type { mock as basicSchema } from "./generated/basic-pipeline/index.ts";
import type { Nodes as Basic } from "./generated/basic-pipeline/nodes.ts";
import type { Nodes as Combos } from "./generated/combos/nodes.ts";
import type { Nodes as DynamicCombo } from "./generated/dynamic-combo/nodes.ts";
import type { Nodes as DynamicGroup } from "./generated/dynamic-group/nodes.ts";
import type { Nodes as Legacy } from "./generated/legacy-and-flags/nodes.ts";
import type { MockBadInputSpecs$In } from "./generated/malformed/nodes.ts";
import type { Nodes as MatchType } from "./generated/match-type/nodes.ts";
import type { Nodes as Names } from "./generated/names/nodes.ts";
import type { Nodes as Numbers } from "./generated/numbers/nodes.ts";
import type { Nodes as Outputs } from "./generated/outputs/nodes.ts";
import type { Nodes as Sockets } from "./generated/sockets/nodes.ts";
import type { Nodes as WidgetTypes } from "./generated/widget-types/nodes.ts";

declare const basic: Basic;
declare const autogrow: Autogrow;
declare const combos: Combos;
declare const dynamicCombo: DynamicCombo;
declare const dynamicGroup: DynamicGroup;
declare const legacy: Legacy;
declare const matchType: MatchType;
declare const names: Names;
declare const numbers: Numbers;
declare const outputs: Outputs;
declare const sockets: Sockets;
declare const widgetTypes: WidgetTypes;

declare const any: Out<"*">;
declare const audio: Out<"AUDIO">;
declare const clip: Out<"CLIP">;
declare const combo: Out<"COMBO">;
declare const conditioning: Out<"CONDITIONING">;
declare const float: Out<"FLOAT">;
declare const image: Out<"IMAGE">;
declare const int: Out<"INT">;
declare const latent: Out<"LATENT">;
declare const mask: Out<"MASK">;
declare const model: Out<"MODEL">;
declare const state: Out<"MOCK_PACK_STATE">;
declare const string: Out<"STRING">;
declare const vae: Out<"VAE">;
declare const video: Out<"VIDEO">;

const sampler = {
  model,
  positive: conditioning,
  negative: conditioning,
  latent_image: latent,
  sampler_name: "euler",
  scheduler: "normal",
} as const;

// The generated schema module is typed by its Nodes interface.
expectTypeOf<typeof basicSchema>().toEqualTypeOf<TypedSchema<Basic>>();

// --- Sockets -----------------------------------------------------------------------------------

basic.KSampler(sampler);
basic.KSampler({ ...sampler, model: any });
// @ts-expect-error -- a CLIP output into a MODEL socket
basic.KSampler({ ...sampler, model: clip });

const socketInputs = {
  image,
  custom: any,
  any: latent,
  union: string,
  forced_int: int,
  forced_string: string,
} as const;
sockets.MockSockets(socketInputs);
// Comma unions take any member; `*` sockets take anything.
sockets.MockSockets({ ...socketInputs, union: any, any: model });
// @ts-expect-error -- IMAGE isn't in STRING,FILE_3D_GLB,FILE_3D
sockets.MockSockets({ ...socketInputs, union: image });
// @ts-expect-error -- a forceInput widget takes a link only
sockets.MockSockets({ ...socketInputs, forced_int: 1 });
// @ts-expect-error -- a socketless widget takes a value only
sockets.MockSockets({ ...socketInputs, socketless: string });
// TYPE:name is a type of its own.
expectTypeOf(numbers.MockNumbers)
  .parameter(0)
  .toHaveProperty("typed_seed")
  .toEqualTypeOf<Out<"INT:seed" | "*">>();

// --- Widgets -----------------------------------------------------------------------------------

basic.KSampler({ ...sampler, seed: 18446744073709551615n, steps: 30, cfg: 7.5, denoise: float });
basic.KSampler({ ...sampler, seed: int, steps: int });
// @ts-expect-error -- a string isn't an INT
basic.KSampler({ ...sampler, seed: "1" });
// @ts-expect-error -- a FLOAT output into an INT widget
basic.KSampler({ ...sampler, steps: float });
basic.CLIPTextEncode({ clip, text: "a cat" });
basic.CLIPTextEncode({ clip, text: string });
// A widget whose type is a union takes links of any member.
widgetTypes.MockWidgetTypeOverrides({ custom: state, rate: int, file: string });
// A primitive type decides the value, whatever the widget.
widgetTypes.MockWidgetTypeOverrides({ custom: state, sketch: "mask.png", count: 2 });

// Value widgets take JSON.
widgetTypes.MockValueWidgets({ compare: ["a", "b"], region: { x: 1, y: 2, width: 3, height: 4 } });
expectTypeOf(widgetTypes.MockValueWidgets)
  .parameter(0)
  .toHaveProperty("color")
  .toEqualTypeOf<JsonValue | undefined>();
// @ts-expect-error -- a socketless value widget takes no link
widgetTypes.MockValueWidgets({ compare: null, color: string });

// --- Combos ------------------------------------------------------------------------------------

// Option-list outputs have their own socket name; only exactly-COMBO and `*` inputs take them.
declare const optionList: Out<OptionList>;
combos.MockComboForms({ legacy_bare: "alpha", v2_no_default: optionList, legacy_control: "first" });
sockets.MockSockets({ ...socketInputs, any: optionList });
// @ts-expect-error -- an option list into a comma union, even one containing STRING
sockets.MockSockets({ ...socketInputs, union: optionList });
// INT and FLOAT never take lists: the backend's int() and float() reject them.
expectTypeOf(numbers.MockNumbers)
  .parameter(0)
  .toHaveProperty("int_list_default")
  .toEqualTypeOf<number | bigint | In<"INT">>();

basic.KSampler({ ...sampler, sampler_name: "dpmpp_2m", scheduler: "karras" });
// @ts-expect-error -- not one of the options
basic.KSampler({ ...sampler, sampler_name: "eulr" });
// A legacy combo only takes `*` links: an option-list output would need an identical list.
basic.KSampler({ ...sampler, sampler_name: any });
// @ts-expect-error -- an option-list output into a legacy combo
basic.KSampler({ ...sampler, sampler_name: combo });
// The COMBO form takes option-list outputs.
combos.MockComboForms({ legacy_bare: "alpha", v2_no_default: combo, legacy_control: "first" });
// @ts-expect-error -- a COMBO widget on another type takes no option-list links
widgetTypes.MockWidgetTypeOverrides({ custom: state, size: combo });
combos.MockComboNumeric({ v2_mixed: 2 });
// @ts-expect-error -- 3 isn't an option
combos.MockComboNumeric({ v2_mixed: 3 });
combos.MockComboBoolean({ mode: "auto", flag: false });
combos.MockComboMultiselect({ tags: ["red", "blue"] });
// @ts-expect-error -- purple isn't an option
combos.MockComboMultiselect({ tags: ["purple"] });
// Upload and remote combos take any string; their options are runtime state.
combos.MockComboUploadRemote({ upload: "new-upload.png", remote: "anything" });
// Empty combos carry no information to be strict about.
combos.MockComboEmpty({ legacy_empty: "anything", v2_empty: "anything" });

// --- Required, optional and unknown inputs -----------------------------------------------------

// An explicit default makes an input optional; no default keeps it required.
basic.EmptyLatentImage();
const { latent_image: _latent, ...withoutLatent } = sampler;
// @ts-expect-error -- latent_image is required
basic.KSampler(withoutLatent);
// @ts-expect-error -- sampler_name has no default
basic.KSampler({
  model,
  positive: conditioning,
  negative: conditioning,
  latent_image: latent,
  scheduler: "normal",
});
// @ts-expect-error -- no such input
basic.VAEDecode({ samples: latent, vae, extra: 1 });
legacy.MockNoInputs();
legacy.MockNoInputs({});
// @ts-expect-error -- this node has no inputs
legacy.MockNoInputs({ value: 1 });
expectTypeOf<MockBadInputSpecs$In["null_spec"]>().toEqualTypeOf<unknown>();

// --- Names -------------------------------------------------------------------------------------

names["Context Big (mock-pack)"]({ model });
names.MockModelMergeBlocks({ model1: model, model2: model, "input_blocks.0.": 0.5 });
names.MockOddInputNames({ constructor: true, "1st": 1, "with space": 2 });

// --- Outputs -----------------------------------------------------------------------------------

expectTypeOf(basic.SaveImage({ images: image })).toEqualTypeOf<NodeHandle>();
expectTypeOf(basic.VAEDecode({ samples: latent, vae })).toEqualTypeOf<Out<"IMAGE">>();
const checkpoint = basic.CheckpointLoaderSimple({ ckpt_name: "model-a.safetensors" });
const [loadedModel, loadedClip, loadedVae] = checkpoint;
expectTypeOf(loadedModel).toEqualTypeOf<Out<"MODEL">>();
expectTypeOf(loadedClip).toEqualTypeOf<Out<"CLIP">>();
expectTypeOf(loadedVae).toEqualTypeOf<Out<"VAE">>();
expectTypeOf(checkpoint.CLIP).toEqualTypeOf<Out<"CLIP">>();
expectTypeOf(checkpoint.id).toEqualTypeOf<string>();
expectTypeOf(checkpoint.length).toEqualTypeOf<3>();

const named = outputs.MockOutputNames({ image });
expectTypeOf(named[1]).toEqualTypeOf<Out<"IMAGE">>();
expectTypeOf(named["has space"]).toEqualTypeOf<Out<"MASK">>();
// @ts-expect-error -- a duplicated name is reachable by index only
void named.images;
expectTypeOf(named.length).toEqualTypeOf<7>();
expectTypeOf(named[3]).toEqualTypeOf<Out<"INT">>();

// --- Autogrow ----------------------------------------------------------------------------------

// The backend requires the first `min` slots even when the Autogrow itself is optional.
autogrow.MockAutogrowOptionalRequired({ images: [image] });
// @ts-expect-error -- images.image0 is required by min 1
autogrow.MockAutogrowOptionalRequired({});
// MatchType slots: the first infers the template, the others must agree.
expectTypeOf(autogrow.MockAutogrowMatchType({ values: [image, image] })).toEqualTypeOf<
  Out<"IMAGE">
>();
// @ts-expect-error -- mixed slot types don't infer a union
autogrow.MockAutogrowMatchType({ values: [image, latent] });

autogrow.MockAutogrowPrefix({ images: [image] });
autogrow.MockAutogrowPrefix({ images: [image, any, image] });
// @ts-expect-error -- min 1: at least one image
autogrow.MockAutogrowPrefix({ images: [] });
// @ts-expect-error -- a MASK into an IMAGE slot
autogrow.MockAutogrowPrefix({ images: [mask] });
autogrow.MockAutogrowPrefixOptional({ ref_images: [] });
autogrow.MockAutogrowNames({ values: { a: float, b: int } });
// @ts-expect-error -- min 2: b is required
autogrow.MockAutogrowNames({ values: { a: float } });
// @ts-expect-error -- no slot named e
autogrow.MockAutogrowNames({ values: { a: float, b: int, e: int } });

// --- DynamicCombo (§6.4) -----------------------------------------------------------------------

dynamicCombo.MockDynamicComboNested({
  video,
  format: { option: "mp4", inputs: { codec: { option: "h264", inputs: { encoding: "auto" } } } },
});
dynamicCombo.MockDynamicComboNested({
  video,
  format: { option: "auto", inputs: { codec: "auto" } },
});
dynamicCombo.MockDynamicComboNested({
  video,
  format: { option: "auto", inputs: { codec: "auto" } },
  // The top-level `codec` and `format.codec` can't collide.
  codec: "h264",
});
dynamicCombo.MockDynamicComboNested({
  video,
  // @ts-expect-error -- h265 isn't an option of codec
  format: { option: "mp4", inputs: { codec: "h265" } },
});
// An option without required inputs can be given by its key.
dynamicCombo.MockDynamicComboOptional({ audio, format: "flac" });
dynamicCombo.MockDynamicComboOptional({ audio, format: "mp3" });
dynamicCombo.MockDynamicComboOptional({
  audio,
  format: { option: "mp3", inputs: { quality: "320k" } },
});
// @ts-expect-error -- "scale by" needs a factor
dynamicCombo.MockDynamicComboSimple({ image, mode: "scale by" });
dynamicCombo.MockDynamicComboSimple({ image, mode: { option: "scale by", inputs: { factor: 2 } } });
// Autogrow and MatchType inside options.
dynamicCombo.MockDynamicComboMixed({
  model: { option: "Model [pro]", inputs: { images: { image_1: image } } },
});
expectTypeOf(
  dynamicCombo.MockDynamicComboMixed({ model: { option: "List", inputs: { list: image } } }),
).toEqualTypeOf<Out<"IMAGE">>();

// --- DynamicGroup ------------------------------------------------------------------------------

// The backend enforces min rows even when the group is optional.
dynamicGroup.MockDynamicGroupOptionalMin({ rows: [{}] });
// @ts-expect-error -- min 1 row, although the group is optional
dynamicGroup.MockDynamicGroupOptionalMin({});

dynamicGroup.MockDynamicGroup({ model, loras: [{ lora_name: "lora-a.safetensors" }] });
dynamicGroup.MockDynamicGroup({
  model,
  loras: [
    { lora_name: "lora-a.safetensors", strength: 0.5 },
    { lora_name: "lora-b.safetensors", enabled: false },
  ],
});
// @ts-expect-error -- min 1 row
dynamicGroup.MockDynamicGroup({ model, loras: [] });
// @ts-expect-error -- not one of the LoRA files
dynamicGroup.MockDynamicGroup({ model, loras: [{ lora_name: "missing.safetensors" }] });
dynamicGroup.MockDynamicGroupOptional({});

// --- MatchType (§6.3) --------------------------------------------------------------------------

// Equal branches pass, and the output follows them.
expectTypeOf(matchType.MockSwitch({ switch: true, on_false: image, on_true: image })).toEqualTypeOf<
  Out<"IMAGE">
>();
// @ts-expect-error -- mismatched branches fail at the call
matchType.MockSwitch({ switch: true, on_false: image, on_true: latent });
// An any-typed branch passes.
matchType.MockSwitch({ switch: true, on_false: image, on_true: any });
// Nothing to infer from: the template is `*` and connects anywhere.
expectTypeOf(matchType.MockSwitch({ switch: true })).toEqualTypeOf<Out<"*">>();
// A constrained template keeps the narrowed type and rejects others.
expectTypeOf(matchType.MockMatchConstrained({ input: mask })).toEqualTypeOf<Out<"MASK">>();
// @ts-expect-error -- LATENT isn't IMAGE or MASK
matchType.MockMatchConstrained({ input: latent });
// Several templates; outputs follow their own.
const loop = matchType.MockMatchMultiOutput({ initial_value: float, items: image });
expectTypeOf(loop.item).toEqualTypeOf<Out<"IMAGE">>();
expectTypeOf(loop.value).toEqualTypeOf<Out<"FLOAT">>();
expectTypeOf(loop.index).toEqualTypeOf<Out<"INT">>();
