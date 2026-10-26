import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sanitizeServerName } from "codemcp-core";
import { ClientConfigDiscovery } from "../src/import.js";
import { ConfigLoader } from "../src/config.js";

const { normalizeEntry, readCodexToml, merge: mergeDiscovered } = ClientConfigDiscovery;
const validateConfig = ConfigLoader.validate;

describe("normalizeEntry", () => {
  it("accepts stdio and http shapes from the common client formats", () => {
    expect(normalizeEntry({ command: "npx", args: ["-y", "@x/y"], env: { A: "1" } })).toEqual({ command: "npx", args: ["-y", "@x/y"], env: { A: "1" } });
    expect(normalizeEntry({ type: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer t" } })).toEqual({ url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer t" } });
    expect(normalizeEntry({ disabled: true })).toBeUndefined();
  });
});

describe("readCodexToml", () => {
  it("parses mcp_servers tables", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codemcp-"));
    const path = join(dir, "config.toml");
    await writeFile(path, ['model = "x"', "", "[mcp_servers.github]", 'command = "npx"', 'args = ["-y", "@modelcontextprotocol/server-github"]', "", "[mcp_servers.remote]", 'url = "https://r.example/mcp"', ""].join("\n"));
    const found = await readCodexToml(path);
    expect(found.map((f) => f.name)).toEqual(["github", "remote"]);
    expect(found[0]?.config).toEqual({ command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] });
    expect(found[1]?.config).toEqual({ url: "https://r.example/mcp" });
  });
});

describe("mergeDiscovered", () => {
  it("dedupes identical servers and suffixes conflicting ones", () => {
    const merged = mergeDiscovered(
      { github: { command: "a" } },
      [
        { name: "github", config: { command: "a" }, host: "cursor" },
        { name: "github", config: { command: "b" }, host: "vscode" },
      ],
    );
    expect(Object.keys(merged).sort()).toEqual(["github", "github-vscode"]);
  });
});

describe("validateConfig", () => {
  it("rejects servers with neither or both transports and bad names", () => {
    expect(() => validateConfig({ servers: { x: {} } })).toThrow(/exactly one/);
    expect(() => validateConfig({ servers: { x: { command: "a", url: "b" } } })).toThrow(/exactly one/);
    expect(() => validateConfig({ servers: { "bad name": { command: "a" } } })).toThrow(/letters/);
    expect(validateConfig({ servers: { ok: { command: "a" } } }).servers.ok).toEqual({ command: "a" });
  });

  it("sanitizes server names", () => {
    expect(sanitizeServerName("My Server (v2)")).toBe("My-Server-v2");
  });
});
