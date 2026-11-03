import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { Proxy } from "../src/server.js";

const fixture = fileURLToPath(new URL("./fixtures/echo-server.mjs", import.meta.url));
let proxy: Proxy;
const open: Array<{ close(): Promise<void> }> = [];

type Answer = "allow" | "deny" | "none";

/** A client on the given era. `answer` is what its human says to an approval form; "none" means it cannot show one. */
async function connect(era: "legacy" | "2026-07-28", answer: Answer): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  open.push(serveStdio(() => proxy.createServer(), { transport: serverSide }));
  const client = new Client(
    { name: `test-${era}`, version: "0" },
    {
      capabilities: answer === "none" ? {} : { elicitation: {} },
      versionNegotiation: { mode: era === "legacy" ? "legacy" : { pin: era } },
    },
  );
  if (answer !== "none") {
    client.setRequestHandler("elicitation/create", async () => ({ action: "accept", content: { decision: answer } }));
  }
  await client.connect(clientSide);
  expect(client.getProtocolEra()).toBe(era === "legacy" ? "legacy" : "modern");
  open.push(client);
  return client;
}

async function execute(client: Client, code: string): Promise<string> {
  const res = await client.callTool({ name: "execute", arguments: { code } });
  return (res.content as Array<{ text?: string }>).map((c) => c.text ?? "").join("\n");
}

const DELETE = "try { return 'after: ' + await tools.shop.delete_item({ id: 1 }); } catch (e) { return 'kept: ' + e.code + '/' + e.reason; }";

beforeAll(async () => {
  proxy = new Proxy({
    config: {
      servers: {
        shop: { command: process.execPath, args: [fixture], protocol: "auto" },
        shop25: { command: process.execPath, args: [fixture] },
      },
      audit: { file: false },
      pins: { file: false },
      approvals: { timeoutMs: 5_000 },
    },
    log: () => undefined,
  });
  await proxy.start();
}, 30_000);

afterAll(async () => {
  for (const o of open.reverse()) await o.close().catch(() => undefined);
  await proxy.close();
});

describe("protocol eras", () => {
  it("negotiates 2026-07-28 with an upstream set to auto and keeps 2025 for one left at the stdio default", () => {
    const status = Object.fromEntries(proxy.serverStatus().map((s) => [s.name, s]));
    expect(status.shop).toMatchObject({ state: "connected", era: "modern" });
    expect(status.shop25).toMatchObject({ state: "connected", era: "legacy" });
  });

  it("calls tools on both upstream eras from one script", async () => {
    const client = await connect("legacy", "none");
    const out = await execute(client, "const a = await tools.shop.get_item({ id: 2 }); const b = await tools.shop25.get_item({ id: 2 }); return [a.name, b.name];");
    expect(out).toContain('"item-2"');
    expect(out).toContain("2 tool calls");
  });

  for (const era of ["2026-07-28", "legacy"] as const) {
    it(`asks a ${era} client through elicitation and continues the run with its answer`, async () => {
      const allowing = await connect(era, "allow");
      expect((await allowing.listTools()).tools.map((t) => t.name)).not.toContain("approve");
      expect(await execute(allowing, DELETE)).toContain("after: deleted");

      const denying = await connect(era, "deny");
      expect(await execute(denying, DELETE)).toContain("kept: approval_required/denied");
    });
  }

  it("asks once per gated call when a script needs several approvals", async () => {
    const client = await connect("2026-07-28", "allow");
    const out = await execute(client, "const r = []; for (const id of [3, 4, 5]) r.push(await tools.shop.delete_item({ id })); return r;");
    expect(out).toContain('"deleted"');
    expect(out).toContain("3 tool calls");
  });

  it("pauses for the approve tool when a 2026-07-28 client cannot show a form", async () => {
    const client = await connect("2026-07-28", "none");
    expect((await client.listTools()).tools.map((t) => t.name)).toContain("approve");
    const paused = await execute(client, DELETE);
    const m = /execution (\S+) is waiting for approval of call #(\d+)/.exec(paused);
    expect(m, paused).not.toBeNull();
    const res = await client.callTool({ name: "approve", arguments: { executionId: m![1], seq: Number(m![2]), allow: true } });
    expect((res.content as Array<{ text?: string }>)[0]?.text).toContain("after: deleted");
  });

  it("refuses approval state that was not minted by this proxy", async () => {
    const client = await connect("2026-07-28", "allow");
    const res = await client
      .request({ method: "tools/call", params: { name: "execute", arguments: { code: "return 1" }, requestState: "v1.forged.state" } as never })
      .then(
        () => "accepted",
        (e: Error) => e.message,
      );
    expect(res).toMatch(/Invalid or expired requestState/);
  });
});
