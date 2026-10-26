import { Worker } from "node:worker_threads";
import { callHostFunction, DEFAULT_EXECUTE_LIMITS, stripUndefined, type ExecuteLimits, type ExecuteOptions, type ExecuteResult, type ExecutionErrorCode, type Executor, type HostFunction, type LogEntry } from "codemcp-core";
import type { HostToWorker, WorkerInput, WorkerToHost } from "./messages.js";

/** The worker's own V8 heap holds the WASM module and reply strings on top of the guest's heap. */
const WORKER_HEAP_HEADROOM_MB = 64;

/**
 * Tracks how much of the time budget the guest has used. Time spent waiting on the host (an upstream
 * call, a human approval) is not the script's, so the clock stops while any call is in flight.
 */
class GuestClock {
  private used = 0;
  private runningSince: number | undefined = Date.now();
  private inflight = 0;

  constructor(readonly budgetMs: number) {}

  callStarted(): void {
    if (this.inflight++ === 0 && this.runningSince !== undefined) {
      this.used += Date.now() - this.runningSince;
      this.runningSince = undefined;
    }
  }

  callFinished(): void {
    if (--this.inflight === 0) this.runningSince = Date.now();
  }

  get waiting(): boolean {
    return this.inflight > 0;
  }

  remainingMs(): number {
    const running = this.runningSince === undefined ? 0 : Date.now() - this.runningSince;
    return Math.max(0, this.budgetMs - this.used - running);
  }
}

/** Keeps log entries within both an entry count and a byte budget, and records what was dropped. */
class LogBuffer {
  readonly entries: LogEntry[] = [];
  private bytes = 0;
  private droppedEntries = 0;
  private droppedBytes = 0;

  constructor(
    private readonly maxEntries: number,
    private readonly maxBytes: number,
    private readonly onLog?: (entry: LogEntry) => void,
  ) {}

  push(entry: LogEntry): void {
    this.onLog?.(entry);
    const size = Buffer.byteLength(entry.message);
    if (this.entries.length >= this.maxEntries || this.bytes + size > this.maxBytes) {
      this.droppedEntries++;
      this.droppedBytes += size;
      return;
    }
    this.entries.push(entry);
    this.bytes += size;
  }

  finish(t: number): LogEntry[] {
    if (this.droppedEntries > 0) this.entries.push({ level: "warn", message: `[${this.droppedEntries} log entries (${this.droppedBytes} bytes) dropped; log less or return the data instead]`, t });
    return this.entries;
  }
}

/**
 * Tier 0 executor. Every execution gets a fresh QuickJS runtime inside a fresh Node worker thread.
 *
 * Limits are enforced in layers, none of which depend on the guest cooperating:
 *  1. QuickJS memory limit, stack limit and interrupt-on-deadline inside the runtime
 *  2. The worker's own V8 `resourceLimits`
 *  3. A host-side timer that calls `worker.terminate()`
 *
 * The guest's only capabilities are the string-only host functions defined in the worker.
 */
export class QuickJsExecutor implements Executor {
  readonly name = "quickjs-wasm";
  private readonly defaults: Required<ExecuteLimits>;

  constructor(limits: ExecuteLimits = {}) {
    this.defaults = { ...DEFAULT_EXECUTE_LIMITS, ...stripUndefined(limits) };
  }

  execute(code: string, fns: Record<string, HostFunction>, options: ExecuteOptions = {}): Promise<ExecuteResult> {
    const started = Date.now();
    const { signal, onLog, ...overrides } = options;
    const limits = { ...this.defaults, ...stripUndefined(overrides) };
    const input: WorkerInput = { code, timeoutMs: limits.timeoutMs, memoryLimitBytes: limits.memoryLimitBytes, maxStackBytes: limits.maxStackBytes };
    const clock = new GuestClock(limits.timeoutMs);
    const logs = new LogBuffer(limits.maxLogEntries, limits.maxLogBytes, onLog);

    return new Promise<ExecuteResult>((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const worker = new Worker(new URL("./worker.js", import.meta.url), {
        workerData: input,
        resourceLimits: { maxOldGenerationSizeMb: Math.ceil(limits.memoryLimitBytes / (1024 * 1024)) + WORKER_HEAP_HEADROOM_MB },
        stdout: false,
        stderr: false,
      });

      const finish = (partial: Pick<ExecuteResult, "status" | "value" | "error">): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        void worker.terminate();
        resolve({ ...partial, logs: logs.finish(Date.now() - started), calls: [], durationMs: Date.now() - started });
      };

      const onAbort = (): void => finish({ status: "error", error: { code: "cancelled", message: "Execution was cancelled" } });
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }

      // Hard backstop while the guest is running: the in-runtime interrupt should fire first, but a bug
      // in the guest runtime must not hang the host. Suspended while the guest waits on the host.
      const armBackstop = (): void => {
        clearTimeout(timer);
        if (clock.waiting) return;
        timer = setTimeout(() => {
          finish({ status: "error", error: { code: "timeout", message: `Execution exceeded its time limit of ${limits.timeoutMs} ms` } });
        }, clock.remainingMs() + 250);
      };
      armBackstop();

      worker.on("message", (m: WorkerToHost) => {
        switch (m.type) {
          case "log":
            logs.push({ level: m.level, message: m.message, t: Date.now() - started });
            return;
          case "done":
            finish(m.ok ? { status: "completed", value: m.value } : { status: "error", error: m.error });
            return;
          case "call":
            clock.callStarted();
            armBackstop();
            void callHostFunction(fns, m.seq, m.tool, m.args).then(({ reply, fatal }) => {
              clock.callFinished();
              if (settled) return;
              const msg: HostToWorker = { type: "reply", seq: m.seq, json: JSON.stringify(reply), remainingMs: clock.remainingMs() };
              worker.postMessage(msg);
              armBackstop();
              if (fatal) finish({ status: "error", error: { code: fatal.code as ExecutionErrorCode, message: fatal.message } });
            });
        }
      });

      worker.on("error", (err: Error & { code?: string }) => {
        finish({
          status: "error",
          error:
            err.code === "ERR_WORKER_OUT_OF_MEMORY"
              ? { code: "memory_limit", message: "Execution exceeded its memory limit" }
              : { code: "executor_failure", message: err.message, ...(err.stack !== undefined ? { stack: err.stack } : {}) },
        });
      });

      worker.on("exit", (exitCode) => finish({ status: "error", error: { code: "executor_failure", message: `Sandbox worker exited unexpectedly with code ${exitCode}` } }));
    });
  }
}

export { GUEST_PRELUDE } from "./guest-prelude.js";
