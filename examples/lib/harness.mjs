// Runs the proxy in-process and talks to it the way an MCP client would, over an in-memory transport.
// Both examples use this so they exercise exactly the code path a real client does.
//
// By default it connects the two demo servers. Set CODEMCP_CONFIG to a config file to run the same
// examples against your real MCP servers instead.
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MemorySink } from "codemcp-core";
import { ConfigLoader, Proxy } from "codemcp-cli";

export const CATALOG_SERVER = fileURLToPath(new URL("../servers/catalog-server.mjs", import.meta.url));
export const CRM_SERVER = fileURLToPath(new URL("../servers/crm-server.mjs", import.meta.url));

export class ProxyHarness {
  constructor(config) {
    this.configPromise = config ? Promise.resolve(config) : ProxyHarness.loadConfig();
    this.audit = new MemorySink();
    this.client = new Client({ name: "codemcp-example", version: "0" });
  }

  static demoConfig() {
    return {
      servers: {
        catalog: { command: process.execPath, args: [CATALOG_SERVER] },
        // The CRM demands a token. It is given to the server process only; code in the sandbox cannot read it.
        crm: { command: process.execPath, args: [CRM_SERVER], env: { CRM_TOKEN: "demo-token" } },
      },
      // One high-frequency tool exposed directly, everything else through code.
      passthrough: ["catalog.get_item"],
      policy: { rules: { "catalog.add_note": "allow", "crm.refund_order": "deny" } },
      budget: { maxCalls: 50 },
      limits: { timeoutMs: 10_000 },
      audit: { file: false },
      pins: { file: false },
    };
  }

  /** The demo config, or the file named by CODEMCP_CONFIG with relative `args` resolved against the file's folder. */
  static async loadConfig() {
    const path = process.env.CODEMCP_CONFIG;
    if (!path) return ProxyHarness.demoConfig();
    const { config } = await new ConfigLoader().load(path);
    const base = dirname(resolve(path));
    for (const s of Object.values(config.servers)) {
      if (s.args) s.args = s.args.map((a) => (/^\.{1,2}[\\/]/.test(a) ? resolve(base, a) : a));
      if (s.cwd) s.cwd = resolve(base, s.cwd);
    }
    console.error(`[examples] using ${resolve(path)}`);
    return { audit: { file: false }, pins: { file: false }, ...config };
  }

  /** Still available for callers that want to tweak the demo setup. */
  static defaultConfig() {
    return ProxyHarness.demoConfig();
  }

  async start() {
    this.proxy = new Proxy({ config: await this.configPromise, audit: this.audit, log: (m) => process.stderr.write(`${m}\n`) });
    await this.proxy.start();
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await this.proxy.server.connect(serverSide);
    await this.client.connect(clientSide);
    return this;
  }

  async listTools() {
    return (await this.client.listTools()).tools;
  }

  /** Call one of the proxy's tools and return its text output. */
  async call(name, args = {}) {
    const res = await this.client.callTool({ name, arguments: args });
    return { text: res.content.map((c) => c.text ?? "").join("\n"), isError: Boolean(res.isError) };
  }

  search(query, limit) {
    return this.call("search", limit ? { query, limit } : { query });
  }

  describe(args) {
    return this.call("describe", args);
  }

  execute(code) {
    return this.call("execute", { code });
  }

  async close() {
    await this.client.close();
    await this.proxy.close();
  }
}
