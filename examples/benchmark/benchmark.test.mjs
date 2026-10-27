// Runs the benchmark end to end against a local stand-in for both provider APIs and the two demo
// servers, then checks the results shape, the pass/fail logic and that the report renders.
// Run: node --test examples/benchmark/benchmark.test.mjs
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { CATALOG_SERVER, CRM_SERVER } from "../lib/harness.mjs";

const RUN = fileURLToPath(new URL("./run.mjs", import.meta.url));
const SCRIPT = "const items = await tools.catalog.list_items({ category: 'garden' }); return items.length;";

function readJson(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => resolve(JSON.parse(body)));
  });
}

/** How many garden items a tool result reports: a bare number from execute, or a JSON array from the direct call. */
function countFrom(text) {
  const m = /^(\d+)/.exec(text);
  if (m) return Number(m[1]);
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v.length : NaN;
  } catch {
    return NaN;
  }
}

/**
 * A model that answers "how many garden items" with one tool call (execute when codemcp's tools are
 * offered, the flattened catalog tool otherwise) and any other question with a shrug, so one task
 * passes and one fails. Input tokens scale with the request body, as a provider's would.
 */
async function mockProviders() {
  const seen = [];
  const server = createServer(async (req, res) => {
    const body = await readJson(req);
    seen.push({ url: req.url, body });
    const usage = { input_tokens: Math.ceil(JSON.stringify(body).length / 4), output_tokens: 20 };
    const codemcp = body.tools.some((t) => t.name === "execute");
    const call = codemcp ? { name: "execute", args: { code: SCRIPT } } : { name: "catalog__list-items", args: { category: "garden" } };
    let reply;
    if (req.url.endsWith("/messages")) {
      const first = body.messages.length === 1;
      const question = body.messages[0].content;
      if (first && /garden/.test(question)) reply = { role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id: "tu_1", name: call.name, input: call.args }], usage };
      else if (first) reply = { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "I do not know." }], usage };
      else reply = { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: `There are ${countFrom(body.messages.at(-1).content[0].content)} garden items.` }], usage };
    } else {
      const first = !body.previous_response_id;
      const question = first ? body.input[0].content : "";
      if (first && /garden/.test(question)) reply = { id: "resp_1", output: [{ type: "function_call", call_id: "c1", name: call.name, arguments: JSON.stringify(call.args) }], usage };
      else if (first) reply = { id: "resp_1", output: [{ type: "message", content: [{ type: "output_text", text: "I do not know." }] }], usage };
      else reply = { id: "resp_2", output: [{ type: "message", content: [{ type: "output_text", text: `There are ${countFrom(body.input[0].output)} garden items.` }] }], usage };
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(reply));
  });
  await new Promise((r) => server.listen(0, r));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => server.close() };
}

