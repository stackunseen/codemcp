import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { dirname } from "node:path";
import type { JsonValue, LogEntry, PolicyDecision } from "./types.js";

interface ExecutionScoped {
  executionId: string;
  ts: string;
  traceparent?: string;
  /** Who the execution acts for. */
  principal?: string;
}

/**
 * One line of the JSONL audit log. Every call that reaches the upstream produces a `call_start` event
 * before it is forwarded and exactly one `call` event when it settles; a call refused by the pin, policy,
 * approval, schema or budget produces only the `call` event.
 */
export type AuditEvent =
  | (ExecutionScoped & {
      type: "execution_start";
      codeHash: string;
      codeBytes: number;
      fixes: string[];
      executor: string;
      /** Only included when `auditCode` is on. */
      code?: string;
    })
  | (ExecutionScoped & {
      /** Written, and accepted by the sink, before the call is forwarded upstream. */
      type: "call_start";
      seq: number;
      tool: string;
      decision: PolicyDecision;
      /** Only included when `includeArgs` is on. Arguments can contain sensitive data. */
      args?: JsonValue;
    })
  | (ExecutionScoped & {
      type: "call";
      seq: number;
      tool: string;
      decision: PolicyDecision;
      ok: boolean;
      durationMs: number;
      resultBytes?: number;
      truncated?: boolean;
      error?: string;
      /** The sink refused this call's `call_start` record and the host ran fail-open; the call went out unrecorded until now. */
      auditError?: string;
      /** Only included when `includeArgs` is on. Arguments can contain sensitive data. */
      args?: JsonValue;
    })
  | (ExecutionScoped & {
      type: "execution_end";
      status: "completed" | "error";
      durationMs: number;
      calls: number;
      error?: string;
      /** Only included when `auditResults` is on: what the script returned and printed. */
      value?: JsonValue;
      logs?: LogEntry[];
    })
  | {
      type: "pin_drift";
      ts: string;
      tool: string;
      previousHash: string;
      currentHash: string;
    };

export interface AuditSink {
  /**
   * Record one event. A returned promise settles when the sink has taken the event in (for the file sink,
   * when the line has reached the OS); it rejects when the sink could not. The host awaits it for
   * `call_start` and, with `auditRequired`, refuses the call on rejection.
   */
  write(event: AuditEvent): Promise<void> | void;
  /** Wait until everything written so far is durable. Optional. */
  flush?(): Promise<void>;
}

/** Appends one JSON object per line through a single long-lived append stream. */
export class JsonlFileSink implements AuditSink {
  private stream: WriteStream | undefined;
  private last: Promise<void> = Promise.resolve();
  private failure: Error | undefined;

  constructor(private readonly filePath: string) {}

  /** Resolves once the line has been handed to the OS; rejects if the file cannot be opened or written. */
  write(event: AuditEvent): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    if (!this.stream) {
      try {
        mkdirSync(dirname(this.filePath), { recursive: true });
        this.stream = createWriteStream(this.filePath, { flags: "a" });
        this.stream.on("error", (err) => {
          this.failure = err;
        });
      } catch (err) {
        this.failure = err as Error;
        return Promise.reject(this.failure);
      }
    }
    const stream = this.stream;
    const p = new Promise<void>((resolve, reject) => stream.write(`${JSON.stringify(event)}\n`, (err) => (err ? reject(err) : resolve())));
    this.last = p.catch(() => undefined);
    return p;
  }

  flush(): Promise<void> {
    return this.last;
  }
}

/** Writes to stderr. stdout is reserved for the MCP stdio transport. */
export class StderrSink implements AuditSink {
  write(event: AuditEvent): Promise<void> {
    return new Promise((resolve, reject) => process.stderr.write(`${JSON.stringify(event)}\n`, (err) => (err ? reject(err) : resolve())));
  }
}

export class MemorySink implements AuditSink {
  readonly events: AuditEvent[] = [];
  write(event: AuditEvent): void {
    this.events.push(event);
  }
}

export class NullSink implements AuditSink {
  write(): void {}
}

/**
 * Hands every event to a function: the hook for pushing into a tracer, a queue or a database. Events are
 * delivered in order. A throwing callback never breaks an execution, so this sink is never the one that
 * fails a call under `auditRequired`; wrap it in your own sink if you want that.
 */
export class CallbackSink implements AuditSink {
  private last: Promise<void> = Promise.resolve();

  constructor(private readonly fn: (event: AuditEvent) => void | Promise<void>) {}

  write(event: AuditEvent): Promise<void> {
    this.last = this.last.then(() => this.fn(event)).catch(() => undefined);
    return this.last;
  }

  flush(): Promise<void> {
    return this.last;
  }
}

/**
 * Fans each event out to several sinks, so a file, a webhook and a callback can all receive the same stream.
 * Every sink gets every event; the returned promise rejects if any of them refused it.
 */
export class MultiSink implements AuditSink {
  constructor(private readonly sinks: AuditSink[]) {}

  write(event: AuditEvent): Promise<void> {
    const writes = this.sinks.map((s) => {
      try {
        return Promise.resolve(s.write(event));
      } catch (err) {
        return Promise.reject(err);
      }
    });
    return Promise.allSettled(writes).then((results) => {
      const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
      if (failed) throw failed.reason;
    });
  }

  async flush(): Promise<void> {
    await Promise.all(this.sinks.map((s) => s.flush?.()));
  }
}

export interface HttpSinkOptions {
  url: string;
  headers?: Record<string, string>;
  /** Events are batched for this long before a POST. Default 500 ms; 0 posts each event on its own. */
  batchMs?: number;
  /** Largest batch. Default 200 events. */
  maxBatch?: number;
}

/**
 * POSTs batches of events as a JSON array to a webhook. Best effort: a failed POST is retried once on the
 * next flush and then dropped, so an unreachable collector slows nothing and loses only its own data.
 * Because it batches, it never refuses a write, so it cannot fail a call under `auditRequired`.
 */
export class HttpSink implements AuditSink {
  private queue: AuditEvent[] = [];
  private timer: NodeJS.Timeout | undefined;
  private inflight: Promise<void> = Promise.resolve();
  private retry: AuditEvent[] = [];

  constructor(private readonly opts: HttpSinkOptions) {}

  write(event: AuditEvent): void {
    this.queue.push(event);
    const batchMs = this.opts.batchMs ?? 500;
    if (batchMs === 0 || this.queue.length >= (this.opts.maxBatch ?? 200)) {
      this.send();
      return;
    }
    if (!this.timer) {
      this.timer = setTimeout(() => this.send(), batchMs);
      this.timer.unref?.();
    }
  }

  async flush(): Promise<void> {
    this.send();
    await this.inflight;
  }

  private send(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    const batch = [...this.retry, ...this.queue];
    this.queue = [];
    this.retry = [];
    if (batch.length === 0) return;
    this.inflight = this.inflight.then(async () => {
      try {
        const res = await fetch(this.opts.url, { method: "POST", headers: { "content-type": "application/json", ...this.opts.headers }, body: JSON.stringify(batch) });
        if (!res.ok) this.retry = batch;
      } catch {
        this.retry = batch;
      }
    });
  }
}
