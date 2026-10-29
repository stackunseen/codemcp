# Credentials, identity and approvals

codemcp sits between your client and your upstream servers. A credential can live in three places, and codemcp keeps them apart on purpose.

```
client ──(stdio)──► codemcp ──► upstream A (stdio, needs an API key)
                      │     └► upstream B (HTTP, needs a bearer token)
                      └── sandbox: JSON results only, never a credential
```

## The sandbox never holds a credential

Code the model writes runs with no environment, no filesystem and no network. All it can do is call `tools.<server>.<tool>(args)`, which sends JSON to the proxy. The proxy looks up the connection it already holds for that server and forwards the call. The script gets an already-authorized client, never the key that authorized it, and the conformance suite checks that `process`, `fetch` and `require` are undefined in there.

## Upstream credentials live in the proxy

A stdio server gets its secrets as environment variables. Each one starts with a minimal environment plus whatever you put in its `env`; nothing else from the proxy's environment leaks across.

```json
{
  "servers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}" }
    },
    "remote": {
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ${EXAMPLE_TOKEN}" }
    }
  }
}
```

`${NAME}` is replaced from the proxy's environment when the config loads. An unset variable is an error at startup, so a missing secret fails loudly instead of producing an empty token. Keep the values in your shell, a `.env` loader or your secret manager; the config file itself is safe to commit.

Credentials belong to the connection, not the call. Each `servers` entry is one connection with its own transport, environment and headers. When a script calls `tools.crm.list_orders()` the bridge forwards to the `crm` connection; the script names a tool and never sees or chooses a credential. Two entries can run the same server binary with different tokens and each gets only its own.

## Identity on the client side

Every request acts for a principal, resolved once by an identity provider. Policy, approvals and audit key on it without knowing how it was obtained, which is what lets you swap the provider in config.

| `identity.mode` | Principal comes from | Use it for |
|---|---|---|
| `local` (default) | the OS user that launched the proxy; stdio only | your laptop, one agent per process |
| `static` | a bearer token looked up in `identity.tokens` (`{ id, roles, tenant }`) | a small shared instance without an identity server |
| `trusted-header` | `x-forwarded-user` and `x-forwarded-roles` set by a gateway that already authenticated the user | behind an API gateway or mesh that is the only way in |

A request whose principal cannot be resolved is refused, so a misconfigured provider fails closed. `jwt` and `oauth` providers will come on top of the SDK v2 auth helpers.

With a principal, policy rules can decide per subject:

```json
"crm.refund_order": { "roles": { "finance": "approve" }, "principals": { "ada": "allow" }, "default": "deny" }
```

The id is checked first, then roles in the order the principal lists them, then the default. Approvals are bound to the principal that started the execution; only that principal or an operator role (`approvals.operatorRoles`, default `["operator"]`) can resume it. Every audit event carries the principal.

Per-principal upstream credentials, where the finance lead's own GitHub login is used for her calls, need the SDK v2 migration first.

## Human in the loop

When policy marks a call `approve`, by rule or because the server flagged it `destructiveHint`, the call stops at the bridge. The state that has to survive the wait is the script itself, and it stays exactly where it is: suspended inside `await tools.x.y()`, worker alive, nothing replayed. The wait has its own limit (`approvals.timeoutMs`, default ten minutes) and does not count against the script's deadline.

The decision reaches the proxy one of three ways:

- **Elicitation.** If the client advertises it, the proxy asks through it and the execution finishes inside the same request.
- **The `approve` tool.** Otherwise `execute` returns `Paused: execution <id> is waiting for approval of call #<n> ...` and advertises `approve`. The default `approvals.tool: "auto"` only advertises it to clients without elicitation. The model is told to ask you first; the agent examples confirm at the terminal.
- **An operator channel.** With `approvals.tool: false` the model cannot approve; something that holds the `Proxy` object calls `resume(executionId, seq, allow)`. The chat page and playground do this over HTTP.

The resumed run's result is returned to whoever decided. A denial rejects the call with `approval_required`, which the script can catch.

## Not there yet

OAuth 2.1 for upstream HTTP servers. Many hosted servers expect an interactive flow rather than a static token. Until it lands, use a pre-issued token in `headers`.

## Knowing what connected

Every configured server has a state: `connected`, `auth_failed`, `unreachable` or `listing_failed`. `codemcp tools` prints it, the UI shows it, and the model is told too: an empty `search` names unavailable servers and `describe` on one explains why, so a missing credential reads as "an operator must fix this" rather than "that tool does not exist".

## Tracing what ran

Each execution writes an `execution_start` event (code hash, normalization fixes, principal, and the source with `audit.includeCode`), a `call_start` event before each call is forwarded (tool, decision, and arguments with `audit.includeArgs`), one `call` event per bridged call when it settles (tool, decision, duration, bytes, arguments), and an `execution_end` event (status, call count, and the result with `audit.includeResults`). Events carry the request's `traceparent` when the client sends one.

Several destinations can be active at once: `audit.file` (default `~/.codemcp/audit.jsonl`), `audit.stderr`, `audit.webhook` (`{ url, headers, batchMs }`, batched, retried once, never slows an execution), and `onAudit` on `ProxyOptions` for your own tracer or queue. The sink classes are exported from `codemcp-core`.
