import { describe, expect, it } from "vitest";
import { CodeNormalizer } from "../src/index.js";

const normalizeCode = (code: string) => new CodeNormalizer().normalize(code);

describe("normalizeCode", () => {
  it("strips markdown fences", () => {
    const r = normalizeCode("```ts\nreturn 1;\n```");
    expect(r.code).toBe("return 1;");
    expect(r.fixes).toContain("stripped markdown fence");
  });

  it("converts literal \\n escapes when the code has no real newlines", () => {
    const r = normalizeCode("const a = 1;\\nconst b = 2;\\nreturn a + b;");
    expect(r.code.split("\n")).toHaveLength(3);
    expect(r.fixes.some((f) => f.includes("escapes"))).toBe(true);
  });

  it("leaves \\n inside normal multi-line code alone", () => {
    const r = normalizeCode('const s = "a\\nb";\nreturn s;');
    expect(r.code).toBe('const s = "a\\nb";\nreturn s;');
    expect(r.fixes).toEqual([]);
  });

  it("unwraps an async IIFE so return works", () => {
    const r = normalizeCode("(async () => {\n  return await tools.x.y();\n})();");
    expect(r.code).toBe("return await tools.x.y();");
    expect(r.fixes).toContain("unwrapped async function wrapper");
  });

  it("accepts top-level await and return", () => {
    expect(() => normalizeCode("const x = await tools.a.b({}); return x;")).not.toThrow();
  });

  it("erases TypeScript syntax and records the fix; plain JavaScript is untouched", () => {
    const ts = normalizeCode("const items: Array<{ id: number }> = (await tools.a.b({})) as any[];\nconst n = items.length!;\nreturn n satisfies number;");
    expect(ts.code).not.toMatch(/: Array|as any|satisfies|!;/);
    expect(ts.code).toContain("await tools.a.b({})");
    expect(ts.fixes).toContain("stripped TypeScript syntax");
    const js = normalizeCode("const x = 1;\nreturn x;");
    expect(js.fixes).toEqual([]);
    expect(js.code).toBe("const x = 1;\nreturn x;");
  });

  it("throws a SyntaxError with a line number for broken code", () => {
    expect(() => normalizeCode("return (\n")).toThrow(SyntaxError);
    expect(() => normalizeCode("const = 1;")).toThrow(/line 1/);
  });
});
