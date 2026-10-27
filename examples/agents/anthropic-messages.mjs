// Tool loop against the Anthropic Messages API, with codemcp as the only tool provider.
// Usage: ANTHROPIC_API_KEY=... node agents/anthropic-messages.mjs "your question"
import { bootstrap } from "../lib/agent-setup.mjs";
import { runToolLoop } from "../lib/tool-loop.mjs";

const { apiKey, model, question, tools, callProxy, close } = await bootstrap({ keyVar: "ANTHROPIC_API_KEY", modelVar: "ANTHROPIC_MODEL", defaultModel: "claude-sonnet-5-5" });

try {
  // MCP tool definitions become Messages API tools one-to-one inside runToolLoop.
  const { answer } = await runToolLoop({
    provider: "anthropic",
    apiKey,
    model,
    system:
      "You have three tools from an MCP proxy: search, describe and execute. Prefer one execute call that loops over data to many calls. " +
      "If execute returns a Paused message, ask the user whether to approve, and only then call approve.",
    tools,
    question,
    callTool: callProxy,
    onCall: (name, args) => console.log(`\n> ${name}(${JSON.stringify(args).slice(0, 200)})`),
    onResult: (_name, text) => console.log(text.slice(0, 600)),
  });
  console.log(`\n${answer}`);
} finally {
  await close();
}
