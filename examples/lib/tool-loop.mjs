// One tool loop for the Anthropic Messages and OpenAI Responses APIs, with the provider differences
// in a small table. The agent scripts and the benchmark share it; the browser chat has its own copy
// because it also keeps conversation state across questions.

export const PROVIDERS = {
  anthropic: {
    keyVar: "ANTHROPIC_API_KEY",
    baseUrlVar: "ANTHROPIC_BASE_URL",
    baseUrl: "https://api.anthropic.com",
    toolShape: (t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }),
  },
  openai: {
    keyVar: "OPENAI_API_KEY",
    baseUrlVar: "OPENAI_BASE_URL",
    baseUrl: "https://api.openai.com",
    toolShape: (t) => ({ type: "function", name: t.name, description: t.description, parameters: t.inputSchema }),
  },
};

/** Which provider serves a model id: `claude-*` is Anthropic, everything else OpenAI. */
export function providerFor(model) {
  return /^claude/i.test(model) ? "anthropic" : "openai";
}

/** Token counts from one provider reply, in a provider-neutral shape. */
function usageOf(reply) {
  const u = reply.usage ?? {};
  return { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0 };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** POST with retries on rate limits and server errors; anything else is thrown with the body. */
async function post(url, headers, body, { retries, timeoutMs }) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      if (attempt >= retries) throw err;
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (res.ok) return res.json();
    const text = await res.text();
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      const after = Number(res.headers.get("retry-after"));
      await sleep(after > 0 ? after * 1000 : 2000 * 2 ** attempt);
      continue;
    }
    throw new Error(`${res.status} ${text.slice(0, 500)}`);
  }
}

/**
 * Runs a question to completion. `tools` are MCP-shaped (`name`, `description`, `inputSchema`) and
 * `callTool(name, args)` returns the text result. Returns the final text and the provider's own
 * usage figures: total input and output tokens, the first request's input tokens (where the tool
 * definitions are paid for), and the number of model and tool calls.
 */
export async function runToolLoop({ provider, apiKey, baseUrl, model, system, tools, question, callTool, maxRounds = 12, retries = 2, timeoutMs = 180_000, onCall, onResult }) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`Unknown provider "${provider}"`);
  // Like the official SDKs, the base URL is the origin; ANTHROPIC_BASE_URL and OPENAI_BASE_URL
  // are usually set without /v1, and a value that already ends in /v1 is accepted too.
  const base = (baseUrl ?? process.env[p.baseUrlVar] ?? p.baseUrl).replace(/\/+$/, "").replace(/\/v1$/, "");
  const shaped = tools.map(p.toolShape);
  const usage = { input: 0, output: 0, firstInput: 0, modelCalls: 0 };
  const calls = [];
  const texts = [];
  const account = (reply) => {
    const u = usageOf(reply);
    usage.input += u.input;
    usage.output += u.output;
    usage.modelCalls++;
    if (usage.modelCalls === 1) usage.firstInput = u.input;
  };
  const handle = async (name, args) => {
    onCall?.(name, args);
    const started = performance.now();
    const text = await callTool(name, args);
    calls.push({ name, ms: Math.round(performance.now() - started) });
    onResult?.(name, text);
    return text;
  };
  let stopped = "end";

  if (provider === "anthropic") {
    const messages = [{ role: "user", content: question }];
    for (let round = 0; ; round++) {
      if (round >= maxRounds) {
        stopped = "max_rounds";
        break;
      }
      const reply = await post(
        `${base}/v1/messages`,
        { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        { model, max_tokens: 8192, system, tools: shaped, messages },
        { retries, timeoutMs },
      );
      account(reply);
      messages.push({ role: "assistant", content: reply.content });
      for (const b of reply.content) if (b.type === "text" && b.text.trim()) texts.push(b.text);
      const uses = reply.content.filter((b) => b.type === "tool_use");
      if (reply.stop_reason !== "tool_use" || uses.length === 0) {
        if (reply.stop_reason === "max_tokens") stopped = "max_tokens";
        // The API can decline a request outright (stop_reason "refusal", with the category in
        // stop_details); the reply then has no content, which is not the same as an empty answer.
        if (reply.stop_reason === "refusal") stopped = `refusal:${reply.stop_details?.category ?? "unknown"}`;
        break;
      }
      const results = [];
      for (const u of uses) results.push({ type: "tool_result", tool_use_id: u.id, content: await handle(u.name, u.input) });
      messages.push({ role: "user", content: results });
    }
  } else {
    let input = [{ role: "user", content: question }];
    let previous;
    for (let round = 0; ; round++) {
      if (round >= maxRounds) {
        stopped = "max_rounds";
        break;
      }
      const reply = await post(
        `${base}/v1/responses`,
        { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        { model, instructions: system, tools: shaped, input, ...(previous ? { previous_response_id: previous } : {}) },
        { retries, timeoutMs },
      );
      account(reply);
      previous = reply.id;
      // The REST shape has no output_text field; the text lives in message items.
      const text = (reply.output ?? [])
        .filter((o) => o.type === "message")
        .flatMap((o) => o.content ?? [])
        .filter((c) => c.type === "output_text")
        .map((c) => c.text)
        .join("");
      if (text.trim()) texts.push(text);
      else if (typeof reply.output_text === "string" && reply.output_text.trim()) texts.push(reply.output_text);
      const fcalls = (reply.output ?? []).filter((o) => o.type === "function_call");
      if (fcalls.length === 0) {
        if (reply.status === "incomplete") stopped = "incomplete";
        break;
      }
      input = [];
      for (const c of fcalls) {
        let args;
        let output;
        try {
          args = JSON.parse(c.arguments || "{}");
        } catch {
          output = "Error: the arguments were not valid JSON.";
        }
        if (output === undefined) output = await handle(c.name, args);
        input.push({ type: "function_call_output", call_id: c.call_id, output });
      }
    }
  }
  return { answer: texts.at(-1) ?? "", texts, usage, calls, toolCalls: calls.length, stopped };
}
