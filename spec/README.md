# codemcp specification

This directory is the language-neutral definition of codemcp. Every implementation, whatever it is written in, reads these files and is tested against them. The TypeScript in `packages/` is one port of this directory, not the thing itself.

| Path | What it fixes | How implementations use it |
|---|---|---|
| `VERSION` | The spec version an implementation claims | Exposed as `SPEC_VERSION`; bumped on any change here, major for a breaking one |
| `bridge/errors.json` | Every error code a guest can see, and whether it ends the execution | Generated into source by `pnpm spec:sync`; the host, executors and tests read the generated copy |
| `bridge/messages.schema.json` | The JSON shapes that cross the sandbox boundary | Validated in executor tests |
| `config/codemcp.config.schema.json` | The user's config file | Validated at load; a config written for one implementation works with another |
| `audit/events.schema.json` | Audit event shapes | Validated in tests; collectors can rely on it |
| `policy/cases.json` | Policy decisions for given rules, tools and principals | Table-driven test in every implementation |
| `stubs/cases.json`, `stubs/types.json` | Golden outputs of the stub generator and the schema-to-type mapping | Table-driven test; outputs must match byte for byte |
| `conformance/cases.json` | Hostile-script and semantics cases every executor must pass | Generated into the conformance package; scripts are keyed by guest language |

## Host language and guest language are different things

The host language is what the proxy is written in. It decides which MCP SDK you use and how the CLI feels. The guest language is what the model writes and the sandbox runs: JavaScript on QuickJS today, Python on Monty later. They are independent. A Python host can run the JavaScript guest, and a TypeScript host can run the Python guest. That is why each conformance case carries one script per guest language and a single shared expectation.

## Changing the spec

Edit the files here, run `pnpm spec:sync` to regenerate the derived sources, and run the tests. CI runs `pnpm spec:check`, which fails if a generated file is stale.
