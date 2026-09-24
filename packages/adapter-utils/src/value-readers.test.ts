import { describe, expect, it } from "vitest";
import { asString } from "./server-utils.js";
import { readString, readTrimmedNonEmptyString } from "./value-readers.js";

describe("readString", () => {
  it("returns strings unchanged, including the empty string", () => {
    expect(readString("hello")).toBe("hello");
    expect(readString("  padded  ")).toBe("  padded  ");
    expect(readString("", "fallback")).toBe("");
  });

  it("returns the fallback for non-strings", () => {
    expect(readString(undefined)).toBe("");
    expect(readString(null, "x")).toBe("x");
    expect(readString(42, "x")).toBe("x");
    expect(readString({ text: "a" }, "x")).toBe("x");
  });

  it("differs from server-utils asString on the empty string", () => {
    expect(asString("", "fallback")).toBe("fallback");
    expect(readString("", "fallback")).toBe("");
  });
});

describe("readTrimmedNonEmptyString", () => {
  it("returns the trimmed string when it has content", () => {
    expect(readTrimmedNonEmptyString("  /home/agent  ")).toBe("/home/agent");
  });

  it("returns null for blank strings and non-strings", () => {
    expect(readTrimmedNonEmptyString("")).toBeNull();
    expect(readTrimmedNonEmptyString("   ")).toBeNull();
    expect(readTrimmedNonEmptyString(undefined)).toBeNull();
    expect(readTrimmedNonEmptyString(7)).toBeNull();
  });
});
