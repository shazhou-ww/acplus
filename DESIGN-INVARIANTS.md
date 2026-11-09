# ACP design invariants

Status: implementation contract for the direct ACP `/v2` repository entry. These
invariants and the [requirements](docs/REQUIREMENTS.md) govern the
[ACP design](docs/ACP-DESIGN.md). The legacy source entry was replaced only
after independent-entry verification; published packages are unchanged.

## 1. HTTP resources belong to the service

- A configured Agent is not a running process.
- A Session is one conversation with a stable local ID and an optional opaque
  ACP backend binding.
- A Turn has a caller-chosen local ID, unique within its Session.
- Events are durable ordered observations with explicit source/coverage.
- Do not introduce synthetic Chats, Task/job aliases, or pretend a local Turn ID
  is an ACP-native identifier.
- Backend bindings include Agent/profile identity. Configuration changes must
  not resume a different conversation under an old local Session ID.

## 2. Reads and Session creation never launch Agents

- Every HTTP GET is answered locally, including when the Agent is unavailable.
- No implicit backend catalogue, authentication, synchronization, load/resume,
  or live-read fallback.
- Session creation validates configuration/workspace and persists only local
  metadata. The first admitted execution performs backend creation.
- Expose observation time and partial/unknown coverage. Unknown local IDs may
  return 404; missing cached portions of a known Session must not masquerade as
  complete empty history.

## 3. Own and constrain every runtime

- Agents are registered from static schema-2 configuration. Requests cannot
  supply startup commands, credentials, profiles, MCP servers, or env overrides.
- One owned stdio runtime per configured Agent; coalesce concurrent starts.
- Require ACP initialization and capability negotiation before Session use.
- Use explicitly selected dedicated profiles; no ambient credential discovery or
  copying, and no shared profile across active runtimes.
- Validate each Session's existing absolute working directory and canonicalize
  it; no Agent-level workspace allowlist. Enforce configured callback permission
  policy. Neither process/profile separation nor tool policy is an OS sandbox.
- Initially serialize prompts per Agent and Session; reject busy input rather
  than queueing it or inventing generic ACP concurrency support.
- Idle means no pending execution/load/auth/callback or known background work.
  Unknown activity is not idle. Only terminate owned process trees.

## 4. Persistence precedes execution claims

- Commit admission, the user message, and identity before HTTP 202.
- Commit dispatch intent before sending an ACP prompt.
- Persist streamed updates in order with bounded buffering and explicit failure
  handling; never silently drop content.
- Commit all preceding updates and terminal evidence before publishing a
  terminal observation.
- Store selected typed message/tool/state content, not credentials, raw login
  transcripts, environment dumps, or unfiltered process output.
- Redact known secrets before storage and output. Do not claim this detects
  arbitrary secrets in Agent-generated workspace content.
- Storage failure stops new admission and triggers bounded execution cleanup; it
  cannot produce a success-shaped unpersisted result.

## 5. Observe honestly; do not replay uncertain work

- Repeated identical Turn submissions return existing records without dispatch;
  changed input with the same ID conflicts.
- There is no atomic transaction across the store and the Agent.
- Dispatch intent without trustworthy completion becomes `unknown` after a
  crash/disconnection, not `error`, `complete`, or implicit resubmission.
- Undispatched records may be terminated as explicitly not dispatched; no
  automatic durable job scheduler.
- A client disconnect does not cancel an accepted Turn.
- ACP stop reason is preserved separately from the local terminal projection.
  End of execution is not proof of successful task completion.
- Cancel the exact bound active Turn, not "latest". A cancel notification is not
  terminal evidence; late normal completion remains normal completion.

## 6. History is not restored Agent context

- Local history remains readable without backend recovery.
- Use only negotiated resume/load support to continue a bound ACP Session.
- Unsupported/missing backend recovery fails explicitly. Never recreate the
  backend and replay cached prompts as silent restoration.
- Loading replay is staged separately from live observations. Do not deduplicate
  legitimate repeated messages by text/hash or attach replay to a new Turn.
- Without stable backend message identity, keep replay as a separately sourced
  snapshot instead of merging it by guesswork.
- Backend loading alone is not proof of an interrupted Turn's outcome.
- Uncorrelated/late background events can be Session-scoped with no Turn ID; do
  not attach them to whichever prompt happens to be running.

## 7. Authentication and interaction remain explicit

- Agent credentials are operator-provisioned. Ordinary HTTP execution does not
  require the caller to submit provider credentials.
- Authentication adapters are Agent-specific where ACP alone is insufficient.
- Explicit auth HTTP routes are operator-protected; agent-driven and terminal
  methods follow their respective negotiated flows, not one generic RPC.
- Cache sanitized authentication observations separately by Agent/profile and
  runtime generation. Credentials stay in the configured Agent profile/store,
  not the Session/Turn/Event database.
- Authentication GETs are local. Restart/reconnection, profile/account change,
  logout, auth challenge, and known expiry invalidate current evidence.
  Historical success remains stale, never a guarantee of valid credentials or
  inbound authorization; missing expiry is not an invented TTL.
- Device link/code, authenticated profile, and successful model execution are
  distinct evidence. No hidden paid authentication probe.
- Plaintext storage requires explicit operator consent.
- Advertise only callback capabilities actually implemented and policy-checked.
- Permission requests follow explicit policy; default deny, never silent
  auto-approval. Unsupported interactive requests fail rather than hang.
- External gateways own inbound authentication, authorization, and TLS.

## 8. Make the cutover explicit

- New `/v2` API and schema 2, without silent `/v1` compatibility.
- Develop ACP behind an independent entry in the same package, with separate
  config/data/profile/port. Keep the old entry unchanged until the new path
  passes automated and isolated real-Agent acceptance; then replace it and
  remove the legacy stack. Temporary coexistence is not a compatibility layer.
- Use the official ACP SDK; remove AHP/AHPD/VS Code runtime code at the tested
  cutover rather than retaining unused dual-protocol abstractions.
- Keep one ESM package and preserve its exports map/files allowlist. Public
  exports remain in `src/index.ts`.
- No automatic legacy configuration/history/credential import.
- Update HTTP/OpenAPI, CLI/init, config, storage, runtime, tests, and docs
  together before claiming ACP support.
- Legacy live-provider verification is not evidence that the redesigned
  persistent ACP execution path works.
