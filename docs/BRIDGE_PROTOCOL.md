# Bridge protocol v1

The bridge is the only channel between a sandbox (the guest) and the proxy (the host). It is narrow on purpose, so the same policy, budget, audit and credential handling applies whichever executor runs the code.

## Rules

Everything that crosses is JSON. No functions, host objects, schema instances, tokens or client references cross in either direction; executors deep-copy through `JSON.parse(JSON.stringify(x))` at the boundary to make sure.

Each guest call carries a `seq` that increases within one execution, and the host answers with the same `seq`. That is what lets an approval pause and resume one specific call.

The guest addresses tools by `<namespace>.<stubName>`, both sanitized identifiers. The host maps that to the upstream `server.tool` and evaluates policy on the qualified name.

The transport is whatever suits the executor: host-function callbacks and `postMessage` for the WASM tier, stdio for subprocess tiers, an RPC binding for remote tiers.

## Messages

Guest to host:

```json
{ "type": "call", "seq": 1, "tool": "github.create_issue", "args": { "title": "x" } }
{ "type": "log",  "level": "log", "message": "..." }
```

Host to guest:

```json
{ "v": 1, "seq": 1, "ok": true,  "value": { "...": "..." } }
{ "v": 1, "seq": 1, "ok": false, "error": { "code": "policy_denied", "message": "..." } }
```

Per call the host runs, in order: pin check, policy, approval if required, argument validation, call budget, audit `call_start` event (awaited, so the sink holds it before anything leaves the process), forward upstream with an abort signal and timeout, serialize, truncate to `maxResultBytes`, byte budget, audit `call` event, return.

`sleep(ms)` is the guest's one other asynchronous capability, carried the same way and counted against the deadline. A script that returns while a call is still pending fails with a `runtime_error` naming the missing `await`; the call is still forwarded, never dropped.

## Error codes

The single source is `spec/bridge/errors.json`, generated into `BRIDGE_ERRORS` in `codemcp-core`. Fatality is a property of the code, not the throw site.

| code | meaning | fatal |
|---|---|---|
| `unknown_tool` | no such stub; use `search` / `describe` | no |
| `invalid_arguments` | failed schema validation | no |
| `upstream_error` | the upstream server returned an error | no |
| `policy_denied` | denied by a policy rule | no |
| `approval_required` | needed human approval and none was granted | no |
| `pin_drifted` | the tool definition changed since approval | yes |
| `budget_exceeded` | call count or byte budget exhausted | yes |

A refused call is catchable so a script can fall back or return partial work. A fatal error ends the execution even if caught: after drift or an exhausted budget nothing further can be trusted. Host functions throw `BridgeCallError`; anything else is reported as `upstream_error`. Executors use `callHostFunction()` so this shaping never drifts between tiers.

`BRIDGE_PROTOCOL_VERSION` is bumped for any incompatible change, and executors reject an unknown `v`.
