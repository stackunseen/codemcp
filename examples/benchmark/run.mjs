// Measures what codemcp saves against real MCP servers: every task in tasks.json runs with the
// proxy's three tools and again with every upstream tool passed to the provider directly, for each
// model and N repeats, and the providers' own usage figures are recorded with a pass/fail check.
//
// Usage: node benchmark/run.mjs [--set no-key] [--repeats 2] [--models claude-sonnet-5-5,gpt-5.6]
//        [--modes codemcp,direct] [--tasks id,id] [--concurrency 2] [--out results] [--no-report]
import { parseArgs } from "node:util";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ProxyHarness } from "../lib/harness.mjs";
import { directCall, directTools, definitionTokens } from "../lib/direct.mjs";
import { PROVIDERS, providerFor, runToolLoop } from "../lib/tool-loop.mjs";
import { BENCHMARK_DIR, DEFAULT_SERVERS_FILE, benchmarkConfig, loadServerSet } from "./servers.mjs";
import { writeReport } from "./report.mjs";

export const DEFAULT_MODELS = ["claude-sonnet-5-5", "claude-haiku-5-5", "gpt-5.6"];

const CODEMCP_SYSTEM =
  "You have tools from an MCP proxy: search, describe and execute. Use search or describe to find the stubs you need, then prefer one execute call that does the work. " +
  "Answer the question directly and concisely, including the specific values asked for, in your final message.";
const DIRECT_SYSTEM =
  "You have tools from several MCP servers. Use them to answer the question. " +
  "Answer the question directly and concisely, including the specific values asked for, in your final message.";

const { values: opts } = parseArgs({
  options: {
    set: { type: "string", default: "no-key" },
    repeats: { type: "string", default: "2" },
    models: { type: "string", default: DEFAULT_MODELS.join(",") },
    modes: { type: "string", default: "codemcp,direct" },
    tasks: { type: "string" },
    concurrency: { type: "string", default: "2" },
    "max-rounds": { type: "string", default: "12" },
    "servers-file": { type: "string", default: DEFAULT_SERVERS_FILE },
    "tasks-file": { type: "string", default: resolve(BENCHMARK_DIR, "tasks.json") },
    out: { type: "string", default: resolve(BENCHMARK_DIR, "results") },
    docs: { type: "string", default: resolve(BENCHMARK_DIR, "../../docs") },
    "no-report": { type: "boolean", default: false },
  },
});

const csv = (s) => String(s).split(",").map((x) => x.trim()).filter(Boolean);
const repeats = Math.max(1, Number(opts.repeats) || 1);
const concurrency = Math.max(1, Number(opts.concurrency) || 1);
const maxRounds = Math.max(1, Number(opts["max-rounds"]) || 12);
const modes = csv(opts.modes);
for (const m of modes) if (!["codemcp", "direct"].includes(m)) fail(`Unknown mode "${m}"`);

/** True when every expectation matches somewhere in the answer. */
function passes(answer, expect) {
  return (expect ?? []).every((re) => new RegExp(re, "is").test(answer ?? ""));
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

/** Runs `jobs` (functions returning promises) with at most `limit` in flight. */
async function pool(jobs, limit) {
  const queue = jobs.slice();
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await queue.shift()();
  });
  await Promise.all(workers);
}

async function runOne({ set, harness, task, model, provider, mode, repeat, tools, callTool }) {
  const started = performance.now();
  const record = { set, task: task.id, model, provider, mode, repeat, pass: false, error: null, inputTokens: 0, outputTokens: 0, firstInputTokens: 0, modelCalls: 0, toolCalls: 0, wallMs: 0, stopped: null, answer: "", calls: [] };
  try {
    const r = await runToolLoop({
      provider,
      apiKey: process.env[PROVIDERS[provider].keyVar],
      model,
      system: mode === "codemcp" ? CODEMCP_SYSTEM : DIRECT_SYSTEM,
      tools,
      question: task.question,
      callTool,
      maxRounds,
    });
    const answer = r.texts.join("\n");
    Object.assign(record, {
      pass: passes(answer, task.expect),
      inputTokens: r.usage.input,
      outputTokens: r.usage.output,
      firstInputTokens: r.usage.firstInput,
      modelCalls: r.usage.modelCalls,
      toolCalls: r.toolCalls,
      stopped: r.stopped,
      answer: answer.slice(0, 2000),
      calls: r.calls.map((c) => c.name),
    });
    // A provider refusal is not a wrong answer; it goes in the errors table and out of the token pairs.
    if (r.stopped?.startsWith("refusal")) record.error = `provider refused the request (${r.stopped.slice("refusal:".length)})`;
  } catch (err) {
    record.error = String(err.message ?? err).slice(0, 500);
  }
  record.wallMs = Math.round(performance.now() - started);
  const mark = record.error ? "error" : record.pass ? "pass" : "FAIL";
  console.error(`[benchmark] ${set} ${task.id} ${model} ${mode} #${repeat}: ${mark} ${record.inputTokens + record.outputTokens} tokens, ${record.modelCalls} model calls, ${record.toolCalls} tool calls, ${(record.wallMs / 1000).toFixed(1)}s${record.error ? ` (${record.error.slice(0, 120)})` : ""}`);
  return record;
}

