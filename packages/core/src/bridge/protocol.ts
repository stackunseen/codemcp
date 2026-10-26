/**
 * The bridge protocol between an executor's guest runtime and the host.
 *
 * Rules:
 *  1. Every message is JSON. Nothing else ever crosses: no functions, no host objects, no schemas.
 *  2. Each guest call carries a monotonically increasing `seq` per execution. The host answers with the same `seq`.
 *  3. Transport is executor-specific: worker messages for the WASM tier, a stdio pipe for subprocess
 *     tiers, an RPC binding or SDK channel for remote and microVM tiers.
 */
import { BRIDGE_ERRORS } from "../generated/spec.js";
import type { HostFunction, JsonValue, LogLevel } from "../types.js";

export { BRIDGE_ERRORS };

export const BRIDGE_PROTOCOL_VERSION = 1 as const;

export type BridgeErrorCode = keyof typeof BRIDGE_ERRORS;

/**
 * The error a host function throws to reject a guest call. `fatal` is derived from the code.
 * Executors forward `code` and `message` to the guest and end the execution when `fatal` is set.
 */
export class BridgeCallError extends Error {
  override readonly name = "BridgeCallError";
  constructor(
    readonly code: BridgeErrorCode,
    message: string,
  ) {
    super(message);
  }
  get fatal(): boolean {
    return BRIDGE_ERRORS[this.code].fatal;
  }
}

/** Anything a host function throws that is not already a bridge error is an upstream error. */
export function asBridgeError(err: unknown): BridgeCallError {
  return err instanceof BridgeCallError ? err : new BridgeCallError("upstream_error", (err as Error)?.message ?? String(err));
}

/** Guest -> host */
export type GuestCall = { type: "call"; seq: number; tool: string; args: JsonValue };
export type GuestLog = { type: "log"; level: LogLevel; message: string };

/** Host -> guest: the reply to one `GuestCall`, matched by `seq`. */
export type HostReply =
  | { v: typeof BRIDGE_PROTOCOL_VERSION; seq: number; ok: true; value: JsonValue }
  | { v: typeof BRIDGE_PROTOCOL_VERSION; seq: number; ok: false; error: { code: string; message: string } };

/**
 * Run one guest call against the host-function table. Shared by every executor so that unknown-tool
 * handling and error shaping never drift between tiers. Returns the reply to send to the guest and,
 * when the error was fatal, the error the executor must end the execution with.
 */
export async function callHostFunction(
  fns: Record<string, HostFunction>,
  seq: number,
  tool: string,
  args: JsonValue,
): Promise<{ reply: HostReply; fatal?: BridgeCallError }> {
  const fn = Object.hasOwn(fns, tool) ? fns[tool] : undefined;
  if (!fn) {
    return { reply: { v: BRIDGE_PROTOCOL_VERSION, seq, ok: false, error: { code: "unknown_tool", message: `Unknown tool "${tool}". Use search and describe to find the right name.` } } };
  }
  try {
    return { reply: { v: BRIDGE_PROTOCOL_VERSION, seq, ok: true, value: await fn(args) } };
  } catch (err) {
    const e = asBridgeError(err);
    return { reply: { v: BRIDGE_PROTOCOL_VERSION, seq, ok: false, error: { code: e.code, message: e.message } }, ...(e.fatal ? { fatal: e } : {}) };
  }
}

/**
 * Deep-copy through JSON to guarantee the value is plain data with no prototypes, getters,
 * functions or host references. `undefined` and unserializable values become `null`.
 */
export function toPlainJson(value: unknown): JsonValue {
  if (value === undefined) return null;
  try {
    const json = JSON.stringify(value);
    return json === undefined ? null : (JSON.parse(json) as JsonValue);
  } catch {
    return null;
  }
}
