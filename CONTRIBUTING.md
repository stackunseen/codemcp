# Contributing

Thanks for helping build a neutral code-mode layer for MCP. A few things to know before you open a pull request.

Sign off your commits with `git commit -s`. That certifies the Developer Certificate of Origin (https://developercertificate.org).

To get going: `pnpm install && pnpm build && pnpm test`.

The spec is the source of truth. Error codes, conformance cases, policy cases, stub goldens, and the schemas for config and audit events all live in `spec/`, not in the TypeScript sources. Edit them there, run `pnpm spec:sync` to regenerate the derived files, and commit both. CI runs `pnpm spec:check` and fails if a generated file is stale. `spec/README.md` explains the layout.

Changes under `packages/core/src/bridge` or in any `executor-*` package need a second reviewer, and the conformance suite has to stay green.

If you are adding an executor, implement `Executor` from `codemcp-core` and add a test that runs every case of `ConformanceSuite` from `codemcp-conformance` against it. An executor that does not pass conformance will not be merged. A new guest language is a `code.<lang>` entry on each case in `spec/conformance/cases.json`.

A change to the bridge protocol bumps `BRIDGE_PROTOCOL_VERSION`, updates `spec/bridge/` and `docs/BRIDGE_PROTOCOL.md`, and bumps `spec/VERSION`.

Security issues go through the private channel in SECURITY.md, not the issue tracker.

## Releasing

All packages under `packages/` share one version and ship together. Releases run from the `release` workflow in GitHub Actions: open the Actions tab, pick **release**, choose a bump (`patch`, `minor`, `major`, `prerelease`, or an exact version) and a dist-tag, and run it on `main`. The workflow runs the full CI checks, bumps every `package.json`, commits and tags `vX.Y.Z`, publishes to npm with provenance, and creates a GitHub release with generated notes.

Locally, `pnpm release:current` prints the version and `pnpm release:bump <kind>` rewrites the manifests without publishing.

The first release of a new package needs an `NPM_TOKEN` repository secret (an npm granular access token with publish rights). Once a package exists on npm, configure trusted publishing for it on npmjs.com against this repository and the `release.yml` workflow, then delete the secret.
