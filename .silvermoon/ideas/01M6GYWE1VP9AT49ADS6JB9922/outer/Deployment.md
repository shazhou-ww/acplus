# Deployment

## Steps

### D-S01: Prepare explicit native service contexts

Use the implemented recipe to configure two independent service instances. Have
the operator authorize the real supported service through its native workflow;
do not obtain credentials from unrelated applications.

### D-S02: Verify real HTTP forwarding and failures

Exercise on-demand startup, a harmless question and its exact task result,
independent instance routing, and an unauthenticated service requirement.

### D-S03: Verify shutdown and record reusable evidence

Stop only owned processes and record sanitized versions, configuration,
authorization method, task correlation, and results in Outer World evidence.

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
