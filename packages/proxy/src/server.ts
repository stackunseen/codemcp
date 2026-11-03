import { randomBytes, randomUUID } from "node:crypto";
import { CLIENT_CAPABILITIES_META_KEY, createRequestStateCodec, inputRequired, inputResponse, Server, type ElicitRequestFormParams, type RequestStateCodec, type ServerContext, type Tool } from "@modelcontextprotocol/server";
import {
  ApprovalGate,
  BridgeHost,
  CallbackSink,
  HttpSink,
  MultiSink,
  LocalIdentityProvider,
  StaticTokenIdentityProvider,
  TrustedHeaderIdentityProvider,
  compilePattern,
  executeInstructions,
  JsonlFileSink,
  NullSink,
  parseStubDetail,
  PinStore,
  Policy,
  StderrSink,
  STUB_DETAILS,
  StubGenerator,
  SURFACE,
  ToolRegistry,
  ToolSearch,
  type AuditEvent,
  type AuditSink,
  type ExecuteResult,
  type Executor,
  type IdentityContext,
  type IdentityProvider,
  type JsonValue,
  type LogEntry,
  type PendingApproval,
  type Principal,
  type ToolDescriptor,
  type UpstreamCallContext,
} from "codemcp-core";
import { QuickJsExecutor } from "codemcp-executor-quickjs";
import { ConfigLoader, type CodemcpConfig, type ResolvedConfig, type ServerConfig } from "./config.js";
import { Upstream } from "./upstream.js";

export interface ProxyOptions {
  config: CodemcpConfig;
  executor?: Executor;
  audit?: AuditSink;
  /** Overrides the provider chosen from `config.identity`. */
  identity?: IdentityProvider;
  /** Receives every audit event in addition to the configured sinks: the hook for tracing, queues or databases. */
  onAudit?: (event: AuditEvent) => void | Promise<void>;
  /** Override the config's trust-on-first-use setting (e.g. `--strict`). */
  autoApproveNew?: boolean;
  /** Called for diagnostics. Defaults to stderr (stdout is the MCP transport). */
  log?: (message: string) => void;
}

const APPROVE_TOOL = "approve";
/** Key of the approval question inside an `input_required` result. */
const APPROVAL_INPUT = "approval";
/** Approval rounds one `execute` may ask for over a 2025 connection; one per gated call, so match the default call budget. */
const APPROVAL_ROUNDS = 64;
const DECISION_SCHEMA: ElicitRequestFormParams["requestedSchema"] = {
  type: "object",
  properties: { decision: { type: "string", enum: ["allow", "deny"], title: "Decision", description: "allow runs the call; deny rejects it and the script continues" } },
  required: ["decision"],
};

/** What an approval round carries through the client, sealed by `approvalState`. */
interface ApprovalState {
  executionId: string;
  seq: number;
}

export type ServerState = "connected" | "auth_failed" | "unreachable" | "listing_failed";

export interface ServerStatus {
  name: string;
  state: ServerState;
  tools: number;
  /** The protocol era the connection negotiated, once connected. */
  era?: string;
  error?: string;
}

/** A 401, an SDK UnauthorizedError, or a child that quit mentioning auth all mean "fix the credential", not "server down". */
function classifyConnectError(err: Error): ServerState {
  return /unauthori[sz]ed|\b401\b|forbidden|\b403\b|invalid[_ ]token|authentication/i.test(`${err.name} ${err.message}`) ? "auth_failed" : "unreachable";
}

/**
 * The codemcp proxy: connects upstream servers, maintains the registry, and serves one MCP server
 * exposing `search`, `describe`, `execute` plus any configured passthrough tools.
 *
 * Human approval: a call that needs one parks the sandbox. If the client supports elicitation, `execute`
 * answers `input_required` with the question and a sealed `{executionId, seq}`; the client's retry carries
 * the answer, and the run continues. That is the 2026-07-28 flow; on 2025 connections the SDK plays the
 * same rounds as server-to-client requests inside one call. Otherwise `execute` returns "paused" with the
 * execution id and call number, and the run is resumed later through `resume()` (from the `approve` tool,
 * a UI, or any other operator channel) in a separate request.
 *
 * One `Proxy` serves any number of MCP connections: `createServer()` builds a server per connection, and
 * every one shares the registry, runs and approvals.
 */
