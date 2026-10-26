import MiniSearch from "minisearch";
import type { ToolDescriptor } from "./types.js";

interface Doc {
  id: string;
  name: string;
  server: string;
  description: string;
  keys: string;
}

/**
 * BM25 search over tool names, servers, descriptions and input property names.
 * Rebuilt whenever the registry changes; cheap for tens of thousands of tools.
 * MiniSearch's default tokenizer already splits on `_`, `-`, `.`, `/` and punctuation.
 */
export class ToolSearch {
  private readonly index = new MiniSearch<Doc>({
    fields: ["name", "server", "description", "keys"],
    storeFields: ["id"],
    searchOptions: { boost: { name: 3, server: 1.5, keys: 1.2 }, fuzzy: 0.2, prefix: true, combineWith: "OR" },
  });
  private readonly byId = new Map<string, ToolDescriptor>();

  constructor(tools: ToolDescriptor[] = []) {
    this.replace(tools);
  }

  replace(tools: ToolDescriptor[]): void {
    this.index.removeAll();
    this.byId.clear();
    this.index.addAll(
      tools.map((t) => {
        this.byId.set(t.qualifiedName, t);
        return {
          id: t.qualifiedName,
          name: `${t.name} ${t.stubName} ${t.annotations?.title ?? ""}`,
          server: t.server,
          description: t.description ?? "",
          keys: Object.keys((t.inputSchema.properties as Record<string, unknown> | undefined) ?? {}).join(" "),
        };
      }),
    );
  }

  search(query: string, limit = 10): ToolDescriptor[] {
    const q = query.trim();
    if (!q) return [...this.byId.values()].slice(0, limit);
    return this.index
      .search(q)
      .slice(0, limit)
      .map((h) => this.byId.get(String(h.id)))
      .filter((t): t is ToolDescriptor => Boolean(t));
  }
}
