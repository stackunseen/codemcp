import type { Principal } from "./identity.js";
import { compilePattern } from "./naming.js";
import type { PolicyDecision, ToolDescriptor } from "./types.js";

/**
 * A rule is either one decision for everyone, or a decision per subject.
 * Subjects are checked in order: `principals` by id, then `roles` (first matching role in the
 * principal's list), then `default`. A rule with subjects and no `default` falls through to the next rule.
 */
export type PolicyRule =
  | PolicyDecision
  | {
      default?: PolicyDecision;
      roles?: Record<string, PolicyDecision>;
      principals?: Record<string, PolicyDecision>;
    };

export interface PolicyConfig {
  /** Decision when no rule and no annotation applies. Default `allow`. */
  default?: PolicyDecision;
  /**
   * Ordered rules on qualified names (`server.tool`, `*` wildcard). First rule that yields a decision wins.
   * Example: `{ "github.delete_*": "approve", "crm.refund_order": { roles: { finance: "approve" }, default: "deny" } }`.
   */
  rules?: Record<string, PolicyRule>;
  /**
   * Use MCP tool annotations when no rule matches:
   * `readOnlyHint` -> allow, `destructiveHint` -> approve. Default true.
   * Annotations are hints from the server, so they can only tighten: they never loosen an explicit
   * rule, and they never loosen the configured `default`. With `default: "approve"` a read-only hint
   * still means approve; with `default: "deny"` every annotation still means deny.
   */
  inferFromAnnotations?: boolean;
}

/** allow < approve < deny. */
const STRICTNESS: Record<PolicyDecision, number> = { allow: 0, approve: 1, deny: 2 };

/** The stricter of two decisions. */
export function stricter(a: PolicyDecision, b: PolicyDecision): PolicyDecision {
  return STRICTNESS[a] >= STRICTNESS[b] ? a : b;
}

/**
 * Decide what happens when a script calls a tool. Evaluated on the qualified name and the principal.
 * Explicit rules win. Otherwise an annotation may tighten the configured default but never loosen it,
 * since the annotation is content the upstream server controls. Rules are compiled once.
 */
export class Policy {
  private readonly rules: Array<[RegExp, PolicyRule]>;
  private readonly fallback: PolicyDecision;
  private readonly infer: boolean;

  constructor(config: PolicyConfig = {}) {
    this.rules = Object.entries(config.rules ?? {}).map(([pattern, rule]) => [compilePattern(pattern), rule]);
    this.fallback = config.default ?? "allow";
    this.infer = config.inferFromAnnotations ?? true;
  }

  decide(tool: ToolDescriptor, principal?: Principal): PolicyDecision {
    for (const [re, rule] of this.rules) {
      if (!re.test(tool.qualifiedName)) continue;
      const decision = Policy.apply(rule, principal);
      if (decision) return decision;
    }
    if (this.infer) {
      if (tool.annotations?.destructiveHint) return stricter("approve", this.fallback);
      if (tool.annotations?.readOnlyHint) return stricter("allow", this.fallback);
    }
    return this.fallback;
  }

  private static apply(rule: PolicyRule, principal: Principal | undefined): PolicyDecision | undefined {
    if (typeof rule === "string") return rule;
    if (principal) {
      const byId = rule.principals?.[principal.id];
      if (byId) return byId;
      for (const role of principal.roles ?? []) {
        const byRole = rule.roles?.[role];
        if (byRole) return byRole;
      }
    }
    return rule.default;
  }
}
