import { parentPort, workerData } from "node:worker_threads";
import { newQuickJSWASMModule, shouldInterruptAfterDeadline, type InterruptHandler, type QuickJSContext, type QuickJSHandle, type QuickJSRuntime } from "quickjs-emscripten";
import { CodeNormalizer, toPlainJson, type ExecutionError, type JsonValue, type LogLevel } from "codemcp-core";
import { GUEST_PRELUDE } from "./guest-prelude.js";
import type { HostToWorker, WorkerInput, WorkerToHost } from "./messages.js";

const TIMEOUT: ExecutionError = { code: "timeout", message: "Execution exceeded its time limit" };
const SCRIPT_FILE = "codemcp-script.js";
/** Lines in front of the script body: the prelude and the `(async () => {` wrapper line. */
const BODY_LINE_OFFSET = `${GUEST_PRELUDE}\n${CodeNormalizer.wrap("")}`.split("\n").length - 2;
const DANGLING: ExecutionError = { code: "runtime_error", message: "Script is waiting on a promise that will never settle (only tool calls and sleep are asynchronous in the sandbox)" };

interface Reply {
  seq: number;
  json: string;
  /** Guest time still available after this wait; the deadline is re-armed from it. */
  remainingMs: number;
}

/**
 * One QuickJS runtime running one script, with the bridge loop that shuttles tool calls to the host
 * and replies back into the guest. Lives for exactly one execution inside a worker thread.
 */
class QuickJsSandbox {
  private readonly replies: Reply[] = [];
  private wake: (() => void) | undefined;
  /** Set by the interrupt handler itself, so a timeout is never inferred from error text a script could forge. */
  private deadlineHit = false;
  private runtime!: QuickJSRuntime;
  private vm!: QuickJSContext;
  private deadline!: InterruptHandler;
  private deadlineAt = 0;
  private readonly outgoing: Array<{ seq: number; tool: string; args: JsonValue }> = [];

  constructor(
    private readonly input: WorkerInput,
    private readonly post: (m: WorkerToHost) => void,
  ) {}

  /** Called by the worker's message handler when the host answers a call. */
  receive(reply: Reply): void {
    this.replies.push(reply);
    this.wake?.();
    this.wake = undefined;
  }

  async run(): Promise<void> {
    const QuickJS = await newQuickJSWASMModule();
    this.runtime = QuickJS.newRuntime();
    this.runtime.setMemoryLimit(this.input.memoryLimitBytes);
    this.runtime.setMaxStackSize(this.input.maxStackBytes);
    this.armDeadline(this.input.timeoutMs);
    this.runtime.setInterruptHandler((rt) => {
      this.deadlineHit = this.deadline(rt) === true;
      return this.deadlineHit;
    });
    this.vm = this.runtime.newContext();
    this.installHostFunctions();

    const evaluated = this.vm.evalCode(`${GUEST_PRELUDE}\n${CodeNormalizer.wrap(this.input.code)}`, SCRIPT_FILE, { type: "global" });
    if (evaluated.error) {
      this.fail(this.classify(this.dumpError(evaluated.error)));
      evaluated.error.dispose();
      this.dispose();
      return;
    }
    const promise = evaluated.value;
    const deliver = this.vm.getProp(this.vm.global, "__deliver");
    try {
      await this.pump(promise, deliver);
    } finally {
      deliver.dispose();
      promise.dispose();
      this.dispose();
    }
  }

  /** Drive the guest job queue until the top-level promise settles, feeding host replies in as they arrive. */
  private async pump(promise: QuickJSHandle, deliver: QuickJSHandle): Promise<void> {
    for (;;) {
      const jobs = this.runtime.executePendingJobs();
      if (jobs.error) {
        this.fail(this.classify(this.dumpError(jobs.error)));
        jobs.error.dispose();
        return;
      }
      // Post calls before inspecting the promise: a script that returns without awaiting a call must
      // fail loudly rather than succeed with the call silently dropped.
      for (const c of this.outgoing.splice(0)) this.post({ type: "call", ...c });
      const state = this.vm.getPromiseState(promise);
      if (state.type === "fulfilled") {
        const pending = this.pendingCalls();
        if (pending > 0) {
          this.fail({ code: "runtime_error", message: `Script returned while ${pending} tool call${pending === 1 ? "" : "s"} had not completed (missing await?)` });
          return;
        }
        // `dump` renders functions as source text, which must not leak out as a value.
        const value = this.vm.typeof(state.value) === "function" ? null : toPlainJson(this.vm.dump(state.value));
        if (state.value !== promise) state.value.dispose();
        this.post({ type: "done", ok: true, value });
        return;
      }
      if (state.type === "rejected") {
        this.fail(this.classify(this.dumpError(state.error)));
        state.error.dispose();
        return;
      }
      if (this.replies.length === 0) {
        if (this.pendingCalls() === 0) {
          this.fail(this.deadlineHit ? TIMEOUT : DANGLING);
          return;
        }
        await this.nextReply();
      }
      const batch = this.replies.splice(0);
      // The guest was parked while the host worked; the time it was parked is not its own.
      this.armDeadline(Math.min(...batch.map((r) => r.remainingMs)));
      for (const r of batch) {
        const seqH = this.vm.newNumber(r.seq);
        const jsonH = this.vm.newString(r.json);
        const res = this.vm.callFunction(deliver, this.vm.undefined, seqH, jsonH);
        seqH.dispose();
        jsonH.dispose();
        if (res.error) res.error.dispose();
        else res.value.dispose();
      }
    }
  }

