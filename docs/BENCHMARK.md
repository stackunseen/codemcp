# Benchmark: codemcp against the same servers attached directly

This page is replaced by `examples/benchmark/run.mjs` on every run of the `benchmark` workflow. Each task runs twice per model and repeat: once with codemcp's three tools (`search`, `describe`, `execute`) and once with every upstream tool definition passed to the provider as `server__tool` and calls made straight to the servers. Token counts are the providers' own `usage` figures with no prompt caching. A run passes when the final answer matches every regex in `examples/benchmark/tasks.json`.

**No model run has been published yet.** The tables below cover what can be computed without a model key: the size of each server's tool definitions. The headline table, pass rates and per-task figures appear here after the first run of the workflow (Actions tab, "benchmark") or of the command under "Reproduce".

## Server set `no-key`

Public servers that need no credentials. 71 tools across 7 servers, about 11,732 tokens of tool definitions when attached directly, against about 491 for codemcp's 3 tools.

### Servers ranked by definition cost

What each server adds to every request when attached directly, estimated at four characters per token over the JSON the provider receives.

| Rank | Server | State | Tools | Definition tokens | Share |
| --- | --- | --- | --- | --- | --- |
| 1 | `playwright` | connected | 25 | 4,481 | 38% |
| 2 | `fs` | connected | 14 | 2,034 | 17% |
| 3 | `everything` | connected | 16 | 1,834 | 16% |
| 4 | `memory` | connected | 9 | 1,137 | 10% |
| 5 | `thinking` | connected | 1 | 1,013 | 9% |
| 6 | `mslearn` | connected | 3 | 960 | 8% |
| 7 | `deepwiki` | connected | 3 | 273 | 2% |

Measured on 2026-10-27 with the package versions `npx -y` resolved that day; the two remote servers are `https://mcp.deepwiki.com/mcp` and `https://learn.microsoft.com/api/mcp`.

## Tasks

| Id | Servers | Question |
| --- | --- | --- |
| `fs-list-packages` | `fs` | The filesystem server is rooted at a source repository. List the directories directly under its `packages` folder and state how many there are. |
| `fs-read-license` | `fs` | Which open-source license does the repository on the filesystem server use? Read its top-level LICENSE file and answer with the license name. |
| `fs-search-then-read` | `fs` | Search the filesystem server for files named `codemcp.config.json`, then read the one under `examples/basic` and tell me the names of the servers it configures. |
| `fs-package-name` | `fs` | Read `packages/proxy/package.json` from the filesystem server and report the package's name. |
| `everything-sum` | `everything` | Use the everything server to add 17 and 25 and report the result. |
| `everything-echo` | `everything` | Use the everything server's echo tool to echo the phrase `benchmark ping` and tell me exactly what came back. |
| `count-everything-tools` | `everything` | List the names of every tool the everything server offers and say how many there are. |
| `memory-search` | `memory` | Search the memory server's knowledge graph for entities about `codemcp` and report how many you found. |
| `thinking-prime` | `thinking` | Use the sequential thinking tool for three thoughts to work out whether 221 is prime. Then answer: is it prime, and if not, what are its factors? |
| `mslearn-az-login` | `mslearn` | Search Microsoft Learn for the Azure CLI command that signs you in to Azure and tell me the exact command. |
| `deepwiki-transports` | `deepwiki` | Ask DeepWiki which transports the `modelcontextprotocol/typescript-sdk` repository supports and list them. |
| `join-fs-everything` | `fs`, `everything` | Count the directories directly under the `packages` folder of the filesystem server, then use the everything server to add that count to 100. Report both the count and the sum. |
| `join-memory-everything` | `memory`, `everything` | Read the memory server's whole knowledge graph and count its entities. Then use the everything server to add 1 to that count. Report both numbers. |

## Reproduce

```bash
pnpm install && pnpm build
pnpm --filter codemcp-examples benchmark -- --set no-key --repeats 2 --models claude-sonnet-5-5,claude-haiku-5-5,gpt-5.6
```

Set `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` for the providers you want; a model whose key is missing is skipped. The `with-keys` set also needs the variables named in `examples/benchmark/servers.json`. The direct side bypasses codemcp's policy, approvals, pinning and audit; it exists only to measure the difference.