function run(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [RUN, ...args], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

async function fixtures() {
  const dir = await mkdtemp(join(tmpdir(), "codemcp-benchmark-"));
  const servers = join(dir, "servers.json");
  const tasks = join(dir, "tasks.json");
  await writeFile(
    servers,
    JSON.stringify({
      sets: {
        demo: {
          description: "The two demo servers.",
          servers: {
            catalog: { command: process.execPath, args: [CATALOG_SERVER] },
            crm: { command: process.execPath, args: [CRM_SERVER], env: { CRM_TOKEN: "demo-token" } },
          },
        },
        keyed: { extends: "demo", servers: { secret: { command: process.execPath, args: [CRM_SERVER], env: { CRM_TOKEN: "${CODEMCP_BENCHMARK_TEST_UNSET_VAR}" } } } },
      },
    }),
  );
  await writeFile(
    tasks,
    JSON.stringify({
      tasks: [
        { id: "garden-count", question: "how many garden items are there?", servers: ["catalog"], expect: ["\\b10\\b", "garden"] },
        { id: "unanswerable", question: "what is the answer to everything?", servers: ["catalog", "crm"], expect: ["\\b42\\b"] },
      ],
    }),
  );
  return { dir, servers, tasks, out: join(dir, "results"), docs: join(dir, "docs") };
}

test("benchmark: both providers, both modes, results shape, pass/fail, report", async () => {
  const api = await mockProviders();
  const f = await fixtures();
  try {
    const r = await run(
      ["--set", "demo,keyed", "--repeats", "1", "--models", "claude-test,gpt-test", "--servers-file", f.servers, "--tasks-file", f.tasks, "--out", f.out, "--docs", f.docs, "--concurrency", "2"],
      { ANTHROPIC_API_KEY: "test-key", OPENAI_API_KEY: "test-key", ANTHROPIC_BASE_URL: api.url, OPENAI_BASE_URL: api.url, CODEMCP_BENCHMARK_TEST_UNSET_VAR: undefined },
    );
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /skipping set "keyed": CODEMCP_BENCHMARK_TEST_UNSET_VAR not set/);

    const results = JSON.parse(await readFile(join(f.out, "latest.json"), "utf8"));
    assert.equal(results.version, 1);
    assert.deepEqual(results.models, [
      { id: "claude-test", provider: "anthropic" },
      { id: "gpt-test", provider: "openai" },
    ]);
    assert.deepEqual(results.skippedSets, [{ name: "keyed", missing: ["CODEMCP_BENCHMARK_TEST_UNSET_VAR"] }]);
    assert.equal(results.sets.length, 1);
    const set = results.sets[0];
    assert.equal(set.name, "demo");
    assert.deepEqual(set.servers.map((s) => [s.name, s.state]), [["catalog", "connected"], ["crm", "connected"]]);
    assert.ok(set.totalTools > 5 && set.totalDefinitionTokens > 0 && set.proxyTools === 3 && set.proxyDefinitionTokens > 0, "definition costs are computed for both sides");

    // 2 tasks x 2 models x 2 modes x 1 repeat
    assert.equal(results.runs.length, 8);
    for (const run of results.runs) {
      for (const k of ["set", "task", "model", "provider", "mode", "repeat", "pass", "error", "inputTokens", "outputTokens", "firstInputTokens", "modelCalls", "toolCalls", "wallMs", "stopped", "answer", "calls"]) assert.ok(k in run, `run has ${k}`);
      assert.equal(run.error, null, `${run.task} ${run.model} ${run.mode}: ${run.error}`);
      assert.ok(run.firstInputTokens > 0 && run.inputTokens >= run.firstInputTokens);
      assert.ok(run.wallMs > 0);
    }
    const garden = results.runs.filter((r) => r.task === "garden-count");
    const other = results.runs.filter((r) => r.task === "unanswerable");
    assert.ok(garden.every((r) => r.pass && r.modelCalls === 2 && r.toolCalls === 1), "the answered task passes in both modes for both models");
    assert.ok(other.every((r) => !r.pass && r.modelCalls === 1 && r.toolCalls === 0), "an answer that misses the regex fails");
    assert.deepEqual(garden.filter((r) => r.mode === "codemcp").map((r) => r.calls), [["execute"], ["execute"]]);
    assert.deepEqual(garden.filter((r) => r.mode === "direct").map((r) => r.calls), [["catalog__list-items"], ["catalog__list-items"]]);
    assert.match(garden[0].answer, /There are 10 garden items/);
    // The mock saw the flattened tool list on the direct side and the three-tool surface on the other.
    const directReq = api.seen.find((s) => s.body.tools.some((t) => t.name === "catalog__list-items"));
    assert.ok(directReq && !directReq.body.tools.some((t) => t.name === "execute"));

    const md = await readFile(join(f.docs, "BENCHMARK.md"), "utf8");
    assert.match(md, /^# Benchmark/);
    assert.match(md, /## Server set `demo`/);
    assert.match(md, /\| `claude-test` \| 2 \|/);
    assert.match(md, /\| `gpt-test` \| 2 \|/);
    assert.match(md, /\| 1 \| `(catalog|crm)` \| connected \|/, "servers are ranked");
    assert.match(md, /`garden-count` \| `claude-test` \| [\d,]+ \| [\d,]+ \| -?\d+% \| 1\/1 \| 1\/1 \| 1\.0 \| 1\.0/);
    assert.match(md, /`unanswerable` \| `gpt-test` \| [\d,]+ \| [\d,]+ \| -?\d+% \| 0\/1 \| 0\/1/);
    assert.match(md, /--set demo --repeats 1 --models claude-test,gpt-test/);
    const badge = JSON.parse(await readFile(join(f.docs, "benchmark.json"), "utf8"));
    assert.equal(badge.schemaVersion, 1);
    assert.match(badge.message, /^[-+]\d+%$/);
    assert.ok(["brightgreen", "green", "yellow", "red"].includes(badge.color));
  } finally {
    api.close();
  }
});

test("benchmark: a provider without a key is skipped, and nothing to run is an error", async () => {
  const f = await fixtures();
  const r = await run(["--set", "demo", "--models", "gpt-test", "--servers-file", f.servers, "--tasks-file", f.tasks, "--out", f.out, "--docs", f.docs], { OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined });
  assert.equal(r.code, 1);
  assert.match(r.err, /skipping gpt-test: OPENAI_API_KEY is not set/);
  assert.match(r.err, /No provider key is set/);
});

test("report.mjs renders a results file from the command line", async () => {
  const f = await fixtures();
  const results = {
    version: 1,
    date: "2026-01-01T00:00:00.000Z",
    command: "node benchmark/run.mjs",
    node: "v22",
    platform: "linux",
    repeats: 1,
    modes: ["codemcp", "direct"],
    models: [{ id: "m", provider: "anthropic" }],
    skippedModels: [],
    sets: [{ name: "no-key", description: "", servers: [{ name: "a", state: "connected", tools: 2, definitionTokens: 300, error: null }], totalTools: 2, totalDefinitionTokens: 300, proxyTools: 3, proxyDefinitionTokens: 400 }],
    skippedSets: [],
    tasks: [{ id: "t", question: "q", servers: ["a"], expect: ["x"] }],
    runs: [
      { set: "no-key", task: "t", model: "m", provider: "anthropic", mode: "codemcp", repeat: 1, pass: true, error: null, inputTokens: 1000, outputTokens: 100, firstInputTokens: 500, modelCalls: 2, toolCalls: 1, wallMs: 1000, stopped: "end", answer: "x", calls: ["execute"] },
      { set: "no-key", task: "t", model: "m", provider: "anthropic", mode: "direct", repeat: 1, pass: true, error: null, inputTokens: 4000, outputTokens: 400, firstInputTokens: 2000, modelCalls: 2, toolCalls: 1, wallMs: 2000, stopped: "end", answer: "x", calls: ["a__b"] },
    ],
  };
  const file = join(f.dir, "r.json");
  await writeFile(file, JSON.stringify(results));
  const report = fileURLToPath(new URL("./report.mjs", import.meta.url));
  const r = await new Promise((done) => {
    const child = spawn(process.execPath, [report, file, "--docs", f.docs], { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (c) => (err += c));
    child.on("close", (code) => done({ code, err }));
  });
  assert.equal(r.code, 0, r.err);
  const md = await readFile(resolve(f.docs, "BENCHMARK.md"), "utf8");
  assert.match(md, /\| `m` \| 1 \| 1,100 \| 4,400 \| 75% \| 75% \| 1\/1 \| 1\/1 \| 1\.0s \| 2\.0s \|/);
  const badge = JSON.parse(await readFile(resolve(f.docs, "benchmark.json"), "utf8"));
  assert.deepEqual(badge, { schemaVersion: 1, label: "tokens vs direct MCP", message: "-75%", color: "brightgreen" });
});
