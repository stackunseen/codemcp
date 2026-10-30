import { Ajv, type ValidateFunction } from "ajv";
import { randomUUID } from "node:crypto";
import { NullSink, type AuditEvent, type AuditSink } from "../audit.js";
import { sha256 } from "../hash.js";
import { Budget, truncateSerialized, type BudgetConfig } from "../limits.js";
import { CodeNormalizer, type NormalizeResult } from "../normalize.js";
import { PinStore } from "../pins.js";
import { Policy } from "../policy.js";
import type { ToolRegistry } from "../registry.js";
import type { ApprovalDecision, ApprovalRequest } from "../approvals.js";
import type { Principal } from "../identity.js";
import { stripUndefined, type CallRecord, type ExecuteLimits, type ExecuteResult, type ExecutionErrorCode, type Executor, type HostFunction, type JsonValue, type LogEntry, type ToolDescriptor } from "../types.js";
import { asBridgeError, BridgeCallError, toPlainJson } from "./protocol.js";

/** Per-call context handed to the upstream caller. */
export interface UpstreamCallContext {
  /** Aborted when the call times out or the execution is cancelled; the caller must stop the request. */
  signal: AbortSignal;
  /** Milliseconds the call may take. */
  timeoutMs: number;
  traceparent?: string;
}

/** Forwards an approved, validated call to the upstream server. Owned by the proxy, which holds credentials. */
export type UpstreamCaller = (tool: ToolDescriptor, args: JsonValue, ctx: UpstreamCallContext) => Promise<JsonValue>;

/**
 * Ask a human whether this call may proceed. Resolve `true` or `{ allow: true }` to allow. `false`, a rejection,
 * or `{ allow: false }` denies; give a `reason` so the script's error says whether a person refused or the
 * request expired unanswered.
 */
export type ApprovalHandler = (request: ApprovalRequest) => Promise<boolean | ApprovalDecision>;

export interface BridgeHostOptions {
  registry: ToolRegistry;
  executor: Executor;
  callUpstream: UpstreamCaller;
  policy?: Policy;
  pins?: PinStore;
  budget?: BudgetConfig;
  audit?: AuditSink;
  /** Without a handler, `approve` decisions are denied. */
  approvals?: ApprovalHandler;
  /** Include call arguments in the audit log. Off by default because arguments may contain sensitive data. */
  auditArgs?: boolean;
  /** Include the normalized source in the audit log, so a failed run can be reconstructed. Off by default. */
  auditCode?: boolean;
  /** Include each execution's returned value and logs in its `execution_end` event. Off by default. */
  auditResults?: boolean;
  /**
   * Fail closed: when the sink refuses the `call_start` record, do not forward the call and end the
   * execution with `audit_unavailable`. Off by default, where a failing sink is logged to the `call`
   * event's error and the call proceeds.
   */
  auditRequired?: boolean;
  limits?: ExecuteLimits;
  /** How long one upstream call may take before it fails with `upstream_error`. Default 60 s. Approvals have their own clock. */
  upstreamTimeoutMs?: number;
}

export interface RunOptions {
  /** W3C trace context to attach to audit events and forward upstream. */
  traceparent?: string;
  /** Supplied by callers that need to correlate approvals with this run; generated otherwise. */
  executionId?: string;
  /** Cancels the execution and every in-flight upstream call. */
  signal?: AbortSignal;
  /** Receives log entries as the script produces them. */
  onLog?: (entry: LogEntry) => void;
  /** Who the execution acts for; consulted by policy and approvals, recorded in the audit log. */
  principal?: Principal;
}

/**
 * Host side of the bridge. Every model-initiated tool call passes through here in this order:
 * pin check, policy, approval, schema validation, budget, audit (call_start), forward, size cap, audit (call).
 * Only JSON crosses in either direction; credentials stay inside `callUpstream`.
 */
