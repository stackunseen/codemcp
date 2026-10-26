import { createHash } from "node:crypto";
import type { UpstreamTool } from "./types.js";

/** Stable JSON serialization: object keys sorted recursively so hashes do not depend on key order. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * The pinning hash covers everything the model is influenced by and everything policy trusts:
 * name, description, input schema, output schema and annotations. A server that changes any of
 * these after approval is treated as a new, unapproved tool.
 */
export function descriptionHash(tool: UpstreamTool): string {
  return sha256(canonicalJson({ n: tool.name, d: tool.description ?? "", s: tool.inputSchema, o: tool.outputSchema ?? null, a: tool.annotations ?? null }));
}
