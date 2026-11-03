# Requirements

This document supports [Idea.md](./Idea.md). It specifies required behavior, not
a completed implementation or a finalized configuration schema.

## Responsibility boundary

Ahplex has two responsibilities:

1. Start the selected agent service when needed, using its configured launch
   context, and manage only the processes it owns.
2. Use ahpc/ahpd to bridge that service into a locally usable HTTP interface.

The agent service and its provider own model access, account identity,
authorization, and native login or renewal. A VS Code Agent Host is one possible
service, not the definition of ahplex itself.

## R-01: Explicit service configuration

Users must be able to declare multiple named services without editing ahplex
source. Each service declaration must identify:

- A unique service ID and supported service/bridge kind.
- An executable and argument array, without implicit shell evaluation.
- Working directory and intended environment/profile or data context.
- How the bridge discovers or connects to the selected service endpoint.
- Readiness timeout and owned-process lifecycle behavior.

Configuration must distinguish launcher options from provider options and bridge
connection options. Provider-specific arguments remain service inputs, not a new
ahplex-wide provider authentication schema. Credentials must not be required in
a checked-in configuration file.

Reject duplicate IDs, invalid configuration, unsupported bridge kinds, and
unresolvable executable or endpoint requirements with explicit errors. Do not
silently select a different service, account, endpoint, or profile.

The exact file format, defaults, and HTTP service-selection shape are Inner
World decisions. Their final documentation must include a usable example and the
behavior of existing CLI options.

## R-02: On-demand startup and independent instances

Selecting a service must start its declared runtime when needed, rather than
unconditionally launching a fixed VS Code Host. Merely declaring several
services must not require all of them to start.

Concurrent requests for the same service instance must not create duplicate
owned runtimes. Different service IDs must not accidentally share locks,
registry entries, bridge ports, sessions, or task ownership. Long-lived
connections must be reused instead of spawning a CLI for every HTTP request.

Startup must verify the selected instance's actual readiness. Missing
executables, premature exits, unsupported endpoint metadata, and timeouts must
be distinguishable failures, not successful HTTP readiness.

## R-03: Preserve the service's intended identity context

A configured service must run in its explicitly selected context. Ahplex must
not unconditionally replace that context with a fresh identity environment that
discards the service's intentionally established login state.

This does not authorize reading token stores, copying editor credentials,
searching for arbitrary authenticated Hosts, or forwarding all ambient
credentials. An inherited context and an isolated context must have documented
semantics; isolation cannot silently substitute a different identity.

An already signed-in VS Code window does not by itself prove a new independent
Host is authenticated. Any supported way to use an existing Host must be
explicit and must not transfer process ownership to ahplex.

## R-04: Native authorization, not ahplex authorization

Do not require an ahplex-owned provider login, manual provider token injection,
or a synthetic global `authentication: configured` flag as a prerequisite for
forwarding operations. The selected backend determines whether an operation
requires authentication and whether supplied/native authorization is valid.

OAuth and token refresh belong to the service/provider's native workflow. Where
a protocol delegates interaction or token delivery to a client, document that
requirement explicitly: do not claim a headless Host can always log in
independently. Any bridge interaction must be explicit, supported by the
protocol, and distinguishable from an ahplex account or permission policy.

If native authorization needs human action and the selected combination cannot
relay it, return an actionable authentication requirement rather than silently
retrieving credentials or reporting readiness as successful execution.

Service/bridge connection tokens and optional local HTTP access protection are
transport security, not provider authorization. They may remain necessary. Never
expose provider or transport secrets in HTTP output or logs.

## R-05: Honest bridge capability and HTTP forwarding

Only claim support for service protocols actually understood by the chosen
ahpc/ahpd integration. Running an executable alone is not protocol support; new
adapters are separate work unless necessary for the supported path. Do not
require both ahpc and ahpd processes when the selected integration only needs
one.

HTTP operations must unambiguously target a service instance and preserve its
session and task identities. Preserve existing correlated completion, bounded
wait, cancellation, and explicit error behavior for capabilities that remain
supported. A request to an unsupported backend capability must fail explicitly.

Backend login failure, connection loss, cancellation, and task failure must not
be replaced with fabricated successful results or conflated with each other.
There is no requirement to invent multi-provider capabilities absent upstream.

## R-06: Ownership and shutdown

Shutdown and failed-start cleanup may stop only the service and bridge processes
owned by that ahplex instance. Never stop an editor Host, an explicitly attached
service, or unrelated processes.

Retain ownership protection when cleanup fails and report the failure. Repeated
shutdown must be safe. Preserve intentionally persistent service profiles and
native login state; do not delete them as temporary bridge data.

## R-07: Observable proof

Implementation tests must prove configuration validation, exact executable
arguments/context, on-demand startup, concurrent startup deduplication, instance
routing, and owned-process cleanup. They must also prove that provider
authentication is forwarded or reported from the backend rather than enforced by
ahplex's current global credential gate.

Real-environment verification must demonstrate:

- Two independently configured service instances and no accidental
  cross-routing.
- An HTTP question sent through a real supported bridge to an agent service
  authorized using its native supported workflow, with the response correlated
  to the exact submitted task.
- An independent unauthenticated or expired-authorization case that produces an
  actionable backend requirement without reading editor credentials.
- Shutdown that leaves unrelated editor/agent processes and native service
  identity data intact.

Use a harmless question requiring no repository changes for the real round trip.
Record the service/bridge versions, configuration shape without secrets,
authorization method, task correlation, and results in phase-appropriate
evidence. Mock tests do not count as real native authorization or agent
execution. If human authorization is unavailable, record the blocker instead of
claiming acceptance.

## Implementation decisions requiring verification

The exact native authorization path for standalone VS Code Hosts, bridge support
for client-mediated authorization, and the final supported service matrix remain
to be verified. Neither discussion nor an editor's existing login proves these
capabilities. Resolve them before promising a working service recipe.
