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
