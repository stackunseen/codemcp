import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_ROOT_NAME, readJsonFile, SERVER_NAME_RE, type BudgetConfig, type ExecuteLimits, type HttpSinkOptions, type PolicyConfig, type Principal } from "codemcp-core";

export interface StdioServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface HttpServerConfig {
  url: string;
  headers?: Record<string, string>;
}

export type ServerConfig = StdioServerConfig | HttpServerConfig;

export function isHttpServer(c: ServerConfig): c is HttpServerConfig {
  return typeof (c as HttpServerConfig).url === "string";
}

export interface CodemcpConfig {
  /** Upstream MCP servers keyed by the name used as the stub namespace. */
  servers: Record<string, ServerConfig>;
  /**
   * Qualified-name patterns (`server.tool`, `*` wildcard) to expose directly as ordinary MCP tools in
   * addition to the code-mode surface. Keep this to a few high-frequency tools: single calls are
   * cheaper direct, fan-out and chains are cheaper through `execute`.
   */
  passthrough?: string[];
  policy?: PolicyConfig;
  budget?: BudgetConfig;
  limits?: ExecuteLimits;
  audit?: {
    /** JSONL file. Set to `false` to disable. */
    file?: string | false;
    stderr?: boolean;
    includeArgs?: boolean;
    /** Record the normalized source of every execution so a failure can be reconstructed from the log alone. */
    includeCode?: boolean;
    /** Record each execution's returned value and console output in its end event. */
    includeResults?: boolean;
    /** Also POST batches of events to a collector (SIEM, tracing backend, your own service). */
    webhook?: HttpSinkOptions;
  };
  pins?: {
    /** Pin file. Set to `false` to keep pins in memory only. */
    file?: string | false;
    /** Pin tools automatically the first time they are seen. Drift is always blocked. */
    autoApproveNew?: boolean;
  };
  stubs?: { rootName?: string };
  /**
   * Who requests act for. `local` (default) is the OS user that launched the proxy and only works over
   * stdio. `static` maps bearer tokens from this file to principals. `trusted-header` trusts a header set
   * by a gateway in front of the proxy. Requests without a resolvable principal are refused.
   */
  identity?:
    | { mode?: "local" }
    | { mode: "static"; tokens: Record<string, Principal> }
    | { mode: "trusted-header"; header?: string; rolesHeader?: string };
  approvals?: {
    /**
     * Expose an `approve` tool so the MCP client can resume a parked execution. `"auto"` (default)
     * exposes it only when the client cannot show an elicitation prompt. `true` always exposes it;
     * only do that when the client puts a human in front of the call, otherwise the model approves itself.
     */
    tool?: boolean | "auto";
    /** How long a parked execution waits for a decision before it is denied. Default 10 minutes. */
    timeoutMs?: number;
    /** Roles that may decide any principal's parked call. Default `["operator"]`. */
    operatorRoles?: string[];
  };
}

/** A config with every default applied, so consumers never re-derive one. */
export interface ResolvedConfig extends CodemcpConfig {
  passthrough: string[];
  auditFile: string | undefined;
  auditStderr: boolean;
  auditIncludeArgs: boolean;
  auditIncludeCode: boolean;
  auditIncludeResults: boolean;
  auditWebhook: HttpSinkOptions | undefined;
  pinsFile: string | undefined;
  autoApproveNew: boolean;
  rootName: string;
  approvalsTool: boolean | "auto";
  approvalTimeoutMs: number;
  operatorRoles: string[];
  identity: NonNullable<CodemcpConfig["identity"]>;
}

export const CONFIG_FILENAME = "codemcp.config.json";

/** Finds, validates and resolves the proxy configuration. */
export class ConfigLoader {
  constructor(private readonly cwd: string = process.cwd()) {}

  static home(): string {
    return process.env.CODEMCP_HOME ?? join(homedir(), ".codemcp");
  }

  /** `./codemcp.config.json`, then `~/.codemcp/config.json`. */
  candidatePaths(): string[] {
    return [resolve(this.cwd, CONFIG_FILENAME), join(ConfigLoader.home(), "config.json")];
  }

  /** The path a new config should be written to: the existing file if any, else the project-local name. */
  async targetPath(explicitPath?: string): Promise<string> {
    return (await this.load(explicitPath)).path ?? resolve(this.cwd, CONFIG_FILENAME);
  }

