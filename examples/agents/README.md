# Driving codemcp from a raw model API

Anything that speaks MCP attaches to codemcp by launching `codemcp serve`: Claude Code, Cursor, VS Code, Claude Desktop, Codex CLI, the Claude Agent SDK, the OpenAI Agents SDK, the Vercel AI SDK, LangChain's MCP adapters. Snippets for the editors are in [../clients/README.md](../clients/README.md).

For a raw model API you run the tool loop yourself. The whole surface is three tools, so the loop is short. Two complete examples live here:

| File | API | Run |
|---|---|---|
| `openai-responses.mjs` | OpenAI Responses | `OPENAI_API_KEY=... node agents/openai-responses.mjs "which garden items are low on stock?"` |
| `anthropic-messages.mjs` | Anthropic Messages | `ANTHROPIC_API_KEY=... node agents/anthropic-messages.mjs "which garden items are low on stock?"` |

Both start the proxy in-process, read its tool list over MCP, convert each tool to the API's function shape, send your question, answer every tool call by calling the proxy, and stop when the model replies without one. Chat Completions works the same way with `tools: [{ type: "function", function }]` and `tool_calls`.

Set the key in your shell, never in a file. Models default to `gpt-5.6` and `claude-sonnet-5-5`; override with `OPENAI_MODEL` or `ANTHROPIC_MODEL`. To hit a different endpoint, set `OPENAI_BASE_URL` or `ANTHROPIC_BASE_URL`.

```powershell
$env:ANTHROPIC_API_KEY = "sk-ant-..."; node examples/agents/anthropic-messages.mjs "which garden items are low on stock?"
```

A working run prints each tool call as `> name(args)` with the start of the proxy's reply, then the answer. Expect a `describe` or `search`, one `execute`, then the answer. Ask "delete item 1 from the catalog" to see the approval path: `execute` comes back `Paused`, the model asks you, and when it calls `approve` the terminal confirms before forwarding.

## Approvals from a loop

When a script hits a tool that needs approval, `execute` returns `Paused:` with the execution id and call number. Two ways to handle it:

- Leave `approvals.tool` at `auto` (or `true`). The model sees `approve` as an ordinary tool whose description says to ask a human first, and your loop confirms at the terminal. That is what these scripts do.
- Set `approvals.tool: false` and resolve pauses from an operator channel by calling `proxy.resume()`. The browser chat does this: it hides `approve` from the model and shows a card instead.

Either way the sandbox stays suspended inside the call. Nothing is replayed.

## Without a key

`mock-api.test.mjs` stands up a local server that plays each API, has the "model" ask for an `execute`, and checks the proxy's result comes back in the exact shape the real API expects. It runs under `pnpm --filter codemcp-examples test`.
