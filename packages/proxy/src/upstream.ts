import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { JsonValue, UpstreamCallContext, UpstreamTool } from "codemcp-core";
import { isHttpServer, type ServerConfig } from "./config.js";

/**
 * One connection to one upstream MCP server. Holds that server's transport and credentials.
 * Nothing from here is ever handed to the sandbox; the bridge only receives JSON results.
 */
export class Upstream {
  private client: Client | undefined;

  constructor(
    readonly name: string,
    private readonly config: ServerConfig,
    private readonly onToolsChanged: () => void = () => undefined,
  ) {}

  async connect(): Promise<void> {
    const client = new Client({ name: "codemcp", version: "0.0.1" }, { capabilities: {} });
    const transport = isHttpServer(this.config)
      ? new StreamableHTTPClientTransport(new URL(this.config.url), {
          requestInit: this.config.headers ? { headers: this.config.headers } : undefined,
        })
      : new StdioClientTransport({
          command: this.config.command,
          args: this.config.args ?? [],
          // The SDK's platform-aware minimal environment; secrets reach a server only via its own config `env`.
          env: { ...getDefaultEnvironment(), ...(this.config.env ?? {}) },
          ...(this.config.cwd ? { cwd: this.config.cwd } : {}),
          stderr: "pipe",
        });
    await client.connect(transport);
    client.fallbackNotificationHandler = async (n) => {
      if (n.method === "notifications/tools/list_changed") this.onToolsChanged();
    };
    this.client = client;
  }

  async listTools(): Promise<UpstreamTool[]> {
    const client = this.requireClient();
    const tools: UpstreamTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : {});
      // The SDK tool type is structurally an UpstreamTool; only the missing-schema default is real work.
      for (const t of page.tools) tools.push({ ...t, inputSchema: (t.inputSchema ?? { type: "object" }) as Record<string, unknown> } as UpstreamTool);
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  }

  /**
   * Call a tool and reduce the MCP result to plain JSON for the sandbox:
   * structured content when present, else parsed text, else the content array.
   * `isError` results are thrown so the script sees an exception.
   */
  async callTool(name: string, args: JsonValue, ctx?: UpstreamCallContext): Promise<JsonValue> {
    const result = await this.requireClient().callTool(
      {
        name,
        arguments: (args && typeof args === "object" && !Array.isArray(args) ? args : {}) as Record<string, unknown>,
        ...(ctx?.traceparent !== undefined ? { _meta: { traceparent: ctx.traceparent } } : {}),
      },
      undefined,
      // The bridge owns the clock: its abort signal ends the request; progress from the server keeps it alive.
      ctx ? { signal: ctx.signal, timeout: ctx.timeoutMs, resetTimeoutOnProgress: true } : undefined,
    );
    const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
    if (result.isError) throw new Error(content.map((c) => c.text ?? `[${c.type}]`).join("\n") || "tool returned an error");
    if (result.structuredContent !== undefined) return result.structuredContent as JsonValue;
    if (content.length === 1 && content[0]?.type === "text") return parseMaybeJson(content[0].text ?? "");
    // Content items arrived as JSON over the wire and are already plain data.
    return content.map((c) => (c.type === "text" ? parseMaybeJson(c.text ?? "") : (c as unknown as JsonValue)));
  }

  async close(): Promise<void> {
    await this.client?.close().catch(() => undefined);
    this.client = undefined;
  }

  private requireClient(): Client {
    if (!this.client) throw new Error(`upstream "${this.name}" is not connected`);
    return this.client;
  }
}

function parseMaybeJson(text: string): JsonValue {
  const t = text.trim();
  if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
    try {
      return JSON.parse(t) as JsonValue;
    } catch {
      return text;
    }
  }
  return text;
}
