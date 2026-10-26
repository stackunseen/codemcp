# codemcp-core

Everything in codemcp that does not touch a transport or a sandbox runtime:

- `ToolRegistry`: tools from all upstream servers, namespaced and ordered deterministically
- `SchemaTypeWriter` and `StubGenerator`: JSON Schema to the TypeScript declarations the model reads
- `BridgeHost`: the host side of the bridge; pin check, policy, approval, budget, validation, audit, forward
- `Policy`, `PinStore`, `Budget`: the governance pieces the bridge consults
- `CodeNormalizer`: fixes common model formatting mistakes and syntax-checks the result
- `ToolSearch`: BM25 search over tool names, descriptions and parameters
- audit sinks: JSONL file, stderr, memory
- `BRIDGE_ERRORS`, `BridgeCallError`, `callHostFunction`: the error contract shared by every executor

See `docs/BRIDGE_PROTOCOL.md` at the repo root for the wire contract.
