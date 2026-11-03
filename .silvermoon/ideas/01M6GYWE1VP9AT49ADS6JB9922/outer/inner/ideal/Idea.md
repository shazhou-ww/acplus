# Configuration-driven agent service orchestration and HTTP bridging

## Problem

Ahplex currently hardcodes an isolated VS Code Host and requires provider
credentials at its own boundary. This couples a local service launcher and
bridge to one backend's identity and authentication.

## Outcome

Users configure which supported agent services to start and their launch
parameters. Ahplex starts them on demand and exposes their capabilities through
ahpc/ahpd-backed local HTTP, while each service retains its own identity,
permissions, and native authorization workflow.

## Boundaries

- Configuration selects services, launch context, and bridge connections; it
  does not create an ahplex account or a provider authentication authority.
- Ahplex manages only its owned processes and explicitly selected service
  contexts; it never silently borrows an editor's credentials or Host.
- Support is limited to protocols the chosen bridge actually supports, not
  arbitrary executables. No npm release is included.

## Acceptance criteria

- Independently configured services start on demand with their declared
  parameters, remain distinguishable, and expose usable local HTTP routes.
- HTTP behavior preserves backend session/task identity, outcomes, and
  authorization requirements without an ahplex-owned provider login gate.
- Native service authorization and process ownership remain intact, proven by
  the observable checks in [Requirements.md](./Requirements.md).
