# codemcp-executor-quickjs

The default sandbox (tier 0). Each execution gets a fresh QuickJS runtime, compiled to WebAssembly, inside a fresh Node worker thread.

Limits are enforced in layers that do not rely on the guest cooperating: QuickJS memory, stack and deadline interrupts; the worker's own V8 heap cap; and a host-side timer that terminates the worker.

The guest sees two string-only host functions. Everything else (`tools.*`, `console`) is built in the guest prelude on top of them.

```ts
import { QuickJsExecutor } from "codemcp-executor-quickjs";

const executor = new QuickJsExecutor({ timeoutMs: 10_000 });
const result = await executor.execute("return await tools.echo.say({ hi: 1 });", {
  "echo.say": async (args) => args,
});
```

Passes every case in `codemcp-conformance`.
