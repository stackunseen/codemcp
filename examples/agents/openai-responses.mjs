// Tool loop against the OpenAI Responses API, with codemcp as the only tool provider.
// Usage: OPENAI_API_KEY=... node agents/openai-responses.mjs "your question"
import { bootstrap } from "../lib/agent-setup.mjs";

const { apiKey, model, question, tools: mcpTools, callProxy, close } = await bootstrap({ keyVar: "OPENAI_API_KEY", modelVar: "OPENAI_MODEL", defaultModel: "gpt-5.6" });

/** MCP tool definitions become Responses function tools one-to-one. */
const tools = mcpTools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.inputSchema }));

async function respond(input, previousResponseId) {
  const res = await fetch(`${process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1"}/responses`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      instructions:
        "You have three tools from an MCP proxy: search, describe and execute. Prefer one execute call that loops over data to many calls. " +
        "If execute returns a Paused message, ask the user whether to approve, and only then call approve.",
      tools,
      input,
      ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
    }),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

try {
  let response = await respond([{ role: "user", content: question }]);
  for (let turn = 0; turn < 12; turn++) {
    const calls = response.output.filter((o) => o.type === "function_call");
    if (calls.length === 0) break;
    const outputs = [];
    for (const c of calls) {
      const args = JSON.parse(c.arguments || "{}");
      console.log(`\n> ${c.name}(${JSON.stringify(args).slice(0, 200)})`);
      const text = await callProxy(c.name, args);
      console.log(text.slice(0, 600));
      outputs.push({ type: "function_call_output", call_id: c.call_id, output: text });
    }
    response = await respond(outputs, response.id);
  }
  console.log(`\n${response.output_text ?? "(no final text)"}`);
} finally {
  await close();
}
