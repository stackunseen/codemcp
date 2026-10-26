# Security policy

codemcp runs model-written code. We assume that code is attacker-controlled (via prompt injection, poisoned tool descriptions or hostile tool results) and design accordingly. See [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private vulnerability reporting on this repository (a dedicated security mailbox will be added once the project has a domain).

We aim to acknowledge within 2 business days and to publish a fix or mitigation within 30 days for high and critical findings. We will credit reporters unless they ask otherwise and will request CVE identifiers for confirmed vulnerabilities in released versions.

## Scope

In scope: sandbox escapes from any shipped executor; credential or host-object leakage across the bridge; policy bypass (executing a denied tool, skipping an approval); budget bypass (timeouts, memory limits); audit-log tampering or omission; supply-chain issues in our published packages.

Out of scope: vulnerabilities in upstream MCP servers you connect; the inherent limits of a tier you chose over a stronger one (documented per tier in the threat model).

## Supported versions

Pre-1.0: only the latest minor release receives fixes.
