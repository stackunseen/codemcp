# Running the examples against real MCP servers

Everything in `examples/` takes a config file through the `CODEMCP_CONFIG` environment variable. Leave it unset and you get our demo catalog and CRM servers.

## 1. Get a config

Either import the servers your MCP clients already have:

```bash
node packages/proxy/dist/cli.js import --write
```

That writes `codemcp.config.json` in the current directory from Claude Code, Cursor, VS Code, Claude Desktop, Windsurf and Codex configs.

Or start from the one in this folder. It connects two reference servers: the filesystem server rooted at the current directory (no credentials) and the GitHub server, which needs a token:

```bash
export GITHUB_TOKEN=ghp_...        # PowerShell: $env:GITHUB_TOKEN = "ghp_..."
```

Delete the `github` entry if you only want the filesystem server. Both are started with `npx`, so the first run downloads them.

## 2. Check what connected

```bash
node packages/proxy/dist/cli.js tools --config examples/real/codemcp.config.json
```

The first lines show each server's state (`connected`, `auth_failed`, `unreachable`), then every tool with its pin status and annotations. A wrong token shows up here, before any model is involved. Relative `args` and `cwd` in the config resolve against the config file's folder.

## 3. Run the walkthrough or the playground against it

```bash
CODEMCP_CONFIG=examples/real/codemcp.config.json pnpm --filter codemcp-examples ui
```

On PowerShell:

```powershell
$env:CODEMCP_CONFIG = "examples/real/codemcp.config.json"; pnpm --filter codemcp-examples ui
```

The playground then lists your real servers. The walkthrough (`basic`) is written for the demo catalog and will mostly report unknown tools against other servers; use the playground or write your own script with `ProxyHarness` from `examples/lib/harness.mjs`.

A script worth trying in the playground against the filesystem server:

```js
const entries = await tools.fs.list_directory({ path: "." });
const names = String(entries).split("\n").filter((l) => l.startsWith("[FILE]")).map((l) => l.slice(7));
const sizes = await Promise.all(names.slice(0, 5).map(async (n) => ({ n, info: await tools.fs.get_file_info({ path: n }) })));
return sizes;
```

Note what `describe` shows: most real servers return text rather than structured content, so results arrive as strings unless they parse as JSON. That is the "return types are mostly unknown" item in docs/ASSESSMENT.md.

## 4. Through a real client

Point Claude Code, Cursor or VS Code at:

```bash
node <repo>/packages/proxy/dist/cli.js serve --config <repo>/examples/real/codemcp.config.json
```

Snippets per client are in [../clients/README.md](../clients/README.md). Writes to the filesystem and creating or pushing to GitHub are marked `approve` in this config, so the client either shows an elicitation prompt or the model is handed an `approve` tool it must ask you before calling. The audit log lands in `.codemcp/audit.jsonl` next to wherever you ran it, with results included.
