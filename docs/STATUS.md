# Status and known limitations

codemcp is pre-alpha. This page says what you can rely on today and what you cannot yet. It is updated when something lands or breaks.

## What works

- **Small tool surface.** Three fixed tools, about 500 tokens. Stubs are pulled on demand at three detail levels, and `describe` refuses to dump more than 60 signatures at once.
- **Data stays in the sandbox.** Loops, filters and joins run there, and concurrent calls are batched. A two-server join of 12 calls returns two numbers in about 120 ms.
- **Arguments are validated before the network.** A bad call gets a catchable `invalid_arguments` error with the JSON pointer, and the script can fix it in the same run.
- **Policy is evaluated on the qualified `server.tool` name**, never on a name the model typed. A server's `destructiveHint` raises a default of allow to approve; annotations never loosen a decision, so `readOnlyHint` does not bypass a strict default. Explicit rules override.
- **Limits are enforced from outside the guest.** Call, per-result, total and return byte budgets; memory, stack and deadline; a worker heap cap. The guest clock stops while waiting on the host.
- **No credential enters the sandbox.** There is no process, env, filesystem or network inside. Each upstream holds its own transport, env and headers, and a missing `${VAR}` fails at startup.
- **Approvals park the script.** The suspended worker is the state. A decision is keyed by execution id and call number and arrives through elicitation, the `approve` tool or an operator channel. A denial is catchable.
- **Pinned definitions.** The hash covers name, description, schemas and annotations. Drift is fatal at call time and logged. The pin file keeps the approved definition, so `codemcp approve` shows a diff of what changed before it re-pins, and `--dry-run` shows it without pinning.
- **Tool text is cleaned before the model sees it.** Control and invisible characters are removed and descriptions longer than 2000 characters are cut, in the tool description, the schema descriptions and the title. Each edit is logged and shown by `codemcp tools`. Turn it off with `descriptions.clean: false`.
- **Formatting repair.** Fences, wrappers and literal newlines are fixed, TypeScript is erased, and the syntax is checked before a worker is spawned.
- **Errors carry a line number.** Syntax and runtime errors name the line and column in the code the model wrote, counted past any fence or wrapper that was stripped. An error raised inside the bridge itself has no script frame and reports none.
- **Audit.** JSONL per execution and per call, with decision, bytes, duration and trace context, to a file, stderr, a webhook or your own callback.
- **Identity.** A pluggable provider (`local`, `static`, `trusted-header`) resolves a principal that policy, approvals and audit all key on.
- **Portable executor contract** with a 30-case conformance suite driven from `spec/`.
- **Measured.** `examples/benchmark/` runs read-only tasks against seven public MCP servers (71 tools) with codemcp and with every tool passed directly, checks each answer against regexes, and publishes the token, pass-rate and timing tables in [BENCHMARK.md](BENCHMARK.md) through the `benchmark` workflow. The three-tool surface costs about 490 tokens of definitions against about 11,700 for those servers attached directly.
- **Published.** `codemcp-cli`, `codemcp-core`, `codemcp-executor-quickjs` and `codemcp-conformance` ship together on npm with provenance.

Isolation is weaker than a V8 isolate in its own process and stronger than in-process execution. [THREAT_MODEL.md](THREAT_MODEL.md) spells out what each tier does and does not cover.

## Known limitations

Things to know before you depend on codemcp:

- **Single-tenant.** Pins and budgets are per process, upstream credentials are per server rather than per principal, and there is no HTTP server mode to carry an identity header. Run one proxy per user.
- **No OAuth for upstream HTTP servers.** Hosted servers that need an interactive login are unreachable until that lands; use a pre-issued token in `headers`.
- **Upstream elicitation, sampling and roots are refused.** Resources and prompts are not proxied.
- **Passthrough flattens results to text.** `structuredContent`, images and resource links are lost on that path.
- **New tools are pinned on first use**, including ones a server adds later. Run with `--strict` or set `pins.autoApproveNew: false` for remote servers you do not control, then review with `codemcp approve --dry-run`.
- **Return types are mostly `Promise<unknown>`**, because few servers ship an `outputSchema`. Results that parse as JSON are returned as objects, the rest as strings.
- **No state between executions.** A second pass refetches and spends the budget again.
- **Stdio only.** One proxy process per client, and every upstream is respawned when the client restarts.
- **Startup cost.** Worker plus WASM startup is about 120 ms per `execute`.

## What is next

The order of work is in [ROADMAP.md](ROADMAP.md). The next items are structured results through passthrough and `execute`, and the migration to the MCP TypeScript SDK v2, which unblocks upstream elicitation, resources, OAuth and an HTTP server mode.
