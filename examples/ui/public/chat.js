// The model loop runs here, in the browser, so your API key never touches the local server.
// Tool calls go to the proxy through /api/call; everything else goes straight to the provider.
const $ = (id) => document.getElementById(id);

const SYSTEM =
  "You have tools from an MCP proxy: search, describe and execute. Prefer one execute call that loops over data to many calls. " +
  "When execute reports that a call needs approval, the person using this chat decides in the UI; you receive the final result once they do. Answer in markdown.";

// "Without codemcp": the same question with every upstream tool passed to the provider directly.
const DIRECT_SYSTEM = "You have tools from several MCP servers. Use them to answer the question. Answer in markdown.";

const MODES = {
  codemcp: { label: "with codemcp", tools: "/api/tools", call: "/api/call", system: SYSTEM },
  direct: { label: "without codemcp (every tool passed directly)", tools: "/api/direct/tools", call: "/api/direct/call", system: DIRECT_SYSTEM },
};

const MAX_ROUNDS = 12;

// For testing without a key: ?base=http://127.0.0.1:PORT sends provider requests to a stand-in API.
const BASE_OVERRIDE = new URLSearchParams(location.search).get("base");
const providerUrl = (origin, path) => `${BASE_OVERRIDE ?? origin}${path}`;

/** Token counts from one provider reply, in a provider-neutral shape. */
function usageOf(reply) {
  const u = reply.usage ?? {};
  return { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0 };
}

/** Turn a failed provider response into something a person can act on. */
async function providerError(res, who) {
  const raw = await res.text();
  let detail = raw;
  try {
    detail = JSON.parse(raw).error?.message ?? raw;
  } catch {
    /* not JSON */
  }
  if (res.status === 401 || res.status === 403) return new Error(`${who} rejected the API key (${res.status}). Check the key in the sidebar.`);
  if (res.status === 429) return new Error(`${who} is rate limiting this key (429). Wait a moment and regenerate.`);
  return new Error(`${who} ${res.status}: ${detail.slice(0, 400)}`);
}

/**
 * Each provider keeps its own conversation state between questions, so a follow-up question
 * can refer to the previous answer. `snapshot()`/`restore()` rewind one turn after a failure
 * or for Regenerate, so a half-finished tool round never poisons the next request.
 */
const PROVIDERS = {
  anthropic: {
    label: "Anthropic",
    defaultModel: "claude-sonnet-5-5",
    storageKey: "codemcp.anthropic.key",
    messages: [],
    reset() {
      this.messages = [];
    },
    snapshot() {
      return this.messages.slice();
    },
    restore(s) {
      this.messages = s;
    },
    toolShape: (t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }),
    async *turns({ key, model, tools, question, signal, callTool, system = SYSTEM }) {
      this.messages.push({ role: "user", content: question });
      for (let i = 0; i < MAX_ROUNDS; i++) {
        const res = await fetch(providerUrl("https://api.anthropic.com", "/v1/messages"), {
          method: "POST",
          signal,
          headers: {
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
            "anthropic-dangerous-direct-browser-access": "true",
            "content-type": "application/json",
          },
          body: JSON.stringify({ model, max_tokens: 8192, system, tools, messages: this.messages }),
        });
        if (!res.ok) throw await providerError(res, "Anthropic");
        const reply = await res.json();
        yield { kind: "usage", ...usageOf(reply) };
        this.messages.push({ role: "assistant", content: reply.content });
        for (const b of reply.content) if (b.type === "text" && b.text.trim()) yield { kind: "text", text: b.text };
        if (reply.stop_reason === "max_tokens") yield { kind: "note", text: "The reply hit the token limit and was cut off." };
        const uses = reply.content.filter((b) => b.type === "tool_use");
        if (reply.stop_reason !== "tool_use" || uses.length === 0) return;
        const results = [];
        for (const u of uses) {
          signal.throwIfAborted();
          yield { kind: "call", name: u.name, args: u.input };
          const text = await callTool(u.name, u.input, signal);
          yield { kind: "result", text };
          results.push({ type: "tool_result", tool_use_id: u.id, content: text });
        }
        this.messages.push({ role: "user", content: results });
      }
      yield { kind: "note", text: `Stopped after ${MAX_ROUNDS} tool rounds.` };
    },
  },
  openai: {
    label: "OpenAI",
    defaultModel: "gpt-5.6",
    storageKey: "codemcp.openai.key",
    previous: undefined,
    reset() {
      this.previous = undefined;
    },
    snapshot() {
      return this.previous;
    },
    restore(s) {
      this.previous = s;
    },
    toolShape: (t) => ({ type: "function", name: t.name, description: t.description, parameters: t.inputSchema }),
    async *turns({ key, model, tools, question, signal, callTool, system = SYSTEM }) {
      let input = [{ role: "user", content: question }];
      for (let i = 0; i < MAX_ROUNDS; i++) {
        const res = await fetch(providerUrl("https://api.openai.com", "/v1/responses"), {
          method: "POST",
          signal,
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify({
            model,
            instructions: system,
            tools,
            input,
            ...(this.previous ? { previous_response_id: this.previous } : {}),
          }),
        });
        if (!res.ok) throw await providerError(res, "OpenAI");
        const reply = await res.json();
        yield { kind: "usage", ...usageOf(reply) };
        this.previous = reply.id;
        // The REST shape has no output_text field; the text lives in message items.
        const text = reply.output
          .filter((o) => o.type === "message")
          .flatMap((o) => o.content ?? [])
          .filter((c) => c.type === "output_text")
          .map((c) => c.text)
          .join("");
        if (text.trim()) yield { kind: "text", text };
        if (reply.status === "incomplete") yield { kind: "note", text: `The reply was incomplete (${reply.incomplete_details?.reason ?? "unknown reason"}).` };
        const calls = reply.output.filter((o) => o.type === "function_call");
        if (calls.length === 0) return;
        input = [];
        for (const c of calls) {
          signal.throwIfAborted();
          let args;
          let text;
          try {
            args = JSON.parse(c.arguments || "{}");
          } catch {
            text = "Error: the arguments were not valid JSON.";
          }
          yield { kind: "call", name: c.name, args: args ?? { raw: c.arguments } };
          text ??= await callTool(c.name, args, signal);
          yield { kind: "result", text };
          input.push({ type: "function_call_output", call_id: c.call_id, output: text });
        }
      }
      yield { kind: "note", text: `Stopped after ${MAX_ROUNDS} tool rounds.` };
    },
  },
};

