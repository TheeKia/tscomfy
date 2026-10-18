// A permissive `Nodes` type for client tests (as in core's tests): any class
// type, any inputs, and a result usable as a handle, an output or a tuple of outputs.

import {
  typedSchema,
  type InputValue,
  type NodeHandle,
  type NodeOptions,
  normalizeObjectInfo,
  type Out,
  type TypedSchema,
} from "@tscomfy/core";

export type LooseResult = Out<string> & readonly Out<string>[] & NodeHandle;

export type LooseNodes = {
  readonly [classType: string]: (
    inputs?: { readonly [key: string]: InputValue | undefined },
    options?: NodeOptions,
  ) => LooseResult;
};

/** A schema from mock text, typed loosely. */
export function looseSchema(objectInfo: string): TypedSchema<LooseNodes> {
  return typedSchema<LooseNodes>(normalizeObjectInfo(objectInfo).schema);
}
