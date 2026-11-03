# Deployment

## Steps

### D-S01: Prepare explicit native service contexts

Use the implemented recipe to configure two independent service instances. Have
the operator authorize the real supported service through its native workflow;
do not obtain credentials from unrelated applications.

Use the installed native VS Code executable and the documented owned schema-2
registry configuration with two distinct service IDs, private persistent
profiles, loopback transport and no provider-token injection. Record the exact
VS Code and bridge versions and sanitized configuration in Outer World
verification evidence. Inspect only these operation-owned contexts; the running
editor is not an authorization source.

Compare the CLI-managed Host with an explicitly selected Microsoft VS Code
Server Agent Host entry point in a new operation-owned context. Record the
actual Server build, executable, arguments and environment separately from the
CLI version. Do not equate Microsoft's Server with the third-party code-server
product, or claim to reproduce an earlier successful run without its evidence.

### D-S02: Verify real HTTP forwarding and failures

Exercise on-demand startup, a harmless question and its exact task result,
independent instance routing, and an unauthenticated service requirement.

Check listener/catalogue behavior before selection, then select both services
over HTTP and compare their reported Host identities. Attempt a harmless
no-file-change question only through an available supported provider, recording
its session, task and turn correlation. If native authorization or another
external prerequisite is unavailable, record the exact safe failure and recovery
condition instead of substituting a mock or claiming the criterion passed.

### D-S03: Verify shutdown and record reusable evidence

Stop only owned processes and record sanitized versions, configuration,
authorization method, task correlation, and results in Outer World evidence.

Capture the pre-existing editor process IDs before launch and verify they remain
after shutdown. Verify operation-owned child PIDs exit, ownership locks and
generated transport token files are removed, and persistent profile markers
remain. Leave incomplete criteria unchecked and do not submit this deployment
until all required real outcomes are demonstrated.

## Acceptance criteria

### D-AC01: A real native-authorized agent answers through HTTP

Evidence demonstrates a real supported bridge/service round trip for the exact
submitted task after native authorization. Neither mock output nor HTTP health
alone is proof.

### D-AC02: Instance and authorization failures remain isolated

Real checks show two configured instances do not cross-route and an
unauthenticated or expired-authorization case returns an actionable backend
requirement without ahplex acquiring editor credentials.

### D-AC03: Shutdown preserves external processes and service identity

Before/after evidence shows owned processes stopped, unrelated editor/agent
processes remained intact, and intentionally persistent service identity data
was not removed.

## Verification evidence

[Real-environment verification](./Verification.md) records two independent live
Host/ahpc instances, sanitized configuration, exact task/turn correlations,
cross-instance isolation and owned shutdown/persistent-session proofs. The
historical stream-destroyed failure was traced to an existing 279-character
Windows runtime executable path; an ordinary short private `--cli-data-dir`,
populated normally by the native CLI, restored session operations without
junctions, code patches or editor changes. Both real task attempts then returned
the backend's explicit missing GitHub OAuth/Copilot HMAC authorization
requirement. The tested Host disables Copilot native logged-in-user discovery
and requires client-delivered authorization; a standalone CLI login is not
sufficient for this connection. The alternative Claude provider successfully
downloaded its native SDK into operation-owned storage, but its own
inherited-context account check found no usable native login or API key. Real
HTTP returned `backend_authentication_required` with the native authorization
action. Deployment remains blocked on a supported native-authorized successful
answer, not transport readiness or session creation. The authenticated-execution
criterion remains unchecked; the proven isolation and cleanup criteria are
complete.
