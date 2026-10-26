# Where codemcp stands

An honest status page. I update it when something lands or breaks.

## What works

- **Small tool surface.** Three fixed tools, about 500 tokens. Stubs are pulled on demand at three detail levels, and `describe` refuses to dump more than 60 signatures at once.
- **Data stays in the sandbox.** Loops, filters and joins run there; concurrent calls are batched. A two-server join of 12 calls returns two numbers in about 120 ms.
- **Arguments are validated before the network.** A bad call gets a catchable `invalid_arguments` with the JSON pointer, and the script fixes it in the same run.
- **Policy is evaluated on the qualified `server.tool` name**, never on a name the model typed. Annotations infer read-only and destructive; explicit rules override.
- **Limits are enforced from outside the guest.** Call, per-result, total and return byte budgets; memory, stack and deadline; a worker heap cap; the guest clock stops while waiting on the host.
- **No credential enters the sandbox.** No process, env, fs or network in there. Each upstream holds its own transport, env and headers. A missing `${VAR}` fails at startup.
- **Approvals park the script.** The suspended worker is the state. A decision is keyed by execution id and call number and arrives through elicitation, the `approve` tool or an operator channel. A denial is catchable.
- **Pinned definitions.** The hash covers name, description, schemas and annotations. Drift is fatal at call time and logged.
- **Formatting repair.** Fences, wrappers and literal newlines are fixed, TypeScript is erased, and the syntax is checked before a worker is spawned.
- **Audit.** JSONL per execution and per call, with decision, bytes, duration and trace context, to a file, stderr, a webhook or your own callback.
- **Identity.** A pluggable provider (`local`, `static`, `trusted-header`) resolves a principal that policy, approvals and audit all key on.
- **Portable executor contract** with a 30-case conformance suite driven from `spec/`.

None of Cloudflare Code Mode, Anthropic programmatic tool calling, FastMCP code mode or pctx ship pinning, per-tool approval policy, mid-script approval and an audit log together. Isolation is weaker than a V8 isolate in its own process and stronger than in-process execution; the threat model says so.

## What is open

**Blocking a multi-tenant deployment.** Pins and budgets are per process, upstream credentials are per server rather than per principal, and there is no HTTP server mode to carry an identity header. All of it waits on the SDK v2 migration.

**Major**

- No OAuth for upstream HTTP servers, so most hosted servers are unreachable with static headers alone.
- Upstream elicitation, sampling and roots are refused; resources and prompts are not proxied.
- Passthrough flattens results to text and loses `structuredContent`, images and resource links.
- New tools are pinned on first use, including ones a compromised server adds later, and `codemcp approve` shows no diff. Remote servers should default to manual pinning.
- Descriptions reach the model unfiltered: no length cap, no control-character stripping, no check for cross-server mentions.
- Return types are mostly `Promise<unknown>` because few servers ship an `outputSchema`.
- Runtime errors carry no line number.
- No state between executions; a second pass refetches and spends the budget again.
- Stdio only: one proxy process per client, every upstream respawned when the client restarts.

**Minor.** Passthrough names allow `$` and have no 64-character cap; `_meta` trace context is not forwarded upstream; `describe`'s description embeds the live server list and busts prompt caches; pretty-printed JSON costs 20 to 30 percent more tokens than compact; refresh requests arriving mid-refresh are dropped; Ajv compiles untrusted `pattern` regexes in the host; base64 content passes into the sandbox whole; worker plus WASM startup costs about 120 ms per execute.

## Against the current MCP release

Checked 2026-10-26. The newest spec revision is 2026-07-28. The TypeScript SDK split: 1.x, which I pin, stops at 2025-11-25 and gets fixes until about January 2027; v2 (`@modelcontextprotocol/server`, `/client`, `/core`, `/node`, 2.4.0) implements 2026-07-28 and still speaks 2025-11-25 through `initialize`.

What that means here, in order of impact:

1. **Move to v2 and become dual-era.** On 1.x the proxy can neither accept a modern-only client nor reach a modern-only upstream. The codemod does the mechanical part; the structural changes are one server object per request, `versionNegotiation: { mode: "auto" }` on the client, and `fromJsonSchema()` for proxied tools.
2. **Approvals become multi round-trip requests** on modern connections: a tool result with `resultType: "input_required"` and an opaque `requestState` the client echoes back, which the spec says to treat as attacker-controlled. The parked execution already has the right handle, execution id plus call number.
3. **Stateless by construction**: no session id, deterministic ordering, and `ttlMs`, `cacheScope` and `resultType` on list results. The registry already orders deterministically; the fields are missing because the 1.x types lack them.
4. `subscriptions/listen` replaces `list_changed` and the GET stream. `ping`, `logging/setLevel`, roots and sampling are gone or deprecated.
5. Progress and cancellation flow through the handler context, and a closed response stream is a cancellation. The signal and progress plumbing is already in place.
6. Tasks moved to an extension; long executions and approvals are its textbook case.
7. Auth changed: Dynamic Client Registration is deprecated in favour of Client ID Metadata Documents, and v2 ships `AuthProvider` and `OAuthClientProvider`. Upstream OAuth should start there.
8. Streamable HTTP now requires `Mcp-Method`, `Mcp-Name` and `MCP-Protocol-Version` on every POST, and tells aggregators to prefix colliding tool names with a server id, which the passthrough naming already does.

Not verified: the exact v2 helper for emitting `input_required`, and whether `tasks/update` is implemented in 2.4.0.

## Order I intend to work in

Description hygiene and manual pinning with diffs for remote servers; structured results through passthrough and `execute`; the SDK v2 migration, which unblocks upstream elicitation, resources, OAuth and HTTP server mode; then those four.