export class BridgeHost {
  private readonly opts: Required<Omit<BridgeHostOptions, "approvals" | "limits">> & Pick<BridgeHostOptions, "approvals" | "limits">;
  // Formats (email, uri, ...) are not validated here; the upstream server remains the authority on its own schema.
  private readonly ajv = new Ajv({ strict: false, allErrors: false, allowUnionTypes: true, validateFormats: false });
  private readonly validators = new Map<string, ValidateFunction>();
  private readonly normalizer = new CodeNormalizer();

  constructor(options: BridgeHostOptions) {
    this.opts = { policy: new Policy(), pins: new PinStore(), budget: {}, audit: new NullSink(), auditArgs: false, auditCode: false, auditResults: false, auditRequired: false, upstreamTimeoutMs: 60_000, ...stripUndefined(options) } as typeof this.opts;
  }

  /** Normalize, syntax-check and run `code`, exposing every registered tool through the bridge. */
  async run(code: string, options: RunOptions = {}): Promise<ExecuteResult> {
    const executionId = options.executionId ?? randomUUID();
    const started = Date.now();
    const trace = stripUndefined({ traceparent: options.traceparent, principal: options.principal?.id });
    const budget = new Budget(this.opts.budget);
    const calls: CallRecord[] = [];
    const run = new AbortController();
    const onAbort = (): void => run.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) run.abort();
    let fatal: BridgeCallError | undefined;

    let normalized: NormalizeResult;
    try {
      normalized = this.normalizer.normalize(code);
    } catch (err) {
      const result: ExecuteResult = { status: "error", logs: [], calls, error: { code: "syntax_error", message: (err as Error).message }, durationMs: Date.now() - started };
      this.write({ type: "execution_start", executionId, ts: iso(started), ...trace, codeHash: sha256(code), codeBytes: Buffer.byteLength(code), fixes: [], executor: this.opts.executor.name, ...(this.opts.auditCode ? { code } : {}) });
      await this.end(executionId, trace, result);
      return result;
    }
    this.write({ type: "execution_start", executionId, ts: iso(started), ...trace, codeHash: sha256(normalized.code), codeBytes: Buffer.byteLength(normalized.code), fixes: normalized.fixes, executor: this.opts.executor.name, ...(this.opts.auditCode ? { code: normalized.code } : {}) });

    let seq = 0;
    const fns: Record<string, HostFunction> = {};
    for (const tool of this.opts.registry.list()) {
      fns[tool.stubKey] = async (rawArgs) => {
        const callStart = Date.now();
        const args = toPlainJson(rawArgs);
        const record: CallRecord = { seq: ++seq, tool: tool.qualifiedName, startedAt: callStart - started, durationMs: 0, ok: false, decision: "deny" };
        calls.push(record);
        const base = { executionId, ...trace, seq: record.seq, tool: tool.qualifiedName, ...(this.opts.auditArgs ? { args } : {}) };
        try {
          const { value, bytes, truncated } = await this.handleCall(executionId, tool, args, budget, record, run.signal, options, base);
          Object.assign(record, { ok: true, durationMs: Date.now() - callStart, resultBytes: bytes });
          this.write({ type: "call", ...base, ts: iso(), decision: record.decision, ok: true, durationMs: record.durationMs, resultBytes: bytes, truncated, ...(record.auditError ? { auditError: record.auditError } : {}) });
          return value;
        } catch (err) {
          const e = asBridgeError(err);
          Object.assign(record, { durationMs: Date.now() - callStart, errorCode: e.code, error: e.message });
          this.write({ type: "call", ...base, ts: iso(), decision: record.decision, ok: false, durationMs: record.durationMs, error: `${e.code}: ${e.message}`, ...(record.auditError ? { auditError: record.auditError } : {}) });
          if (e.fatal) {
            fatal ??= e;
            throw e;
          }
          // Non-fatal errors surface to the script so the model can self-correct; the tool name helps it do so.
          throw new BridgeCallError(e.code, e.message.startsWith(tool.qualifiedName) ? e.message : `${tool.qualifiedName}: ${e.message}`);
        }
      };
    }

