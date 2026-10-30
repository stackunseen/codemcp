import { describe, expect, it } from "vitest";
import { BridgeHost, ToolRegistry } from "codemcp-core";
import { QuickJsExecutor } from "../dist/index.js";

const executor = new QuickJsExecutor();

describe("runtime error locations", () => {
  it("names the script line and column of a thrown error", async () => {
    const r = await executor.execute("const a = 1;\nconst b = 2;\n\nnull.x;\nreturn a + b;", {}, { timeoutMs: 5000 });
    expect(r.status).toBe("error");
    expect(r.error).toMatchObject({ code: "runtime_error", line: 4, column: 5 });
  });

  it("the host maps the line back past a stripped fence and puts it in the message", async () => {
    const bridge = new BridgeHost({ registry: new ToolRegistry(), executor, callUpstream: async () => null });
    const r = await bridge.run("```js\nconst a = 1;\n\nthrow new Error('bad thing');\n```");
    expect(r.status).toBe("error");
    expect(r.error?.line).toBe(4);
    expect(r.error?.message).toMatch(/^Error: bad thing \(line 4, column \d+\)$/);
  });

  it("an error raised inside the prelude reports no line rather than a misleading one", async () => {
    // The bridge rejects inside the prelude and the async continuation has no caller frame to fall back to.
    const r = await executor.execute("const x = 1;\nawait tools.a.b();", {}, { timeoutMs: 5000 });
    expect(r.error?.code).toBe("runtime_error");
    expect(r.error?.line).toBeUndefined();
  });
});
