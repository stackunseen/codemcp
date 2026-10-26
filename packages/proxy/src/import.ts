import { readFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { readJsonFile, sanitizeServerName } from "codemcp-core";
import type { ServerConfig } from "./config.js";

export interface DiscoveredServer {
  name: string;
  config: ServerConfig;
  host: string;
}

interface Candidate {
  host: string;
  path: string;
  /** Top-level key holding the server map. */
  key: "mcpServers" | "servers";
}

/**
 * Finds the MCP servers a user already has configured in their MCP clients and normalizes them into
 * codemcp's server config shape. Entries that point at codemcp itself are skipped.
 */
export class ClientConfigDiscovery {
  constructor(
    private readonly cwd: string = process.cwd(),
    private readonly home: string = homedir(),
  ) {}

  async discover(): Promise<DiscoveredServer[]> {
    const perFile = await Promise.all(this.candidates().map((c) => this.readCandidate(c)));
    const codex = await ClientConfigDiscovery.readCodexToml(join(this.home, ".codex", "config.toml"));
    return [...perFile.flat(), ...codex].filter((s) => !ClientConfigDiscovery.isSelf(s.config));
  }

  /** Known client config locations. Project-level files are relative to `cwd`. */
  private candidates(): Candidate[] {
    const os = platform();
    const appData = process.env.APPDATA ?? join(this.home, "AppData", "Roaming");
    const claudeDesktop =
      os === "win32"
        ? join(appData, "Claude", "claude_desktop_config.json")
        : os === "darwin"
          ? join(this.home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
          : join(this.home, ".config", "Claude", "claude_desktop_config.json");
    return [
      { host: "claude-desktop", path: claudeDesktop, key: "mcpServers" },
      { host: "claude-code", path: join(this.home, ".claude.json"), key: "mcpServers" },
      { host: "claude-code", path: join(this.cwd, ".mcp.json"), key: "mcpServers" },
      { host: "cursor", path: join(this.home, ".cursor", "mcp.json"), key: "mcpServers" },
      { host: "cursor", path: join(this.cwd, ".cursor", "mcp.json"), key: "mcpServers" },
      { host: "vscode", path: join(this.cwd, ".vscode", "mcp.json"), key: "servers" },
      { host: "windsurf", path: join(this.home, ".codeium", "windsurf", "mcp_config.json"), key: "mcpServers" },
    ];
  }

  private async readCandidate(c: Candidate): Promise<DiscoveredServer[]> {
    const raw = await readJsonFile(c.path).catch(() => undefined);
    if (!raw || typeof raw !== "object") return [];
    const found = ClientConfigDiscovery.fromMap((raw as Record<string, unknown>)[c.key], c.host);
    // Claude Code also keeps per-project servers under projects[<path>].mcpServers.
    const projects = (raw as { projects?: Record<string, { mcpServers?: unknown }> }).projects;
    if (c.host === "claude-code" && projects && typeof projects === "object") {
      for (const p of Object.values(projects)) found.push(...ClientConfigDiscovery.fromMap(p?.mcpServers, c.host));
    }
    return found;
  }

  private static fromMap(map: unknown, host: string): DiscoveredServer[] {
    if (!map || typeof map !== "object") return [];
    const out: DiscoveredServer[] = [];
    for (const [name, entry] of Object.entries(map as Record<string, unknown>)) {
      const cfg = ClientConfigDiscovery.normalizeEntry(entry);
      if (cfg) out.push({ name: sanitizeServerName(name), config: cfg, host });
    }
    return out;
  }

  static normalizeEntry(entry: unknown): ServerConfig | undefined {
    if (!entry || typeof entry !== "object") return undefined;
    const e = entry as Record<string, unknown>;
    if (typeof e.url === "string") {
      return { url: e.url, ...(isStringMap(e.headers) ? { headers: e.headers } : {}) };
    }
    if (typeof e.command === "string") {
      return {
        command: e.command,
        ...(Array.isArray(e.args) ? { args: e.args.map(String) } : {}),
        ...(isStringMap(e.env) ? { env: e.env } : {}),
        ...(typeof e.cwd === "string" ? { cwd: e.cwd } : {}),
      };
    }
    return undefined;
  }

  /** Reads Codex CLI's `[mcp_servers.<name>]` tables. */
  // shortcut: string and string-array keys only, no inline tables or env; swap for a TOML dependency if Codex adds nested config.
  static async readCodexToml(path: string): Promise<DiscoveredServer[]> {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      return [];
    }
    const out: DiscoveredServer[] = [];
    for (const section of text.split(/^\s*\[/m).slice(1)) {
      const header = /^mcp_servers\.([^\]\s]+)\]\s*\n/.exec(section);
      if (!header?.[1]) continue;
      const body = section.slice(header[0].length);
      const str = (k: string): string | undefined => new RegExp(`^\\s*${k}\\s*=\\s*"([^"]*)"`, "m").exec(body)?.[1];
      const arr = (k: string): string[] | undefined => {
        const m = new RegExp(`^\\s*${k}\\s*=\\s*\\[([^\\]]*)\\]`, "m").exec(body);
        return m?.[1] !== undefined ? [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1] ?? "") : undefined;
      };
      const cfg = ClientConfigDiscovery.normalizeEntry({ command: str("command"), url: str("url"), args: arr("args") });
      if (cfg) out.push({ name: sanitizeServerName(header[1].replace(/"/g, "")), config: cfg, host: "codex" });
    }
    return out;
  }

  /** Merge discovered servers into a config map. A name clash with a different config gets a host suffix. */
  static merge(existing: Record<string, ServerConfig>, discovered: DiscoveredServer[]): Record<string, ServerConfig> {
    const out = { ...existing };
    const same = (a: ServerConfig | undefined, b: ServerConfig): boolean => JSON.stringify(a) === JSON.stringify(b);
    for (const s of discovered) {
      let name = s.name;
      for (let i = 2; out[name] && !same(out[name], s.config); i++) name = `${s.name}-${s.host}${i > 2 ? i : ""}`;
      out[name] = s.config;
    }
    return out;
  }

  private static isSelf(c: ServerConfig): boolean {
    return "command" in c && /codemcp/.test([c.command, ...(c.args ?? [])].join(" "));
  }
}

function isStringMap(x: unknown): x is Record<string, string> {
  return Boolean(x) && typeof x === "object" && Object.values(x as object).every((v) => typeof v === "string");
}
