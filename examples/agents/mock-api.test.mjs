// Drives both agent loops against a local stand-in for each API, so the request and response shapes
// are checked without a key. The mock plays a model that first asks to run a script, then answers.
// Run: node --test examples/agents/mock-api.test.mjs
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const SCRIPT = "const items = await tools.catalog.list_items({ category: 'garden' }); return items.length;";

function readJson(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => resolve(JSON.parse(body)));
  });
}

/** Starts an HTTP server whose handler receives the parsed request body and returns the JSON reply. */
async function mock(handler) {
  const seen = [];
  const server = createServer(async (req, res) => {
    const body = await readJson(req);
    seen.push({ url: req.url, headers: req.headers, body });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(handler(body, seen.length)));
  });
  await new Promise((r) => server.listen(0, r));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => server.close() };
}

function run(script, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL(script, import.meta.url)), "how many garden items?"], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

test("openai-responses loop: function tool -> execute -> final answer", async () => {
  const api = await mock((body, n) => {
    if (n === 1) {
      assert.equal(body.input[0].content, "how many garden items?");
      assert.ok(body.tools.some((t) => t.type === "function" && t.name === "execute"), "execute advertised as a function tool");
      return { id: "resp_1", output: [{ type: "function_call", call_id: "call_1", name: "execute", arguments: JSON.stringify({ code: SCRIPT }) }] };
    }
    assert.equal(body.previous_response_id, "resp_1");
    const out = body.input[0];
    assert.equal(out.type, "function_call_output");
    assert.equal(out.call_id, "call_1");
    assert.match(out.output, /^10\n/, "the proxy's execute result came back to the model");
    return { id: "resp_2", output: [{ type: "message", content: [{ type: "output_text", text: "There are 10." }] }], output_text: "There are 10." };
  });
  try {
    const r = await run("./openai-responses.mjs", { OPENAI_API_KEY: "test-key", OPENAI_BASE_URL: api.url });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /There are 10\./);
    assert.equal(api.seen[0].headers.authorization, "Bearer test-key");
  } finally {
    api.close();
  }
});

test("anthropic-messages loop: tool_use -> execute -> end_turn", async () => {
  const api = await mock((body, n) => {
    if (n === 1) {
      assert.equal(body.messages[0].content, "how many garden items?");
      assert.ok(body.tools.some((t) => t.name === "execute" && t.input_schema), "execute advertised with input_schema");
      return { role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id: "tu_1", name: "execute", input: { code: SCRIPT } }] };
    }
    const result = body.messages.at(-1).content[0];
    assert.equal(result.type, "tool_result");
    assert.equal(result.tool_use_id, "tu_1");
    assert.match(result.content, /^10\n/, "the proxy's execute result came back to the model");
    return { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "There are 10." }] };
  });
  try {
    const r = await run("./anthropic-messages.mjs", { ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: api.url });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /There are 10\./);
    assert.equal(api.seen[0].headers["x-api-key"], "test-key");
    assert.equal(api.seen[0].headers["anthropic-version"], "2023-06-01");
  } finally {
    api.close();
  }
});
