import { BridgeCallError } from "./bridge/protocol.js";
import { stripUndefined } from "./types.js";

export interface BudgetConfig {
  /** Maximum bridged tool calls per execution. Default 200. */
  maxCalls?: number;
  /** Maximum serialized bytes of a single tool result passed into the guest. Default 1 MiB. Larger results are truncated. */
  maxResultBytes?: number;
  /** Maximum total serialized bytes across all results in one execution. Default 8 MiB. */
  maxTotalBytes?: number;
  /** Maximum serialized bytes of the value a script returns. Default 256 KiB. */
  maxReturnBytes?: number;
}

const DEFAULT_BUDGET: Required<BudgetConfig> = {
  maxCalls: 200,
  maxResultBytes: 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024,
  maxReturnBytes: 256 * 1024,
};

/** A budget violation is itself a (fatal) bridge error, so callers never re-wrap it. */
export class BudgetExceededError extends BridgeCallError {
  constructor(message: string) {
    super("budget_exceeded", message);
  }
}

/** Per-execution counters. One instance per `execute()`. */
export class Budget {
  readonly limits: Required<BudgetConfig>;
  calls = 0;
  totalBytes = 0;

  constructor(config: BudgetConfig = {}) {
    this.limits = { ...DEFAULT_BUDGET, ...stripUndefined(config) };
  }

  /** Called before each bridged call. */
  takeCall(): void {
    this.calls += 1;
    if (this.calls > this.limits.maxCalls) {
      throw new BudgetExceededError(`Execution exceeded the limit of ${this.limits.maxCalls} tool calls`);
    }
  }

  /** Called with each result's serialized size. */
  takeBytes(bytes: number): void {
    this.totalBytes += bytes;
    if (this.totalBytes > this.limits.maxTotalBytes) {
      throw new BudgetExceededError(`Execution exceeded the limit of ${this.limits.maxTotalBytes} total result bytes`);
    }
  }
}

/**
 * Truncate a serialized JSON value to `maxBytes`, returning a JSON *string* value that tells the
 * model the result was cut and how to narrow it. The guest always receives valid JSON.
 * Returns the final byte length so callers do not re-measure.
 */
export function truncateSerialized(json: string, maxBytes: number): { json: string; bytes: number; truncated: boolean } {
  const bytes = Buffer.byteLength(json);
  if (bytes <= maxBytes) return { json, bytes, truncated: false };
  const keep = Math.max(0, maxBytes - 200);
  // shortcut: the byte cut may split a multi-byte code point into U+FFFD; harmless because the head is re-quoted as a string, not parsed.
  const head = Buffer.from(json.slice(0, keep), "utf8").subarray(0, keep).toString("utf8");
  const notice = `[truncated: result was ${bytes} bytes, limit ${maxBytes}. Narrow the request or page through results.]`;
  const out = JSON.stringify(`${head}\n${notice}`);
  return { json: out, bytes: Buffer.byteLength(out), truncated: true };
}
