import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SchemaTypeWriter, StubGenerator, ToolRegistry, type StubDetail, type UpstreamTool } from "../src/index.js";

const specFile = (p: string): unknown => JSON.parse(readFileSync(new URL(`../../../spec/stubs/${p}`, import.meta.url), "utf8"));
const types = specFile("types.json") as { cases: Array<{ schema: Record<string, unknown>; expect: string }> };
const stubs = specFile("cases.json") as { servers: Record<string, UpstreamTool[]>; cases: Array<{ name: string; detail: StubDetail; rootName?: string; expect: string }> };

describe("SchemaTypeWriter (spec/stubs/types.json)", () => {
  for (const c of types.cases) {
    it(c.expect, () => expect(SchemaTypeWriter.write(c.schema)).toBe(c.expect));
  }
});

describe("StubGenerator (spec/stubs/cases.json)", () => {
  const registry = new ToolRegistry();
  for (const [server, tools] of Object.entries(stubs.servers)) registry.setServerTools(server, tools);
  for (const c of stubs.cases) {
    it(c.name, () => expect(new StubGenerator(c.rootName).generate(registry.list(), c.detail)).toBe(c.expect));
  }
});

const jsonSchemaToTs = (schema: Record<string, unknown>): string => SchemaTypeWriter.write(schema);
const generateStubs = (tools: Parameters<StubGenerator["generate"]>[0], opts: { detail?: "names" | "signatures" | "full"; rootName?: string } = {}): string => new StubGenerator(opts.rootName).generate(tools, opts.detail);

describe("jsonSchemaToTs", () => {
  it("handles primitives, arrays, enums, const and nullable unions", () => {
    expect(jsonSchemaToTs({ type: "string" })).toBe("string");
    expect(jsonSchemaToTs({ type: "integer" })).toBe("number");
    expect(jsonSchemaToTs({ type: ["string", "null"] })).toBe("string | null");
    expect(jsonSchemaToTs({ type: "array", items: { type: "number" } })).toBe("Array<number>");
    expect(jsonSchemaToTs({ enum: ["a", "b", 1] })).toBe('"a" | "b" | 1');
    expect(jsonSchemaToTs({ const: true })).toBe("true");
  });

  it("renders objects with sorted keys, optional markers and doc comments", () => {
    const ts = jsonSchemaToTs({
      type: "object",
      properties: {
        zeta: { type: "string", description: "last" },
        alpha: { type: "number" },
        "needs-quotes": { type: "boolean" },
      },
      required: ["alpha"],
    });
    expect(ts).toBe('{ alpha: number; "needs-quotes"?: boolean; /** last */ zeta?: string }');
  });

  it("resolves local $refs and degrades cycles to unknown instead of looping", () => {
    const schema = {
      type: "object",
      properties: { node: { $ref: "#/$defs/Node" } },
      $defs: { Node: { type: "object", properties: { child: { $ref: "#/$defs/Node" }, v: { type: "number" } } } },
    };
    const ts = jsonSchemaToTs(schema);
    expect(ts.startsWith("{ node?: { child?: {")).toBe(true);
    expect(ts).toContain("unknown");
  });

  it("supports anyOf, oneOf, allOf and additionalProperties", () => {
    expect(jsonSchemaToTs({ anyOf: [{ type: "string" }, { type: "number" }] })).toBe("string | number");
    expect(jsonSchemaToTs({ oneOf: [{ type: "string" }, { type: "string" }] })).toBe("string");
    expect(jsonSchemaToTs({ allOf: [{ type: "object", properties: { a: { type: "string" } } }, { type: "object", properties: { b: { type: "number" } } }] })).toBe("{ a?: string } & { b?: number }");
    expect(jsonSchemaToTs({ type: "object", additionalProperties: { type: "number" } })).toBe("{ [key: string]: number }");
    expect(jsonSchemaToTs({ type: "object" })).toBe("Record<string, unknown>");
    expect(jsonSchemaToTs({ type: "object", additionalProperties: false })).toBe("Record<string, never>");
  });

  it("is deterministic regardless of property insertion order", () => {
    const a = jsonSchemaToTs({ type: "object", properties: { b: { type: "string" }, a: { type: "string" } } });
    const b = jsonSchemaToTs({ type: "object", properties: { a: { type: "string" }, b: { type: "string" } } });
    expect(a).toBe(b);
  });
});

describe("generateStubs", () => {
  const registry = new ToolRegistry();
  registry.setServerTools("github", [
    {
      name: "create-issue",
      description: "Create an issue.\nSecond line.",
      inputSchema: { type: "object", properties: { title: { type: "string" }, labels: { type: "array", items: { type: "string" } } }, required: ["title"] },
      outputSchema: { type: "object", properties: { number: { type: "integer" } }, required: ["number"] },
      annotations: { destructiveHint: true },
    },
    { name: "list_repos", description: "List repos", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
  ]);
  registry.setServerTools("fs", [{ name: "read", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }]);

  it("produces the golden signatures output", () => {
    expect(generateStubs(registry.list())).toBe(
      [
        "declare const tools: {",
        "  fs: {",
        "    read(args: { path: string }): Promise<unknown>;",
        "  };",
        "  github: {",
        "    create_issue(args: { labels?: Array<string>; title: string }): Promise<unknown>;",
        "    list_repos(args?: Record<string, unknown>): Promise<unknown>;",
        "  };",
        "};",
      ].join("\n"),
    );
  });

  it("produces names output with one-line summaries", () => {
    expect(generateStubs(registry.list(), { detail: "names" })).toBe(
      ["tools.fs.read", "tools.github.create_issue  // Create an issue. Second line.", "tools.github.list_repos  // List repos"].join("\n"),
    );
  });

  it("includes docs, hints and output types in full detail", () => {
    const full = generateStubs(registry.list(), { detail: "full", rootName: "api" });
    expect(full).toContain("declare const api: {");
    expect(full).toContain("     * Create an issue.");
    expect(full).toContain("DESTRUCTIVE: requires approval by default");
    expect(full).toContain("Promise<{ number: number }>");
    expect(full).toContain("[read-only]");
  });

  it("disambiguates upstream names that sanitize to the same identifier", () => {
    const r = new ToolRegistry();
    r.setServerTools("s", [{ name: "a-b", inputSchema: {} }, { name: "a_b", inputSchema: {} }]);
    expect(Object.fromEntries(r.list().map((t) => [t.name, t.stubName]))).toEqual({ "a-b": "a_b_2", a_b: "a_b" });
    expect(r.getByStubKey("s.a_b")?.name).toBe("a_b");
    expect(r.getByStubKey("s.a_b_2")?.name).toBe("a-b");
  });
});
