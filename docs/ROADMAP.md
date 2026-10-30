# Roadmap

Items are in rough order of priority, not on a calendar. Order can change; issues and pull requests are welcome on any item.

## Done

Monorepo with three-OS CI. Core: registry, deterministic TypeScript stubs at three detail levels, JSON-only bridge, policy with annotation inference and per-principal rules, budgets, pinning with drift detection, audit sinks, code normalization, search. QuickJS-WASM executor with memory, stack and deadline limits. A 30-case conformance suite driven from `spec/`. The proxy: stdio MCP server with `search`, `describe` and `execute`, passthrough tools, stdio and Streamable HTTP upstreams, config import from the major clients, parked approvals through elicitation, the `approve` tool or an operator channel, pluggable identity. End-to-end tests through a real upstream. A browser chat with your own key and a playground. Packages published to npm with provenance from a one-click release workflow. A benchmark harness that runs read-only tasks against real MCP servers with codemcp and with every tool passed directly, checks answers, and publishes the numbers in [BENCHMARK.md](BENCHMARK.md) through a workflow. Description hygiene at ingestion with a switch to turn it off; pin files that keep the approved definition so `codemcp approve` shows a diff; line numbers on syntax and runtime errors; a `server.json` for the MCP registry.

## Next

- [ ] Publish benchmark numbers for three model families from the `benchmark` workflow
- [ ] A `reason` field on `approval_required` errors (denied, expired, no approver) so scripts branch on it instead of the message text; publish to the MCP registry from the release workflow
- [ ] Install recipes per client with CI smoke tests
- [ ] Structured results through passthrough and `execute`
- [ ] Migrate to the MCP TypeScript SDK v2: dual-era negotiation, one server object per request, `ttlMs` / `cacheScope` / `resultType`, approvals as multi round-trip requests on 2026-07-28 connections
- [ ] HTTP server mode with per-connection identity; upstream elicitation relay; resources and prompts
- [ ] OAuth 2.1 for upstream HTTP servers with tokens in the OS keychain
- [ ] Deno subprocess executor; Monty executor and Python stubs

## Later

- [ ] Tool-list, stub and idempotent-result caching keyed by `ttlMs` / `cacheScope` and description hash
- [ ] Hybrid mode: adaptive passthrough from call-shape statistics
- [ ] OpenAPI connector
- [ ] Docker + gVisor and self-hosted E2B / microsandbox executors
- [ ] Per-principal upstream credentials; SSO-ready audit records; SIEM export
- [ ] Budget caps and alerting across sessions; Helm chart
- [ ] An MCP extension proposal for a `code_execution` capability
