import type { Principal } from "./identity.js";
import type { JsonValue, ToolDescriptor } from "./types.js";

export interface ApprovalRequest {
  executionId: string;
  seq: number;
  tool: ToolDescriptor;
  args: JsonValue;
  /** Who started the execution. Only they, or an operator, may decide. */
  principal?: Principal;
}

export interface PendingApproval {
  executionId: string;
  seq: number;
  tool: string;
  args: JsonValue;
  principal?: string;
  requestedAt: string;
  expiresAt: string;
}

interface Parked {
  pending: PendingApproval;
  resolve: (decision: ApprovalDecision) => void;
  timer: NodeJS.Timeout;
}

export type DecideResult = "decided" | "not_found" | "forbidden";

/** Why a call was not allowed: a person said no, or nobody answered before `expiresAt`. */
export type ApprovalReason = "denied" | "expired";

/** The outcome of one approval request. `reason` is set only when `allow` is false. */
export interface ApprovalDecision {
  allow: boolean;
  reason?: ApprovalReason;
}

/**
 * Parks a tool call until a human decides. The execution's state is the sandbox itself: the guest
 * is suspended inside `await tools.x.y()`, so nothing has to be replayed. The bridge sequence number
 * identifies which call a decision refers to, and `expiresAt` bounds how long a script can stay parked.
 */
export class ApprovalGate {
  private readonly parked = new Map<string, Parked>();
  private readonly listeners = new Set<(p: PendingApproval) => void>();

  constructor(
    private readonly timeoutMs: number = 10 * 60_000,
    /** Roles allowed to decide for any principal's execution. */
    private readonly operatorRoles: readonly string[] = ["operator"],
  ) {}

  /**
   * The handler `BridgeHost` calls. Resolves when `decide` is called, or with `reason: "expired"` when
   * nobody decides before `expiresAt`, so the script can tell a refusal from an unanswered request.
   */
  request = (req: ApprovalRequest): Promise<ApprovalDecision> =>
    new Promise((resolve) => {
      const key = ApprovalGate.key(req.executionId, req.seq);
      const now = Date.now();
      const pending: PendingApproval = {
        executionId: req.executionId,
        seq: req.seq,
        tool: req.tool.qualifiedName,
        args: req.args,
        ...(req.principal ? { principal: req.principal.id } : {}),
        requestedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + this.timeoutMs).toISOString(),
      };
      const timer = setTimeout(() => this.settle(key, { allow: false, reason: "expired" }), this.timeoutMs);
      timer.unref?.();
      this.parked.set(key, { pending, resolve, timer });
      for (const l of this.listeners) l(pending);
    });

  /**
   * Record a decision. When `by` is given, it must be the principal that started the execution or hold an
   * operator role; an anonymous decision (no `by`) is accepted, which is the local-operator case.
   */
  decide(executionId: string, seq: number, allow: boolean, by?: Principal): DecideResult {
    const key = ApprovalGate.key(executionId, seq);
    const entry = this.parked.get(key);
    if (!entry) return "not_found";
    if (by && entry.pending.principal && by.id !== entry.pending.principal && !this.isOperator(by)) return "forbidden";
    this.settle(key, allow ? { allow: true } : { allow: false, reason: "denied" });
    return "decided";
  }

  private settle(key: string, decision: ApprovalDecision): void {
    const entry = this.parked.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.parked.delete(key);
    entry.resolve(decision);
  }

  list(executionId?: string): PendingApproval[] {
    return [...this.parked.values()].map((e) => e.pending).filter((p) => !executionId || p.executionId === executionId);
  }

  /**
   * Resolves the next time a call from `executionId` parks, or never if the run finishes first;
   * callers race it against the run and call the returned `cancel` afterwards.
   */
  nextPending(executionId: string): { promise: Promise<PendingApproval>; cancel: () => void } {
    const already = this.list(executionId)[0];
    if (already) return { promise: Promise.resolve(already), cancel: () => undefined };
    let listener: (p: PendingApproval) => void = () => undefined;
    const promise = new Promise<PendingApproval>((resolve) => {
      listener = (p) => {
        if (p.executionId !== executionId) return;
        this.listeners.delete(listener);
        resolve(p);
      };
      this.listeners.add(listener);
    });
    return { promise, cancel: () => void this.listeners.delete(listener) };
  }

  private isOperator(p: Principal): boolean {
    return (p.roles ?? []).some((r) => this.operatorRoles.includes(r));
  }

  private static key(executionId: string, seq: number): string {
    return `${executionId}:${seq}`;
  }
}
