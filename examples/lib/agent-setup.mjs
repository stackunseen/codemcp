// Shared bootstrap for the raw-API agent examples: API key, model, question, proxy and terminal guard.
import { ProxyHarness } from "./harness.mjs";
import { TerminalApproval } from "./terminal-approval.mjs";

export async function bootstrap({ keyVar, modelVar, defaultModel }) {
  const apiKey = process.env[keyVar];
  if (!apiKey) {
    console.error(`Set ${keyVar}`);
    process.exit(1);
  }
  const harness = await new ProxyHarness({ ...(await ProxyHarness.loadConfig()), approvals: { tool: true } }).start();
  const terminal = new TerminalApproval();
  return {
    apiKey,
    model: process.env[modelVar] ?? defaultModel,
    question: process.argv.slice(2).join(" ") || "Which garden items are low on stock, and what would it cost to restock each to 10?",
    tools: await harness.listTools(),
    callProxy: terminal.guard(async (name, args) => (await harness.call(name, args)).text),
    close: async () => {
      terminal.close();
      await harness.close();
    },
  };
}
