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
  /**
   * Decision when no rule applies. Default `allow`. A stricter default applies to every tool without a
   * rule, read-only ones included: let reads through with explicit rules such as `"github.list_*": "allow"`.
   */
  default?: PolicyDecision;
  /**
   * Ordered rules on qualified names (`server.tool`, `*` wildcard). First rule that yields a decision wins.
   * Example: `{ "github.delete_*": "approve", "crm.refund_order": { roles: { finance: "approve" }, default: "deny" } }`.
   */
  rules?: Record<string, PolicyRule>;
  /**
   * Use MCP tool annotations when no rule matches. Default true.
   * Annotations are content the upstream server controls, so they can only tighten a decision, never
   * loosen one: `destructiveHint` raises the default `allow` to `approve` (and leaves `approve` and
   * `deny` as they are); `readOnlyHint` changes nothing, since the only direction it could move a
   * decision is looser.
   */
  inferFromAnnotations?: boolean;
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
    // A destructive hint can only raise the default; a read-only hint could only lower it, so it is ignored.
    if (this.infer && tool.annotations?.destructiveHint && this.fallback === "allow") return "approve";
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
