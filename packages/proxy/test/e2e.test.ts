import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readFileSync } from "node:fs";
import { Ajv2020 as Ajv } from "ajv/dist/2020.js";
import { MemorySink, type AuditEvent } from "codemcp-core";
import { Proxy } from "../src/server.js";

const fixture = fileURLToPath(new URL("./fixtures/echo-server.mjs", import.meta.url));
const audit = new MemorySink();
const callbackEvents: string[] = [];
let proxy: Proxy;
let client: Client;

let lastIsError = false;
async function call(name: string, args: Record<string, unknown>, onprogress?: (p: { message?: string }) => void): Promise<string> {
  const res = await client.callTool({ name, arguments: args }, undefined, onprogress ? { onprogress } : undefined);
  const content = res.content as Array<{ type: string; text?: string }>;
  lastIsError = Boolean(res.isError);
  return content.map((c) => c.text ?? "").join("\n");
}

beforeAll(async () => {
  proxy = new Proxy({
    config: {
      servers: {
        shop: { command: process.execPath, args: [fixture], env: { FIXTURE_SECRET: "s3cret-token" } },
        // A second instance of the same server with a different credential: each connection gets only its own.
        shop2: { command: process.execPath, args: [fixture], env: { FIXTURE_SECRET: "other-token" } },
        // A server that cannot start: its state must be reported, not silently absent.
        broken: { command: process.execPath, args: ["-e", "process.stderr.write('Unauthorized: bad token'); process.exit(1)"] },
      },
      audit: { file: false, includeResults: true },
      pins: { file: false },
      passthrough: ["shop.get_item"],
      budget: { maxCalls: 10 },
      // No `approvals.tool` here: the in-memory client has no elicitation, so "auto" must expose `approve`.
      approvals: { timeoutMs: 5_000 },
    },
    audit,
    onAudit: (e) => void callbackEvents.push(e.type),
    log: () => undefined,
  });
  await proxy.start();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await proxy.server.connect(serverTransport);
  client = new Client({ name: "test-client", version: "0" });
  await client.connect(clientTransport);
}, 30_000);

afterAll(async () => {
  await client.close();
  await proxy.close();
});