async function api(method, path, body, signal) {
  let res;
  try {
    res = await fetch(path, { method, signal, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  } catch (err) {
    if (err.name === "AbortError") throw err;
    throw new Error("Could not reach the local proxy. Is the playground server running?");
  }
  const raw = await res.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Local proxy returned ${res.status}: ${raw.slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
}

// ----- a small markdown renderer: paragraphs, headings, lists, quotes, code, bold, italics, links, tables
// Everything is escaped before any tag is added, and links accept http(s) only. Keep it that way.
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function inline(s) {
  // Code spans come out first so nothing inside them is formatted.
  const spans = [];
  let t = escapeHtml(s).replace(/`([^`]+)`/g, (_, c) => `\u0000${spans.push(c) - 1}\u0000`);
  t = t
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>');
  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${spans[Number(i)]}</code>`);
}

function markdown(src) {
  const out = [];
  const lines = src.replace(/\r/g, "").split("\n");
  let i = 0;
  const para = [];
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join("\n"))}</p>`);
    para.length = 0;
  };
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      flush();
      const buf = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code>${escapeHtml(buf.join("\n"))}</code></pre>`);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)/);
    if (heading) {
      flush();
      const level = Math.min(heading[1].length, 3) + 1; // h2..h4 inside a message; the page owns h1
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i++;
      continue;
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      flush();
      out.push("<hr>");
      i++;
      continue;
    }
    if (/^>\s?/.test(line)) {
      flush();
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ""));
      out.push(`<blockquote>${markdown(buf.join("\n"))}</blockquote>`);
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      flush();
      const ordered = /^\s*\d+\./.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
        let item = lines[i++].replace(/^\s*([-*]|\d+\.)\s+/, "");
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*]|\d+\.)\s+/.test(lines[i])) item += " " + lines[i++].trim();
        items.push(item);
      }
      out.push(`<${ordered ? "ol" : "ul"}>${items.map((t) => `<li>${inline(t)}</li>`).join("")}</${ordered ? "ol" : "ul"}>`);
      continue;
    }
    if (line.startsWith("|") && lines[i + 1]?.match(/^\|\s*:?-+/)) {
      flush();
      const cells = (l) => l.split("|").slice(1, -1).map((c) => inline(c.trim()));
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].startsWith("|")) rows.push(cells(lines[i++]));
      out.push(
        `<div class="table-wrap" tabindex="0"><table><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>` +
          rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("") +
          "</tbody></table></div>",
      );
      continue;
    }
    if (line.trim() === "") flush();
    else para.push(line);
    i++;
  }
  flush();
  return out.join("");
}

