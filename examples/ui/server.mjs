// A browser front end for poking at the proxy: see the tools, read the stubs, write code, run it,
// The chat page at / drives a model with your own key; /playground.html shows what the model sees.
// No framework, no build step. Run with `pnpm --filter codemcp-examples ui`.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeJsonFile } from "codemcp-core";
import { ProxyHarness } from "../lib/harness.mjs";

const PORT = Number(process.env.PORT ?? 8765);
const PUBLIC = fileURLToPath(new URL("./public/", import.meta.url));
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

class UiServer {
  constructor(harness) {
    this.harness = harness;
    this.proxy = harness.proxy;
    this.routes = [
      ["GET", /^\/api\/tools$/, () => this.tools()],
      ["GET", /^\/api\/audit$/, () => this.harness.audit.events.slice(-200)],
      ["POST", /^\/api\/search$/, (body) => this.harness.search(body.query ?? "", body.limit)],
      ["POST", /^\/api\/describe$/, (body) => this.harness.describe(body)],
      ["POST", /^\/api\/execute$/, (body) => this.harness.execute(body.code ?? "")],
      // Any advertised tool by name: what the chat page's model loop uses.
      ["POST", /^\/api\/call$/, (body) => this.harness.call(String(body.name ?? ""), body.args ?? {})],
      ["GET", /^\/api\/approvals$/, () => this.proxy.gate.list()],
      // The human's decision: resumes the parked run and returns its final result, like the approve tool would.
      ["POST", /^\/api\/approvals$/, async (body) => ({ text: await this.proxy.resume(body.executionId, Number(body.seq), Boolean(body.allow)) })],
      ["GET", /^\/api\/servers$/, () => this.proxy.serverStatus()],
      ["POST", /^\/api\/servers$/, (body) => this.proxy.addServer(String(body.name ?? ""), body.config ?? {})],
      ["POST", /^\/api\/servers\/save$/, () => this.saveServers()],
      ["DELETE", /^\/api\/servers\/([^/]+)$/, async (_body, [name]) => ({ removed: name, ...(await this.proxy.removeServer(decodeURIComponent(name)), {}) })],
    ];
  }

  async tools() {
    const advertisedTools = await this.harness.listTools();
    const registry = this.proxy.registry.list().map((t) => ({
      qualifiedName: t.qualifiedName,
      stubKey: t.stubKey,
      description: t.description ?? "",
      readOnly: Boolean(t.annotations?.readOnlyHint),
      destructive: Boolean(t.annotations?.destructiveHint),
      pin: this.proxy.pins.check(t).status,
    }));
    return { advertisedTools, registry, servers: this.proxy.serverStatus() };
  }

  /** Writes the live server map next to the config in use, or into examples/ui/ when running the demo. */
  async saveServers() {
    const path = resolve(process.env.CODEMCP_CONFIG ?? fileURLToPath(new URL("./codemcp.config.json", import.meta.url)));
    await writeJsonFile(path, { ...this.proxy.config, servers: this.proxy.serverConfigs() });
    return { path };
  }

  listen(port) {
    return createServer((req, res) => void this.handle(req, res)).listen(port, () => {
      console.log(`codemcp chat on http://localhost:${port}  (playground: http://localhost:${port}/playground.html)`);
    });
  }

  async handle(req, res) {
    const { pathname } = new URL(req.url, "http://localhost");
    try {
      for (const [method, pattern, fn] of this.routes) {
        const m = req.method === method ? pattern.exec(pathname) : null;
        if (!m) continue;
        const body = method === "POST" ? await readJson(req) : undefined;
        return send(res, 200, JSON.stringify(await fn(body, m.slice(1))), "application/json");
      }
      if (req.method === "GET") return this.serveStatic(pathname === "/" ? "/chat.html" : pathname, res);
      send(res, 404, "not found", "text/plain");
    } catch (err) {
      send(res, 400, JSON.stringify({ error: err.message }), "application/json");
    }
  }

  async serveStatic(url, res) {
    const path = join(PUBLIC, url.replace(/^\/+/, ""));
    if (!path.startsWith(PUBLIC)) return send(res, 403, "forbidden", "text/plain");
    try {
      send(res, 200, await readFile(path), TYPES[extname(path)] ?? "application/octet-stream");
    } catch {
      send(res, 404, "not found", "text/plain");
    }
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function send(res, status, body, type) {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

const harness = await new ProxyHarness().start();
const server = new UiServer(harness).listen(PORT);
const shutdown = () => server.close(() => harness.close().then(() => process.exit(0)));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
