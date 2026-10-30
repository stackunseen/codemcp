import { diffLines } from "./diff.js";
import { readJsonFile, writeJsonFile } from "./fs.js";
import type { JsonSchema, ToolAnnotations, ToolDescriptor } from "./types.js";

/** The parts of a tool the hash covers, kept so a drift can be shown as a diff rather than two hashes. */
export interface PinnedDefinition {
  name: string;
  description?: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  annotations?: ToolAnnotations;
}

export interface PinRecord {
  hash: string;
  approvedAt: string;
  /** Absent in pin files written before definitions were stored; `diff` then has nothing to compare. */
  definition?: PinnedDefinition;
}

export type PinStatus = "pinned" | "new" | "drifted";

export interface PinCheck {
  status: PinStatus;
  pinned?: PinRecord;
}

/**
 * Pins the description hash of every tool at approval time. A server that changes a tool's name,
 * description or input schema after approval shows up as `drifted` and is blocked until re-approved.
 */
export class PinStore {
  private pins = new Map<string, PinRecord>();

  constructor(private readonly filePath?: string) {}

  async load(): Promise<void> {
    if (!this.filePath) return;
    const raw = (await readJsonFile(this.filePath)) as Record<string, PinRecord> | undefined;
    if (raw) this.pins = new Map(Object.entries(raw));
  }

  async save(): Promise<void> {
    if (!this.filePath) return;
    await writeJsonFile(this.filePath, Object.fromEntries([...this.pins.entries()].sort(([a], [b]) => a.localeCompare(b))));
  }

  check(tool: ToolDescriptor): PinCheck {
    const pinned = this.pins.get(tool.qualifiedName);
    if (!pinned) return { status: "new" };
    return { status: pinned.hash === tool.descriptionHash ? "pinned" : "drifted", pinned };
  }

  approve(tool: ToolDescriptor, now: Date = new Date()): void {
    this.pins.set(tool.qualifiedName, { hash: tool.descriptionHash, approvedAt: now.toISOString(), definition: PinStore.definitionOf(tool) });
  }

  /** Pin every unpinned tool. Drifted tools are reported, and re-pinned only when `includeDrifted` is set. */
  approveAll(tools: ToolDescriptor[], { includeDrifted = false } = {}): { approved: ToolDescriptor[]; drifted: ToolDescriptor[] } {
    const approved: ToolDescriptor[] = [];
    const drifted: ToolDescriptor[] = [];
    for (const t of tools) {
      const status = this.check(t).status;
      if (status === "drifted") drifted.push(t);
      if (status === "new" || (status === "drifted" && includeDrifted)) {
        this.approve(t);
        approved.push(t);
      }
    }
    return { approved, drifted };
  }

  /**
   * What changed between the pinned definition and the current one, as a unified diff of the pretty-printed
   * definitions. Empty when the tool is not drifted; `undefined` when the pin predates stored definitions.
   */
  diff(tool: ToolDescriptor): string | undefined {
    const { status, pinned } = this.check(tool);
    if (status !== "drifted") return "";
    if (!pinned?.definition) return undefined;
    return diffLines(PinStore.render(pinned.definition), PinStore.render(PinStore.definitionOf(tool)));
  }

  get size(): number {
    return this.pins.size;
  }

  static definitionOf(tool: ToolDescriptor): PinnedDefinition {
    return {
      name: tool.name,
      ...(tool.description !== undefined ? { description: tool.description } : {}),
      inputSchema: tool.inputSchema,
      ...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema } : {}),
      ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
    };
  }

  /** One field per line, with long descriptions split at sentence ends so a diff points at the changed sentence. */
  private static render(d: PinnedDefinition): string {
    const lines = [`name: ${d.name}`];
    if (d.description !== undefined) lines.push("description:", ...d.description.split(/(?<=[.!?])\s+|\n/).map((s) => `  ${s}`));
    lines.push("inputSchema:", ...JSON.stringify(sortKeys(d.inputSchema), null, 2).split("\n").map((s) => `  ${s}`));
    if (d.outputSchema !== undefined) lines.push("outputSchema:", ...JSON.stringify(sortKeys(d.outputSchema), null, 2).split("\n").map((s) => `  ${s}`));
    if (d.annotations !== undefined) lines.push("annotations:", ...JSON.stringify(sortKeys(d.annotations), null, 2).split("\n").map((s) => `  ${s}`));
    return lines.join("\n");
  }
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) out[key] = sortKeys((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}
