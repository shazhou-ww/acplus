# Implementation

## Steps

### I-S01: Verify service and authorization contracts

Verify the actual ahpc/ahpd capability matrix and native authorization path for
the initial supported service. Define the configuration and migration behavior
against [the requirements](./ideal/Requirements.md), recording unsupported
combinations explicitly.

Resolved by the capability and authorization findings below. The implemented
bridge does not promise unattended native OAuth or an authenticated standalone
Host merely because an editor is signed in.

### I-S02: Implement configuration-driven lifecycle and forwarding

Replace hardcoded service startup and the global provider credential gate with
explicit service selection, on-demand lifecycle, and bridge-backed HTTP routing.
Keep connection security and process ownership distinct from provider identity.

Implemented in [configuration](../../../../../src/config.ts),
[runtime](../../../../../src/runtime.ts),
[HTTP routing](../../../../../src/server.ts) and the
[bridge worker](../../../../../src/adapter-worker.ts). Selection uses
`/services/<id>/...`; listener health and the service catalogue start nothing.
Each selected service has its own startup promise, lock, profile, registry,
bridge connection and task manager. Failures are latched until restart rather
than retried silently.

### I-S03: Test and document the supported behavior

Add focused regression tests and usable configuration/authorization recipes,
including changed CLI behavior and any intentional compatibility boundaries.

The [README](../../../../../README.md) contains two-service launch and explicit
attachment examples, context semantics, capability limits, native authorization
requirements and migration of all existing CLI options and HTTP routes.

## Acceptance criteria

### I-AC01: Configured instances start and route independently

Automated tests prove configuration validation, launch arguments/context,
on-demand startup, concurrent startup deduplication, and independent instance
routing, covering R-01, R-02, and R-05.

### I-AC02: Authorization and ownership boundaries hold

Tests prove backend-owned authorization outcomes without an ahplex provider
login gate, secret-safe errors, and cleanup restricted to owned processes,
covering R-03, R-04, and R-06.

### I-AC03: The package and user-facing contract remain verifiable

`pnpm check` passes. Documentation provides a supported service recipe and
explicit compatibility changes, with no npm publication or change to the package
export/file boundaries as an incidental effect.

## Verified contracts and decisions

- The installed dependency is `@softov/ahpc` 0.9.0; the unchanged lockfile
  resolves `@microsoft/agent-host-protocol` 1.0.0. Inspected installed
  `ahp/live.js`, `ahp/live.d.ts`, `ahp/auth.js`, `mcp/http.js` and
  `mcp/tools.js`. The integration embeds `liveHost` plus ahpc's HTTP bridge in
  one owned Node worker per selected service. Neither an `ahpc` CLI per request
  nor an `ahpd` process is needed.
- The only advertised bridge kind is `ahp-websocket`. Owned discovery supports
  the private VS Code schema-2 standalone TCP endpoint registry; attachment
  requires an explicit loopback root WebSocket URL. Owned fixed URLs and
  ACP/stdio, OpenAI HTTP and arbitrary executable protocols are rejected rather
  than advertised as supported adapters.
- Native executable inspection on 2026-11-03 reported VS Code 1.144.1, commit
  `261c84cb1eddf11235f9e2c921425e9663fbe556`.
  `code-tunnel.exe agent host --help` confirmed `--new-instance`,
  `--foreground`, `--user-data-dir`, `--server-data-dir` and
  `--connection-token-file`, without starting a Host. The default launcher never
  uses `--replace`; explicit configurations receive only their declared
  executable/argument array, cwd and environment.
- Configuration is strict version-1 JSON. Launch context, endpoint/transport
  options and provider arguments have separate roles. Secrets are not required
  in JSON: attached transport tokens reference named environment variables.
  Duplicate IDs/endpoints, unsupported kinds, invalid fields/context and
  unresolved required environment variables produce explicit errors.
