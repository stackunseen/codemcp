import { describe, expect, it } from "vitest";
import { MemorySink } from "codemcp-core";
import { readFileSync } from "node:fs";
import { Ajv2020 as Ajv } from "ajv/dist/2020.js";
import { Proxy, formatResult } from "../src/server.js";

describe("spec/config/codemcp.config.schema.json", () => {
  const schema = JSON.parse(readFileSync(new URL("../../../spec/config/codemcp.config.schema.json", import.meta.url), "utf8")) as object;
  const validate = new Ajv({ strict: false }).compile(schema);

  it("accepts the example config and rejects an invalid one", () => {
    const example = JSON.parse(readFileSync(new URL("../../../examples/basic/codemcp.config.json", import.meta.url), "utf8")) as object;
    expect(validate(example), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ servers: { x: { command: "a", url: "b" } } })).toBe(false);
    expect(validate({ servers: {}, identity: { mode: "static" } })).toBe(false);
    expect(validate({ servers: {}, policy: { rules: { "a.b": { roles: { finance: "approve" }, default: "deny" } } } })).toBe(true);
  });
});
import { ConfigLoader } from "../src/config.js";

const resolveConfig = ConfigLoader.resolve;

describe("resolveConfig", () => {
  it("applies every default once and honors audit.file=false", () => {
    const r = resolveConfig({ servers: {}, audit: { file: false } });
    expect(r.auditFile).toBeUndefined();
    expect(r.autoApproveNew).toBe(true);
    expect(r.rootName).toBe("tools");
    expect(r.passthrough).toEqual([]);
    expect(r.approvalsTool).toBe("auto");
    expect(r.auditIncludeCode).toBe(false);
    expect(r.identity).toEqual({ mode: "local" });
    expect(r.operatorRoles).toEqual(["operator"]);
    expect(r.approvalTimeoutMs).toBe(600_000);
    expect(resolveConfig({ servers: {}, pins: { autoApproveNew: false }, stubs: { rootName: "api" } })).toMatchObject({ autoApproveNew: false, rootName: "api" });
    expect(resolveConfig({ servers: {} }).auditFile).toMatch(/audit\.jsonl$/);
  });

  it("expands ${VAR} in env, headers and url from the environment and refuses unset variables", () => {
    const env = { GH_TOKEN: "ghp_x", HOST: "mcp.example.com" };
    const r = ConfigLoader.resolve(
      {
        servers: {
          gh: { command: "npx", args: ["gh-mcp"], env: { GITHUB_TOKEN: "${GH_TOKEN}" } },
          remote: { url: "https://${HOST}/mcp", headers: { Authorization: "Bearer ${GH_TOKEN}" } },
        },
      },
      env,
    );
    expect(r.servers.gh).toEqual({ command: "npx", args: ["gh-mcp"], env: { GITHUB_TOKEN: "ghp_x" } });
    expect(r.servers.remote).toEqual({ url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer ghp_x" } });
    expect(() => ConfigLoader.resolve({ servers: { x: { command: "a", env: { T: "${MISSING}" } } } }, env)).toThrow(/servers\.x\.env\.T references \$\{MISSING\}/);
  });
});

describe("formatResult", () => {
  it("renders completed results with logs and call summary", () => {
    const text = formatResult({
      status: "completed",
      value: { a: 1 },
      logs: [{ level: "log", message: "hi", t: 1 }],
      calls: [{ seq: 1, tool: "x.y", startedAt: 0, durationMs: 2, ok: true, decision: "allow" }],
      durationMs: 5,
    });
    expect(text).toContain('"a": 1');
    expect(text).toContain("[log] hi");
    expect(text).toContain("1 tool call, 5 ms");
  });

  it("renders errors with failed call details", () => {
    const text = formatResult({
      status: "error",
      logs: [],
      calls: [{ seq: 1, tool: "x.y", startedAt: 0, durationMs: 2, ok: false, decision: "deny", errorCode: "policy_denied", error: "nope" }],
      error: { code: "policy_denied", message: "nope" },
      durationMs: 5,
    });
    expect(text).toContain("Error (policy_denied): nope");
    expect(text).toContain("#1 x.y: policy_denied: nope");
  });
});

describe("Proxy surface", () => {
  it("advertises exactly search, describe and execute with no servers configured", async () => {
    const proxy = new Proxy({ config: { servers: {}, audit: { file: false }, pins: { file: false } }, audit: new MemorySink(), log: () => undefined });
    await proxy.start();
    const tools = proxy.listTools();
    expect(tools.map((t) => t.name)).toEqual(["search", "describe", "execute", "approve"]);
    const budget = JSON.stringify(tools).length;
    // Rough proxy for token footprint: the whole surface must stay small.
    expect(budget).toBeLessThan(4_000);
    await proxy.close();
  });
});
