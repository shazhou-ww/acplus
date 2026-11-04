# Coordinating-agent gate review

## Candidate boundary

Review the native AHP implementation against the committed
[requirements](../../../../../docs/REQUIREMENTS.md) and
[OpenAPI contract](../../../../../docs/openapi.yaml), not the legacy Task API.
This evidence is independent of the implementation subagent's completion claim.

## Baseline and prerequisites

- Primary was integrated through `8fa965e6bab7f66687c31725188dedb2c2fdbaeb`
  before preparing this idea. The upstream 120-test baseline passed without
  changing coverage thresholds.
- Existing design and publication metadata changes were preserved. No package
  release or tag is authorized by this implementation.
- Installed native VS Code CLI reports `1.145.0`, commit
  `3c0ec3a089398503a462029e7cc2a5749df5169a`.
- Explicit AHPLEX provider credential and OAuth application variables were
  absent in the coordinating process. Their values were not read or copied from
  another application. Successful real-provider execution therefore remains a
  separate external prerequisite, not a result of unit tests.

## First candidate review

The implementation subagent reported 67 passing tests with all configured 90%
coverage thresholds met. That is supporting evidence, not acceptance.

Independent checks found four blocking defects:

1. A protocol `authenticate` result containing `authenticated: false` was
   reported as succeeded. The coordinator's
   [regression test](../../../../../test/gate-review.test.ts) reproduces it.
2. An unauthenticated `listSessions` refusal made host startup fail, preventing
   login on a host whose root/provider discovery already worked. The same
   independent test file reproduces this readiness/authentication deadlock.
3. The actual checked-in TypeScript configuration failed with TS2748 for SDK
   ambient const-enum accesses. Package scripts passed only by overriding
   `verbatimModuleSyntax`; editor/project settings were inconsistent.
4. Real VS Code 1.145.0 startup and protocol negotiation succeeded for two owned
   hosts, but session creation repeatedly returned
   `502 creation_outcome_unknown` after the request deadline. This is a runtime
   compatibility issue to diagnose, not proof of missing user authorization.

`pnpm --config.verifyDepsBeforeRun=false exec vitest run test\gate-review.test.ts`
failed both coordinator tests before repair. The candidate was returned to the
same implementation subagent; the assertions must not be weakened.

The real-host preflight independently confirmed bodyless health, no inherited
inbound-token/Origin policy, passive GET, unknown-host/legacy-route rejection,
coalesced startup, and isolation of a still-idle second host. Both real hosts
advertised providers. Shutdown completed and removed the operation-owned root
lock on each run. These checks do not prove authenticated execution.

## Repaired candidate verification

All four first-round blockers were corrected and independently retested:

- The coordinator's two authentication regressions pass unchanged. Explicit
  negative authentication never becomes success; catalogue authentication does
  not prevent provider discovery and login.
- The project configuration now compiles SDK ambient const enums consistently;
  plain `node node_modules\typescript\bin\tsc --noEmit -p tsconfig.json` passes
  without command-line compiler overrides.
- VS Code allocates provisional Session/Chat resources before first-send
  provider materialization. Creation is confirmed by the RPC and resource
  snapshots, without sending an implicit turn or inventing lifecycle=ready.
  `test/provisional.test.ts` verifies this allocation behavior, discoverability,
  additional Chat creation, and idle stop. The OpenAPI description now
  explicitly distinguishes allocation from provider materialization.
- An independent real-host rerun obtained 201 Session creation, 200 Chat
  discovery, and 201 ordinary Chat creation on both VS Code hosts. Exact
  caller-chosen turns were accepted and observed as native `error`, not falsely
  completed. No usable provider authorization was supplied, so this is not
  authenticated execution.

The coordinating agent inspected configuration, process ownership, SDK
transport, resource admission/acknowledgement, authentication, extension
registration, HTTP projection, CLI, package shape, and changed test coverage.
The service uses the official SDK rather than private ahpc source, has no Task
queue, and preserves native resource identities and exact turn cancellation.

Final validation:

| Check                                                | Result                                                                           |
| ---------------------------------------------------- | -------------------------------------------------------------------------------- |
| Independent gate/provisional tests                   | 3 passed                                                                         |
| Full `pnpm --config.verifyDepsBeforeRun=false check` | 75 tests passed; format, lint, typecheck, build and publint passed               |
| Coverage                                             | 94.94% statements, 91.52% branches, 94.95% functions, 96.09% lines               |
| OpenAPI lint and regenerated reference               | Passed                                                                           |
| Documented configuration JSON Schema/example         | Passed                                                                           |
| Independent tarball installation                     | Passed with SDK-only runtime dependencies                                        |
| Installed CLI                                        | Help/version, removed-command errors, hosts list JSON and bodyless health passed |
| Installed package API                                | Stdin configuration/overrides, listener and root-lock cleanup passed             |

Coverage thresholds, package exports/files allowlist, and the previous idea's
history were not weakened or rewritten. Real-host startup, provisional resource
handling and cleanup were observed independently; mocked OAuth/transport tests
are not claimed as live-provider authorization evidence.

## Decision

The repaired implementation passes the coordinating-agent gate under the user's
explicit delegation. Record acceptance only for the synchronized submitted
implementation revision. Real authenticated execution remains an Outer World
criterion and cannot be accepted without explicit usable authorization.
