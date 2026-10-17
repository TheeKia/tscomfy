import type { InputDef, JsonValue, NodeDef, OutputDef, Schema } from "@tscomfy/core";
import { expectTypeOf } from "expect-type";

// The schema is plain JSON data (bigint included), so it serializes with `stringify` and can be
// hashed (D15) without conversion.
expectTypeOf<Schema>().toExtend<JsonValue>();
expectTypeOf<NodeDef>().toExtend<JsonValue>();
expectTypeOf<InputDef>().toExtend<JsonValue>();
expectTypeOf<OutputDef>().toExtend<JsonValue>();

// Every input kind is distinct, so `switch (input.kind)` narrows.
expectTypeOf<InputDef["kind"]>().toEqualTypeOf<
  | "socket"
  | "int"
  | "float"
  | "string"
  | "boolean"
  | "combo"
  | "value"
  | "autogrow"
  | "dynamicCombo"
  | "dynamicGroup"
  | "matchType"
  | "unknown"
>();

// @ts-expect-error -- the schema is immutable
const mutate = (schema: Schema): void => void (schema.formatVersion = 1);
void mutate;
