// Tool loop against the OpenAI Responses API, with codemcp as the only tool provider.
// Usage: OPENAI_API_KEY=... node agents/openai-responses.mjs "your question"
import { bootstrap } from "../lib/agent-setup.mjs";
import { runToolLoop } from "../lib/tool-loop.mjs";

const { apiKey, model, question, tools, callProxy, close } = await bootstrap({ keyVar: "OPENAI_API_KEY", modelVar: "OPENAI_MODEL", defaultModel: "gpt-5.6" });

try {
  // MCP tool definitions become Responses function tools one-to-one inside runToolLoop.
  const { answer } = await runToolLoop({
    provider: "openai",
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
  console.log(`\n${answer || "(no final text)"}`);
} finally {
  await close();
}
