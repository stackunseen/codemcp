const $ = (id) => document.getElementById(id);

const SAMPLES = {
  "fan-out over a category": `const items = await tools.catalog.list_items({ category: "garden" });
const details = await Promise.all(items.slice(0, 5).map((i) => tools.catalog.get_item({ id: i.id })));
console.log("fetched", details.length, "of", items.length);
return { count: items.length, value: details.reduce((s, d) => s + d.price * d.stock, 0) };`,
  "aggregate without sending rows to the model": `const all = await tools.catalog.list_items({});
const byCategory = {};
for (const i of all) byCategory[i.category] = (byCategory[i.category] ?? 0) + i.stock;
return byCategory;`,
  "join two servers": `const [customers, orders] = await Promise.all([tools.crm.list_customers({ region: "north" }), tools.crm.list_orders({ status: "open" })]);
const ids = new Set(customers.map((c) => c.id));
const mine = orders.filter((o) => ids.has(o.customerId));
const items = await Promise.all([...new Set(mine.map((o) => o.itemId))].map((id) => tools.catalog.get_item({ id })));
const price = Object.fromEntries(items.map((i) => [i.id, i.price]));
return { openOrders: mine.length, exposure: mine.reduce((s, o) => s + o.quantity * price[o.itemId], 0) };`,
  "write a note": `return await tools.catalog.add_note({ text: "reviewed stock at " + new Date().toISOString() });`,
  "denied by policy rule": `await tools.crm.refund_order({ id: 100 });
return "unreachable";`,
  "destructive tool waits for a human": `const r = await tools.catalog.delete_item({ id: 1 });
return "after approval: " + r;`,
  "recover from a bad argument": `try {
  await tools.catalog.get_item({ id: "one" });
} catch (e) {
  return { code: e.code, message: e.message };
}`,
  "what the sandbox contains": `return { process: typeof process, fetch: typeof fetch, require: typeof require, Date: typeof Date };`,
  "exceed the call budget": `for (let i = 0; i < 100; i++) await tools.catalog.get_item({ id: 2 });
return "done";`,
};

async function api(method, path, body) {
  const res = await fetch(path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
}

async function loadTools() {
  const { advertisedTools, registry, servers } = await api("GET", "/api/tools");
  $("advertised").textContent = advertisedTools.map((t) => `\`${t.name}\``).join(", ");
  $("servers").innerHTML = servers.map((s) => `<span class="tag ${s.state === "connected" ? "ro" : "destructive"}">${s.name}: ${s.state.replace("_", " ")}${s.state === "connected" ? ` (${s.tools})` : ""}</span>`).join(" ");
  const list = $("registry");
  list.innerHTML = "";
  for (const t of registry) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="name">${t.qualifiedName}</span>` +
      (t.readOnly ? `<span class="tag ro">read-only</span>` : "") +
      (t.destructive ? `<span class="tag destructive">destructive</span>` : "") +
      `<span class="tag">${t.pin}</span>` +
      `<div class="hint">${t.description}</div>`;
    li.onclick = () => describe({ tools: [t.qualifiedName], detail: "full" });
    li.dataset.server = t.qualifiedName.split(".")[0];
    list.appendChild(li);
  }
}

async function describe(args) {
  const { text } = await api("POST", "/api/describe", args);
  $("stubs").textContent = text;
}

async function search(query) {
  const { text } = await api("POST", "/api/search", { query });
  $("stubs").textContent = text;
}

async function run() {
  $("status").textContent = "running";
  $("run").disabled = true;
  const started = performance.now();
  try {
    const { text, isError } = await api("POST", "/api/execute", { code: $("code").value });
    showOutput(text, isError, started);
  } catch (err) {
    $("output").textContent = err.message;
    $("status").textContent = "failed";
  } finally {
    $("run").disabled = false;
    await Promise.all([loadAudit(), loadApprovals()]);
  }
}

function showOutput(text, isError, started) {
  $("output").textContent = text;
  const paused = text.startsWith("Paused:");
  $("status").textContent = paused ? "paused, waiting for approval below" : `${isError ? "error" : "ok"} in ${Math.round(performance.now() - started)} ms`;
}

async function loadApprovals() {
  const pending = await api("GET", "/api/approvals");
  const list = $("approvals");
  list.innerHTML = pending.length ? "" : '<li class="hint">nothing waiting</li>';
  for (const p of pending) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="call">#${p.seq} ${p.tool}(${JSON.stringify(p.args)})</span><span class="hint">expires ${new Date(p.expiresAt).toLocaleTimeString()}</span>`;
    for (const allow of [true, false]) {
      const b = document.createElement("button");
      b.className = allow ? "allow" : "deny";
      b.textContent = allow ? "Allow" : "Deny";
      b.onclick = () => decide(p, allow);
      li.appendChild(b);
    }
    list.appendChild(li);
  }
}

async function decide(p, allow) {
  $("status").textContent = allow ? "allowed, resuming" : "denied, resuming";
  const started = performance.now();
  await loadApprovals();
  try {
    const { text } = await api("POST", "/api/approvals", { executionId: p.executionId, seq: p.seq, allow });
    showOutput(text, text.startsWith("Error"), started);
  } catch (err) {
    $("output").textContent = err.message;
  } finally {
    await Promise.all([loadAudit(), loadApprovals()]);
  }
}

async function loadAudit() {
  const events = await api("GET", "/api/audit");
  const rows = events
    .filter((e) => e.type === "call" || e.type === "execution_end" || e.type === "pin_drift")
    .slice(-60)
    .reverse()
    .map((e) => {
      const time = new Date(e.ts).toLocaleTimeString();
      if (e.type === "call") {
        return `<tr><td>${time}</td><td>call</td><td>${e.tool}</td><td>${e.decision}</td><td class="${e.ok ? "ok" : "bad"}">${e.ok ? `${e.resultBytes ?? 0} B${e.truncated ? ", truncated" : ""}` : e.error}</td><td>${e.durationMs}</td></tr>`;
      }
      if (e.type === "execution_end") {
        return `<tr><td>${time}</td><td>execution</td><td>${e.calls} calls</td><td></td><td class="${e.status === "completed" ? "ok" : "bad"}">${e.status}${e.error ? `: ${e.error}` : ""}</td><td>${e.durationMs}</td></tr>`;
      }
      return `<tr><td>${time}</td><td>pin drift</td><td>${e.tool}</td><td></td><td class="bad">definition changed</td><td></td></tr>`;
    });
  $("audit").innerHTML = rows.join("");
}

const describeAll = () => describe({ detail: $("detail").value });
$("describe-form").onsubmit = (ev) => {
  ev.preventDefault();
  const q = $("search-input").value.trim();
  if (q) search(q);
  else describeAll();
};
$("describe-all").onclick = describeAll;
$("run").onclick = run;
$("code").onkeydown = (ev) => {
  if ((ev.ctrlKey || ev.metaKey) && ev.key === "Enter") run();
};

const samples = $("samples");
for (const name of Object.keys(SAMPLES)) samples.add(new Option(name, name));
samples.onchange = () => ($("code").value = SAMPLES[samples.value]);
$("code").value = SAMPLES[samples.value];

await loadTools();
await describe({ detail: "signatures" });
await Promise.all([loadAudit(), loadApprovals()]);
setInterval(loadApprovals, 2000);
