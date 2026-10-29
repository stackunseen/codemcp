import { describe, expect, it } from "vitest";
import { BridgeCallError, BridgeHost, MemorySink, PinStore, Policy, ToolRegistry } from "../src/index.js";
import type { AuditEvent, Executor, HostFunction, JsonValue } from "../src/index.js";

/**
 * A fake executor that runs the "script" as a list of calls, so the bridge can be tested without
 * a real sandbox. Each line is a valid JS call `ns.tool({json});`; the value returned is the array of results.
 */
const scripted: Executor = {
  name: "scripted",
  async execute(code, fns) {
    const results: JsonValue[] = [];
    const logs: { level: "log"; message: string; t: number }[] = [];
    for (const line of code.split("\n").filter(Boolean)) {
      const m = /^([\w.]+)\((.*)\);?$/.exec(line.trim());
      const key = m?.[1] ?? line;
      const fn: HostFunction | undefined = fns[key];
      if (!fn) {
        results.push(`unknown ${key}`);
        continue;
      }
      try {
        results.push(await fn(JSON.parse(m?.[2] || "{}")));
      } catch (err) {
        const e = err as BridgeCallError;
        if (e instanceof BridgeCallError && e.fatal) return { status: "error", logs, calls: [], error: { code: e.code, message: e.message }, durationMs: 0 };
        results.push(`error: ${e.message}`);
      }
    }
    return { status: "completed", value: results, logs, calls: [], durationMs: 0 };
  },
};

function setup(opts: { policy?: Policy; pins?: PinStore; budget?: ConstructorParameters<typeof BridgeHost>[0]["budget"] } = {}) {
  const registry = new ToolRegistry();
  registry.setServerTools("gh", [
    { name: "list", inputSchema: { type: "object", properties: { n: { type: "integer" } } }, annotations: { readOnlyHint: true } },
    { name: "nuke", inputSchema: { type: "object" }, annotations: { destructiveHint: true } },
    { name: "echo", inputSchema: { type: "object", properties: { s: { type: "string" } }, required: ["s"] } },
  ]);
  const audit = new MemorySink();
  const upstreamCalls: Array<{ tool: string; args: JsonValue }> = [];
  const bridge = new BridgeHost({
    registry,
    executor: scripted,
    audit,
    auditArgs: true,
    policy: opts.policy,
    pins: opts.pins,
    budget: opts.budget,
    callUpstream: async (tool, args, ctx) => {
      upstreamCalls.push({ tool: tool.qualifiedName, args });
      expect(ctx.signal).toBeInstanceOf(AbortSignal);
      if (tool.name === "echo") return { echoed: (args as { s: string }).s };
      if (tool.name === "list") return Array.from({ length: (args as { n?: number }).n ?? 1 }, (_, i) => ({ i, pad: "x".repeat(100) }));
      return "boom";
    },
  });
  return { bridge, audit, upstreamCalls, registry };
}

