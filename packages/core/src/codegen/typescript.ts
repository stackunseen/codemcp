import { DEFAULT_ROOT_NAME } from "../prompt.js";
import type { JsonSchema, ToolDescriptor } from "../types.js";

export const STUB_DETAILS = ["names", "signatures", "full"] as const;
export type StubDetail = (typeof STUB_DETAILS)[number];

export function parseStubDetail(x: unknown): StubDetail {
  return (STUB_DETAILS as readonly unknown[]).includes(x) ? (x as StubDetail) : "signatures";
}

const MAX_DEPTH = 12;

/**
 * Renders JSON Schema as TypeScript type expressions. Pure and deterministic: the same schema always
 * produces the same text, and unsupported constructs degrade to `unknown` rather than throwing.
 */
export class SchemaTypeWriter {
  constructor(private readonly root: JsonSchema) {}

  static write(schema: JsonSchema): string {
    return new SchemaTypeWriter(schema).type(schema);
  }

  type(schema: JsonSchema | boolean | undefined, depth = 0): string {
    if (schema === undefined || schema === true) return "unknown";
    if (schema === false) return "never";
    if (depth > MAX_DEPTH) return "unknown";

    if (typeof schema.$ref === "string") {
      const target = this.resolveRef(schema.$ref);
      return target ? this.type(target, depth + 1) : "unknown";
    }
    if (Array.isArray(schema.enum)) return schema.enum.map(literal).join(" | ") || "never";
    if ("const" in schema) return literal(schema.const);
    const alternatives = schema.anyOf ?? schema.oneOf;
    if (Array.isArray(alternatives)) return this.union(alternatives as JsonSchema[], depth);
    if (Array.isArray(schema.allOf)) return (schema.allOf as JsonSchema[]).map((x) => paren(this.type(x, depth + 1))).join(" & ") || "unknown";

    const parts = SchemaTypeWriter.declaredTypes(schema).map((t) => this.composite(t, schema, depth));
    return [...new Set(parts)].join(" | ") || "unknown";
  }

  /** The declared `type`(s) of a schema, inferred from structure when absent. */
  static declaredTypes(schema: JsonSchema): string[] {
    if (Array.isArray(schema.type)) return schema.type.map(String);
    if (schema.type) return [String(schema.type)];
    if (schema.properties || schema.additionalProperties !== undefined || schema.required) return ["object"];
    if (schema.items) return ["array"];
    return [];
  }

  /** `args` may be omitted when the schema is an object with no required properties. */
  static argsOptional(schema: JsonSchema): boolean {
    const types = SchemaTypeWriter.declaredTypes(schema);
    if (types.length > 0 && !types.includes("object")) return false;
    const required = schema.required as string[] | undefined;
    return !required || required.length === 0;
  }

  private composite(t: string, schema: JsonSchema, depth: number): string {
    switch (t) {
      case "string":
        return "string";
      case "number":
      case "integer":
        return "number";
      case "boolean":
        return "boolean";
      case "null":
        return "null";
      case "array": {
        const items = schema.items;
        if (Array.isArray(items)) return `[${items.map((i) => this.type(i as JsonSchema, depth + 1)).join(", ")}]`;
        return `Array<${this.type(items as JsonSchema | undefined, depth + 1)}>`;
      }
      case "object":
        return this.object(schema, depth);
      default:
        return "unknown";
    }
  }

  private object(schema: JsonSchema, depth: number): string {
    const props = (schema.properties ?? {}) as Record<string, JsonSchema>;
    const required = new Set((schema.required as string[] | undefined) ?? []);
    const keys = Object.keys(props).sort();
    const lines: string[] = [];
    for (const key of keys) {
      const prop = props[key] as JsonSchema;
      const doc = typeof prop.description === "string" ? `/** ${oneLine(prop.description)} */ ` : "";
      lines.push(`${doc}${propKey(key)}${required.has(key) ? "" : "?"}: ${this.type(prop, depth + 1)}`);
    }
    const extra = schema.additionalProperties;
    if (extra === true || (extra && typeof extra === "object")) {
      lines.push(`[key: string]: ${this.type(extra as JsonSchema | true, depth + 1)}`);
    } else if (keys.length === 0 && extra !== false) {
      return "Record<string, unknown>";
    }
    if (lines.length === 0) return "Record<string, never>";
    return `{ ${lines.join("; ")} }`;
  }

