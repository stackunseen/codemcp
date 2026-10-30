import { describe, expect, it } from "vitest";
import { CodeNormalizer, PinStore, ToolRegistry, cleanTool, diffLines } from "../src/index.js";

describe("description hygiene", () => {
  it("removes invisible characters and cuts long descriptions, and says what it did", () => {
    const long = "x".repeat(2500);
    const { value, changes } = cleanTool({
      name: "t",
      description: `List​ items‮ ${long}`,
      inputSchema: { type: "object", properties: { q: { type: "string", description: "query\u0000" } } },
      annotations: { title: "Ti﻿tle" },
    });
    expect(value.description).not.toMatch(/[​‮]/);
    expect(value.description?.length).toBe(2000 + " [description truncated]".length);
    expect((value.inputSchema as { properties: { q: { description: string } } }).properties.q.description).toBe("query");
    expect(value.annotations?.title).toBe("Title");
    expect(changes).toEqual([
      "description: removed 2 invisible or control characters",
      "description: cut from 2511 to 2000 characters",
      "inputSchema.properties.q.description: removed 1 invisible or control characters",
      "annotations.title: removed 1 invisible or control characters",
    ]);
  });

  it("leaves clean text alone and keeps newlines and tabs", () => {
    const { value, changes } = cleanTool({ name: "t", description: "line one\n\tline two", inputSchema: {} });
    expect(value.description).toBe("line one\n\tline two");
    expect(changes).toEqual([]);
  });

  it("the registry cleans by default, hashes the cleaned text, and can be told not to", () => {
    const tool = { name: "t", description: "a​b", inputSchema: {} };
    const [cleaned] = new ToolRegistry().setServerTools("s", [tool]);
    const [raw] = new ToolRegistry({ hygiene: false }).setServerTools("s", [tool]);
    expect(cleaned?.description).toBe("ab");
    expect(cleaned?.hygiene).toEqual(["description: removed 1 invisible or control characters"]);
    expect(raw?.description).toBe("a​b");
    expect(raw?.hygiene).toBeUndefined();
    expect(cleaned?.descriptionHash).not.toBe(raw?.descriptionHash);
    const [capped] = new ToolRegistry({ hygiene: { maxLength: 1 } }).setServerTools("s", [{ name: "t", description: "ab", inputSchema: {} }]);
    expect(capped?.description).toBe("a [description truncated]");
  });
});

describe("pin diff", () => {
  it("shows the changed sentence and schema line between the pinned and current definition", () => {
    const pins = new PinStore();
    const registry = new ToolRegistry();
    const [before] = registry.setServerTools("gh", [{ name: "rm", description: "Remove a file. Safe to retry.", inputSchema: { type: "object", properties: { path: { type: "string" } } } }]);
    pins.approve(before!);
    expect(pins.diff(before!)).toBe("");
    const [after] = registry.setServerTools("gh", [
      { name: "rm", description: "Remove a file. Also removes the parent directory.", inputSchema: { type: "object", properties: { path: { type: "string" }, recursive: { type: "boolean" } } } },
    ]);
    expect(pins.check(after!).status).toBe("drifted");
    const diff = pins.diff(after!)!;
    expect(diff).toContain("-   Safe to retry.");
    expect(diff).toContain("+   Also removes the parent directory.");
    expect(diff).toContain('+       "recursive"');
    expect(diff).not.toContain("- name: rm");
  });

  it("has nothing to show for a pin written before definitions were stored", () => {
    const pins = new PinStore();
    const [tool] = new ToolRegistry().setServerTools("gh", [{ name: "x", inputSchema: {} }]);
    (pins as unknown as { pins: Map<string, unknown> }).pins.set("gh.x", { hash: "stale", approvedAt: "2026-01-01T00:00:00Z" });
    expect(pins.diff(tool!)).toBeUndefined();
  });

  it("diffLines keeps context and marks gaps", () => {
    expect(diffLines("a\nb\nc\nd\ne\nf\ng", "a\nb\nc\nd\nE\nf\ng", 1)).toBe("  ...\n  d\n- e\n+ E\n  f");
    expect(diffLines("same", "same")).toBe("");
  });
});

describe("line offsets", () => {
  it("counts the lines the normalizer removed in front of the body", () => {
    const n = new CodeNormalizer();
    expect(n.normalize("return 1;").lineOffset).toBe(0);
    expect(n.normalize("```ts\nreturn 1;\n```").lineOffset).toBe(1);
    expect(n.normalize("\n\nreturn 1;").lineOffset).toBe(2);
    expect(n.normalize("(async () => {\nreturn 1;\n})()").lineOffset).toBe(1);
  });

  it("reports a syntax error at the line the model wrote", () => {
    expect(() => new CodeNormalizer().normalize("```js\nconst a = 1;\nreturn a +;\n```")).toThrow(/line 3/);
  });
});
