// @vitest-environment node
//
// Tests for the transform step — especially the safety of the template evaluator.
// Key invariant: NO eval / Function constructor; arbitrary string injection must
// not execute code.

import { describe, it, expect } from "vitest";
import { getPath, expandTemplate, applyMapping } from "../steps/transform";

describe("getPath", () => {
  it("resolves top-level key", () => {
    expect(getPath({ a: 1 }, "a")).toBe(1);
  });

  it("resolves nested key", () => {
    expect(getPath({ a: { b: { c: "deep" } } }, "a.b.c")).toBe("deep");
  });

  it("returns undefined for missing key", () => {
    expect(getPath({ a: 1 }, "a.b.c")).toBeUndefined();
  });

  it("returns undefined for null parent", () => {
    expect(getPath(null, "a")).toBeUndefined();
  });
});

describe("expandTemplate", () => {
  const ctx = { user: { name: "Alice", score: 42 }, trigger: { body: "hello" } };

  it("expands a simple placeholder", () => {
    expect(expandTemplate("Hello {{user.name}}!", ctx)).toBe("Hello Alice!");
  });

  it("expands multiple placeholders", () => {
    expect(expandTemplate("{{user.name}} scored {{user.score}}", ctx)).toBe("Alice scored 42");
  });

  it("expands missing path to empty string", () => {
    expect(expandTemplate("{{missing.key}}", ctx)).toBe("");
  });

  it("leaves non-placeholder text untouched", () => {
    expect(expandTemplate("no placeholders", ctx)).toBe("no placeholders");
  });

  it("does NOT execute code in placeholders — eval safety", () => {
    // Attempting to inject code must NOT call any function; should expand to empty
    const evil = "{{constructor.constructor('process.exit(1)')()}}";
    // Should not throw; should not execute; resolves to empty string
    const result = expandTemplate(evil, ctx);
    expect(result).toBe("");
  });

  it("does NOT expand nested double-braces as code", () => {
    const tpl = "{{trigger.body}}";
    const result = expandTemplate(tpl, ctx);
    expect(result).toBe("hello"); // just the string value
  });
});

describe("applyMapping", () => {
  const ctx = { step1: { value: "world" }, count: 3 };

  it("maps string values with template expansion", () => {
    const result = applyMapping({ greeting: "Hello {{step1.value}}" }, ctx);
    expect(result.greeting).toBe("Hello world");
  });

  it("preserves numeric values", () => {
    const result = applyMapping({ n: 42, s: "{{count}}" }, ctx);
    expect(result.n).toBe(42);
    expect(result.s).toBe("3");
  });

  it("recursively expands nested objects", () => {
    const result = applyMapping({ nested: { key: "val={{step1.value}}" } }, ctx);
    expect((result.nested as Record<string, string>).key).toBe("val=world");
  });

  it("expands array string values", () => {
    const result = applyMapping({ list: ["{{step1.value}}", "literal"] }, ctx);
    expect(result.list).toEqual(["world", "literal"]);
  });

  it("strips unknown placeholders to empty string", () => {
    const result = applyMapping({ x: "{{missing.value}}" }, ctx);
    expect(result.x).toBe("");
  });
});
