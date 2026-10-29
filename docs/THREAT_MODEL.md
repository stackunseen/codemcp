# Threat model

## What codemcp protects

The credentials the proxy holds for upstream servers. The host process and machine. Data that tools return. The integrity of actions: no tool call happens that policy did not permit. And the audit log.

## Who attacks, and how

**Prompt injection that becomes code execution.** Any tool result, web page or document can steer the model into writing hostile code. In August 2026 Check Point chained prompt injection, model-written TypeScript and a workerd memory bug into native code execution. So codemcp treats every script as attacker-authored, full stop.

**Tool poisoning and rug pulls.** A compromised server can put instructions in tool descriptions (Invariant Labs, April 2025) or change a description after you approved it (Microsoft, June 2026). codemcp hashes and pins every definition, including annotations and output schema, and blocks the tool when the hash changes.

**Cross-server shadowing.** One server's description tries to redirect calls to another server's tool. Stubs are namespaced per server and policy is evaluated on the qualified `server.tool` name, so a description cannot reach across.

**Host objects leaking across the bridge.** This is the class behind FrontMCP's CVE-2026-67531: live schema objects exposed to scripts gave a path to the host `Function` constructor. The bridge here is JSON in both directions; no object, function, schema instance, token or client reference crosses it.

**Resource exhaustion.** Infinite loops, allocation bombs, deep recursion, giant results. Memory, stack and wall-clock limits are enforced from outside the untrusted thread, and the host caps each result and the total bytes per execution.

**A malicious upstream package.** postmark-mcp 1.0.16 quietly exfiltrated email. codemcp does not solve supply chain for the servers you connect, but every call is logged so exfiltration is at least observable.

## What each tier covers

| Tier | Boundary | Not covered |
|---|---|---|
| 0 QuickJS-WASM worker | WASM linear memory; only injected host functions reachable; worker termination as backstop | bugs in quickjs-emscripten; the host Node process shares the OS process |
| 0 Monty (planned) | Rust VM with no fs, env or network; subprocess pool | Python subset only; VM bugs |
| 1 Deno subprocess (planned) | OS process, default-deny permissions, SIGKILL on timeout | no memory cap; V8 bugs |
| 2 Docker + gVisor (planned) | user-space kernel | gVisor bugs; Linux only |
| 3 Firecracker / microsandbox (planned) | hardware virtualization | hypervisor bugs |

## Runtimes that are not a boundary

codemcp will not ship these as executors. Node `vm`, whose docs say it "is not a security mechanism". `isolated-vm`, in maintenance mode, whose memory limit its author calls "more of a guideline". Pyodide in Deno, which Pydantic retired because Python can run arbitrary JavaScript and Deno cannot cap memory. Bun, which has no permission model. Bare `workerd`, whose README says it must run inside a VM.

## Invariants the code enforces

1. The sandbox never receives a credential, a host object or a schema instance. Only JSON.
2. Every bridged call is checked against the pin, the policy, the budget and the input schema before it is forwarded. A call that passes is written to the audit log (`call_start`), and the sink has accepted it, before the upstream request is sent; its outcome is written when it settles (`call`). A call that is refused produces the `call` event alone.
3. A tool whose pinned definition changed is blocked until someone re-approves it.
4. Limits on time, memory, stack, calls and bytes are enforced by the host, never by cooperation of the guest.
5. Policy decisions use the qualified `server.tool` name, never a display name the model typed.
6. A tool annotation from a server can tighten the policy decision but never loosen it: a `readOnlyHint` cannot turn a default of `approve` or `deny` into `allow`.

Report a weakness in any of these through the private channel in [SECURITY.md](../SECURITY.md).
