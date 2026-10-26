import type { ExecuteLimits, JsonValue } from "codemcp-core";

export type GuestLanguage = "js" | "py";

/** A declarative host function, so the same case drives any implementation. */
export type SpecFn =
  | { kind: "echo" }
  | { kind: "value"; value: JsonValue }
  | { kind: "throw"; message: string; code?: string }
  | { kind: "delay"; ms: number; value: JsonValue }
  | { kind: "inc" };

export interface SpecExpect {
  status: "completed" | "error";
  codes?: string[];
  value?: JsonValue;
  valueType?: "number" | "string" | "boolean" | "object";
  valueMin?: number;
  messageMatches?: string;
  maxDurationMs?: number;
  logs?: Array<{ level?: string; message?: string; messageMatches?: string }>;
  logsCount?: number;
  lastLogMatches?: string;
  received?: JsonValue[];
  receivedCount?: number;
}

export interface SpecCase {
  name: string;
  category: "semantics" | "isolation" | "limits" | "bridge";
  code: Partial<Record<GuestLanguage, string>>;
  fns?: Record<string, SpecFn>;
  options?: ExecuteLimits & { abortAfterMs?: number };
  expect: SpecExpect;
}
