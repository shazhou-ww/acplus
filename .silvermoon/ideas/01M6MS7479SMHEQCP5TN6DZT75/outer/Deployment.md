# Deployment

Preparation seed: the decisive outcome is successful native Turn execution
through AHPlex after user authorization, not merely a successful login command.

## Steps

### D-S01: Prepare isolated VS Code hosts and complete user authorization

Use an installed candidate, short independent data directories, and two
service-owned VS Code hosts. Complete the supported GitHub login with user
consent, relaying only the authorization link and user code when applicable.
Bind authorization explicitly; do not touch existing editor sessions or copy
their credentials.

### D-S02: Submit and observe real authenticated Turns through AHPlex

Discover or create native Sessions and Chats, then submit harmless no-tool,
no-file-change prompts through the AHPlex HTTP/CLI surface with fresh turn IDs.
Confirm native `complete` and the requested marker for each explicitly bound
host. The successful native CLI probe from prior research is not a substitute
for this AHPlex-to-Host execution path.

### D-S03: Verify authorization isolation and clean shutdown

Exercise an unbound or rejected-authorization case without disturbing the
successful host. Verify the recovery behavior required by the implementation's
connection contract, then stop only owned resources. Record sanitized versions,
resource/turn IDs, outcomes, and credential-custody boundaries.

## Acceptance criteria

### D-AC01: User login authorizes the actual AHPlex Host connection

Real evidence links user consent and successful upstream authentication to the
intended connection. A valid native CLI login alone, or token acquisition
without Host acceptance, does not pass.

### D-AC02: User-submitted Turns finish successfully on the bound hosts

After login, real AHPlex requests on two explicitly authorized VS Code hosts
reach native `complete` for the exact submitted chat/turn IDs and return the
expected harmless response. HTTP 202, native `error`, or fixture results fail
this criterion.

### D-AC03: Authorization and cleanup remain scoped

Evidence shows credentials are not implicitly granted to an unbound host,
failures are actionable without credential disclosure, and shutdown stops only
operation-owned processes while preserving unrelated editor work.
