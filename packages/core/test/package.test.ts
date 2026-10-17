import { expect, test } from "bun:test";

test("@tscomfy/core resolves to its source entry under the @tscomfy/source condition", () => {
  expect(import.meta.resolve("@tscomfy/core")).toEndWith("/packages/core/src/index.ts");
});