    let result: ExecuteResult;
    try {
      result = await this.opts.executor.execute(normalized.code, fns, { ...stripUndefined(this.opts.limits ?? {}), signal: run.signal, ...(options.onLog ? { onLog: options.onLog } : {}) });
    } catch (err) {
      result = { status: "error", logs: [], calls: [], error: { code: "executor_failure", message: (err as Error).message }, durationMs: 0 };
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
    }
    result.calls = calls;
    result.durationMs = Date.now() - started;
    if (result.error?.line !== undefined) result.error = locateInInput(result.error, normalized.lineOffset);

    if (fatal) {
      result = withError(result, { code: fatal.code as ExecutionErrorCode, message: fatal.message });
    } else if (result.status === "completed" && result.value !== undefined) {
      const bytes = Buffer.byteLength(JSON.stringify(result.value));
      if (bytes > budget.limits.maxReturnBytes) {
        result = withError(result, { code: "result_too_large", message: `Returned value is ${bytes} bytes; limit is ${budget.limits.maxReturnBytes}. Return a summary or a subset.` });
      }
    }

    await this.end(executionId, trace, result);
    return result;
  }

  private async handleCall(
    executionId: string,
    tool: ToolDescriptor,
    args: JsonValue,
    budget: Budget,
    record: CallRecord,
    runSignal: AbortSignal,
    options: RunOptions,
    base: Omit<Extract<AuditEvent, { type: "call_start" }>, "type" | "ts" | "decision">,
  ): Promise<{ value: JsonValue; bytes: number; truncated: boolean }> {
    const { traceparent, principal } = options;
    const pin = this.opts.pins.check(tool);
    if (pin.status === "drifted") {
      this.write({ type: "pin_drift", ts: iso(), tool: tool.qualifiedName, previousHash: pin.pinned?.hash ?? "", currentHash: tool.descriptionHash });
      throw new BridgeCallError("pin_drifted", `Tool definition changed since it was approved; re-approve ${tool.qualifiedName} to use it`);
    }

    record.decision = this.opts.policy.decide(tool, principal);
    if (record.decision === "deny") throw new BridgeCallError("policy_denied", `Policy denies ${tool.qualifiedName}`);
    if (record.decision === "approve") {
      const outcome = this.opts.approvals ? await this.opts.approvals({ executionId, seq: record.seq, tool, args, ...(principal ? { principal } : {}) }).catch(() => false) : false;
      const decision: ApprovalDecision = typeof outcome === "boolean" ? { allow: outcome } : outcome;
      if (!decision.allow) throw new BridgeCallError("approval_required", approvalMessage(tool.qualifiedName, decision.reason, this.opts.approvals !== undefined));
    }

    // Validate before spending budget so an argument mistake does not cost a retry.
    this.validate(tool, args);
    budget.takeCall();

    // The call is in the audit stream before anything leaves the process, so a crash mid-call still leaves a record.
    await this.writeBeforeForward({ type: "call_start", ...base, ts: iso(), decision: record.decision }, record);

    // One controller per call: the run's cancellation and this call's timeout both abort the upstream request.
    const call = new AbortController();
    const onRunAbort = (): void => call.abort();
    runSignal.addEventListener("abort", onRunAbort, { once: true });
    const timer = setTimeout(() => call.abort(), this.opts.upstreamTimeoutMs);
    try {
      if (runSignal.aborted) throw new BridgeCallError("upstream_error", "execution cancelled");
      const raw = await this.opts.callUpstream(tool, args, { signal: call.signal, timeoutMs: this.opts.upstreamTimeoutMs, ...(traceparent !== undefined ? { traceparent } : {}) });
      const { json, bytes, truncated } = truncateSerialized(JSON.stringify(raw ?? null), budget.limits.maxResultBytes);
      budget.takeBytes(bytes);
      return { value: JSON.parse(json) as JsonValue, bytes, truncated };
    } catch (err) {
      if (call.signal.aborted && !(err instanceof BridgeCallError)) {
        throw new BridgeCallError("upstream_error", runSignal.aborted ? "execution cancelled" : `${tool.qualifiedName} did not answer within ${this.opts.upstreamTimeoutMs} ms and was aborted`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
      runSignal.removeEventListener("abort", onRunAbort);
    }
  }

  private validate(tool: ToolDescriptor, args: JsonValue): void {
    const validator = this.validators.get(tool.qualifiedName) ?? this.compile(tool);
    if (!validator(args ?? {})) {
      const detail = (validator.errors ?? []).map((e) => `${e.instancePath || "args"} ${e.message ?? ""}`.trim()).join("; ");
      throw new BridgeCallError("invalid_arguments", `${tool.qualifiedName}: invalid arguments: ${detail}`);
    }
  }

  private compile(tool: ToolDescriptor): ValidateFunction {
    let validator: ValidateFunction;
    try {
      validator = this.ajv.compile(tool.inputSchema);
    } catch {
      // shortcut: an uncompilable schema passes unvalidated (the upstream still validates); surface these in `codemcp tools` before 0.1.0.
      validator = (() => true) as unknown as ValidateFunction;
    }
    this.validators.set(tool.qualifiedName, validator);
    return validator;
  }

  /**
   * Hands the event to the sink synchronously, so events reach the sink in the order they happen whatever
   * the executor's timing. Completion is not awaited per event; the sink is flushed once at the end of
   * the execution. A sink failure here is swallowed: these are records of things that already happened.
   */
  private write(event: AuditEvent): void {
    try {
      const r = this.opts.audit.write(event);
      if (r) r.catch(() => undefined);
    } catch {
      // see above
    }
  }

  /**
   * The one awaited write. A sink that accepts holds the record before the upstream sees the call. A sink
   * that refuses fails the call when `auditRequired` is set; otherwise the call proceeds and the refusal
   * is noted on the `call` event.
   */
  private async writeBeforeForward(event: Extract<AuditEvent, { type: "call_start" }>, record: CallRecord): Promise<void> {
    try {
      await this.opts.audit.write(event);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (this.opts.auditRequired) throw new BridgeCallError("audit_unavailable", `Audit sink refused the record for ${event.tool} (${reason}); the call was not forwarded`);
      record.auditError = reason;
    }
  }

  private async end(executionId: string, trace: { traceparent?: string; principal?: string }, result: ExecuteResult): Promise<void> {
    this.write({
      type: "execution_end",
      executionId,
      ts: iso(),
      ...trace,
      status: result.status,
      durationMs: result.durationMs,
      calls: result.calls.length,
      error: result.error?.message,
      ...(this.opts.auditResults ? { value: result.value ?? null, logs: result.logs } : {}),
    });
    try {
      await this.opts.audit.flush?.();
    } catch {
      // A sink that fails to flush has already reported it through write(); nothing more to do at the end of a run.
    }
  }
}

/** Shift the executor's line past whatever the normalizer removed, and say it in the message so every reader sees it. */
function locateInInput(error: NonNullable<ExecuteResult["error"]>, lineOffset: number): NonNullable<ExecuteResult["error"]> {
  const line = (error.line ?? 0) + lineOffset;
  const where = error.column !== undefined ? `line ${line}, column ${error.column}` : `line ${line}`;
  return { ...error, line, message: error.message.includes(`(${where})`) ? error.message : `${error.message} (${where})` };
}

function withError(result: ExecuteResult, error: NonNullable<ExecuteResult["error"]>): ExecuteResult {
  const { value: _dropped, ...rest } = result;
  return { ...rest, status: "error", error };
}

/** One message per way a call can fail approval, so a script can tell them apart. The code is always `approval_required`. */
function approvalMessage(tool: string, reason: ApprovalDecision["reason"], hasHandler: boolean): string {
  if (reason === "expired") return `Call to ${tool} requires approval and the request expired before anyone decided`;
  if (reason === "denied") return `Call to ${tool} requires approval and was denied`;
  if (!hasHandler) return `Call to ${tool} requires approval and no approver is configured`;
  return `Call to ${tool} requires approval and was not approved`;
}

function iso(ms: number = Date.now()): string {
  return new Date(ms).toISOString();
}