export class Proxy {
  readonly registry: ToolRegistry;
  readonly search = new ToolSearch();
  readonly pins: PinStore;
  /** A server built at construction, for hosts that connect one transport themselves. */
  readonly server: Server;
  readonly config: ResolvedConfig;
  readonly gate: ApprovalGate;
  readonly identity: IdentityProvider;
  private readonly upstreams = new Map<string, Upstream>();
  private readonly servers = new Set<Server>();
  /** Seals approval state that round-trips through the client; the key never leaves this process, nor do the runs it names. */
  private readonly approvalState: RequestStateCodec<ApprovalState>;
  private readonly status = new Map<string, ServerStatus>();
  private readonly bridge: BridgeHost;
  private readonly stubs: StubGenerator;
  private readonly log: (m: string) => void;
  private readonly autoApproveNew: boolean;
  /** Runs that returned "paused" to the client and are waiting for a decision. */
  private readonly parkedRuns = new Map<string, Promise<ExecuteResult>>();
  private passthrough = new Map<string, ToolDescriptor>();
  private refreshing: Promise<void> | undefined;

  constructor(options: ProxyOptions) {
    this.config = ConfigLoader.resolve(options.config);
    this.registry = new ToolRegistry({ hygiene: this.config.descriptionHygiene });
    this.stubs = new StubGenerator(this.config.rootName);
    this.log = options.log ?? ((m) => process.stderr.write(`${m}\n`));
    this.autoApproveNew = options.autoApproveNew ?? this.config.autoApproveNew;
    this.pins = new PinStore(this.config.pinsFile);
    this.gate = new ApprovalGate(this.config.approvalTimeoutMs, this.config.operatorRoles);
    this.identity = options.identity ?? Proxy.identityFrom(this.config.identity);
    const audit = Proxy.auditSink(this.config, options);
    this.bridge = new BridgeHost({
      registry: this.registry,
      executor: options.executor ?? new QuickJsExecutor(),
      callUpstream: (tool, args, ctx) => this.callUpstream(tool, args, ctx),
      policy: new Policy(this.config.policy ?? {}),
      pins: this.pins,
      budget: this.config.budget ?? {},
      audit,
      auditArgs: this.config.auditIncludeArgs,
      auditRequired: this.config.auditRequired,
      auditCode: this.config.auditIncludeCode,
      auditResults: this.config.auditIncludeResults,
      limits: this.config.limits,
      // Every approval parks; the request that started the run decides how the human is asked.
      approvals: (req) => this.gate.request(req),
    });
    this.approvalState = createRequestStateCodec<ApprovalState>({
      key: randomBytes(32),
      ttlSeconds: Math.ceil(this.config.approvalTimeoutMs / 1000),
      bind: (ctx) => ctx.mcpReq.method,
    });
    this.server = this.createServer();
  }

