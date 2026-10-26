const RESERVED = new Set([
  "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do", "else",
  "enum", "export", "extends", "false", "finally", "for", "function", "if", "import", "in", "instanceof",
  "new", "null", "return", "super", "switch", "this", "throw", "true", "try", "typeof", "var", "void",
  "while", "with", "yield", "let", "static", "implements", "interface", "package", "private", "protected",
  "public", "await", "async", "of", "undefined", "NaN", "Infinity", "arguments", "eval",
]);

/**
 * Turn an arbitrary MCP tool or server name into a safe JavaScript identifier.
 * Deterministic: the same input always yields the same output.
 */
export function sanitizeIdentifier(name: string): string {
  let id = name.replace(/[^A-Za-z0-9_$]+/g, "_").replace(/^_+|_+$/g, "");
  if (id.length === 0) id = "tool";
  if (/^[0-9]/.test(id)) id = `_${id}`;
  if (RESERVED.has(id)) id = `${id}_`;
  return id;
}

/** The alphabet allowed for server names in config: letters, digits, `_` and `-`. */
export const SERVER_NAME_RE = /^[A-Za-z0-9_-]+$/;

/** Coerce a client-config server name into the allowed alphabet. */
export function sanitizeServerName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "server";
}

/**
 * Compile a glob-ish pattern on qualified names into a RegExp: `*` matches any run of characters.
 * Examples: `github.*`, `*.delete_*`, `*`.
 */
export function compilePattern(pattern: string): RegExp {
  return new RegExp(`^${pattern.split("*").map(escapeRegExp).join(".*")}$`);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
