// The accepts table at the type level (docs/plan.md §5.2): for every input × output pair of the
// accepts mock, a link the generated types allow must be one `accepts()` allows (Backend, from
// generated/accepts-matrix.ts). Where the types are stricter, the pair is listed below.

import { expectTypeOf } from "expect-type";
import type { Backend } from "./generated/accepts-matrix.ts";
import type { MockAcceptsInputs$In, MockAcceptsOutputs$Out } from "./generated/accepts/nodes.ts";

// A MatchType input infers its template from the link, so any output can pick it.
type Inputs = MockAcceptsInputs$In<string>;
type Outputs = MockAcceptsOutputs$Out;

type Typed<I extends keyof Inputs, O extends keyof Outputs> = Outputs[O] extends Inputs[I]
  ? true
  : false;

type Pairs<Wanted extends [boolean, boolean]> = {
  [I in Extract<keyof Backend & keyof Inputs, string>]: {
    [O in Extract<keyof Backend[I] & keyof Outputs, string>]: [
      Typed<I, O>,
      Backend[I][O],
    ] extends Wanted
      ? `${I} <- ${O}`
      : never;
  }[Extract<keyof Backend[I] & keyof Outputs, string>];
}[Extract<keyof Backend & keyof Inputs, string>];

// Sound: no link compiles that the backend would reject.
expectTypeOf<Pairs<[true, false]>>().toBeNever();

// Stricter than the backend, each for a reason in §5.2 and §6.2.
expectTypeOf<Pairs<[false, true]>>().toEqualTypeOf<
  // Outputs whose comma list holds `*` without being exactly `*`: the backend lets them into
  // string-typed inputs only, so they are typed by their other members (or only fit `*`).
  | "combo_form <- image_or_any"
  | "combo_form <- padded_any"
  | "combo_on_pack_type <- image_or_any"
  | "combo_on_pack_type <- padded_any"
  | "combo_socket <- image_or_any"
  | "combo_socket <- padded_any"
  | "combo_union <- image_or_any"
  | "combo_union <- padded_any"
  | "image_or_mask <- padded_any"
  | "int_widget <- image_or_any"
  | "int_widget <- padded_any"
  | "model <- image_or_any"
  | "model <- padded_any"
  | "star_union <- padded_any"
  // Inputs whose comma list holds `*` without being exactly `*`: typed by their other members.
  | "padded_any <- clip"
  | "padded_any <- combo_type"
  | "padded_any <- image_or_any"
  | "padded_any <- image_or_mask"
  | "padded_any <- int"
  | "padded_any <- model"
  | "padded_any <- padded_any"
  | "star_union <- clip"
  | "star_union <- combo_type"
  | "star_union <- image_or_mask"
  | "star_union <- int"
  | "star_union <- model"
  // A legacy combo takes only `*`: an identical option list can't be told apart by type.
  | "legacy <- options"
>();
