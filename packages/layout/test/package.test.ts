import { expect, test } from "bun:test";

test("@tscomfy/layout resolves to its source entry under the @tscomfy/source condition", () => {
  expect(import.meta.resolve("@tscomfy/layout")).toEndWith("/packages/layout/src/index.ts");
});
