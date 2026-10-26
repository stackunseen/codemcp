# Examples

Everything here runs against two small MCP servers in `servers/`: a product catalog with notes, and a CRM with customers and orders. Between them they have read-only, plain and destructive tools, so you see policy decisions and not just the happy path.

Build first, from the repo root:

```bash
pnpm install && pnpm build
```

## Scripted walkthrough

```bash
pnpm --filter codemcp-examples basic
```

No model, no browser. It starts the proxy in-process, talks to it over an in-memory MCP transport exactly as a client would, and prints each step: the advertised tools, a search, the stubs, a fan-out `execute`, a join across both servers, a parked destructive call being approved, argument validation, the empty sandbox, a budget overrun, a passthrough call, and the audit summary. It is the fastest check after a change and what `pnpm test` runs here.

## Chat with your own key

```bash
pnpm --filter codemcp-examples ui
```

Open http://localhost:8765. Pick Anthropic or OpenAI, paste your key, ask a question. The model loop runs in the browser, so the key goes from the page straight to the provider and never to the local server. Tool calls go to the local proxy. When a script stops on a call that needs approval, a card appears with Approve and Deny; the model only sees the final result after you decide.

The sidebar lets you add MCP servers by command or URL with one secret as `NAME=value`, shows each one's connection state, and can save the list to the config in use. Secrets typed there go to the local proxy only and are written as typed if you save, so swap them for `${VAR}` references before committing.

To try the page without a key, add `?base=http://127.0.0.1:PORT` and provider requests go to that stand-in instead; `agents/mock-api.test.mjs` shows the shapes it has to speak.

## Playground

http://localhost:8765/playground.html shows what the model sees: the registry with hints, pins and server states, the stubs at three detail levels, an editor to run code against `tools.<server>.<tool>`, an approvals panel, and the audit log. Nothing is mocked; it is the same `Proxy` class a client talks to.

## From a raw model API

`agents/openai-responses.mjs` and `agents/anthropic-messages.mjs` run a complete tool loop against the Responses and Messages APIs with codemcp as the only tool provider. See [agents/README.md](agents/README.md).

## Through a real MCP client

```bash
cd examples
node ../packages/proxy/dist/cli.js tools --config basic/codemcp.config.json
node ../packages/proxy/dist/cli.js stubs --config basic/codemcp.config.json --detail full
```

Then point Claude Code, Cursor, VS Code, Claude Desktop or Codex at `codemcp serve`; snippets are in [clients/README.md](clients/README.md).

## Your own servers

Set `CODEMCP_CONFIG` to a config file and every example uses those servers instead. [real/README.md](real/README.md) walks through importing your client configs and running against the filesystem and GitHub reference servers.

## Testing a change

| Changed | Run |
|---|---|
| `core` | `pnpm --filter codemcp-core test` |
| the sandbox | `pnpm --filter codemcp-executor-quickjs test` |
| the proxy or config import | `pnpm --filter codemcp test` |
| everything | `pnpm build && pnpm typecheck && pnpm test` |