// ----- small helpers
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function fmtMs(ms) {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function fmtTokens(n) {
  return n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`;
}

function copyButton(getText, label) {
  const b = el("button", "copy", "Copy");
  b.type = "button";
  b.setAttribute("aria-label", label);
  b.onclick = async () => {
    try {
      await navigator.clipboard.writeText(getText());
      b.textContent = "Copied";
      b.setAttribute("aria-label", "Copied");
      setTimeout(() => {
        b.textContent = "Copy";
        b.setAttribute("aria-label", label);
      }, 1500);
    } catch {
      b.textContent = "Failed";
    }
  };
  return b;
}

/** Screen readers hear status changes through one polite live region. */
function announce(text) {
  const live = $("live");
  live.textContent = "";
  requestAnimationFrame(() => {
    live.textContent = text;
  });
}

// ----- key handling: localStorage only when the user opts in, never sent to /api
function provider() {
  return PROVIDERS[$("provider").value];
}

function updateHeader() {
  const p = provider();
  $("head-model").textContent = `${p.label} · ${$("model").value.trim() || p.defaultModel}`;
}

function loadKey() {
  const p = provider();
  let saved = "";
  try {
    saved = localStorage.getItem(p.storageKey) ?? "";
  } catch {
    /* storage unavailable */
  }
  $("key").value = saved;
  $("remember").checked = Boolean(saved);
  if (!$("model").value || Object.values(PROVIDERS).some((x) => x.defaultModel === $("model").value)) $("model").value = p.defaultModel;
  $("key-status").textContent = saved ? "Key loaded from this browser's storage." : "No key saved. Paste one above.";
  updateHeader();
}

function persistKey() {
  const p = provider();
  try {
    if ($("remember").checked && $("key").value) localStorage.setItem(p.storageKey, $("key").value);
    else localStorage.removeItem(p.storageKey);
  } catch {
    /* storage unavailable */
  }
}

$("provider").onchange = () => {
  loadKey();
  newChat();
};
$("model").oninput = updateHeader;
$("remember").onchange = persistKey;
$("key").onchange = persistKey;
$("forget").onclick = () => {
  $("key").value = "";
  $("remember").checked = false;
  persistKey();
  $("key-status").textContent = "Key cleared.";
};
$("reveal").onclick = () => {
  const k = $("key");
  const show = k.type === "password";
  k.type = show ? "text" : "password";
  const name = show ? "Hide key" : "Show key";
  $("reveal").title = name;
  $("reveal").setAttribute("aria-label", name);
  $("reveal").setAttribute("aria-pressed", String(show));
};

// ----- sidebar: always open on wide screens, a modal slide-over on narrow ones
const narrow = matchMedia("(max-width: 900px)");

function setSidebar(open, moveFocus = true) {
  document.body.classList.toggle("sidebar-hidden", !open);
  const modal = open && narrow.matches;
  $("chat-main").inert = modal;
  $("sidebar-open").setAttribute("aria-expanded", String(open));
  $("sidebar-toggle").setAttribute("aria-expanded", String(open));
  if (moveFocus) (open ? $("sidebar-toggle") : $("sidebar-open")).focus();
}
$("sidebar-toggle").onclick = () => setSidebar(false);
$("sidebar-open").onclick = () => setSidebar(true);
$("scrim").onclick = () => setSidebar(false);
narrow.addEventListener("change", () => setSidebar(!narrow.matches, false));
setSidebar(!narrow.matches, false);
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && narrow.matches && !document.body.classList.contains("sidebar-hidden")) setSidebar(false);
});

// ----- servers
async function loadServers() {
  const list = $("servers");
  let servers;
  try {
    servers = await api("GET", "/api/servers");
  } catch (err) {
    list.replaceChildren(el("li", "hint", err.message));
    $("head-servers").textContent = "local proxy unreachable";
    return;
  }
  list.innerHTML = "";
  if (!servers.length) list.appendChild(el("li", "hint", "No servers yet. Add one below."));
  const up = servers.filter((s) => s.state === "connected");
  $("server-count").textContent = servers.length ? `${up.length} of ${servers.length} connected` : "";
  const tools = up.reduce((n, s) => n + s.tools, 0);
  $("head-servers").textContent = up.length
    ? `${tools} tool${tools === 1 ? "" : "s"} from ${up.length === 1 ? up[0].name : `${up.length} servers`}`
    : "No servers connected. Add one in the sidebar.";
  for (const s of servers) {
    const li = el("li", s.state === "connected" ? "connected" : "failed");
    li.append(
      el("span", "dot"),
      el("span", "name", s.name),
      el("span", "state", `${s.state.replace(/_/g, " ")}${s.state === "connected" ? ` · ${s.tools} tool${s.tools === 1 ? "" : "s"}` : ""}`),
    );
    if (s.error) li.appendChild(el("span", "err", s.error.slice(0, 200)));
    const rm = el("button", "", "Remove");
    rm.type = "button";
    rm.setAttribute("aria-label", `Remove server ${s.name}`);
    rm.onclick = async () => {
      rm.disabled = true;
      try {
        await api("DELETE", `/api/servers/${encodeURIComponent(s.name)}`);
      } catch (err) {
        formStatus(err.message);
      }
      await loadServers();
    };
    li.appendChild(rm);
    list.appendChild(li);
  }
}

function formStatus(text) {
  $("server-status").textContent = text;
}

$("server-form").onsubmit = async (ev) => {
  ev.preventDefault();
  const name = $("server-name").value.trim();
  const target = $("server-target").value.trim();
  const secret = $("server-secret").value.trim();
  const http = $("server-kind").value === "http";
  // NAME=value for an env var, Header: value or Header=value for a header.
  const m = secret.match(http ? /^([^=:]+)\s*[=:]\s*(.+)$/ : /^([^=]+)=(.+)$/);
  const kv = m ? { [m[1].trim()]: m[2].trim() } : undefined;
  if (secret && !kv) {
    formStatus(http ? "Write the secret as Header: value." : "Write the secret as NAME=value.");
    return;
  }
  const config = http
    ? { url: target, ...(kv ? { headers: kv } : {}) }
    : (() => {
        const [command, ...args] = target.match(/"[^"]*"|\S+/g).map((a) => a.replace(/^"|"$/g, ""));
        return { command, args, ...(kv ? { env: kv } : {}) };
      })();
  formStatus(`Connecting to ${name}…`);
  try {
    const status = await api("POST", "/api/servers", { name, config });
    $("server-secret").value = "";
    if (status.state === "connected") {
      $("server-name").value = "";
      $("server-target").value = "";
      $("add-server").open = false;
      formStatus(`${name} connected with ${status.tools} tool${status.tools === 1 ? "" : "s"}.`);
    } else formStatus(`${name}: ${status.state.replace(/_/g, " ")}. ${status.error ?? ""}`.trim());
  } catch (err) {
    formStatus(err.message);
  }
  await loadServers();
};

$("save-servers").onclick = async () => {
  try {
    const { path } = await api("POST", "/api/servers/save");
    formStatus(`Saved to ${path}. Secrets were written as typed; move them to \${VAR} references before committing.`);
  } catch (err) {
    formStatus(err.message);
  }
};

// ----- transcript
let controller;
let thinking;
let run; // the section for the question being answered, with its tool group and counters
const totals = { tokens: 0 };
const STATE_WORDS = { idle: "Ready", running: "Working…", error: "Error" };

/** Keep the view pinned to the newest content only while the reader is already at the bottom. */
function scrollDown(force = false) {
  const t = $("transcript");
  const nearBottom = t.scrollHeight - t.scrollTop - t.clientHeight < 120;
  if (force || nearBottom) t.scrollTop = t.scrollHeight;
  else $("jump").hidden = false;
}
$("transcript").addEventListener("scroll", () => {
  const t = $("transcript");
  if (t.scrollHeight - t.scrollTop - t.clientHeight < 40) $("jump").hidden = true;
});
$("jump").onclick = () => {
  scrollDown(true);
  $("jump").hidden = true;
};

function message(kind, text, section = run?.section ?? $("transcript")) {
  const div = el("div", `msg ${kind}`);
  const who = el("span", "who", kind === "user" ? "You" : kind === "assistant" ? provider().label : kind === "note" ? "Note" : "Error");
  const body = el("div", "body");
  if (kind === "assistant") body.innerHTML = markdown(text);
  else body.textContent = text;
  if (kind === "error") div.setAttribute("role", "alert");
  div.append(who, body);
  if (kind === "assistant") div.appendChild(messageActions(text, section));
  if (kind === "error" && section.dataset.question) {
    const retry = el("button", "", "Retry");
    retry.type = "button";
    retry.onclick = () => regenerate(section);
    div.appendChild(el("div", "actions")).appendChild(retry);
  }
  section.appendChild(div);
  scrollDown();
  return div;
}

/** The quiet bar under an assistant message: copy the text, or ask the same question again. */
function messageActions(text, section) {
  const bar = el("div", "actions");
  bar.appendChild(copyButton(() => text, "Copy answer"));
  const again = el("button", "", "Regenerate");
  again.type = "button";
  again.onclick = () => regenerate(section);
  bar.appendChild(again);
  return bar;
}

function showThinking(on) {
  thinking?.remove();
  thinking = undefined;
  if (!on) return;
  thinking = el("div", "thinking");
  thinking.setAttribute("role", "status");
  thinking.setAttribute("aria-label", "Waiting for the model");
  thinking.innerHTML = "<i></i><i></i><i></i>";
  (run?.section ?? $("transcript")).appendChild(thinking);
  scrollDown();
}

/** One sentence a person can read on the summary line, instead of raw JSON. */
function describeCall(name, args) {
  const a = args ?? {};
  if (name === "search" && a.query) return `Searched for "${a.query}"`;
  if (name === "describe") {
    const what = a.names?.length ? a.names.join(", ") : a.server ? `server ${a.server}` : "every tool";
    return `Read stubs for ${what}`;
  }
  if (name === "execute") return "Ran a script";
  const keys = Object.keys(a);
  return keys.length ? JSON.stringify(a) : "";
}

/** All tool calls of one question live in a group that sums them up, so the answer is not buried. */
function toolGroup() {
  if (run.group) return run.group;
  const g = el("details", "group");
  g.open = true;
  const s = el("summary");
  const chev = el("span", "chev", "▶");
  chev.setAttribute("aria-hidden", "true");
  s.append(chev, el("span", "label", "Using tools…"), el("span", "ms", ""));
  s.setAttribute("aria-label", "Tool calls for this question");
  g.appendChild(s);
  run.section.appendChild(g);
  run.group = g;
  run.calls = 0;
  run.failed = 0;
  run.toolMs = 0;
  return g;
}

function updateGroup(running) {
  const label = run.group.querySelector(":scope > summary .label");
  const ms = run.group.querySelector(":scope > summary .ms");
  if (running) {
    label.textContent = "Using tools…";
    run.group.classList.add("running");
    return;
  }
  run.group.classList.remove("running");
  label.textContent = `Used ${run.calls} tool${run.calls === 1 ? "" : "s"}${run.failed ? ` · ${run.failed} failed` : ""}`;
  ms.textContent = fmtMs(run.toolMs);
}

const MAX_SHOWN = 200_000;

/** A capped code block with a copy button and a "Show all" toggle for long payloads. */
function codeSection(label, getText) {
  const head = el("div", "label");
  head.append(el("span", "", label), copyButton(getText, `Copy ${label}`));
  const pre = el("pre");
  const wrap = el("div", "capped");
  wrap.appendChild(pre);
  const more = el("button", "more", "Show all");
  more.type = "button";
  more.onclick = () => {
    wrap.classList.toggle("expanded");
    more.textContent = wrap.classList.contains("expanded") ? "Show less" : "Show all";
  };
  wrap.appendChild(more);
  const set = (text) => {
    pre.textContent = text.length > MAX_SHOWN ? `${text.slice(0, MAX_SHOWN)}\n… ${text.length - MAX_SHOWN} more characters (use Copy for all of it)` : text;
    wrap.classList.toggle("overflowing", pre.scrollHeight > 240);
  };
  set(getText());
  return { nodes: [head, wrap], pre, set };
}

/** A tool call renders as a collapsed card: name, summary and a live timer, folding open to code and result. */
function callBlock(name, args) {
  const group = toolGroup();
  run.calls++;
  updateGroup(true);
  const details = el("details", "tool running");
  const summary = el("summary");
  const chev = el("span", "chev", "▶");
  chev.setAttribute("aria-hidden", "true");
  const fn = el("span", "fn", name);
  fn.title = name;
  const server = args?.server ? el("span", "meta", `/ ${args.server}`) : null;
  const what = el("span", "args", describeCall(name, args));
  what.title = JSON.stringify(args ?? {});
  const ms = el("span", "ms", "running");
  summary.append(chev, fn, ...(server ? [server] : []), what, ms);
  details.appendChild(summary);
  const { code, ...rest } = args ?? {};
  const body = el("div", "body");
  if (typeof code === "string") {
    const c = codeSection("code", () => code);
    c.pre.classList.add("code");
    body.append(...c.nodes);
  }
  if (Object.keys(rest).length) body.append(...codeSection("arguments", () => JSON.stringify(rest, null, 2)).nodes);
  let resultText = "";
  const result = codeSection("result", () => resultText);
  result.pre.textContent = "Waiting for result…";
  body.append(...result.nodes);
  details.appendChild(body);
  group.appendChild(details);
  announce(`${name} running`);
  scrollDown();
  const started = performance.now();
  const timer = setInterval(() => {
    ms.textContent = `running ${fmtMs(performance.now() - started)}`;
  }, 100);
  return {
    done(text) {
      clearInterval(timer);
      const took = performance.now() - started;
      run.toolMs += took;
      resultText = text;
      result.set(text);
      details.classList.remove("running");
      const failed = /^Error/.test(text);
      ms.textContent = failed ? `failed · ${fmtMs(took)}` : fmtMs(took);
      if (failed) {
        details.classList.add("failed");
        details.open = true;
        run.failed++;
      }
      announce(`${name} ${failed ? "failed" : "finished"}`);
      updateGroup(false);
      scrollDown();
    },
    abort() {
      clearInterval(timer);
      ms.textContent = "stopped";
      details.classList.remove("running");
      updateGroup(false);
    },
  };
}

// ----- approvals: a paused execute call renders a card; the person decides, the model only sees the final result
const PAUSED_RE = /^Paused: execution (\S+) is waiting for approval of call #(\d+) (\S+?)\((.*)\)\. .*?parked until (\S+);/s;

function approvalCard({ executionId, seq, tool, args, expiresAt }) {
  return new Promise((resolve) => {
    const card = el("div", "approval");
    card.setAttribute("role", "group");
    card.setAttribute("aria-label", `Approve call ${seq}: ${tool}`);
    const head = el("div", "head");
    head.append(el("span", "badge", "needs you"), el("span", "meta", `call #${seq} / ${executionId.slice(0, 8)}`));
    const title = el("h3", "", `${tool} wants to run`);
    const why = el("p", "why", "The script is parked on this call. Nothing happens until you decide, and the model only sees the final result.");
    const argsBlock = el("pre", "args", args);
    const stats = statGrid([
      ["tool", tool],
      ["call", `#${seq}`],
      ["expires", expiresAt ? new Date(expiresAt).toLocaleTimeString() : "—", true],
    ]);
    const foot = el("div", "foot");
    foot.appendChild(el("span", "meta", `parked since ${new Date().toLocaleTimeString()}`));
    const buttons = el("div", "buttons");
    const deny = el("button", "ghost");
    deny.type = "button";
    deny.innerHTML = 'Deny <kbd aria-hidden="true">Esc</kbd>';
    deny.setAttribute("aria-keyshortcuts", "Escape");
    const approve = el("button", "primary");
    approve.type = "button";
    approve.innerHTML = 'Approve <kbd aria-hidden="true">Ctrl ↵</kbd>';
    approve.setAttribute("aria-keyshortcuts", "Control+Enter");
    buttons.append(deny, approve);
    foot.appendChild(buttons);
    card.append(head, title, why, argsBlock, stats, foot);
    run.section.appendChild(card);
    showThinking(false);
    announce(`Approval needed for ${tool}`);
    scrollDown(true);
    approve.focus();
    const decide = (allow) => {
      card.removeEventListener("keydown", onKey);
      card.classList.add("resolved", allow ? "approved" : "denied");
      const icon = el("span", "status", allow ? "✓" : "✕");
      icon.setAttribute("aria-hidden", "true");
      card.replaceChildren(icon, el("span", "", `${allow ? "Approved" : "Denied"} ${tool}`));
      card.tabIndex = -1;
      card.focus();
      announce(`${allow ? "Approved" : "Denied"} ${tool}`);
      resolve(allow);
    };
    const onKey = (ev) => {
      if (ev.key === "Escape") {
        ev.stopPropagation();
        decide(false);
      } else if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) decide(true);
    };
    card.addEventListener("keydown", onKey);
    deny.onclick = () => decide(false);
    approve.onclick = () => decide(true);
  });
}