  /**
   * Build one MCP server. `serveStdio` and HTTP hosting call this per connection (and once more for a discarded
   * era probe); hosts that wire a single transport use `server`.
   */
  createServer(): Server {
    const server = new Server(
      { name: "codemcp", version: "0.0.1" },
      {
        capabilities: { tools: { listChanged: true } },
        // Approval rounds are human-paced, and one script may need several.
        inputRequired: { maxRounds: APPROVAL_ROUNDS, roundTimeoutMs: this.config.approvalTimeoutMs },
        requestState: { verify: this.approvalState.verify },
      },
    );
    this.servers.add(server);
    server.onclose = () => void this.servers.delete(server);
    // Built per request: whether `approve` is advertised depends on whether this client can show a form.
    server.setRequestHandler("tools/list", async (_req, ctx) => ({ tools: this.buildAdvertised(canElicit(server, ctx)) }));
    server.setRequestHandler("tools/call", async (req, ctx) => {
      const args = (req.params.arguments ?? {}) as Record<string, unknown>;
      const meta = req.params._meta as { traceparent?: string; progressToken?: string | number } | undefined;
      const progress = meta?.progressToken;
      const principal = await this.identity.resolve(Proxy.identityContext(ctx));
      if (!principal) return { content: [{ type: "text", text: `Unauthenticated: the ${this.identity.name} identity provider could not resolve a principal for this request` }], isError: true };
      const call: CallContext = {
        principal,
        traceparent: meta?.traceparent,
        signal: ctx.mcpReq.signal,
        canElicit: canElicit(server, ctx),
        // Log lines become progress notifications when the client asked for progress.
        onLog:
          progress === undefined
            ? undefined
            : (entry: LogEntry) => void ctx.mcpReq.notify({ method: "notifications/progress", params: { progressToken: progress, progress: entry.t, message: `[${entry.level}] ${entry.message}` } }).catch(() => undefined),
      };
      try {
        // A retry that carries approval state answers the question the previous round asked.
        const state = ctx.mcpReq.requestState<ApprovalState>();
        const outcome = state ? await this.answerApproval(state, ctx, call) : await this.handleTool(req.params.name, args, call);
        if (outcome.pending && call.canElicit) return this.askForApproval(outcome.pending, ctx);
        return { content: [{ type: "text", text: outcome.text }], isError: outcome.isError };
      } catch (err) {
        return { content: [{ type: "text", text: (err as Error).message }], isError: true };
      }
    });
    return server;
  }

  /** Connect every configured upstream and build the registry. A server that fails is recorded, not fatal. */
  async start(): Promise<void> {
    await this.pins.load();
    await Promise.all(Object.entries(this.config.servers).map(([name, cfg]) => this.connect(name, cfg)));
    await this.refresh();
  }

  /** Open one upstream connection and record its state; a failure is logged, never thrown. */
  private async connect(name: string, cfg: ServerConfig): Promise<void> {
    const up = new Upstream(name, cfg, () => void this.refresh([name]));
    try {
      await up.connect();
      this.upstreams.set(name, up);
      this.status.set(name, { name, state: "connected", tools: 0 });
    } catch (err) {
      const e = err as Error;
      this.status.set(name, { name, state: classifyConnectError(e), tools: 0, error: e.message });
      this.log(`[codemcp] ${this.status.get(name)?.state} "${name}": ${e.message}`);
    }
  }

  /** Connection state of every configured server, for the model (via search/describe), the CLI and operators. */
  serverStatus(): ServerStatus[] {
    return Object.keys(this.config.servers).map((name) => this.status.get(name) ?? { name, state: "unreachable", tools: 0 });
  }

  /** Connect one more upstream at runtime. Replaces a server of the same name. Secrets in `cfg` are used as given. */
  async addServer(name: string, cfg: ServerConfig): Promise<ServerStatus> {
    ConfigLoader.validate({ servers: { [name]: cfg } }, `server "${name}"`);
    await this.removeServer(name);
    this.config.servers[name] = cfg;
    await this.connect(name, cfg);
    await this.refresh([name]);
    return this.status.get(name)!;
  }

  /** Disconnect an upstream and drop its tools. */
  async removeServer(name: string): Promise<void> {
    const up = this.upstreams.get(name);
    if (up) {
      this.upstreams.delete(name);
      await up.close();
    }
    this.registry.removeServer(name);
    this.status.delete(name);
    delete this.config.servers[name];
    this.search.replace(this.registry.list());
    this.rebuildPassthrough();
  }

  /** The current server map, for saving a config edited at runtime. */
  serverConfigs(): Record<string, ServerConfig> {
    return { ...this.config.servers };
  }

