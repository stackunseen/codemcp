import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JsonlFileSink, PinStore, StubGenerator, ToolRegistry, truncateSerialized } from "../src/index.js";

describe("JsonlFileSink", () => {
  it("flush resolves after a normal append and the file holds one JSON line per event", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codemcp-audit-"));
    const sink = new JsonlFileSink(join(dir, "nested", "audit.jsonl"));
    sink.write({ type: "pin_drift", ts: "t1", tool: "a.b", previousHash: "x", currentHash: "y" });
    sink.write({ type: "pin_drift", ts: "t2", tool: "a.c", previousHash: "x", currentHash: "y" });
    await sink.flush();
    const lines = (await readFile(join(dir, "nested", "audit.jsonl"), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!)).toMatchObject({ tool: "a.c" });
  });
});

describe("PinStore file round trip", () => {
  it("saves and reloads pins", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codemcp-pins-"));
    const file = join(dir, "pins.json");
    const r = new ToolRegistry();
    const [tool] = r.setServerTools("s", [{ name: "x", inputSchema: {} }]);
    const a = new PinStore(file);
    a.approve(tool!);
    await a.save();
    const b = new PinStore(file);
    await b.load();
    expect(b.check(tool!).status).toBe("pinned");
    const empty = new PinStore(join(dir, "missing.json"));
    await expect(empty.load()).resolves.toBeUndefined();
  });
});

describe("truncateSerialized", () => {
  it("returns the input untouched under the limit and a quoted notice over it", () => {
    const small = truncateSerialized('{"a":1}', 100);
    expect(small).toEqual({ json: '{"a":1}', bytes: 7, truncated: false });
    const big = truncateSerialized(JSON.stringify("é".repeat(1000)), 400);
    expect(big.truncated).toBe(true);
    expect(big.bytes).toBeLessThanOrEqual(400 + 50);
    const parsed = JSON.parse(big.json) as string;
    expect(parsed).toMatch(/\[truncated: result was 2002 bytes, limit 400/);
  });
});

describe("generateStubs escapes comment terminators", () => {
  it("cannot be broken out of by a hostile description", () => {
    const r = new ToolRegistry();
    r.setServerTools("s", [{ name: "x", description: "ok */ declare const evil = 1; /**", inputSchema: {} }]);
    const full = new StubGenerator().generate(r.list(), "full");
    expect(full).not.toContain("*/ declare");
    expect(full).toContain("* /");
    expect(new StubGenerator().generate(r.list(), "names")).not.toContain("*/");
  });
});
