import type { ExecutionError, GuestCall, GuestLog, JsonValue } from "codemcp-core";

/** Posted by the host into the worker when it starts. */
export interface WorkerInput {
  code: string;
  timeoutMs: number;
  memoryLimitBytes: number;
  maxStackBytes: number;
}

/** Worker -> host: bridge messages plus the terminal `done`. */
export type WorkerToHost = GuestCall | GuestLog | { type: "done"; ok: true; value: JsonValue } | { type: "done"; ok: false; error: ExecutionError };

/**
 * Host -> worker: a bridge reply, pre-serialized so the worker can hand it to the guest as one string,
 * plus how much guest time remains so the in-runtime deadline can be re-armed after the wait.
 */
export type HostToWorker = { type: "reply"; seq: number; json: string; remainingMs: number };