  private installHostFunctions(): void {
    const vm = this.vm;
    vm.newFunction("__host_call", (seqH, toolH, argsH) => {
      let args: JsonValue = {};
      try {
        args = JSON.parse(vm.getString(argsH)) as JsonValue;
      } catch {
        /* keep {} */
      }
      this.outgoing.push({ seq: vm.getNumber(seqH), tool: vm.getString(toolH), args });
    }).consume((fn) => vm.setProp(vm.global, "__host_call", fn));
    vm.newFunction("__host_sleep", (seqH, msH) => {
      const seq = vm.getNumber(seqH);
      const ms = vm.getNumber(msH);
      // Sleeping is the script's own time: the reply carries the deadline that was already running.
      setTimeout(() => this.receive({ seq, json: '{"ok":true,"value":null}', remainingMs: Math.max(0, this.deadlineAt - Date.now()) }), ms);
    }).consume((fn) => vm.setProp(vm.global, "__host_sleep", fn));
    vm.newFunction("__host_log", (levelH, msgH) => {
      this.post({ type: "log", level: vm.getString(levelH) as LogLevel, message: vm.getString(msgH) });
    }).consume((fn) => vm.setProp(vm.global, "__host_log", fn));
  }

  private armDeadline(remainingMs: number): void {
    this.deadlineAt = Date.now() + remainingMs;
    this.deadline = shouldInterruptAfterDeadline(this.deadlineAt);
  }

  private nextReply(): Promise<void> {
    return this.replies.length ? Promise.resolve() : new Promise((r) => (this.wake = r));
  }

  /** Calls still awaiting a reply, read from the guest's own pending map. */
  // shortcut: trusts the guest's map; a script that clears it only changes the error message it sees itself.
  private pendingCalls(): number {
    const res = this.vm.evalCode("__pending.size");
    if (res.error) {
      res.error.dispose();
      return 0;
    }
    const n = this.vm.getNumber(res.value);
    res.value.dispose();
    return n;
  }

  private classify(err: { name?: string; message?: string; stack?: string }): ExecutionError {
    const message = `${err.name ? `${err.name}: ` : ""}${err.message ?? "unknown error"}`;
    const stack = err.stack !== undefined ? { stack: err.stack } : {};
    if (this.deadlineHit) return { ...TIMEOUT, ...stack };
    // QuickJS reports these two as InternalError with fixed messages; there is no structured signal for them.
    if (err.name === "InternalError" && /out of memory/i.test(err.message ?? "")) return { code: "memory_limit", message: "Execution exceeded its memory limit", ...stack };
    if (err.name === "InternalError" && /stack overflow/i.test(err.message ?? "")) return { code: "stack_overflow", message: "Execution exceeded its stack limit", ...stack };
    if (err.name === "SyntaxError") return { code: "syntax_error", message, ...stack };
    return { code: "runtime_error", message, ...stack, ...QuickJsSandbox.locate(err.stack) };
  }

  /** The script line of the innermost frame, mapped past the prelude and wrapper. Frames inside the prelude give nothing. */
  private static locate(stack: string | undefined): { line: number; column: number } | Record<string, never> {
    if (!stack) return {};
    const re = new RegExp(`\\(${SCRIPT_FILE}:(\\d+):(\\d+)\\)`, "g");
    for (const m of stack.matchAll(re)) {
      const line = Number(m[1]) - BODY_LINE_OFFSET;
      if (line >= 1) return { line, column: Number(m[2]) };
    }
    return {};
  }

  private dumpError(handle: QuickJSHandle): { name?: string; message?: string; stack?: string } {
    const dumped = this.vm.dump(handle) as unknown;
    if (dumped && typeof dumped === "object") return dumped as { name?: string; message?: string; stack?: string };
    return { message: String(dumped) };
  }

  private fail(error: ExecutionError): void {
    this.post({ type: "done", ok: false, error });
  }

  private dispose(): void {
    try {
      this.vm.dispose();
      this.runtime.dispose();
    } catch {
      // The worker is about to exit; a disposal failure changes nothing.
    }
  }
}

if (!parentPort) throw new Error("quickjs worker must run as a worker thread");
const port = parentPort;
const sandbox = new QuickJsSandbox(workerData as WorkerInput, (m) => port.postMessage(m));
port.on("message", (m: HostToWorker) => {
  if (m.type === "reply") sandbox.receive({ seq: m.seq, json: m.json, remainingMs: m.remainingMs });
});
sandbox.run().catch((err: Error) => {
  port.postMessage({ type: "done", ok: false, error: { code: "executor_failure", message: err.message, ...(err.stack !== undefined ? { stack: err.stack } : {}) } } satisfies WorkerToHost);
});
