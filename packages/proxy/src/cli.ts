#!/usr/bin/env node
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parseStubDetail, StubGenerator, writeJsonFile } from "codemcp-core";
import { CONFIG_FILENAME, ConfigLoader, type CodemcpConfig } from "./config.js";
import { ClientConfigDiscovery } from "./import.js";
import { Proxy } from "./server.js";

const USAGE = `codemcp - vendor-neutral code mode for MCP

Usage:
  codemcp serve   [--config <path>] [--strict]     Run the proxy over stdio (point your MCP client here)
  codemcp import  [--config <path>] [--write]      Discover servers from Claude Code, Cursor, VS Code, Claude Desktop, Windsurf, Codex
  codemcp tools   [--config <path>]                Connect and list every tool with its pin status
  codemcp stubs   [--config <path>] [--detail names|signatures|full]
  codemcp approve [--config <path>]                Pin every new or changed tool definition after you have reviewed them
  codemcp --help

Config is read from ./${CONFIG_FILENAME} or ~/.codemcp/config.json.
`;

interface Flags {
  config?: string;
  write: boolean;
  strict: boolean;
  detail: string;
  help: boolean;
}

/** The `codemcp` command line. Each command is a method; `run` parses flags and dispatches. */
export class Cli {
  private readonly loader = new ConfigLoader();

  constructor(
    private readonly out: (s: string) => void = (s) => process.stdout.write(s),
    private readonly err: (s: string) => void = (s) => process.stderr.write(s),
  ) {}

  async run(argv: string[]): Promise<number> {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        config: { type: "string", short: "c" },
        write: { type: "boolean", default: false },
        strict: { type: "boolean", default: false },
        detail: { type: "string", default: "signatures" },
        help: { type: "boolean", short: "h", default: false },
      },
    });
    const flags = values as Flags;
    const command = positionals[0];
    if (flags.help || !command) {
      this.out(USAGE);
      return command ? 0 : 1;
    }
    const { config } = await this.loader.load(flags.config);
    switch (command) {
      case "serve":
        return this.serve(config, flags.strict);
      case "import":
        return this.import(config, await this.loader.targetPath(flags.config), flags.write);
      case "tools":
        return this.tools(config);
      case "stubs":
        return this.stubs(config, flags.detail);
      case "approve":
        return this.approve(config);
      default:
        this.err(`Unknown command: ${command}\n\n${USAGE}`);
        return 1;
    }
  }

  private async serve(config: CodemcpConfig, strict: boolean): Promise<number> {
    const proxy = new Proxy({ config, ...(strict ? { autoApproveNew: false } : {}) });
    await proxy.start();
    await proxy.server.connect(new StdioServerTransport());
    const shutdown = async (): Promise<void> => {
      await proxy.close();
      process.exit(0);
    };
    process.on("SIGINT", () => void shutdown());
    process.on("SIGTERM", () => void shutdown());
    await new Promise(() => undefined);
    return 0;
  }

  private async import(config: CodemcpConfig, target: string, write: boolean): Promise<number> {
    const discovered = await new ClientConfigDiscovery().discover();
    if (discovered.length === 0) {
      this.out("No MCP servers found in known client configs.\n");
      return 0;
    }
    for (const d of discovered) {
      const how = "url" in d.config ? d.config.url : [d.config.command, ...(d.config.args ?? [])].join(" ");
      this.out(`${d.host.padEnd(15)} ${d.name.padEnd(24)} ${how}\n`);
    }
    const merged = ClientConfigDiscovery.merge(config.servers, discovered);
    if (!write) {
      this.out(`\n${Object.keys(merged).length} servers would be written to ${target}. Re-run with --write to save.\n`);
      return 0;
    }
    await writeJsonFile(target, { ...config, servers: merged });
    this.out(`\nWrote ${Object.keys(merged).length} servers to ${target}\n`);
    return 0;
  }

  private tools(config: CodemcpConfig): Promise<number> {
    return this.withProxy(config, async (proxy) => {
      for (const s of proxy.serverStatus()) this.out(`${s.state.padEnd(14)} ${s.name}${s.state === "connected" ? `  ${s.tools} tools` : `  ${s.error ?? ""}`}\n`);
      this.out("\n");
      for (const t of proxy.registry.list()) {
        const flags = [t.annotations?.readOnlyHint ? "ro" : "", t.annotations?.destructiveHint ? "DESTRUCTIVE" : ""].filter(Boolean).join(",");
        this.out(`${proxy.pins.check(t).status.padEnd(8)} ${t.qualifiedName}${flags ? `  [${flags}]` : ""}\n`);
      }
      this.out(`\n${proxy.registry.size} tools, ${proxy.pins.size} pinned; identity: ${proxy.identity.name}\n`);
    });
  }

  private stubs(config: CodemcpConfig, detail: string): Promise<number> {
    return this.withProxy(config, async (proxy) => {
      this.out(`${new StubGenerator(proxy.config.rootName).generate(proxy.registry.list(), parseStubDetail(detail))}\n`);
    });
  }

  private approve(config: CodemcpConfig): Promise<number> {
    return this.withProxy(
      config,
      async (proxy) => {
        const { approved } = proxy.pins.approveAll(proxy.registry.list(), { includeDrifted: true });
        await proxy.pins.save();
        this.out(`Pinned ${approved.length} tool definitions (${proxy.pins.size} total)\n`);
      },
      { autoApproveNew: false },
    );
  }

  private async withProxy(config: CodemcpConfig, fn: (proxy: Proxy) => Promise<void>, extra: { autoApproveNew?: boolean } = {}): Promise<number> {
    const proxy = new Proxy({ config, ...extra });
    try {
      await proxy.start();
      await fn(proxy);
      return 0;
    } finally {
      await proxy.close();
    }
  }
}

new Cli().run(process.argv.slice(2)).then(
  (code) => {
    if (code !== 0) process.exitCode = code;
  },
  (err: Error) => {
    process.stderr.write(`codemcp: ${err.message}\n`);
    process.exitCode = 1;
  },
);
