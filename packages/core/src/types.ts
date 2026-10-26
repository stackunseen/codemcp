/** A JSON Schema object as returned by MCP `tools/list`. Treated as opaque data; never executed. */
export type JsonSchema = Record<string, unknown>;

/** Any JSON value. The bridge carries nothing else. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** Tool annotations from the MCP spec (2025-03-26 onward). All optional hints; never trusted alone for security. */
export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** A tool as advertised by an upstream server, before namespacing. */
export interface UpstreamTool {
  name: string;
  description?: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  annotations?: ToolAnnotations;
}

/** A tool registered in the proxy, namespaced by its server. */
export interface ToolDescriptor extends UpstreamTool {
  /** Config name of the upstream server, e.g. `github`. */
  server: string;
  /** Identifier-safe name used in generated stubs, e.g. `create_issue`. */
  stubName: string;
  /** Identifier-safe server name used as the stub namespace, e.g. `github`. */
  stubNamespace: string;
  /** `server.tool` using the raw upstream names: the policy and audit key, e.g. `github.create-issue`. */
  qualifiedName: string;
  /** `stubNamespace.stubName`: the key the guest uses to call the tool. */
  stubKey: string;
  /** sha256 over name, description and input schema; used for pinning. */
  descriptionHash: string;
}

export type PolicyDecision = "allow" | "deny" | "approve";

export type LogLevel = "log" | "info" | "warn" | "error";

export interface LogEntry {
  level: LogLevel;
  message: string;
  /** Milliseconds since execution start. */
  t: number;
}

export interface CallRecord {
  seq: number;
  tool: string;
  /** Milliseconds since execution start. */
  startedAt: number;
  durationMs: number;
  ok: boolean;
  decision: PolicyDecision;
  /** Bridge error code when `ok` is false. */
  errorCode?: string;
  error?: string;
  resultBytes?: number;
}

import type { BRIDGE_ERRORS, EXECUTION_CODES } from "./generated/spec.js";

/** Codes an executor raises itself, plus the fatal bridge codes. Both lists come from the spec. */
export type ExecutionErrorCode = (typeof EXECUTION_CODES)[number] | { [K in keyof typeof BRIDGE_ERRORS]: (typeof BRIDGE_ERRORS)[K]["fatal"] extends true ? K : never }[keyof typeof BRIDGE_ERRORS];

export interface ExecutionError {
  code: ExecutionErrorCode;
  message: string;
  /** Guest stack trace if the executor can provide one. */
  stack?: string;
}

export interface ExecuteResult {
  status: "completed" | "error";
  /** The value the script returned, JSON only. Present when status is `completed`. */
  value?: JsonValue;
  logs: LogEntry[];
  calls: CallRecord[];
  error?: ExecutionError;
  durationMs: number;
}

/**
 * A host function exposed into the sandbox. Receives and returns JSON only.
 * Throw `BridgeCallError` to reject the call inside the guest with a code; any other error becomes
 * `upstream_error`. A fatal code (see `BRIDGE_ERRORS`) also ends the execution, even if the script catches it.
 */
export type HostFunction = (args: JsonValue) => Promise<JsonValue>;

/** The limits an operator may configure per execution. */
export interface ExecuteLimits {
  /** Wall-clock limit enforced by the host. */
  timeoutMs?: number;
  /** Guest heap limit in bytes where the executor supports it. */
  memoryLimitBytes?: number;
  /** Guest stack limit in bytes where the executor supports it. */
  maxStackBytes?: number;
  /** Maximum log entries kept; later entries are dropped with one warning. */
  maxLogEntries?: number;
  /** Maximum total bytes of log text kept; later entries are dropped with one warning. */
  maxLogBytes?: number;
}

export const DEFAULT_EXECUTE_LIMITS: Required<ExecuteLimits> = {
  timeoutMs: 30_000,
  memoryLimitBytes: 64 * 1024 * 1024,
  maxStackBytes: 1024 * 1024,
  maxLogEntries: 500,
  maxLogBytes: 16 * 1024,
};

export interface ExecuteOptions extends ExecuteLimits {
  /** Aborting ends the execution with `cancelled`; executors must also stop forwarding calls. */
  signal?: AbortSignal;
  /** Receives each log entry as it is produced, for streaming to the client. */
  onLog?: (entry: LogEntry) => void;
}

/** The executor contract. Kept to `execute(code, fns)` so executors from other code-mode runtimes can be adapted without glue. */
export interface Executor {
  readonly name: string;
  execute(code: string, fns: Record<string, HostFunction>, options?: ExecuteOptions): Promise<ExecuteResult>;
}

/** Drop keys whose value is `undefined` so spreads do not clobber defaults. */
export function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}