  /** File or stderr from config, plus an optional webhook and an optional callback, all receiving the same events. */
  private static auditSink(config: ResolvedConfig, options: ProxyOptions): AuditSink {
    const sinks: AuditSink[] = [];
    if (options.audit) sinks.push(options.audit);
    else if (config.auditStderr) sinks.push(new StderrSink());
    else if (config.auditFile) sinks.push(new JsonlFileSink(config.auditFile));
    if (config.auditWebhook) sinks.push(new HttpSink(config.auditWebhook));
    if (options.onAudit) sinks.push(new CallbackSink(options.onAudit));
    return sinks.length === 0 ? new NullSink() : sinks.length === 1 ? sinks[0]! : new MultiSink(sinks);
  }

  private static identityFrom(cfg: ResolvedConfig["identity"]): IdentityProvider {
    switch (cfg.mode) {
      case "static":
        return new StaticTokenIdentityProvider(cfg.tokens);
      case "trusted-header":
        return new TrustedHeaderIdentityProvider(cfg.header, cfg.rolesHeader);
      default:
        return new LocalIdentityProvider();
    }
  }

  /** What the transport layer knows about the caller. The SDK exposes HTTP details only on HTTP transports. */
  private static identityContext(ctx: ServerContext): IdentityContext {
    const req = ctx.http?.req;
    if (!req) return { transport: "stdio" };
    // v2 hands over a Web `Request`; identity providers read a plain record keyed by lower-case name.
    const headers = Object.fromEntries(req.headers.entries());
    return { transport: "http", headers, ...(ctx.http?.authInfo ? { authInfo: ctx.http.authInfo as IdentityContext["authInfo"] } : {}) };
  }

