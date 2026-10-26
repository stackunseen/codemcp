# Roadmap

Dates are relative to the first commit, October 2026. The research behind the order is in [reports](reports/).

## Done

Monorepo with three-OS CI. Core: registry, deterministic TypeScript stubs at three detail levels, JSON-only bridge, policy with annotation inference and per-principal rules, budgets, pinning with drift detection, audit sinks, code normalization, search. QuickJS-WASM executor with memory, stack and deadline limits. A 30-case conformance suite driven from `spec/`. The proxy: stdio MCP server with `search`, `describe` and `execute`, passthrough tools, stdio and Streamable HTTP upstreams, config import from the major clients, parked approvals through elicitation, the `approve` tool or an operator channel, pluggable identity. End-to-end tests through a real upstream. A browser chat with your own key and a playground.

## Next

- [ ] Publish `0.1.0` to npm with provenance
- [ ] Install recipes per client with CI smoke tests
- [ ] Measure and publish the token footprint of the three-tool surface
- [ ] Description hygiene at ingestion; manual pinning with diffs for remote servers
- [ ] Structured results through passthrough and `execute`

## Month 1

- [ ] Migrate to the MCP TypeScript SDK v2: dual-era negotiation, one server object per request, `ttlMs` / `cacheScope` / `resultType`, approvals as multi round-trip requests on 2026-07-28 connections
- [ ] HTTP server mode with per-connection identity; upstream elicitation relay; resources and prompts
- [ ] OAuth 2.1 for upstream HTTP servers with tokens in the OS keychain
- [ ] Deno subprocess executor; Monty executor and Python stubs
- [ ] Benchmark harness against naive MCP and Tool Search, numbers for three model families
- [ ] Launch write-up

## Months 2 to 3

- [ ] Tool-list, stub and idempotent-result caching keyed by `ttlMs` / `cacheScope` and description hash
- [ ] Hybrid mode: adaptive passthrough from call-shape statistics
- [ ] OpenAPI connector
- [ ] Docker + gVisor and self-hosted E2B / microsandbox executors
- [ ] Registry listings

## Months 4 to 6

- [ ] Per-principal upstream credentials; SSO-ready audit records; SIEM export
- [ ] Budget caps and alerting across sessions; Helm chart
- [ ] An MCP extension proposal for a `code_execution` capability
- [ ] Hosted execution and enterprise governance as the sustainability path
