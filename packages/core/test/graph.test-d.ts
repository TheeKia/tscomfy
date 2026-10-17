import type { In, Match, Out } from "@tscomfy/core";
import { expectTypeOf } from "expect-type";

declare const model: Out<"MODEL">;
declare const clip: Out<"CLIP">;
declare const any: Out<"*">;
declare const imageOrMask: Out<"IMAGE" | "MASK">;

// Covariant: an output fits an input of its own type, and `*` fits everywhere.
expectTypeOf(model).toExtend<In<"MODEL">>();
expectTypeOf(any).toExtend<In<"MODEL">>();
expectTypeOf(clip).not.toExtend<In<"MODEL">>();
expectTypeOf(model).toExtend<Out<string>>();

// Union outputs must fit inside the input's set (stricter than the backend's overlap rule).
expectTypeOf(imageOrMask).toExtend<Out<"IMAGE" | "MASK" | "*">>();
expectTypeOf(imageOrMask).not.toExtend<In<"IMAGE">>();

// Branded: a look-alike object or a raw link tuple doesn't pass.
expectTypeOf<{ node: string; slot: number }>().not.toExtend<Out<"MODEL">>();
expectTypeOf<readonly [string, number]>().not.toExtend<Out<string>>();

// Match: a concrete template type or `*`; an inferred `*` lets anything through.
expectTypeOf<Match<"IMAGE">>().toEqualTypeOf<"IMAGE" | "*">();
expectTypeOf<Match<"*">>().toEqualTypeOf<string>();