  private union(items: JsonSchema[], depth: number): string {
    return [...new Set(items.map((x) => this.type(x, depth + 1)))].join(" | ") || "unknown";
  }

  private resolveRef(ref: string): JsonSchema | undefined {
    if (!ref.startsWith("#/")) return undefined;
    let node: unknown = this.root;
    for (const part of ref.slice(2).split("/")) {
      const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
      if (!node || typeof node !== "object") return undefined;
      node = (node as Record<string, unknown>)[key];
    }
    return node && typeof node === "object" ? (node as JsonSchema) : undefined;
  }
}

/**
 * Generates the TypeScript declarations the model reads. Output is deterministic over registry order.
 * Compact typed stubs are used rather than a directory-style listing because they hold up better as
 * the context fills.
 */
export class StubGenerator {
  constructor(private readonly rootName: string = DEFAULT_ROOT_NAME) {}

  generate(tools: ToolDescriptor[], detail: StubDetail = "signatures"): string {
    if (detail === "names") return this.names(tools);
    const byNamespace = new Map<string, ToolDescriptor[]>();
    for (const t of tools) byNamespace.set(t.stubNamespace, [...(byNamespace.get(t.stubNamespace) ?? []), t]);

    const out: string[] = [`declare const ${this.rootName}: {`];
    for (const [ns, list] of [...byNamespace.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      out.push(`  ${ns}: {`);
      for (const t of list) {
        const doc = this.docFor(t);
        if (detail === "full" && doc) out.push(docComment(doc, "    "));
        const output = detail === "full" && t.outputSchema ? SchemaTypeWriter.write(t.outputSchema) : "unknown";
        out.push(`    ${t.stubName}(args${SchemaTypeWriter.argsOptional(t.inputSchema) ? "?" : ""}: ${SchemaTypeWriter.write(t.inputSchema)}): Promise<${output}>;`);
      }
      out.push("  };");
    }
    out.push("};");
    return out.join("\n");
  }

  private names(tools: ToolDescriptor[]): string {
    return tools
      .map((t) => `${this.rootName}.${t.stubNamespace}.${t.stubName}${t.description ? `  // ${oneLine(t.description).slice(0, 100)}` : ""}`)
      .join("\n");
  }

  private docFor(t: ToolDescriptor): string {
    const hints: string[] = [];
    if (t.annotations?.readOnlyHint) hints.push("read-only");
    if (t.annotations?.destructiveHint) hints.push("DESTRUCTIVE: requires approval by default");
    if (t.annotations?.idempotentHint) hints.push("idempotent");
    const head = t.description?.trim() ?? "";
    return [head, hints.length ? `[${hints.join(", ")}]` : ""].filter(Boolean).join("\n");
  }
}

function literal(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (v === null) return "null";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "unknown";
}

function paren(t: string): string {
  return t.includes("|") ? `(${t})` : t;
}

function propKey(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
}

// Tool text goes inside generated comments, so a comment terminator in a description must not close them.
function escapeCommentClose(s: string): string {
  return s.replace(/\*\//g, "* /");
}

function oneLine(s: string): string {
  return escapeCommentClose(s).replace(/\s+/g, " ").trim();
}

function docComment(text: string, indent: string): string {
  const lines = escapeCommentClose(text).trim().split(/\r?\n/);
  return [indent + "/**", ...lines.map((l) => indent + " * " + l), indent + " */"].join("\n");
}
