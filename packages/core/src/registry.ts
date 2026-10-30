import { descriptionHash } from "./hash.js";
import { cleanTool, type DescriptionHygiene } from "./hygiene.js";
import { sanitizeIdentifier } from "./naming.js";
import type { ToolDescriptor, UpstreamTool } from "./types.js";

/**
 * In-memory registry of all tools across upstream servers, keyed by qualified name.
 * Tools are listed in deterministic order (server, then tool name) so generated stubs and
 * `tools/list` output are stable, which keeps LLM prompt caches warm.
 */
export class ToolRegistry {
  private readonly byQualified = new Map<string, ToolDescriptor>();
  private readonly byStubKey = new Map<string, ToolDescriptor>();
  private sorted: ToolDescriptor[] | undefined;

  /** `hygiene: false` passes tool text through untouched; the default cleans it (see `DescriptionHygiene`). */
  constructor(private readonly options: { hygiene?: DescriptionHygiene | false } = {}) {}

  /** Replace every tool for `server` with `upstream`. Returns the registered descriptors. */
  setServerTools(server: string, upstream: UpstreamTool[]): ToolDescriptor[] {
    this.removeServer(server);
    const ns = sanitizeIdentifier(server);
    const used = new Set<string>();
    const out: ToolDescriptor[] = [];
    // Tools whose upstream name already is a valid identifier claim it first, so `a_b` is never displaced by `a-b`.
    const candidates = upstream
      .map((raw) => {
        const cleaned = this.options.hygiene === false ? { value: raw, changes: [] } : cleanTool(raw, this.options.hygiene ?? {});
        return { tool: cleaned.value, changes: cleaned.changes, id: sanitizeIdentifier(raw.name) };
      })
      .sort((a, b) => Number(a.id !== a.tool.name) - Number(b.id !== b.tool.name) || a.tool.name.localeCompare(b.tool.name));
    for (const { tool, changes, id } of candidates) {
      let stubName = id;
      // Two distinct upstream names may sanitize to the same identifier; disambiguate deterministically.
      for (let i = 2; used.has(stubName); i++) stubName = `${id}_${i}`;
      used.add(stubName);
      const descriptor: ToolDescriptor = {
        ...tool,
        server,
        stubName,
        stubNamespace: ns,
        qualifiedName: `${server}.${tool.name}`,
        stubKey: `${ns}.${stubName}`,
        descriptionHash: descriptionHash(tool),
        ...(changes.length ? { hygiene: changes } : {}),
      };
      this.byQualified.set(descriptor.qualifiedName, descriptor);
      this.byStubKey.set(descriptor.stubKey, descriptor);
      out.push(descriptor);
    }
    this.sorted = undefined;
    return out;
  }

  removeServer(server: string): void {
    for (const [key, tool] of this.byQualified) {
      if (tool.server === server) {
        this.byQualified.delete(key);
        this.byStubKey.delete(tool.stubKey);
      }
    }
    this.sorted = undefined;
  }

  get(qualified: string): ToolDescriptor | undefined {
    return this.byQualified.get(qualified);
  }

  /** Resolve a guest-side stub key (`namespace.stubName`) to its descriptor. */
  getByStubKey(stubKey: string): ToolDescriptor | undefined {
    return this.byStubKey.get(stubKey);
  }

  /** All tools in deterministic order. Cached until the registry changes. */
  list(): ToolDescriptor[] {
    this.sorted ??= [...this.byQualified.values()].sort((a, b) =>
      a.server === b.server ? a.name.localeCompare(b.name) : a.server.localeCompare(b.server),
    );
    return this.sorted;
  }

  /** Tools of one server, addressed by its config name or its stub namespace. */
  toolsForServer(ref: string): ToolDescriptor[] {
    return this.list().filter((t) => t.server === ref || t.stubNamespace === ref);
  }

  servers(): string[] {
    return [...new Set(this.list().map((t) => t.server))];
  }

  get size(): number {
    return this.byQualified.size;
  }
}
