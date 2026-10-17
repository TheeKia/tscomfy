import { expect, test } from "bun:test";

test("@tscomfy/cli resolves to its source entry under the @tscomfy/source condition", () => {
  expect(import.meta.resolve("@tscomfy/cli")).toEndWith("/packages/cli/src/index.ts");
});