async function callTool(name, args, signal, path = "/api/call") {
  let { text } = await api("POST", path, { name, args }, signal);
  // A script may stop more than once; each stop is one card.
  for (let m = text.match(PAUSED_RE); m; m = text.match(PAUSED_RE)) {
    const [, executionId, seq, tool, callArgs, expiresAt] = m;
    const allow = await approvalCard({ executionId, seq: Number(seq), tool, args: callArgs, expiresAt });
    showThinking(true);
    ({ text } = await api("POST", "/api/approvals", { executionId, seq: Number(seq), allow }, signal));
  }
  return text;
}

function setState(s) {
  $("run-state").className = `state ${s}`;
  $("run-state").textContent = STATE_WORDS[s];
  $("transcript").setAttribute("aria-busy", String(s === "running"));
  $("ask").hidden = s === "running";
  $("stop").hidden = s !== "running";
}

const emptyState = $("transcript").querySelector(".empty");

function newChat() {
  controller?.abort();
  for (const p of Object.values(PROVIDERS)) p.reset();
  totals.tokens = 0;
  $("head-usage").textContent = "";
  $("transcript").replaceChildren(emptyState, $("jump"));
  $("jump").hidden = true;
  setState("idle");
  run = undefined;
}
$("new-chat").onclick = newChat;

