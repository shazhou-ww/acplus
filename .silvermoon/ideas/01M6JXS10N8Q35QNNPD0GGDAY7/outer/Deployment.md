# Deployment

## Steps

### D-S01: Start two independent real VS Code hosts

Use the installed executable and explicit short operation-owned data roots.
Exercise the installed service API without adopting the editor or another host.

Use the independently installed local tarball and native VS Code 1.145.0.
Prepare two configured hosts in a short private data root, prove GET leaves them
idle, issue concurrent starts to one, and verify the other remains idle until
selected. Record separate native registry instance IDs and ports without reading
or publishing transport-token values.

### D-S02: Verify native resources and upstream authentication

Verify discovery, Session/Chat identity, supported Chat creation, exact Turn
observation/cancellation, and authentication through explicit provisioning. If
no usable OAuth application/credential is supplied, record the blocker and leave
authenticated execution unaccepted rather than use ambient credentials.

Create native Session/Chat resources on each host, verify cross-host routing and
ordinary Chat creation without changing defaultChat, then send a harmless
no-tool/no-file-change prompt under a caller-chosen turn ID. Observe the exact
native outcome. Exercise missing explicit token provisioning through the auth
API and verify the failure stays host-scoped. Do not equate an accepted Turn
ending in native error with an authenticated answer.

### D-S03: Verify cleanup and preserve external evidence

Stop owned processes and confirm unrelated processes remain. Record sanitized
versions, commands, actual outcomes, and remaining prerequisites in this world.

Capture only operation-owned process IDs and an unrelated test sentinel before
shutdown. Prove the captured owned processes exit, the sentinel survives, the
root lock and generated token files disappear, and host data remains until
explicit test cleanup. Dispose the test sentinel by its own PID afterward.

### D-S04: Test native VS Code login and a fresh accountless AHP connection

Use a new short private root for both an owned standalone Host and a separate VS
Code Agents window with its own user-data and extension directories. Configure
only that window to connect to the test Host. The user completes the native VS
Code GitHub/Copilot sign-in; ahplex must not start OAuth, register an OAuth
application, or obtain/copy a user access token.

Compare a pre-login and post-login fresh AHP client against the same Host. The
probe may use the Host's generated transport connection token, but must never
send AHP authenticate or provider credentials. Separately test whether omitting
the connection token permits the WebSocket handshake. Record connection,
catalogue, Session/Chat creation, and exact harmless Turn outcomes
independently. The UI must first demonstrate a successful test response on that
same Host before claiming a post-login result. Preserve existing editor sessions
and stop only experiment-owned processes when all user interactions finish.

## Acceptance criteria

### D-AC01: Independent real hosts are usable and isolated

Real HTTP evidence shows two configured hosts start independently, advertise
providers, and keep Session/Chat identities routed to the intended host.

### D-AC02: A real authenticated native Turn completes

An explicitly authorized provider completes a harmless prompt through the exact
API chat/turn ID. Fixture success or unauthenticated readiness is not proof.

### D-AC03: Shutdown cleans only operation-owned resources

Before/after process checks prove owned processes stopped, no unrelated editor
was stopped, and cleanup preserved intended persistent host data.

### D-AC04: Native login scope is established by independent client evidence

Evidence distinguishes transport admission from provider authorization and
proves whether a fresh client that supplies no user credential can execute after
native VS Code login. A refusal is a valid finding about login scope, not a
completed authenticated-execution criterion. If native login cannot be
completed, leave this criterion open and describe that prerequisite rather than
infer the outcome.

## Evidence and blocker

[Installed-package verification](Verification.md) records independent real
startup, native resource routing, missing-credential isolation, and owned
cleanup against the synchronized deployment contract. D-AC01 and D-AC03 passed.
D-AC02 remains open because no explicitly authorized real-provider Turn
completed; both unauthenticated attempts ended in native error. Do not submit
the deployment gate or infer authorization from fixture results.
