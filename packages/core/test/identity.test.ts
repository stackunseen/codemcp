import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import {
  ApprovalGate,
  CallbackSink,
  HttpSink,
  LocalIdentityProvider,
  MultiSink,
  MemorySink,
  Policy,
  StaticTokenIdentityProvider,
  ToolRegistry,
  TrustedHeaderIdentityProvider,
  type AuditEvent,
} from "../src/index.js";

const drift: AuditEvent = { type: "pin_drift", ts: "t", tool: "a.b", previousHash: "x", currentHash: "y" };

describe("identity providers", () => {
  it("local resolves the OS user on stdio and nothing on http", async () => {
    const p = new LocalIdentityProvider();
    const local = await p.resolve({ transport: "stdio" });
    expect(local?.id).toMatch(/^local:/);
    expect(local?.roles).toEqual(["local"]);
    expect(await p.resolve({ transport: "http", headers: {} })).toBeUndefined();
  });

  it("static maps bearer tokens and refuses unknown or missing ones", async () => {
    const p = new StaticTokenIdentityProvider({ "tok-1": { id: "ada", roles: ["finance"] } });
    expect(await p.resolve({ transport: "http", headers: { authorization: "Bearer tok-1" } })).toEqual({ id: "ada", roles: ["finance"] });
    expect(await p.resolve({ transport: "http", headers: { authorization: "Bearer nope" } })).toBeUndefined();
    expect(await p.resolve({ transport: "http", headers: {} })).toBeUndefined();
  });

  it("trusted-header reads the gateway's user and roles", async () => {
    const p = new TrustedHeaderIdentityProvider();
    expect(await p.resolve({ transport: "http", headers: { "x-forwarded-user": "bo", "x-forwarded-roles": "support, operator" } })).toEqual({ id: "bo", roles: ["support", "operator"] });
    expect(await p.resolve({ transport: "http", headers: {} })).toBeUndefined();
  });
});

describe("policy with principals", () => {
  const r = new ToolRegistry();
  const [refund] = r.setServerTools("crm", [{ name: "refund", inputSchema: {} }]);
  const policy = new Policy({ rules: { "crm.refund": { principals: { ada: "allow" }, roles: { finance: "approve" }, default: "deny" } } });

  it("checks principal id, then roles, then the rule default", () => {
    expect(policy.decide(refund!, { id: "ada" })).toBe("allow");
    expect(policy.decide(refund!, { id: "cy", roles: ["finance"] })).toBe("approve");
    expect(policy.decide(refund!, { id: "bo", roles: ["support"] })).toBe("deny");
    expect(policy.decide(refund!)).toBe("deny");
  });

  it("a subject-only rule without a default falls through to later rules", () => {
    const p = new Policy({ rules: { "crm.*": { roles: { finance: "allow" } }, "*": "deny" } });
    expect(p.decide(refund!, { id: "x", roles: ["finance"] })).toBe("allow");
    expect(p.decide(refund!, { id: "x", roles: ["support"] })).toBe("deny");
  });
});

describe("approval gate with principals", () => {
  it("only the owner or an operator may decide", async () => {
    const gate = new ApprovalGate(5_000);
    const r = new ToolRegistry();
    const [tool] = r.setServerTools("s", [{ name: "x", inputSchema: {} }]);
    const decision = gate.request({ executionId: "e1", seq: 1, tool: tool!, args: {}, principal: { id: "ada" } });
    expect(gate.list()[0]?.principal).toBe("ada");
    expect(gate.decide("e1", 1, true, { id: "bo" })).toBe("forbidden");
    expect(gate.decide("e1", 9, true, { id: "ada" })).toBe("not_found");
    expect(gate.decide("e1", 1, true, { id: "root", roles: ["operator"] })).toBe("decided");
    expect(await decision).toBe(true);
  });
});

describe("audit sinks", () => {
  it("CallbackSink delivers in order and survives a throwing callback", async () => {
    const seen: string[] = [];
    const sink = new CallbackSink((e) => {
      if (e.type === "pin_drift" && e.tool === "boom") throw new Error("collector down");
      seen.push(e.type);
    });
    sink.write({ ...drift, tool: "boom" });
    sink.write(drift);
    await sink.flush();
    expect(seen).toEqual(["pin_drift"]);
  });

  it("MultiSink fans out to every sink", async () => {
    const a = new MemorySink();
    const b = new MemorySink();
    const m = new MultiSink([a, b]);
    m.write(drift);
    await m.flush();
    expect(a.events).toHaveLength(1);
    expect(b.events).toHaveLength(1);
  });

  it("HttpSink posts batched JSON arrays and retries a failed batch on the next flush", async () => {
    const received: AuditEvent[][] = [];
    let failNext = true;
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (failNext) {
          failNext = false;
          res.writeHead(503).end();
          return;
        }
        received.push(JSON.parse(body) as AuditEvent[]);
        res.writeHead(204).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    const sink = new HttpSink({ url: `http://127.0.0.1:${port}/events`, batchMs: 10 });
    sink.write(drift);
    sink.write({ ...drift, tool: "second" });
    await sink.flush();
    expect(received).toEqual([]);
    sink.write({ ...drift, tool: "third" });
    await sink.flush();
    expect(received).toHaveLength(1);
    expect(received[0]!.map((e) => (e as { tool: string }).tool)).toEqual(["a.b", "second", "third"]);
    server.close();
  });
});
