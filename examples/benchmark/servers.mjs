// Loads one server set from servers.json as a codemcp config, or explains why it cannot run.
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const BENCHMARK_DIR = fileURLToPath(new URL("./", import.meta.url));
export const DEFAULT_SERVERS_FILE = resolve(BENCHMARK_DIR, "servers.json");

/** Every `${VAR}` referenced by a server map. */
export function referencedVars(servers) {
  const vars = new Set();
  const scan = (v) => {
    for (const m of String(v).matchAll(/\$\{([A-Z0-9_]+)\}/gi)) vars.add(m[1]);
  };
  for (const s of Object.values(servers)) {
    if (s.url) scan(s.url);
    for (const v of Object.values(s.env ?? {})) scan(v);
    for (const v of Object.values(s.headers ?? {})) scan(v);
  }
  return [...vars];
}

/**
 * Resolves a set (following `extends`) into `{ name, servers, missing }`. `missing` lists the unset
 * variables; a set with any is skipped by the runner rather than started with empty secrets.
 */
export async function loadServerSet(name, { file = DEFAULT_SERVERS_FILE, env = process.env } = {}) {
  const { sets } = JSON.parse(await readFile(file, "utf8"));
  if (!sets?.[name]) throw new Error(`No server set "${name}" in ${file}. Sets: ${Object.keys(sets ?? {}).join(", ")}`);
  const base = dirname(resolve(file));
  const servers = {};
  const chain = [];
  for (let cur = name; cur; cur = sets[cur].extends) {
    if (chain.includes(cur)) throw new Error(`Server set "${cur}" extends itself`);
    chain.unshift(cur);
  }
  for (const setName of chain) {
    for (const [serverName, cfg] of Object.entries(sets[setName].servers ?? {})) {
      const s = structuredClone(cfg);
      if (s.args) s.args = s.args.map((a) => (/^\.{1,2}[\/]/.test(a) ? resolve(base, a) : a));
      if (s.env) for (const [k, v] of Object.entries(s.env)) if (/^\.{1,2}[\/]/.test(v)) s.env[k] = resolve(base, v);
      if (s.cwd) s.cwd = resolve(base, s.cwd);
      servers[serverName] = s;
    }
  }
  const missing = referencedVars(servers).filter((v) => env[v] === undefined);
  return { name, description: sets[name].description ?? "", servers, missing };
}

/** The proxy config the benchmark runs a set with: no files written, no approvals, generous budgets. */
export function benchmarkConfig(servers) {
  return {
    servers,
    budget: { maxCalls: 200, maxResultBytes: 1_048_576 },
    limits: { timeoutMs: 60_000 },
    audit: { file: false },
    pins: { file: false },
    approvals: { tool: false },
  };
}
