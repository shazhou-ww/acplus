# Proxy GitHub user authorization to VS Code hosts

## Problem

Users can sign in through the native Copilot CLI, yet fresh clients of the
tested standalone VS Code Host still cannot execute without provider
credentials. AHPlex needs to represent the user's authorization on its actual
Host connections, rather than assume another application's login is inherited.

## Outcome

A user completes supported GitHub authorization without a VS Code GUI, then
submits native Turns through AHPlex and receives successful Copilot responses.
AHPlex centrally manages the explicit association between that authorization,
the required resource, and each selected VS Code Host connection.

## Boundaries

- The first increment supports only VS Code Agent Host and GitHub/Copilot
  authentication. Keep the HTTP/CLI surface MVP-sized and retain native Session,
  Chat, and Turn identities; no new account, tenant, or Task system.
- Login may be performed by a supported external/native component. AHPlex must
  receive the resulting authorization through an explicit supported handoff, not
  scrape unrelated application credentials or impersonate an OAuth app. Host
  connection tokens remain separate from provider credentials.
- Inbound access control remains a gateway responsibility. Credential reuse
  across hosts requires explicit binding; expiry and reconnect must not silently
  select another identity or replay a Turn. No npm publication is included.

## Acceptance criteria

- A user-visible GitHub login/authorization flow results in usable authorization
  on the intended AHPlex-to-VS Code Host connection, without requiring the user
  to expose a password or paste a token into conversation.
- Host/resource credential bindings are explicit and observable through safe
  status or errors; credentials are not broadcast to unselected hosts or leaked.
- Deployment evidence shows real Turns submitted through AHPlex after user login
  reach native `complete` and return the expected response. Login success, HTTP
  202, health checks, and fixture output alone do not satisfy this outcome.