  async load(explicitPath?: string): Promise<{ config: CodemcpConfig; path: string | undefined }> {
    const candidates = explicitPath ? [resolve(this.cwd, explicitPath)] : this.candidatePaths();
    for (const path of candidates) {
      let raw: unknown;
      try {
        raw = await readJsonFile(path);
      } catch (err) {
        throw new Error(`Failed to read config at ${path}: ${(err as Error).message}`);
      }
      if (raw === undefined) {
        if (explicitPath) throw new Error(`Config file not found: ${path}`);
        continue;
      }
      return { config: ConfigLoader.validate(raw, path), path };
    }
    return { config: { servers: {} }, path: undefined };
  }

  static validate(raw: unknown, source = "config"): CodemcpConfig {
    if (!raw || typeof raw !== "object") throw new Error(`${source}: expected an object`);
    const cfg = raw as Partial<CodemcpConfig>;
    const servers = cfg.servers ?? {};
    if (typeof servers !== "object") throw new Error(`${source}: "servers" must be an object`);
    for (const [name, s] of Object.entries(servers)) {
      if (!SERVER_NAME_RE.test(name)) throw new Error(`${source}: server name "${name}" may only contain letters, digits, _ and -`);
      const hasCmd = typeof (s as StdioServerConfig).command === "string";
      const hasUrl = typeof (s as HttpServerConfig).url === "string";
      if (hasCmd === hasUrl) throw new Error(`${source}: server "${name}" needs exactly one of "command" or "url"`);
    }
    return { ...cfg, servers } as CodemcpConfig;
  }

  /**
   * Replace `${NAME}` in server `env`, `headers` and `url` values with the process environment, so
   * secrets live in the environment (or a secret manager that populates it) rather than in the file.
   * An unset variable is an error: a silently empty token is harder to debug than a refusal to start.
   */
  static expandSecrets(servers: Record<string, ServerConfig>, env: NodeJS.ProcessEnv = process.env): Record<string, ServerConfig> {
    const expand = (value: string, where: string): string =>
      value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_, name: string) => {
        const v = env[name];
        if (v === undefined) throw new Error(`${where} references $\{${name}} but it is not set in the environment`);
        return v;
      });
    const expandMap = (map: Record<string, string> | undefined, where: string): Record<string, string> | undefined =>
      map && Object.fromEntries(Object.entries(map).map(([k, v]) => [k, expand(v, `${where}.${k}`)]));
    const out: Record<string, ServerConfig> = {};
    for (const [name, s] of Object.entries(servers)) {
      out[name] = isHttpServer(s)
        ? { ...s, url: expand(s.url, `servers.${name}.url`), ...(s.headers ? { headers: expandMap(s.headers, `servers.${name}.headers`) } : {}) }
        : { ...s, ...(s.env ? { env: expandMap(s.env, `servers.${name}.env`) } : {}) };
    }
    return out;
  }

  static resolve(config: CodemcpConfig, env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
    const home = ConfigLoader.home();
    return {
      ...config,
      servers: ConfigLoader.expandSecrets(config.servers, env),
      passthrough: config.passthrough ?? [],
      auditFile: config.audit?.file === false ? undefined : (config.audit?.file ?? join(home, "audit.jsonl")),
      auditStderr: config.audit?.stderr ?? false,
      auditIncludeArgs: config.audit?.includeArgs ?? false,
      auditIncludeCode: config.audit?.includeCode ?? false,
      auditIncludeResults: config.audit?.includeResults ?? false,
      auditWebhook: config.audit?.webhook,
      pinsFile: config.pins?.file === false ? undefined : (config.pins?.file ?? join(home, "pins.json")),
      autoApproveNew: config.pins?.autoApproveNew ?? true,
      rootName: config.stubs?.rootName ?? DEFAULT_ROOT_NAME,
      approvalsTool: config.approvals?.tool ?? "auto",
      approvalTimeoutMs: config.approvals?.timeoutMs ?? 10 * 60_000,
      operatorRoles: config.approvals?.operatorRoles ?? ["operator"],
      identity: config.identity ?? { mode: "local" },
    };
  }
}
