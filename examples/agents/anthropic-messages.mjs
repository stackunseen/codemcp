// Tool loop against the Anthropic Messages API, with codemcp as the only tool provider.
// Usage: ANTHROPIC_API_KEY=... node agents/anthropic-messages.mjs "your question"
import { bootstrap } from "../lib/agent-setup.mjs";

const { apiKey, model, question, tools: mcpTools, callProxy, close } = await bootstrap({ keyVar: "ANTHROPIC_API_KEY", modelVar: "ANTHROPIC_MODEL", defaultModel: "claude-sonnet-5-5" });

/** MCP tool definitions become Messages API tools one-to-one. */
const tools = mcpTools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));

async function send(messages) {
  const res = await fetch(`${process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com/v1"}/messages`, {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model,
      max_tokens: 8192,
      system:
        "You have three tools from an MCP proxy: search, describe and execute. Prefer one execute call that loops over data to many calls. " +
        "If execute returns a Paused message, ask the user whether to approve, and only then call approve.",
      tools,
      messages,
    }),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

try {
  const messages = [{ role: "user", content: question }];
  for (let turn = 0; turn < 12; turn++) {
    const reply = await send(messages);
    messages.push({ role: "assistant", content: reply.content });
    const uses = reply.content.filter((b) => b.type === "tool_use");
    if (reply.stop_reason !== "tool_use" || uses.length === 0) {
      console.log(`\n${reply.content.filter((b) => b.type === "text").map((b) => b.text).join("\n")}`);
      break;
    }
    const results = [];
    for (const u of uses) {
      console.log(`\n> ${u.name}(${JSON.stringify(u.input).slice(0, 200)})`);
      const text = await callProxy(u.name, u.input);
      console.log(text.slice(0, 600));
      results.push({ type: "tool_result", tool_use_id: u.id, content: text });
    }
    messages.push({ role: "user", content: results });
  }
} finally {
  await close();
}
