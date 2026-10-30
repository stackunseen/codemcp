import type { JsonSchema, UpstreamTool } from "./types.js";

/**
 * Cleaning applied to tool text before it reaches the model. A server controls its own descriptions,
 * so a hostile or careless one can send pages of text or characters that render as nothing. This is
 * on by default and can be turned off per proxy; the pin hash is computed on the cleaned text.
 */
export interface DescriptionHygiene {
  /** Longest description kept, in characters. Longer ones are cut and marked. Default 2000. */
  maxLength?: number;
  /** Remove control characters and invisible Unicode (zero-width, bidi overrides, BOM). Default true. */
  stripInvisible?: boolean;
}

export const DEFAULT_MAX_DESCRIPTION_LENGTH = 2000;

// Keeps tab, newline and carriage return. Removes C0 and C1 controls, zero-width characters,
// bidi embedding and override marks, word joiners and the byte-order mark.
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F​-‏‪-‮⁠-⁤﻿]/g;

const TRUNCATION_MARK = " [description truncated]";

export interface CleanResult<T> {
  value: T;
  /** What was changed, one entry per edit, for logs and `codemcp tools`. Empty when nothing changed. */
  changes: string[];
}

/** Clean one string. */
export function cleanText(text: string, where: string, opts: DescriptionHygiene = {}): CleanResult<string> {
  const changes: string[] = [];
  let out = text;
  if (opts.stripInvisible ?? true) {
    const stripped = out.replace(INVISIBLE, "");
    if (stripped !== out) {
      changes.push(`${where}: removed ${out.length - stripped.length} invisible or control characters`);
      out = stripped;
    }
  }
  const max = opts.maxLength ?? DEFAULT_MAX_DESCRIPTION_LENGTH;
  if (out.length > max) {
    changes.push(`${where}: cut from ${out.length} to ${max} characters`);
    out = out.slice(0, max) + TRUNCATION_MARK;
  }
  return { value: out, changes };
}

/** Clean every `description` and `title` string inside a JSON Schema, at any depth. */
function cleanSchema(schema: JsonSchema, where: string, opts: DescriptionHygiene, changes: string[]): JsonSchema {
  const walk = (node: unknown, path: string): unknown => {
    if (Array.isArray(node)) return node.map((item, i) => walk(item, `${path}[${i}]`));
    if (!node || typeof node !== "object") return node;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if ((key === "description" || key === "title") && typeof value === "string") {
        const r = cleanText(value, `${path}.${key}`, opts);
        changes.push(...r.changes);
        out[key] = r.value;
      } else {
        out[key] = walk(value, `${path}.${key}`);
      }
    }
    return out;
  };
  return walk(schema, where) as JsonSchema;
}

/** Clean a tool's description, its annotation title, and the descriptions inside its schemas. */
export function cleanTool(tool: UpstreamTool, opts: DescriptionHygiene = {}): CleanResult<UpstreamTool> {
  const changes: string[] = [];
  const out: UpstreamTool = { ...tool };
  if (typeof tool.description === "string") {
    const r = cleanText(tool.description, "description", opts);
    changes.push(...r.changes);
    out.description = r.value;
  }
  out.inputSchema = cleanSchema(tool.inputSchema, "inputSchema", opts, changes);
  if (tool.outputSchema) out.outputSchema = cleanSchema(tool.outputSchema, "outputSchema", opts, changes);
  if (typeof tool.annotations?.title === "string") {
    const r = cleanText(tool.annotations.title, "annotations.title", opts);
    changes.push(...r.changes);
    out.annotations = { ...tool.annotations, title: r.value };
  }
  return { value: out, changes };
}
