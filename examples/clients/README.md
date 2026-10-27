# Wiring codemcp into an MCP client

Every client launches the same command: `npx -y codemcp-cli serve`. From a checkout you can use the built CLI instead (`node <repo>/packages/proxy/dist/cli.js serve`).

The proxy reads `codemcp.config.json` from the working directory, or `~/.codemcp/config.json`. Generate one from the servers you already have:

```bash
npx -y codemcp-cli import --write
```

Then replace those servers in the client config with the single entry below, so the client sees `search`, `describe` and `execute` instead of every upstream tool.

## Claude Code (`.mcp.json` in the project, or `~/.claude.json`)

```json
{
  "mcpServers": {
    "codemcp": { "command": "npx", "args": ["-y", "codemcp-cli", "serve"] }
  }
}
```

## Cursor (`.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "codemcp": { "command": "npx", "args": ["-y", "codemcp-cli", "serve", "--config", "/absolute/path/codemcp.config.json"] }
  }
}
```

## VS Code (`.vscode/mcp.json`)

```json
{
  "servers": {
    "codemcp": { "type": "stdio", "command": "npx", "args": ["-y", "codemcp-cli", "serve"] }
  }
}
```

## Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "codemcp": { "command": "npx", "args": ["-y", "codemcp-cli", "serve", "--config", "/absolute/path/codemcp.config.json"] }
  }
}
```

Claude Desktop does not start servers from a project directory, so pass `--config` with an absolute path.

## Codex CLI (`~/.codex/config.toml`)

```toml
[mcp_servers.codemcp]
command = "npx"
args = ["-y", "codemcp-cli", "serve"]
```

Codex asks before each `execute` call unless the tool is marked read-only or you have set an approval policy.

## Checking it works

Ask the model something that needs several tool calls, for example "find every garden item under 50 and tell me the total stock". With codemcp the model should call `describe` once, then `execute` once with a short loop, instead of one tool call per item. The audit log at `~/.codemcp/audit.jsonl` shows every bridged call.
