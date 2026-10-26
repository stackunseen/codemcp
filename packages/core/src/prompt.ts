/** Name of the global the guest calls tools through, e.g. `tools.github.create_issue(...)`. */
export const DEFAULT_ROOT_NAME = "tools";

/** The three-tool surface the model sees. Short, stable descriptions keep the surface under ~1K tokens and cache-friendly. */
export const SURFACE = {
  search: {
    name: "search",
    description:
      "Search the available tools by keyword. Returns qualified names and one-line summaries. " +
      "Use before `describe` or `execute` when you do not already know the tool you need.",
  },
  describe: {
    name: "describe",
    description:
      "Return TypeScript signatures (and, with detail=full, documentation and output types) for the given tools " +
      "or for every tool of a server. Call this to learn exact argument shapes before writing code.",
  },
  execute: {
    name: "execute",
    description:
      "Run TypeScript/JavaScript in a sandbox. Call tools as `await tools.<server>.<tool>({...})`. " +
      "Use loops, filters and `console.log` freely; only the returned value and logs come back to you. " +
      "The sandbox has no network, filesystem, timers beyond the deadline, or access to credentials. " +
      "Return a compact result; large intermediate data should stay in the sandbox.",
  },
} as const;

export function executeInstructions(rootName = DEFAULT_ROOT_NAME): string {
  return [
    `Write the body of an async function. Use \`return\` to send a value back.`,
    `Tools are at \`${rootName}.<server>.<tool>(args)\` and return Promises. Call \`describe\` first for exact types.`,
    `Independent tool calls may run concurrently with Promise.all.`,
    `Errors from tools throw; catch them if you want to continue.`,
  ].join("\n");
}