describe("end to end: client -> proxy -> QuickJS -> upstream stdio server", () => {
  it("advertises the code-mode surface plus the passthrough tool", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["search", "describe", "execute", "approve", "shop__get_item"]);
  });

  it("each server receives only its own credential, selected by the tool's server, never by the script", async () => {
    const out = await call("execute", { code: "return { a: await tools.shop.secret({}), b: await tools.shop2.secret({}) };" });
    expect(out).toContain('"a": "s3cret-token"');
    expect(out).toContain('"b": "other-token"');
  });

  it("search finds tools and describe returns typed stubs", async () => {
    expect(await call("search", { query: "delete item" })).toContain("tools.shop.delete_item");
    const stubs = await call("describe", { server: "shop" });
    expect(stubs).toContain("list_items(args?: { minPrice?: number }): Promise<unknown>;");
    expect(stubs).toContain("get_item(args: { id: number }): Promise<unknown>;");
  });

  it("describe resolves qualified names, stub paths and rejects unknown refs", async () => {
    const byQualified = await call("describe", { tools: ["shop.list-items"] });
    const byStubPath = await call("describe", { tools: ["tools.shop.list_items"], detail: "full" });
    expect(byQualified).toContain("list_items(");
    expect(byStubPath).toContain("List catalog items");
    expect(await call("describe", { tools: ["shop.nope"] })).toContain("Unknown tools: shop.nope");
  });

  it("execute runs code that fans out over tool results inside the sandbox", async () => {
    const out = await call("execute", {
      code: [
        "const items = await tools.shop.list_items({ minPrice: 60 });",
        "const details = await Promise.all(items.slice(0, 3).map(i => tools.shop.get_item({ id: i.id })));",
        "console.log('fetched', details.length);",
        "return { count: items.length, total: details.reduce((s, d) => s + d.price, 0), names: details.map(d => d.name) };",
      ].join("\n"),
    });
    expect(out).toContain('"count": 6');
    expect(out).toContain('"total": 189');
    expect(out).toContain("[log] fetched 3");
    expect(out).toContain("4 tool calls");
  });

  it("a destructive call parks the script; the final result arrives with the human's decision", async () => {
    const paused = await call("execute", { code: "const r = await tools.shop.delete_item({ id: 1 }); return 'after: ' + r;" });
    const m = /execution (\S+) is waiting for approval of call #(\d+) shop\.delete_item/.exec(paused);
    expect(m, paused).not.toBeNull();
    expect(paused).toContain("call approve");
    const resumed = await call("approve", { executionId: m![1], seq: Number(m![2]), allow: true });
    expect(resumed).toContain("after: deleted");

    const paused2 = await call("execute", { code: "try { await tools.shop.delete_item({ id: 2 }); return 'deleted'; } catch (e) { return 'kept: ' + e.code; }" });
    const m2 = /execution (\S+) is waiting for approval of call #(\d+)/.exec(paused2)!;
    const denied = await call("approve", { executionId: m2[1], seq: Number(m2[2]), allow: false });
    expect(denied).toContain("kept: approval_required");
    expect(lastIsError).toBe(false);

    expect(await call("approve", { executionId: m2[1], seq: 99, allow: true })).toMatch(/No parked execution/);
  });

  it("failed executions are flagged with isError and TypeScript syntax is accepted", async () => {
    const out = await call("execute", { code: "const items: Array<{ id: number }> = await tools.shop.list_items({ minPrice: 60 }) as any; return items.length satisfies number;" });
    expect(out).toContain("6");
    expect(lastIsError).toBe(false);
    await call("execute", { code: "throw new Error('nope');" });
    expect(lastIsError).toBe(true);
    await call("execute", { code: "return (" });
    expect(lastIsError).toBe(true);
  });

  it("log lines stream to the client as progress notifications", async () => {
    const messages: string[] = [];
    const out = await call("execute", { code: "console.log('one'); await tools.shop.get_item({ id: 1 }); console.log('two'); return 'ok';" }, (p) => void messages.push(p.message ?? ""));
    expect(out).toContain("ok");
    expect(messages).toEqual(["[log] one", "[log] two"]);
  });

  it("credentials given to the upstream never reach the sandbox", async () => {
    const out = await call("execute", {
      code: "const env = typeof process === 'undefined' ? 'no-process' : JSON.stringify(process.env); const viaTool = await tools.shop.secret({}); return { env, viaTool };",
    });
    // The upstream itself can see its own secret (that is its job); the sandbox has no process at all.
    expect(out).toContain('"env": "no-process"');
    expect(out).toContain('"viaTool": "s3cret-token"');
  });

  it("upstream errors are catchable inside the script", async () => {
    const out = await call("execute", { code: "try { await tools.shop.get_item({ id: 999 }); } catch (e) { return 'caught: ' + e.message; }" });
    expect(out).toContain("caught: shop.get_item: no item 999");
  });

  it("argument validation rejects bad input before it reaches the upstream", async () => {
    const out = await call("execute", { code: "try { await tools.shop.get_item({ id: 'one' }); } catch (e) { return e.message; }" });
    expect(out).toContain("shop.get_item: invalid arguments");
  });

  it("budgets end runaway loops", async () => {
    const out = await call("execute", { code: "for (let i = 0; i < 50; i++) await tools.shop.get_item({ id: 1 }); return 'done';" });
    expect(out).toContain("Error (budget_exceeded)");
  });

  it("passthrough tools call the upstream directly", async () => {
    const out = await call("shop__get_item", { id: 2 });
    expect(out).toContain('"name": "item-2"');
  });

  it("a server that failed to start is reported to the model and the operator", async () => {
    const status = proxy.serverStatus();
    expect(status.find((s) => s.name === "broken")?.state).toBe("unreachable");
    expect(status.find((s) => s.name === "shop")).toMatchObject({ state: "connected", tools: 4 });
    const search = await call("search", { query: "zzzz-nothing" });
    expect(search).toContain("Unavailable servers: broken (unreachable)");
    const describe = await call("describe", { server: "broken" });
    expect(lastIsError).toBe(true);
    expect(describe).toMatch(/configured but unreachable/);
  });

  it("every execution runs as a principal, and results reach the audit callback", async () => {
    await call("execute", { code: "console.log('traced'); return 42;" });
    const end = audit.events.filter((e) => e.type === "execution_end").at(-1) as Extract<AuditEvent, { type: "execution_end" }>;
    expect(end.principal).toMatch(/^local:/);
    expect(end.value).toBe(42);
    expect(end.logs?.map((l) => l.message)).toEqual(["traced"]);
    expect(callbackEvents).toContain("execution_end");
  });

  it("servers can be added and removed at runtime", async () => {
    const added = await proxy.addServer("shop3", { command: process.execPath, args: [fixture], env: { FIXTURE_SECRET: "third" } });
    expect(added).toMatchObject({ state: "connected", tools: 4 });
    expect(await call("execute", { code: "return await tools.shop3.secret({});" })).toContain("third");
    const bad = await proxy.addServer("nope", { command: process.execPath, args: ["-e", "process.exit(2)"] });
    expect(bad.state).toBe("unreachable");
    await expect(proxy.addServer("bad name", { command: "x" })).rejects.toThrow(/letters/);
    await proxy.removeServer("shop3");
    await proxy.removeServer("nope");
    expect(proxy.serverStatus().map((s) => s.name)).toEqual(["shop", "shop2", "broken"]);
    expect(await call("describe", { server: "shop3" })).toMatch(/No server named/);
  });

  it("every audit event conforms to spec/audit/events.schema.json", () => {
    const schema = JSON.parse(readFileSync(new URL("../../../spec/audit/events.schema.json", import.meta.url), "utf8")) as object;
    const validate = new Ajv({ strict: false }).compile(schema);
    for (const e of audit.events) expect(validate(e), `${JSON.stringify(e)}: ${JSON.stringify(validate.errors)}`).toBe(true);
  });

  it("every bridged call is in the audit log", () => {
    const calls = audit.events.filter((e) => e.type === "call");
    expect(calls.length).toBeGreaterThanOrEqual(15);
    expect(calls.some((e) => e.type === "call" && e.tool === "shop.delete_item" && e.decision === "approve" && !e.ok)).toBe(true);
    expect(calls.some((e) => e.type === "call" && e.tool === "shop.delete_item" && e.decision === "approve" && e.ok)).toBe(true);
  });
});