/** The tool list for one mode, in the provider's shape, plus a rough size so the two modes can be compared before any request. */
async function toolsFor(mode, p, signal) {
  const m = MODES[mode];
  const raw = mode === "direct" ? await api("GET", m.tools, undefined, signal) : (await api("GET", m.tools, undefined, signal)).advertisedTools.filter((t) => t.name !== "approve");
  const tools = raw.map(p.toolShape);
  // About four characters per token for JSON schemas; close enough to show the gap, the real count comes from the provider.
  return { tools, count: tools.length, approxTokens: Math.round(JSON.stringify(tools).length / 4) };
}

/**
 * One question through one mode: a section in the transcript with its tool calls, answer and stats.
 * Returns the numbers the comparison card needs. Throws on failure after rewinding the provider state.
 */
async function runMode(mode, question, section, { p, key, model, signal }) {
  const m = MODES[mode];
  section.dataset.question = question;
  section.dataset.mode = mode;
  run = { section, question, mode, snapshot: p.snapshot(), llmCalls: 0, tokens: 0, firstInput: 0, started: performance.now(), active: true };
  if (mode === "direct") {
    section.prepend(el("h3", "mode-label", m.label));
    message("note", "Direct mode has no sandbox, policy, approvals, pinning or audit. A destructive tool runs the moment the model calls it.");
  } else if ($("mode").value === "compare") section.prepend(el("h3", "mode-label", m.label));
  showThinking(true);
  let openCall;
  try {
    const { tools, count, approxTokens } = await toolsFor(mode, p, signal);
    run.toolCount = count;
    run.approxToolTokens = approxTokens;
    const call = (name, args, sig) => callTool(name, args, sig, m.call);
    for await (const t of p.turns({ key, model, tools, question, signal, callTool: call, system: m.system })) {
      if (t.kind === "usage") {
        run.llmCalls++;
        if (!run.firstInput) run.firstInput = t.input;
        run.tokens += t.input + t.output;
        totals.tokens += t.input + t.output;
        $("head-usage").textContent = `${fmtTokens(totals.tokens)} tokens this chat`;
      } else if (t.kind === "call") openCall = callBlock(t.name, t.args);
      else if (t.kind === "result") {
        openCall?.done(t.text);
        openCall = undefined;
        showThinking(true);
      } else {
        showThinking(false);
        message(t.kind === "note" ? "note" : "assistant", t.text);
      }
    }
    runSummary();
    return {
      mode,
      label: m.label,
      toolCount: count,
      approxToolTokens: approxTokens,
      firstInput: run.firstInput,
      tokens: run.tokens,
      llmCalls: run.llmCalls,
      calls: run.calls ?? 0,
      ms: performance.now() - run.started,
    };
  } catch (err) {
    openCall?.abort();
    p.restore(run.snapshot); // never leave a half-finished tool round in the history
    throw err;
  } finally {
    run.active = false;
    showThinking(false);
  }
}

