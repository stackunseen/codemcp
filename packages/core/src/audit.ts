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
  write(event: AuditEvent): Promise<void> | void;
  /** Wait until everything written so far is durable. Optional. */
  flush?(): Promise<void>;
}

/** Appends one JSON object per line through a single long-lived append stream. */
export class JsonlFileSink implements AuditSink {
  private stream: WriteStream | undefined;
  private last: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  write(event: AuditEvent): void {
    if (!this.stream) {
      mkdirSync(dirname(this.filePath), { recursive: true });
      this.stream = createWriteStream(this.filePath, { flags: "a" });
    }
    const stream = this.stream;
    this.last = new Promise((resolve) => stream.write(`${JSON.stringify(event)}\n`, () => resolve()));
  }

  flush(): Promise<void> {
    return this.last;
  }
}

/** Writes to stderr. stdout is reserved for the MCP stdio transport. */
export class StderrSink implements AuditSink {
  write(event: AuditEvent): void {
    process.stderr.write(`${JSON.stringify(event)}\n`);
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

/** Hands every event to a function: the hook for pushing into a tracer, a queue or a database. A throwing callback never breaks an execution. */
export class CallbackSink implements AuditSink {
  private last: Promise<void> = Promise.resolve();

  constructor(private readonly fn: (event: AuditEvent) => void | Promise<void>) {}

  write(event: AuditEvent): void {
    this.last = this.last.then(() => this.fn(event)).catch(() => undefined);
  }

  flush(): Promise<void> {
    return this.last;
  }
}

/** Fans each event out to several sinks, so a file, a webhook and a callback can all receive the same stream. */
export class MultiSink implements AuditSink {
  constructor(private readonly sinks: AuditSink[]) {}

  write(event: AuditEvent): void {
    for (const s of this.sinks) void Promise.resolve(s.write(event)).catch(() => undefined);
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
