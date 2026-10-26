# codemcp-conformance

The suite every executor must pass: semantics (return values, logs, errors), bridge behavior (calls, concurrency, fatal errors), isolation (no host globals, no prototype escape) and limits (deadline, memory, stack, dangling awaits).

```ts
import { ConformanceSuite } from "codemcp-conformance";

const suite = new ConformanceSuite();
for (const c of suite.cases) {
  it(`${c.category}: ${c.name}`, () => suite.run(myExecutor, c));
}
```
