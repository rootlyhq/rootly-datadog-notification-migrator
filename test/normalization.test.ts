import { describe, expect, it } from "vitest";

import { escapeRegExp, normalizeServiceName } from "../src/normalization.js";

describe("normalizeServiceName", () => {
  it.each([
    ["Production on-call", "production_on-call"],
    ["[Production] On-Call", "production_on-call"],
    ["__Leading and trailing!!", "leading_and_trailing"],
    ["", ""],
  ])("normalizes %j", (input, expected) => {
    expect(normalizeServiceName(input)).toBe(expected);
  });
});

it("escapes regular-expression syntax", () => {
  expect(new RegExp(escapeRegExp("@source+[x]")).test("@source+[x]")).toBe(
    true,
  );
});
