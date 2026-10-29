// Generated from spec/VERSION and spec/bridge/errors.json by scripts/sync-spec.mjs. Do not edit; edit the spec and run `pnpm spec:sync`.
export const SPEC_VERSION = "0.2.0";

/** Every error code a guest can observe on a rejected call, and whether it also ends the execution. */
export const BRIDGE_ERRORS = {
  unknown_tool: { fatal: false },
  invalid_arguments: { fatal: false },
  upstream_error: { fatal: false },
  policy_denied: { fatal: false },
  approval_required: { fatal: false },
  pin_drifted: { fatal: true },
  budget_exceeded: { fatal: true },
  audit_unavailable: { fatal: true },
} as const;

/** Codes raised by an executor itself. */
export const EXECUTION_CODES = ["syntax_error","runtime_error","timeout","memory_limit","stack_overflow","executor_failure","result_too_large","cancelled"] as const;
