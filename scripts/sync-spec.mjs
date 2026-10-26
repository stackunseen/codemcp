// Regenerates the source files that are derived from spec/. Run `node scripts/sync-spec.mjs` to write
// them, or `node scripts/sync-spec.mjs --check` to fail when a committed file is stale (CI does this).
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const check = process.argv.includes("--check");
const read = (p) => readFileSync(join(root, p), "utf8");
const header = (source) => `// Generated from ${source} by scripts/sync-spec.mjs. Do not edit; edit the spec and run \`pnpm spec:sync\`.\n`;

const version = read("spec/VERSION").trim();
const errors = JSON.parse(read("spec/bridge/errors.json"));
const conformance = JSON.parse(read("spec/conformance/cases.json"));

const outputs = {
  "packages/core/src/generated/spec.ts":
    header("spec/VERSION and spec/bridge/errors.json") +
    `export const SPEC_VERSION = ${JSON.stringify(version)};\n\n` +
    `/** Every error code a guest can observe on a rejected call, and whether it also ends the execution. */\n` +
    `export const BRIDGE_ERRORS = {\n` +
    Object.entries(errors.codes).map(([code, { fatal }]) => `  ${code}: { fatal: ${fatal} },`).join("\n") +
    `\n} as const;\n\n` +
    `/** Codes raised by an executor itself. */\n` +
    `export const EXECUTION_CODES = ${JSON.stringify(errors.executionCodes)} as const;\n`,
  "packages/conformance/src/generated/cases.ts":
    header("spec/conformance/cases.json") +
    `import type { SpecCase } from "../spec-types.js";\n\n` +
    `export const CASES: readonly SpecCase[] = ${JSON.stringify(conformance.cases, null, 2)};\n`,
};

let stale = 0;
for (const [path, content] of Object.entries(outputs)) {
  let current;
  try {
    current = read(path);
  } catch {
    current = undefined;
  }
  // Compare with normalized line endings so a CRLF checkout (Windows runners) is not reported as stale.
  if (current?.replace(/\r\n/g, "\n") === content) continue;
  if (check) {
    console.error(`stale: ${path}`);
    stale++;
  } else {
    writeFileSync(join(root, path), content);
    console.log(`wrote ${path}`);
  }
}
if (check && stale) {
  console.error("run `pnpm spec:sync` and commit the result");
  process.exit(1);
}