async function ask(question, before, mode = $("mode").value) {
  if (controller && !controller.signal.aborted && run?.active) return; // one run at a time
  const p = provider();
  const key = $("key").value.trim();
  if (!key) {
    $("key-status").textContent = `Paste your ${p.label} API key first.`;
    setSidebar(true, false);
    $("key").focus();
    return;
  }
  persistKey();
  emptyState.remove();
  const model = $("model").value.trim() || p.defaultModel;
  const section = el("section", "run");
  if (before) before.replaceWith(section);
  else $("transcript").insertBefore(section, $("jump"));
  run = { section, active: true };
  message("user", question, section);
  controller = new AbortController();
  const opts = { p, key, model, signal: controller.signal };
  setState("running");
  try {
    if (mode !== "compare") {
      await runMode(mode, question, section, opts);
    } else {
      // Same starting conversation for both; the chat continues from the codemcp run afterwards.
      const before = p.snapshot();
      const a = await runMode("codemcp", question, section, opts);
      const after = p.snapshot();
      p.restore(before);
      const direct = el("section", "run");
      section.after(direct);
      message("user", question, direct);
      const b = await runMode("direct", question, direct, opts);
      p.restore(after);
      const card = compareCard(a, b);
      direct.after(card);
      scrollDown();
    }
    setState("idle");
  } catch (err) {
    if (err.name === "AbortError") {
      message("note", "Stopped. Send a new message or regenerate.");
      setState("idle");
    } else {
      message("error", err.message);
      setState("error");
    }
  } finally {
    run.active = false;
    showThinking(false);
    const active = document.activeElement;
    if (!active || active === document.body || active === $("stop") || active === $("ask")) $("question").focus();
  }
}