describe("BridgeHost", () => {
  it("validates arguments and forwards only JSON, keying functions by stub path", async () => {
    const { bridge, upstreamCalls, audit } = setup();
    const r = await bridge.run('gh.echo({"s":"hi"});\ngh.echo({"s":5});');
    expect(r.status).toBe("completed");
    expect(r.value).toEqual([{ echoed: "hi" }, expect.stringContaining("gh.echo: invalid arguments")]);
    expect(upstreamCalls).toEqual([{ tool: "gh.echo", args: { s: "hi" } }]);
    const callEvents = audit.events.filter((e) => e.type === "call");
    expect(callEvents).toHaveLength(2);
    expect(callEvents[1]).toMatchObject({ ok: false, args: { s: 5 } });
    expect(r.calls.map((c) => c.seq)).toEqual([1, 2]);
  });

  it("writes call_start, and the sink has accepted it, before the call is forwarded; refused calls get no call_start", async () => {
    const order: string[] = [];
    const pending: Promise<void>[] = [];
    const registry = new ToolRegistry();
    registry.setServerTools("gh", [{ name: "echo", inputSchema: { type: "object" } }, { name: "nuke", inputSchema: {}, annotations: { destructiveHint: true } }]);
    const audit = new MemorySink();
    const bridge = new BridgeHost({
      registry,
      executor: scripted,
      // A slow sink: proves the host waits for call_start to be accepted, while completion writes are only flushed at the end.
      audit: {
        write: (e) => {
          const p = new Promise<void>((r) => setTimeout(r, 5)).then(() => {
            audit.write(e);
            order.push(`audit:${e.type}`);
          });
          pending.push(p);
          return p;
        },
        flush: async () => {
          await Promise.all(pending);
        },
      },
      callUpstream: async () => {
        order.push("upstream");
        return "ok";
      },
    });
    const r = await bridge.run("gh.nuke({});\ngh.echo({});");
    expect(r.status).toBe("completed");
    expect(order.indexOf("audit:call_start")).toBeGreaterThan(-1);
    expect(order.indexOf("audit:call_start")).toBeLessThan(order.indexOf("upstream"));
    const starts = audit.events.filter((e) => e.type === "call_start");
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ seq: 2, tool: "gh.echo", decision: "allow" });
    expect(audit.events.filter((e) => e.type === "call")).toHaveLength(2);
  });

  it("hands events to the sink in the order they happen, even when the executor calls a tool at once", async () => {
    const { bridge, audit } = setup();
    const r = await bridge.run('gh.echo({"s":"hi"});');
    expect(r.status).toBe("completed");
    expect(audit.events.map((e) => e.type)).toEqual(["execution_start", "call_start", "call", "execution_end"]);
  });

  it("fail-open by default: a sink that refuses call_start does not block the call, and the call event says so", async () => {
    const registry = new ToolRegistry();
    registry.setServerTools("gh", [{ name: "echo", inputSchema: { type: "object" } }]);
    const seen: AuditEvent[] = [];
    let upstream = 0;
    const bridge = new BridgeHost({
      registry,
      executor: scripted,
      audit: {
        write: (e) => {
          seen.push(e);
          if (e.type === "call_start") throw new Error("disk full");
        },
      },
      callUpstream: async () => {
        upstream++;
        return "ok";
      },
    });
    const r = await bridge.run("gh.echo({});");
    expect(r.status).toBe("completed");
    expect(upstream).toBe(1);
    expect(r.calls[0]).toMatchObject({ ok: true, auditError: "disk full" });
    expect(seen.find((e) => e.type === "call")).toMatchObject({ ok: true, auditError: "disk full" });
  });

  it("auditRequired: a sink that refuses call_start fails the call closed with a fatal audit_unavailable", async () => {
    const registry = new ToolRegistry();
    registry.setServerTools("gh", [{ name: "echo", inputSchema: { type: "object" } }]);
    let upstream = 0;
    const bridge = new BridgeHost({
      registry,
      executor: scripted,
      auditRequired: true,
      audit: { write: async (e) => {
        if (e.type === "call_start") throw new Error("collector down");
      } },
      callUpstream: async () => {
        upstream++;
        return "ok";
      },
    });
    const r = await bridge.run("gh.echo({});\ngh.echo({});");
    expect(r.status).toBe("error");
    expect(r.error?.code).toBe("audit_unavailable");
    expect(upstream).toBe(0);
  });

  it("denies destructive tools without an approval handler; the refusal is catchable and later calls still run", async () => {
    const { bridge, upstreamCalls } = setup();
    const r = await bridge.run('gh.nuke({});\ngh.echo({"s":"after"});');
    expect(r.status).toBe("completed");
    expect(r.value).toEqual([expect.stringContaining("requires approval"), { echoed: "after" }]);
    expect(r.calls[0]).toMatchObject({ ok: false, errorCode: "approval_required", decision: "approve" });
    expect(upstreamCalls).toEqual([{ tool: "gh.echo", args: { s: "after" } }]);
  });

  it("aborts the upstream call when the run is cancelled", async () => {
    const registry = new ToolRegistry();
    registry.setServerTools("gh", [{ name: "slow", inputSchema: {} }]);
    const bridge = new BridgeHost({
      registry,
      executor: scripted,
      callUpstream: (_tool, _args, ctx) => new Promise((_, reject) => ctx.signal.addEventListener("abort", () => reject(new Error("aborted by signal")))),
    });
    const r = await bridge.run("gh.slow({});", { signal: AbortSignal.timeout(100) });
    expect(r.value).toEqual([expect.stringContaining("cancelled")]);
  });

  it("aborts an upstream call that exceeds the upstream timeout", async () => {
    const registry = new ToolRegistry();
    registry.setServerTools("gh", [{ name: "slow", inputSchema: {} }]);
    const bridge = new BridgeHost({
      registry,
      executor: scripted,
      upstreamTimeoutMs: 100,
      callUpstream: (_tool, _args, ctx) => new Promise((_, reject) => ctx.signal.addEventListener("abort", () => reject(new Error("aborted")))),
    });
    const r = await bridge.run("gh.slow({});");
    expect(r.value).toEqual([expect.stringContaining("did not answer within 100 ms")]);
  });

  it("allows approved destructive calls when the handler says yes", async () => {
    const registry = new ToolRegistry();
    registry.setServerTools("gh", [{ name: "nuke", inputSchema: {}, annotations: { destructiveHint: true } }]);
    const bridge = new BridgeHost({ registry, executor: scripted, callUpstream: async () => "done", approvals: async () => true });
    const r = await bridge.run("gh.nuke({});");
    expect(r.value).toEqual(["done"]);
    expect(r.calls[0]?.decision).toBe("approve");
  });

  it("blocks tools whose definition drifted since approval", async () => {
    const pins = new PinStore();
    const { bridge, registry } = setup({ pins });
    pins.approveAll(registry.list());
    registry.setServerTools("gh", [{ name: "echo", description: "now evil", inputSchema: { type: "object" } }]);
    const r = await bridge.run('gh.echo({"s":"x"});');
    expect(r.status).toBe("error");
    expect(r.error?.code).toBe("pin_drifted");
    expect(r.error?.message).toMatch(/changed since it was approved/);
  });

  it("enforces call and byte budgets", async () => {
    const { bridge } = setup({ budget: { maxCalls: 2 } });
    const r = await bridge.run('gh.list({"n":1});\ngh.list({"n":1});\ngh.list({"n":1});');
    expect(r.status).toBe("error");
    expect(r.error?.code).toBe("budget_exceeded");

    const { bridge: b2 } = setup({ budget: { maxResultBytes: 300, maxTotalBytes: 100_000 } });
    const r2 = await b2.run('gh.list({"n":50});');
    expect(r2.status).toBe("completed");
    expect(String((r2.value as JsonValue[])[0])).toMatch(/truncated/);

    const { bridge: b3 } = setup({ budget: { maxResultBytes: 10_000, maxTotalBytes: 5_000 } });
    const r3 = await b3.run('gh.list({"n":40});\ngh.list({"n":40});');
    expect(r3.status).toBe("error");
    expect(r3.error?.code).toBe("budget_exceeded");
    expect(r3.error?.message).toMatch(/total result bytes/);
  });

  it("rejects return values over the limit", async () => {
    const { bridge } = setup({ budget: { maxReturnBytes: 50 } });
    const r = await bridge.run('gh.list({"n":5});');
    expect(r.status).toBe("error");
    expect(r.error?.code).toBe("result_too_large");
  });

  it("reports syntax errors without executing", async () => {
    const { bridge, upstreamCalls, audit } = setup();
    const r = await bridge.run("return (");
    expect(r.status).toBe("error");
    expect(r.error?.code).toBe("syntax_error");
    expect(upstreamCalls).toEqual([]);
    expect(audit.events.map((e) => e.type)).toEqual(["execution_start", "execution_end"]);
  });

  it("attaches traceparent to audit events", async () => {
    const { bridge, audit } = setup();
    await bridge.run('gh.echo({"s":"t"});', { traceparent: "00-abc-def-01" });
    expect(audit.events.every((e) => (e as { traceparent?: string }).traceparent === "00-abc-def-01" || e.type === "pin_drift")).toBe(true);
  });
});