async function main() {
  const command = `node benchmark/run.mjs ${process.argv.slice(2).join(" ")}`.trim();
  const { tasks: allTasks } = JSON.parse(await readFile(opts["tasks-file"], "utf8"));
  const wanted = opts.tasks ? csv(opts.tasks) : null;
  const tasks = wanted ? allTasks.filter((t) => wanted.includes(t.id)) : allTasks;
  if (tasks.length === 0) fail("No tasks selected");

  const models = [];
  const skippedModels = [];
  for (const id of csv(opts.models)) {
    const provider = providerFor(id);
    if (process.env[PROVIDERS[provider].keyVar]) models.push({ id, provider });
    else skippedModels.push({ id, provider, reason: `${PROVIDERS[provider].keyVar} is not set` });
  }
  for (const m of skippedModels) console.error(`[benchmark] skipping ${m.id}: ${m.reason}`);
  if (models.length === 0) fail("No provider key is set (ANTHROPIC_API_KEY or OPENAI_API_KEY); nothing to run.");

  const results = { version: 1, date: new Date().toISOString(), command, node: process.version, platform: process.platform, repeats, modes, maxRounds, models, skippedModels, sets: [], skippedSets: [], tasks, runs: [] };

  for (const setName of csv(opts.set)) {
    const set = await loadServerSet(setName, { file: opts["servers-file"] });
    if (set.missing.length) {
      console.error(`[benchmark] skipping set "${setName}": ${set.missing.join(", ")} not set`);
      results.skippedSets.push({ name: setName, missing: set.missing });
      continue;
    }
    // The memory server persists to a file; start every run from an empty graph.
    for (const s of Object.values(set.servers)) if (s.env?.MEMORY_FILE_PATH) await rm(s.env.MEMORY_FILE_PATH, { force: true });

    console.error(`[benchmark] starting set "${setName}" (${Object.keys(set.servers).length} servers)`);
    const harness = await new ProxyHarness(benchmarkConfig(set.servers)).start();
    try {
      const flat = directTools(harness.proxy);
      const servers = harness.proxy.serverStatus().map((s) => {
        const mine = flat.filter((t) => t.server === s.name);
        return { name: s.name, state: s.state, tools: mine.length, definitionTokens: mine.reduce((n, t) => n + definitionTokens(t), 0), error: s.error ?? null };
      });
      const proxyTools = (await harness.listTools()).filter((t) => t.name !== "approve");
      results.sets.push({
        name: setName,
        description: set.description,
        servers,
        totalTools: flat.length,
        totalDefinitionTokens: servers.reduce((n, s) => n + s.definitionTokens, 0),
        proxyTools: proxyTools.length,
        proxyDefinitionTokens: proxyTools.reduce((n, t) => n + definitionTokens(t), 0),
      });
      const down = servers.filter((s) => s.state !== "connected").map((s) => s.name);
      const runnable = tasks.filter((t) => !t.servers?.some((s) => down.includes(s)));
      for (const t of tasks) if (!runnable.includes(t)) console.error(`[benchmark] skipping task ${t.id}: needs ${t.servers.filter((s) => down.includes(s)).join(", ")} which did not connect`);

      const toolsFor = { codemcp: proxyTools, direct: flat };
      const callFor = {
        codemcp: async (name, args) => (await harness.call(name, args)).text,
        direct: async (name, args) => (await directCall(harness.proxy, name, args)).text,
      };
      const jobs = [];
      for (const task of runnable) {
        for (const { id: model, provider } of models) {
          for (let repeat = 1; repeat <= repeats; repeat++) {
            // Both modes of one (task, model, repeat) run side by side so they see the same server state and load.
            jobs.push(async () => {
              const records = await Promise.all(modes.map((mode) => runOne({ set: setName, harness, task, model, provider, mode, repeat, tools: toolsFor[mode], callTool: callFor[mode] })));
              results.runs.push(...records);
            });
          }
        }
      }
      await pool(jobs, concurrency);
    } finally {
      await harness.close();
    }
  }

  if (results.sets.length === 0) fail("Every server set was skipped; nothing was measured.");
  const order = ["set", "task", "model", "repeat", "mode"];
  results.runs.sort((a, b) => order.reduce((c, k) => c || String(a[k]).localeCompare(String(b[k]), "en", { numeric: true }), 0));
  await mkdir(opts.out, { recursive: true });
  const stamp = results.date.replace(/[:.]/g, "-");
  const file = resolve(opts.out, `${stamp}.json`);
  const json = `${JSON.stringify(results, null, 2)}\n`;
  await writeFile(file, json);
  await writeFile(resolve(opts.out, "latest.json"), json);
  console.error(`[benchmark] wrote ${file}`);
  if (!opts["no-report"]) {
    const written = await writeReport(results, opts.docs);
    console.error(`[benchmark] wrote ${written.join(", ")}`);
  }
}

await main();
