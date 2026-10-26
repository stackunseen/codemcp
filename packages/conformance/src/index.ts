import { BridgeCallError, type BridgeErrorCode, type ExecuteResult, type Executor, type HostFunction, type JsonValue } from "codemcp-core";
import { CASES } from "./generated/cases.js";
import type { GuestLanguage, SpecCase, SpecFn } from "./spec-types.js";

export type { GuestLanguage, SpecCase, SpecExpect, SpecFn } from "./spec-types.js";

/**
 * Runs the spec's conformance cases against an executor. Cases are data (`spec/conformance/cases.json`);
 * this class only interprets the declarative host functions and expectations, so a port in another host
 * language needs an equivalent interpreter, not a rewrite of the cases.
 */
export class ConformanceSuite {
  readonly cases: readonly SpecCase[];

  constructor(readonly language: GuestLanguage = "js") {
    this.cases = CASES.filter((c) => c.code[language] !== undefined);
  }

  async run(executor: Executor, c: SpecCase): Promise<void> {
    const received: JsonValue[] = [];
    const fns: Record<string, HostFunction> = {};
    for (const [name, spec] of Object.entries(c.fns ?? {})) {
      fns[name] = async (args) => {
        received.push(args);
        return ConformanceSuite.hostFunction(spec)(args);
      };
    }
    const { abortAfterMs, ...limits } = c.options ?? {};
    const code = c.code[this.language];
    if (code === undefined) throw new Error(`[${c.name}] has no ${this.language} script`);
    const result = await executor.execute(code, fns, { ...limits, ...(abortAfterMs !== undefined ? { signal: AbortSignal.timeout(abortAfterMs) } : {}) });
    ConformanceSuite.check(c, result, received);
  }

  private static hostFunction(spec: SpecFn): HostFunction {
    switch (spec.kind) {
      case "echo":
        return async (args) => args;
      case "value":
        return async () => spec.value;
      case "inc":
        return async (args) => ((args as { v?: number })?.v ?? 0) + 1;
      case "delay":
        return () => new Promise((res) => setTimeout(() => res(spec.value), spec.ms));
      case "throw":
        return async () => {
          throw spec.code ? new BridgeCallError(spec.code as BridgeErrorCode, spec.message) : new Error(spec.message);
        };
    }
  }

  private static check(c: SpecCase, r: ExecuteResult, received: JsonValue[]): void {
    const fail = (message: string): never => {
      throw new Error(`[${c.name}] ${message}`);
    };
    const e = c.expect;
    if (r.status !== e.status) fail(`expected ${e.status}, got ${r.status}: ${r.error?.message ?? JSON.stringify(r.value)}`);
    if (e.codes && !e.codes.includes(r.error?.code ?? "")) fail(`expected one of ${e.codes.join("|")}, got ${r.error?.code}: ${r.error?.message}`);
    if ("value" in e && JSON.stringify(r.value) !== JSON.stringify(e.value)) fail(`expected value ${JSON.stringify(e.value)}, got ${JSON.stringify(r.value)}`);
    if (e.valueType && typeof r.value !== e.valueType) fail(`expected a ${e.valueType}, got ${JSON.stringify(r.value)}`);
    if (e.valueMin !== undefined && !(typeof r.value === "number" && r.value >= e.valueMin)) fail(`expected at least ${e.valueMin}, got ${String(r.value)}`);
    if (e.messageMatches && !new RegExp(e.messageMatches).test(r.error?.message ?? "")) fail(`message should match /${e.messageMatches}/: ${r.error?.message}`);
    if (e.maxDurationMs !== undefined && r.durationMs > e.maxDurationMs) fail(`took ${r.durationMs} ms, limit ${e.maxDurationMs}`);
    if (e.logs) {
      e.logs.forEach((want, i) => {
        const got = r.logs[i];
        if (!got) fail(`missing log entry ${i}`);
        if (want.level && got!.level !== want.level) fail(`log ${i} level ${got!.level}, expected ${want.level}`);
        if (want.message !== undefined && got!.message !== want.message) fail(`log ${i} was ${JSON.stringify(got!.message)}`);
        if (want.messageMatches && !new RegExp(want.messageMatches).test(got!.message)) fail(`log ${i} should match /${want.messageMatches}/: ${got!.message}`);
      });
    }
    if (e.logsCount !== undefined && r.logs.length !== e.logsCount) fail(`expected ${e.logsCount} log entries, got ${r.logs.length}`);
    if (e.lastLogMatches && !new RegExp(e.lastLogMatches).test(r.logs.at(-1)?.message ?? "")) fail(`last log should match /${e.lastLogMatches}/: ${r.logs.at(-1)?.message}`);
    if (e.received && JSON.stringify(received) !== JSON.stringify(e.received)) fail(`host received ${JSON.stringify(received)}, expected ${JSON.stringify(e.received)}`);
    if (e.receivedCount !== undefined && received.length !== e.receivedCount) fail(`host received ${received.length} calls, expected ${e.receivedCount}`);
  }
}
