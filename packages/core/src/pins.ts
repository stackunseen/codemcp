import { readJsonFile, writeJsonFile } from "./fs.js";
import type { ToolDescriptor } from "./types.js";

export interface PinRecord {
  hash: string;
  approvedAt: string;
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
    this.pins.set(tool.qualifiedName, { hash: tool.descriptionHash, approvedAt: now.toISOString() });
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

  get size(): number {
    return this.pins.size;
  }
}