/** Side by side: what the same question cost through codemcp and with every tool passed directly. */
function compareCard(a, b) {
  const card = el("section", "compare");
  card.setAttribute("aria-label", "Comparison of both runs");
  card.appendChild(el("h3", "", "Same question, both ways"));
  const pct = (x, y) => (y ? `${Math.round((1 - x / y) * 100)}%` : "—");
  const rows = [
    ["tools sent to the model", String(a.toolCount), String(b.toolCount)],
    ["≈ tokens of tool definitions", fmtTokens(a.approxToolTokens), fmtTokens(b.approxToolTokens)],
    ["input tokens, first request", fmtTokens(a.firstInput), fmtTokens(b.firstInput)],
    ["total tokens", fmtTokens(a.tokens), fmtTokens(b.tokens), true],
    ["model calls", String(a.llmCalls), String(b.llmCalls)],
    ["tool calls", String(a.calls), String(b.calls)],
    ["time", fmtMs(a.ms), fmtMs(b.ms)],
  ];
  const table = el("table");
  const thead = el("thead");
  const hr = el("tr");
  hr.append(el("th", "", ""), el("th", "", "with codemcp"), el("th", "", "direct"));
  thead.appendChild(hr);
  const tbody = el("tbody");
  for (const [label, x, y, hot] of rows) {
    const tr = el("tr", hot ? "hot" : "");
    tr.append(el("th", "", label), el("td", "", x), el("td", "", y));
    tbody.appendChild(tr);
  }
  table.append(thead, tbody);
  card.appendChild(table);
  const saved = a.tokens && b.tokens ? pct(a.tokens, b.tokens) : "—";
  const firstSaved = a.firstInput && b.firstInput ? pct(a.firstInput, b.firstInput) : "—";
  card.appendChild(
    el("p", "hint", `codemcp used ${saved} fewer tokens overall and ${firstSaved} fewer on the first request, where the tool definitions are paid for. Counts are the providers' own usage figures; the tool-definition size is an estimate.`),
  );
  announce("Comparison ready");
  return card;
}

