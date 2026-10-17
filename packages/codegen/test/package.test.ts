import { expect, test } from "bun:test";

test("@tscomfy/codegen resolves to its source entry under the @tscomfy/source condition", () => {
  expect(import.meta.resolve("@tscomfy/codegen")).toEndWith("/packages/codegen/src/index.ts");
});