- Inherited identity preserves the caller's selected HOME/APPDATA/XDG and VS
  Code data context, not arbitrary ambient credentials. Isolated identity uses a
  persistent service profile, not a disposable login environment. Both modes
  support explicitly named inheritance and string overrides. Neither mode copies
  credential stores or discovers editor Hosts. The legacy launcher no longer
  overrides native CLI identity using a fresh `--cli-data-dir`.
- AHP's provider authorization is backend-owned. The inspected contract exposes
  `authenticate(resource, token)`, JSON-RPC `-32007` and `auth/required`. Its
  `onConnected` documentation says credentials can be connection-scoped; another
  client's authentication is not proof this connection is authorized. The
  embedded HTTP bridge does not acquire OAuth tokens or relay browser,
  device-login or permission interactions. Such combinations remain external
  authorization prerequisites, not an ahplex login requirement.
- The old synthetic provider-credential gate is removed. Operations are
  forwarded without ahplex provider credentials; backend refusals become
  `backend_authentication_required` and health supplies an actionable native
  workflow instruction. Unsupported method responses become
  `backend_capability_unsupported`; offline connections and ordinary backend
  failures remain distinct safe codes. Health's `authentication: "backend"`
  means delegated authorization, not proven login.
- Optional legacy explicit resource-token delivery remains available only
  without `--config`; it is never a forwarding prerequisite. A refused or
  expired token is not blindly redelivered on reconnect. Configuration mode
  rejects conflicting legacy service/credential options.
- Shutdown aborts pending startup, closes task managers, and stops only owned
  process trees by exact PID. Explicit attachments are never owned. Generated
  transport tokens are removed, persistent native profile data is retained, and
  cleanup errors retain service/hub ownership locks. Repeated shutdown is safe.

## Evidence

On Node.js v24.11.1 and pnpm 11.22.0, `pnpm check` passed on 2026-11-03:
formatting, zero-warning ESLint, strict TypeScript, all **120 tests in 10
files**, coverage, ESM build and publint package-shape validation. Coverage was
95.47% statements, 93.16% branches, 94.40% functions and 96.22% lines; existing
90% thresholds were unchanged. Dependency manifests/lockfile, package exports
and the published-file allowlist are unchanged; no npm publication was
performed.

The focused proofs are:

- [Configuration tests](../../../../../test/config.test.ts): version/field
  validation, duplicate IDs/endpoints, supported kinds, launch context,
  environment names, literal argument arrays and explicit JSON loading.
- [Runtime tests](../../../../../test/runtime.test.ts): lazy selection,
  concurrent-start deduplication, two instances with the same backend session
  URI, exact per-instance task/turn results and rejected cross-routing; exact
  launch arguments/cwd/context; preserved native context; explicit token
  references/redaction; startup failures, connectivity loss, owned cleanup and
  preserved profile markers.
- [Worker tests](../../../../../test/worker.test.ts): no provider credential
  gate, actual upstream tool invocation against an explicit test connection,
  native `-32007` propagation, unsupported methods, safe backend errors, exact
  turn IDs, cancellation, expiry and no credential replay.
- [Process boundary tests](../../../../../test/process-boundaries.test.ts) and
  [process tests](../../../../../test/processes.test.ts): exact spawn
  boundaries, missing executable, premature exit, timeout, cancellation,
  instance locks, private registries and PID-scoped cleanup. Test scratch
  directories live in the repository and are removed after execution.
- [HTTP tests](../../../../../test/http.test.ts) and
  [CLI tests](../../../../../test/cli.test.ts): real loopback sockets,
  authentication/capability/connectivity error normalization, HTTP protections,
  configuration loading and compatibility options. Existing task correlation,
  bounded-wait and cancellation tests remain passing.

These are automated implementation proofs, not native-authorized agent
execution. No real service was started or authenticated during this
implementation phase; native executable help/version inspection is not an
execution claim. The deployment contract remains responsible for two real
independent instances, a harmless authenticated HTTP question correlated to its
exact submitted task, an independent unauthenticated/expired case and
preservation of unrelated processes and native identity data. If supported
native authorization requires unavailable human interaction, record that blocker
instead of accepting mock results as deployment evidence.