/** A small stat grid after an answer: label above, value below, the cost figure picked out. */
function statGrid(stats, className = "stats") {
  const grid = el("dl", className);
  for (const [label, value, hot] of stats) {
    grid.appendChild(el("dt", "", label));
    grid.appendChild(el("dd", hot ? "hot" : "", value));
  }
  return grid;
}

function runSummary() {
  run.section.appendChild(
    statGrid([
      ["model calls", String(run.llmCalls)],
      ["tool calls", String(run.calls ?? 0)],
      ["tokens", run.tokens ? fmtTokens(run.tokens) : "—", true],
      ["time", fmtMs(performance.now() - run.started)],
    ], "stats run-summary"),
  );
}

function regenerate(section) {
  if (run?.active || !section.dataset.question) return;
  // Only the latest turn can be rewound precisely; an older one restarts the conversation from scratch.
  if (section === run?.section) provider().restore(run.snapshot);
  else provider().reset();
  void ask(section.dataset.question, section, section.dataset.mode ?? $("mode").value);
}

$("ask-form").onsubmit = (ev) => {
  ev.preventDefault();
  if (run?.active) return;
  const q = $("question").value.trim();
  if (!q) return;
  $("question").value = "";
  autogrow();
  void ask(q);
};
$("stop").onclick = () => controller?.abort();

function autogrow() {
  const q = $("question");
  q.style.height = "auto";
  q.style.height = `${Math.min(q.scrollHeight, 220)}px`;
}
$("question").oninput = autogrow;
$("question").onkeydown = (ev) => {
  if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
    ev.preventDefault();
    $("ask-form").requestSubmit();
  }
};
for (const b of document.querySelectorAll(".suggestions button")) {
  b.onclick = () => {
    $("question").value = b.dataset.q;
    $("ask-form").requestSubmit();
  };
}

setState("idle");
loadKey();
await loadServers();