  /** Re-list tools for the given servers (default: all) in parallel, then rebuild derived state. */
  async refresh(servers: string[] = [...this.upstreams.keys()]): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      await Promise.all(
        servers.map(async (name) => {
          const up = this.upstreams.get(name);
          if (!up) return;
          try {
            const tools = this.registry.setServerTools(name, await up.listTools());
            this.status.set(name, { name, state: "connected", tools: tools.length, ...(up.era ? { era: up.era } : {}) });
            for (const t of tools) if (t.hygiene) this.log(`[codemcp] cleaned ${t.qualifiedName}: ${t.hygiene.join("; ")}`);
          } catch (err) {
            this.status.set(name, { name, state: "listing_failed", tools: 0, error: (err as Error).message });
            this.log(`[codemcp] failed to list tools for "${name}": ${(err as Error).message}`);
          }
        }),
      );
      const tools = this.registry.list();
      this.search.replace(tools);
      if (this.autoApproveNew) {
        const { approved, drifted } = this.pins.approveAll(tools);
        if (approved.length) await this.pins.save();
        for (const t of drifted) this.log(`[codemcp] BLOCKED: ${t.qualifiedName} changed since it was approved; run "codemcp approve" after reviewing`);
      }
      this.rebuildPassthrough();
      this.log(`[codemcp] ${tools.length} tools from ${this.registry.servers().length} servers`);
      await Promise.all([...this.servers].map((s) => s.sendToolListChanged().catch(() => undefined)));
    })().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  async close(): Promise<void> {
    await Promise.all([...this.upstreams.values()].map((u) => u.close()));
    await Promise.all([...this.servers].map((s) => s.close().catch(() => undefined)));
  }

  /** The advertised tools as a client without elicitation sees them. */
  listTools(): Tool[] {
    return this.buildAdvertised(false);
  }

  /** `approve` is advertised when configured on, or in `auto` mode when the client cannot show an elicitation. */
  private approveToolExposed(canElicit: boolean): boolean {
    const mode = this.config.approvalsTool;
    return mode === true || (mode === "auto" && !canElicit);
  }

  /**
   * Record a human decision for a parked call and wait for the run to finish or park again.
   * This is the operator entry point; the `approve` tool and the playground both call it.
   */
  async resume(executionId: string, seq: number, allow: boolean, by?: Principal): Promise<string> {
    return (await this.resumeOutcome(executionId, seq, allow, by, false)).text;
  }

  private async resumeOutcome(executionId: string, seq: number, allow: boolean, by: Principal | undefined, canElicit: boolean): Promise<Outcome> {
    const run = this.parkedRuns.get(executionId);
    if (!run) throw new Error(`No parked execution ${executionId}`);
    const decided = this.gate.decide(executionId, seq, allow, by);
    if (decided === "not_found") throw new Error(`Execution ${executionId} has no call #${seq} waiting for approval`);
    if (decided === "forbidden") throw new Error(`Execution ${executionId} belongs to another principal; only its owner or an operator may decide`);
    return this.settle(executionId, run, canElicit);
  }

  /** Ask the client's human about a parked call: the question, plus sealed state naming the call it is about. */
  private async askForApproval(p: PendingApproval, ctx: ServerContext) {
    const shownArgs = JSON.stringify(p.args).slice(0, 500);
    return inputRequired({
      inputRequests: {
        [APPROVAL_INPUT]: inputRequired.elicit({
          message: `Allow ${p.tool}(${shownArgs})? This tool is marked destructive or requires approval.`,
          requestedSchema: DECISION_SCHEMA,
        }),
      },
      requestState: await this.approvalState.mint({ executionId: p.executionId, seq: p.seq }, ctx),
    });
  }

  /** Apply the answer a retried request carries. Anything but an explicit "allow", including no answer, denies. */
  private async answerApproval(state: ApprovalState, ctx: ServerContext, call: CallContext): Promise<Outcome> {
    const answer = inputResponse(ctx.mcpReq.inputResponses, APPROVAL_INPUT);
    const allow = answer.kind === "elicit" && answer.action === "accept" && (answer.content as { decision?: unknown } | undefined)?.decision === "allow";
    return this.resumeOutcome(state.executionId, state.seq, allow, call.principal, call.canElicit);
  }

  /** Wait for a run to finish, or return a "paused" outcome the moment one of its calls parks. */
  private async settle(executionId: string, run: Promise<ExecuteResult>, canElicit: boolean): Promise<Outcome> {
    const pending = this.gate.nextPending(executionId);
    try {
      const outcome = await Promise.race([run.then((r) => ({ done: r })), pending.promise.then((p) => ({ paused: p }))]);
      if ("done" in outcome) {
        this.parkedRuns.delete(executionId);
        return { text: formatResult(outcome.done), isError: outcome.done.status === "error" };
      }
      this.parkedRuns.set(executionId, run);
      return { text: this.pausedMessage(outcome.paused, canElicit), isError: false, pending: outcome.paused };
    } finally {
      pending.cancel();
    }
  }

  private pausedMessage(p: PendingApproval, canElicit: boolean): string {
    const how = this.approveToolExposed(canElicit)
      ? `Ask the user, then call ${APPROVE_TOOL} with {"executionId":"${p.executionId}","seq":${p.seq},"allow":true|false}.`
      : `A human must approve it out of band (operator UI or CLI); you cannot approve it yourself.`;
    return `Paused: execution ${p.executionId} is waiting for approval of call #${p.seq} ${p.tool}(${JSON.stringify(p.args)}). ${how} The script stays parked until ${p.expiresAt}; the final result comes back once a decision is made.`;
  }

  private rebuildPassthrough(): void {
    const patterns = this.config.passthrough.map(compilePattern);
    this.passthrough = new Map(
      this.registry
        .list()
        .filter((t) => patterns.some((re) => re.test(t.qualifiedName)))
        .map((t) => [passthroughName(t), t]),
    );
  }

  private buildAdvertised(canElicit: boolean): Tool[] {
    const servers = this.registry.servers();
    const base: Tool[] = [
      {
        name: SURFACE.search.name,
        description: SURFACE.search.description,
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Keywords, a tool name fragment, or a short task description." },
            limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
          },
          required: ["query"],
        },
        annotations: { readOnlyHint: true },
      },
      {
        name: SURFACE.describe.name,
        description: `${SURFACE.describe.description} Servers: ${servers.join(", ") || "(none connected)"}.`,
        inputSchema: {
          type: "object",
          properties: {
            tools: { type: "array", items: { type: "string" }, description: "Qualified names (server.tool) or stub paths (tools.server.tool)." },
            server: { type: "string", description: "Describe every tool of this server instead." },
            detail: { type: "string", enum: [...STUB_DETAILS], default: "signatures" },
          },
        },
        annotations: { readOnlyHint: true },
      },
      {
        name: SURFACE.execute.name,
        description: `${SURFACE.execute.description}\n${executeInstructions(this.config.rootName)}`,
        inputSchema: {
          type: "object",
          properties: { code: { type: "string", description: "Body of an async function. Use `return` for the result." } },
          required: ["code"],
        },
        annotations: { openWorldHint: true, destructiveHint: true },
      },
    ];
    if (this.approveToolExposed(canElicit)) {
      base.push({
        name: APPROVE_TOOL,
        description: "Resume an execution that paused for approval. Only call this after a human has explicitly decided.",
        inputSchema: {
          type: "object",
          properties: { executionId: { type: "string" }, seq: { type: "integer" }, allow: { type: "boolean" } },
          required: ["executionId", "seq", "allow"],
        },
      });
    }
    const passthrough = [...this.passthrough].map<Tool>(([name, t]) => ({
      name,
      ...(t.description !== undefined ? { description: t.description } : {}),
      inputSchema: t.inputSchema as Tool["inputSchema"],
      ...(t.annotations ? { annotations: t.annotations } : {}),
    }));
    return [...base, ...passthrough];
  }

  private async handleTool(name: string, args: Record<string, unknown>, ctx: CallContext): Promise<Outcome> {
    const ok = (text: string): Outcome => ({ text, isError: false });
    switch (name) {
      case SURFACE.search.name:
        return ok(this.handleSearch(String(args.query ?? ""), Number(args.limit ?? 10)));
      case SURFACE.describe.name:
        return ok(this.handleDescribe(args));
      case SURFACE.execute.name: {
        const executionId = randomUUID();
        return this.settle(executionId, this.bridge.run(String(args.code ?? ""), { executionId, traceparent: ctx.traceparent, signal: ctx.signal, onLog: ctx.onLog, principal: ctx.principal }), ctx.canElicit);
      }
      case APPROVE_TOOL:
        if (!this.approveToolExposed(ctx.canElicit)) throw new Error(`Unknown tool: ${name}`);
        return this.resumeOutcome(String(args.executionId ?? ""), Number(args.seq), Boolean(args.allow), ctx.principal, ctx.canElicit);
      default: {
        const tool = this.passthrough.get(name);
        if (!tool) throw new Error(`Unknown tool: ${name}`);
        return ok(renderJson(await this.callUpstream(tool, args as JsonValue, { signal: ctx.signal, timeoutMs: 60_000, ...(ctx.traceparent !== undefined ? { traceparent: ctx.traceparent } : {}) })));
      }
    }
  }

  private handleSearch(query: string, limit: number): string {
    const hits = this.search.search(query, Math.min(50, Math.max(1, limit || 10)));
    if (hits.length === 0) return `No tools matched "${query}". ${this.registry.size} tools are available; try broader keywords or describe a server: ${this.registry.servers().join(", ")}.${this.unavailableNote()}`;
    return this.stubs.generate(hits, "names");
  }

  /** Tells the model which configured servers are missing and why, so "unknown tool" is not a dead end. */
  private unavailableNote(): string {
    const down = this.serverStatus().filter((s) => s.state !== "connected");
    if (down.length === 0) return "";
    return ` Unavailable servers: ${down.map((s) => `${s.name} (${s.state.replace("_", " ")})`).join(", ")}; their tools cannot be called until an operator fixes them.`;
  }

  private handleDescribe(args: Record<string, unknown>): string {
    const detail = parseStubDetail(args.detail);
    let tools: ToolDescriptor[];
    if (typeof args.server === "string") {
      tools = this.registry.toolsForServer(args.server);
      if (tools.length === 0) {
        const down = this.serverStatus().find((s) => s.name === args.server && s.state !== "connected");
        if (down) throw new Error(`Server "${down.name}" is configured but ${down.state.replace("_", " ")}${down.error ? `: ${down.error}` : ""}. An operator must fix it; its tools cannot be called.`);
        throw new Error(`No server named "${args.server}". Servers: ${this.registry.servers().join(", ")}`);
      }
    } else if (Array.isArray(args.tools) && args.tools.length > 0) {
      tools = [];
      const missing: string[] = [];
      for (const ref of args.tools.map(String)) {
        const t = this.resolveRef(ref);
        if (t) tools.push(t);
        else missing.push(ref);
      }
      if (missing.length) throw new Error(`Unknown tools: ${missing.join(", ")}. Use search first.`);
    } else {
      tools = this.registry.list();
      if (tools.length > 60 && detail !== "names") {
        return `${tools.length} tools across ${this.registry.servers().length} servers; too many to describe at once. Narrow with "server" or "tools", or use detail=names.\n\n${this.stubs.generate(tools, "names")}`;
      }
    }
    return this.stubs.generate(tools, detail);
  }

  /** Accepts `server.tool`, `ns.stub` or `tools.ns.stub`. */
  private resolveRef(ref: string): ToolDescriptor | undefined {
    const root = `${this.config.rootName}.`;
    const key = ref.startsWith(root) ? ref.slice(root.length) : ref;
    return this.registry.get(key) ?? this.registry.getByStubKey(key);
  }

  private async callUpstream(tool: ToolDescriptor, args: JsonValue, ctx: UpstreamCallContext): Promise<JsonValue> {
    const up = this.upstreams.get(tool.server);
    if (!up) throw new Error(`server "${tool.server}" is not connected`);
    return up.callTool(tool.name, args, ctx);
  }
}

