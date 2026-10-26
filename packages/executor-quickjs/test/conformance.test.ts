import { describe, it } from "vitest";
import { ConformanceSuite } from "codemcp-conformance";
import { QuickJsExecutor } from "../dist/index.js";

const executor = new QuickJsExecutor();
const suite = new ConformanceSuite();

describe("QuickJsExecutor conformance", () => {
  for (const c of suite.cases) {
    it(`${c.category}: ${c.name}`, { timeout: 20_000 }, async () => {
      await suite.run(executor, c);
    });
  }
});