interface Outcome {
  text: string;
  isError: boolean;
  /** Set when the run parked; `text` is then the "paused" message for a client that cannot be asked. */
  pending?: PendingApproval;
}

interface CallContext {
  principal: Principal;
  traceparent: string | undefined;
  signal: AbortSignal;
  /** Whether this request's client can show an elicitation form. */
  canElicit: boolean;
  onLog: ((entry: LogEntry) => void) | undefined;
}

/** From the 2026-07-28 per-request envelope when there is one, else the 2025 `initialize` handshake. */
function canElicit(server: Server, ctx: ServerContext): boolean {
  const envelope = ctx.mcpReq.envelope as Record<string, { elicitation?: unknown } | undefined> | undefined;
  return Boolean(envelope?.[CLIENT_CAPABILITIES_META_KEY]?.elicitation ?? server.getClientCapabilities()?.elicitation);
}

/** MCP tool name under which a passthrough tool is advertised. `__` because `.` is not allowed in tool names by some clients. */
function passthroughName(t: ToolDescriptor): string {
  return `${t.stubNamespace}__${t.stubName}`;
}

function renderJson(v: JsonValue | undefined): string {
  return typeof v === "string" ? v : JSON.stringify(v ?? null, null, 2);
}

/** Render an execution result for the model: compact, with logs and a one-line call summary. */
export function formatResult(r: ExecuteResult): string {
  const parts: string[] = [];
  if (r.status === "completed") parts.push(renderJson(r.value));
  else if (r.error) parts.push(`Error (${r.error.code}): ${r.error.message}`);
  if (r.logs.length) parts.push(`--- logs ---\n${r.logs.map((l) => `[${l.level}] ${l.message}`).join("\n")}`);
  const failed = r.calls.filter((c) => !c.ok);
  parts.push(`--- ${r.calls.length} tool call${r.calls.length === 1 ? "" : "s"}${failed.length ? `, ${failed.length} failed` : ""}, ${r.durationMs} ms ---`);
  if (failed.length) parts.push(failed.map((c) => `  #${c.seq} ${c.tool}: ${c.errorCode}: ${c.error}`).join("\n"));
  return parts.join("\n");
}
