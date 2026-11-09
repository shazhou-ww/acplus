# ACP-backed HTTP service design

English | [简体中文](ACP-DESIGN.zh-CN.md)

Status: approved direction and implementation plan, not implemented behavior.
The existing package still implements the legacy AHP `/v1` API.

## Silvermoon design work

This direction is tracked by the repository-owned
[ACP HTTP idea](../.silvermoon/ideas/01M6ZA9HR2B1A5H9QYVRN0CKX0/outer/inner/ideal/Idea.md).
Its
[supporting design decisions](../.silvermoon/ideas/01M6ZA9HR2B1A5H9QYVRN0CKX0/outer/inner/ideal/Design-decisions.md)
explain the product choices and link back to the detailed project documents. Its
Ideal World defines outcomes and boundaries; this document remains the detailed
design draft, not evidence of lifecycle acceptance or implementation. After the
ideal gate, refine the Inner World contract and export agreed details into this
document, its Chinese edition, root requirements/invariants, and HTTP/OpenAPI,
CLI, and configuration documentation. Keep each exported contract consistent and
explicitly distinguish planned behavior from shipped behavior.

## Decisions

- Connect directly to ACP Agents. No AHP, AHPD, or VS Code Agent Host in the
  target execution path.
- Introduce `/v2`; do not retain `/v1` compatibility or silently convert its
  configuration, resource URIs, or histories.
- Creating a Session writes a local record only. The first Turn starts the
  configured Agent and creates its ACP session.
- Persist user/Agent messages, tool calls/results, and execution observations.
  Authentication secrets and raw login transcripts are excluded.
- Bridge explicit Agent authentication and cache sanitized authentication
  observations separately; credentials stay in the Agent's dedicated profile.
- All HTTP GET operations use local records. They never start, authenticate,
  load, resume, or query an Agent.
- Keep one ESM package, the package name, and the public exports/files layout. A
  release/version decision is separate from this design.

These decisions supersede the old AHP resource and online-read constraints. The
target requirements and invariants are in [REQUIREMENTS.md](REQUIREMENTS.md) and
[DESIGN-INVARIANTS.md](../DESIGN-INVARIANTS.md).

## Architecture

```text
HTTP / CLI clients
        |
HTTP /v2 + request validation
        |
Session service ----------------------> SQLite store
        |                                |
        | execution requests             +-- local history / status queries
        v
Agent runtime manager
        |
owned process + ACP SDK over stdio
        |
configured Agent, e.g. copilot --acp
```

Use the official `@agentclientprotocol/sdk` for framing and protocol types, not
handwritten JSON-RPC. Start with Copilot CLI as the verified integration. Other
ACP Agents require their own initialization, authentication, tool-policy, and
restart tests; a working CLI or a protocol name is not sufficient evidence.

SQLite is the proposed local store: one database under the private `dataDir`,
one service writer, schema migrations, transactions, and indexed pagination.
Evaluate `node:sqlite` against the supported Node minimum before selecting the
implementation; do not add an ORM or database server by default.

## Configuration and ownership

Introduce `schemaVersion: 2`, explicitly rejecting legacy schema 1 in the new
runtime. Keep the HTTP listener, service identity, private data root, and
single-owner lock. Replace `hosts` with a static `agents` registry.

Each configured Agent declares:

- Stable `id`, label, native executable, argument array, and startup timeout.
- A dedicated credential/state profile and explicit environment references.
- Allowed workspace roots, configured MCP servers, and tool permission policy.
- Idle timeout and an Agent-specific authentication adapter where necessary.

Requests select an `agentId` and a working directory inside its allowed roots.
They cannot submit executable paths, shell commands, environment overrides,
credential profiles, MCP servers, or arbitrary provider configuration.
Canonicalize workspace paths and enforce symlink-aware boundaries. Configuration
and workspace checks may access the local filesystem without starting an Agent.

Use one owned ACP process per configured Agent, with several Sessions where the
Agent supports them. Coalesce concurrent starts. The initial scheduler admits
one prompt at a time per Agent, rejecting `agent_busy`; this avoids assuming
cross-session concurrency that ACP does not universally guarantee. Also enforce
one active Turn per Session. No queue and no process per HTTP read/request.

Different Agent configurations have distinct profiles and can run independently.
Profiles are never discovered or copied from another application. Sharing a
profile across active runtimes is rejected. Directory separation and tool
policies are not an OS sandbox.

## Resource model

```text
Configured Agent
  Session (local durable identity)
    Turn (local durable identity)
    Events (ordered local observations)
```

An ACP Session is already a conversation. Do not introduce a synthetic Chat or
pretend ACP exposes AHP's defaultChat, fork, or multipleChats semantics.

- `agentId` identifies static configuration, not a running process.
- `sessionId` is a service-generated UUID, stable before backend creation and
  across HTTP/service/Agent restarts.
- `turnId` is a caller-generated UUID, unique within a Session.
- `backendSessionId` is the opaque ACP ID, stored internally with its binding.
- Runtime generations are ephemeral; they fence callbacks from retired
  connections. Backend bindings also record Agent/profile identity so that a
  configuration change cannot accidentally resume another conversation.

The same local Turn ID is used for submission, observation, and cancellation. It
is not passed off as a native ACP Turn ID: ACP prompt requests are correlated by
the client, and session updates are generally scoped only to an ACP Session.

## Durable records

Use three tables for Session content, plus a separate authentication observation
table:

| Table      | Important fields                                                                                              |
| ---------- | ------------------------------------------------------------------------------------------------------------- |
| `sessions` | local ID, Agent ID, canonical workspace, backend binding, created/updated times, history coverage             |
| `turns`    | Session/Turn IDs, submitted prompt, observation state, stop reason/error, last persisted sequence, timestamps |
| `events`   | Session ID, optional Turn ID, monotonic sequence, kind, filtered typed payload, observed time                 |

Enforce uniqueness of `(sessionId, turnId)` and `(sessionId, sequence)`. Every
Event belongs to a Session and optionally one Turn; a non-null Turn reference
must resolve within that same Session, enforced by a composite foreign key.
Index `(sessionId, turnId, sequence)` for filtered event reads. Persist the
submitted user message once; do not append its echoed ACP chunks as another user
message. Tool IDs are scoped to their Session/Turn or replay context;
incremental `tool_call_update` patches update the derived tool view. Keep
message boundaries and content-block types rather than flattening every
notification into one string.

Store selected ACP updates and normalized message/tool views. Exclude raw auth
responses, environment dumps, transport credentials, raw process stderr/login
transcripts, and hidden reasoning by default. Redact known secrets before
storage and HTTP output, including secrets inside tool arguments/results.
Arbitrary Agent output may still contain sensitive workspace data; do not claim
generic redaction can identify every secret. Database access, backups, and any
later retention/deletion policy must be treated accordingly.

Keep sanitized authentication observations in a separate `agent_auth` table, not
in Session/Turn/Events. Persist only Agent/profile identity, sanitized method
descriptors, last known authentication result, evidence source, verification
time, known expiry, and invalidation reason. Device codes, pending-login
interaction data, and raw descriptors with environment values remain short-lived
in memory. Do not store a second copy of Agent tokens. Persisted observations
are historical and stale after service restart.

The record is authoritative about what the service observed, not everything the
Agent ever did. Report `observedAt`, `lastSequence`, and coverage (`complete`,
`partial`, or `unknown` for the known observation interval). Completed Turn
coverage requires all updates preceding its final response to be durably
committed. A completed Turn does not prove that a previously imported or
disconnected Session's entire history is complete.

## Execution and crash boundary

1. Validate the request, workspace policy, Session identity, and duplicate ID.
2. Serialize admission for the Session and Agent. Reject busy or unresolved work
   before accepting another prompt.
3. Commit the Turn, user message, and `accepted` observation before returning
   HTTP 202. This is durable admission, not a claim of backend execution.
4. Prepare the Agent process, negotiate ACP, and authenticate from its
   configured profile. Create or restore its backend Session.
5. Persist `dispatching` before invoking `session/prompt`, then `running` when
   dispatch is known. Persist notifications in order as they arrive.
6. After the prompt response, commit all preceding updates, stop reason, and
   terminal observation before exposing it as terminal.

Observation states are `accepted`, `starting`, `dispatching`, `running`,
`cancelling`, `complete`, `cancelled`, `error`, and `unknown`. Preserve the ACP
stop reason separately; a token limit or refused request is not represented as a
successful requested result merely because RPC resolved. Completion means
execution ended, not that the user's task was accomplished.

After a service crash, a durable `accepted`/`starting` record with no persisted
dispatch intent can be terminated as `error: dispatch_not_started`; do not
implicitly run it later. Records with dispatch intent but no trustworthy
terminal evidence become `unknown`, even if the Agent process is gone. There is
no atomic transaction across SQLite and an ACP process.

Repeated submissions with the same ID and identical prompt return the existing
record without dispatch; changed input returns `409 turn_id_conflict`. Unknown
outcomes never trigger automatic replay or another prompt in that Session. A
client disconnect does not cancel a durably accepted Turn.

On storage failure, stop admitting new work, report the failure, and attempt
bounded cancellation of active prompts. Do not publish completion while its
updates are uncommitted or continue silently dropping notifications. Queue
bounded writes/backpressure; overflow becomes an explicit history gap and
unknown observation, never invented complete history.

## Agent restarts and history replay

Local history reads need no backend recovery. Continuing an existing Session
does:

- Reuse its bound ACP Session when still attached to the current runtime.
- After restart, prefer advertised `sessionCapabilities.resume` for reconnecting
  without history replay.
- Otherwise use `session/load` only when `loadSession` is advertised.
- If neither is supported, return `409 session_resume_unsupported`; retain
  read-only history. A missing backend Session is a distinct
  `session_backend_unavailable` error.
- Never create a replacement backend Session and submit cached text as if it
  restored the original model/tool context.

Loading may replay user/Agent/tool history. Mark a loading phase and stage
replay separately from live Turn events. Do not deduplicate arbitrary text by
hash: identical messages may be genuine repeated messages. Reconcile using
stable backend message IDs where available; otherwise retain replay as a
separate snapshot with explicit provenance and coverage, without appending it to
the already observed live transcript or inventing local Turn associations.

Backend load does not by itself resolve the outcome of an interrupted prompt.
ACP has no universal exact-Turn query. Only verified Agent-specific evidence may
reconcile `unknown`; otherwise the Session remains blocked for execution.
Creating another Session is an explicit caller action, not recovery.

## Cancellation, callbacks, and idle processes

Cancellation targets a local Session/Turn and its current runtime binding.
Cancelling an undispatched Turn can complete locally under the admission lock.
For a dispatched Turn send `session/cancel`, but retain `cancelling` until the
pending prompt resolves with cancellation evidence. Late normal completion is
still recorded honestly. A cancel notification or HTTP 202 is not completion.

ACP callbacks are part of the runtime, not optional errors to swallow:

- Advertise filesystem/terminal capabilities only when their full handlers and
  configured policy are implemented. Check roots and output limits.
- Use explicit allow/deny policy for `session/request_permission`; the default
  is deny, with the denial recorded. Initial `/v2` does not promise interactive
  permission or arbitrary user-question handling.
- Requests for unsupported interactions fail explicitly; they must not hang the
  prompt or be auto-approved.
- Record supported message/tool content, and make unsupported content visible as
  a coverage limitation instead of silently dropping it.

Do not assign replay, uncorrelated, or late background notifications to the next
Turn just because it is currently running. Such events may have `turnId: null`.
Use negotiated message identity/activity extensions only through a tested
Agent-specific mapping.

Idle shutdown requires no pending prompt, load, login, callback, or known
background work. Copilot activity extensions can provide stronger evidence;
generic ACP does not guarantee visibility into all detached background work.
When quiescence is unknown, retain the runtime and report that condition rather
than applying a blind idle timer. Graceful service shutdown closes owned
connections/processes and preserves nonterminal records as uncertain.

## HTTP /v2 proposal

All GET results are local. No `live=true` fallback, hidden synchronization, or
automatic authentication is attached to a read.

| Method | Path                                                             | Behavior                                                                               |
| ------ | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| GET    | `/v2/health`                                                     | HTTP/storage readiness; no Agent startup                                               |
| GET    | `/v2/agents`                                                     | static choices, cached capabilities with observation time, current local runtime state |
| GET    | `/v2/agents/{agentId}/auth`                                      | local sanitized methods, last known auth observation and active login progress         |
| POST   | `/v2/agents/{agentId}/auth`                                      | explicitly begin an advertised/configured method; 202                                  |
| POST   | `/v2/agents/{agentId}/auth/input`                                | answer an exact allowlisted non-secret login step; 202                                 |
| POST   | `/v2/agents/{agentId}/auth/logout`                               | explicitly request supported logout; 202                                               |
| POST   | `/v2/sessions`                                                   | create local Session; 201                                                              |
| GET    | `/v2/sessions?agentId=...&cursor=...&limit=...`                  | paginated local catalogue                                                              |
| GET    | `/v2/sessions/{sessionId}`                                       | local metadata, backend availability evidence, history coverage                        |
| GET    | `/v2/sessions/{sessionId}/events?turnId=...&after=...&limit=...` | ordered durable message/tool events, optionally filtered by Turn                       |
| POST   | `/v2/sessions/{sessionId}/turns`                                 | durable admission with caller Turn ID; 202                                             |
| GET    | `/v2/sessions/{sessionId}/turns?cursor=...&limit=...`            | local Turn catalogue                                                                   |
| GET    | `/v2/sessions/{sessionId}/turns/{turnId}`                        | persisted observation and response projection                                          |
| POST   | `/v2/sessions/{sessionId}/turns/{turnId}/cancel`                 | exact cancellation request; 202                                                        |

Creation: `{"agentId":"copilot","workingDirectory":"/srv/work/project"}`.
Submission: `{"turnId":"<uuid>","text":"Explain the entry point"}`. Use local
IDs in path segments, not backend ACP IDs. Responses include local identity and
observation metadata. Event pagination defaults to 100 records, caps at 1,000,
and follows committed sequence cursors with no duplicates/skips. These bounds
are proposed API constants, not runtime claims.

The event endpoint accepts an optional `turnId` filter:

- Omitted: return all Session events, including events with `turnId: null`.
- Present: return only events associated with that Turn in the selected Session;
  unassigned events are excluded.
- Malformed, empty, or repeated `turnId` parameters return 400. A well-formed
  Turn ID absent from this Session returns 404, including an ID belonging only
  to another Session.
- A known Turn with no matching events returns an empty page with observation
  coverage, not a missing-Turn error.
- Apply the filter before the page limit. `after` remains an exclusive cursor
  over the Session-wide committed sequence; do not renumber filtered events.
  Continue with the last returned sequence and keep the filter unchanged. Gaps
  between filtered sequence values are normal, not evidence of lost data.

For example,
`/v2/sessions/{sessionId}/events?turnId={turnId}&after=42&limit=100` reads the
next matching events after Session sequence 42. This remains a local query and
never starts or contacts an Agent. No second nested Turn-event route is needed.

An unknown local ID returns 404. A known incomplete record returns its coverage,
not a misleading 404 or empty complete history. Busy/conflict/resume/unknown
execution conditions use actionable 409 errors; startup/protocol/storage
failures have explicit error codes and must not resemble success.

External gateways continue to own inbound identity, authorization, and TLS. The
service must remain loopback/private behind that protection. History persistence
does not grant callers access to other users' workspaces.

## Authentication and CLI

### Explicit authentication bridge

Agent authentication is operator provisioning, not a credential requirement on
ordinary execution requests. Expose the flow through operator-protected HTTP
auth routes and the target `agents login` CLI; the external gateway must
restrict those routes and authorize Agent use. Cached upstream login never
grants an HTTP caller permission to use that account.

Use `initialize.authMethods` to discover supported flows. For an `agent` method
(including an omitted type), call ACP `authenticate` with only its advertised
`methodId`. For a `terminal` method, advertise `auth.terminal` only when the
complete interactive launcher is implemented: run the configured executable with
approved method arguments/environment, then reconnect and initialize after
success. Never pass a terminal method to `authenticate`. Do not allow
descriptors to select another executable or silently override program lookup,
interpreter startup, proxy, or TLS trust.

ACP does not standardize device-code terminal output. Copilot's native login
command, link/code extraction, storage consent, and account verification remain
an Agent-specific adapter. Public methods can also be configured for this
adapter when ACP does not advertise the needed flow. No generic OAuth app or AHP
token handoff, no hidden model probe, and no automatic interactive login inside
a Turn.

POST auth accepts `{"methodId":"<advertised-or-configured-id>"}` and may
explicitly prepare a stopped Agent to negotiate methods. One active auth
operation per Agent/profile; active or uncertain execution blocks a conflicting
login/logout rather than closing another caller's Session. Return a bounded,
expiring flow with public device link/code or a configured non-secret input
step. POST auth/input accepts `stepId` and allowlisted `values`, such as
explicit plaintext-storage consent; it is not a generic password/token ingestion
API. Logout calls ACP `logout` only when `agentCapabilities.auth.logout` is
advertised, or a configured tested native adapter supports it. Otherwise return
`409 agent_logout_unsupported`; never report a local cache clear as successful
upstream logout. Logout semantics for existing ACP Sessions are not universal
and must remain explicit.

### Authentication observation cache

Credentials stay in the dedicated Agent profile or its explicitly configured
credential store. Cache observations by Agent/profile identity and the current
runtime generation, not by Session and not as a shared HTTP-user login. Persist
only the sanitized historical projection described above.

GET auth remains local even when the Agent is stopped or inaccessible. Represent
the observation independently from the active login flow:

- `lastKnownStatus`: `authenticated`, `required`, or `unknown`.
- `verifiedAt`, known `expiresAt` or `null`, and the evidence source.
- `freshness`: `current`, `stale`, or `unknown`, plus an invalidation reason.
- Sanitized method IDs/names/types and optional public active-flow progress.

`current` means the observation still belongs to this live runtime/profile and
has no known invalidation; it does not guarantee credentials have not been
revoked externally. Do not invent an expiry or refresh guarantee when ACP does
not provide one. Method discovery alone is not authentication evidence.

Runtime restart/reconnection, profile or account configuration change,
`auth_required`, explicit logout, and known expiry invalidate current evidence.
Keep the old observation only as `stale`; do not return its success as current
authorization. Invalidate on logout request before dispatch, even if the outcome
is uncertain. A subsequent successful explicit authentication can establish new
evidence.

Cache invalidation does not itself require another human login: reuse the
configured saved credentials and respect the Agent's actual response. Use a
tested non-billable verification mechanism when one exists; otherwise keep
authentication unknown until legitimate protocol/execution evidence appears. Do
not skip backend authentication checks or accept credentials as valid just
because the database contains a past success. Missing login yields an actionable
`agent_auth_required` failure, distinct from network/storage failures and from
unknown authentication. Successful login is not proof of paid entitlement.

Keep `serve`, local exclusive `init`, and thin HTTP client commands, redesigned
around `agents`, `sessions`, `turns`, and `events`. Authentication provisioning
executes in the service deployment and is serialized against profile use. Remove
old `hosts`, `chats`, and AHP auth-input commands rather than silently
translating them. Polling/paginated event reads are sufficient initially; SSE is
not required for the first implementation.

## Migration and implementation order

### Independent entry first, replacement after verification

Build the ACP implementation behind a separate entry in the same package,
initially invoked as `node dist/acp-cli.js`. Do not route the old `ahplex`
command, exported `start`, or `/v1` requests into it during development. Use its
own schema-2 configuration, database/data root, profile, and port. This
temporary coexistence is rollout isolation, not backward compatibility: the new
entry accepts only `/v2` and never translates old IDs or configuration.

Keep the old entry working while the new entry passes automated, installed
artifact, and isolated real-Agent tests, including offline reads, authentication
cache invalidation, restart, cancellation, and failure handling. Then replace
the normal CLI/library entry with the verified ACP implementation and delete the
old runtime, routes, adapters, tests tied only to removed behavior, and
dependencies. Remove the temporary entry when it is redundant. Do not publish a
second package or maintain two execution stacks permanently. Final
installed-package acceptance verifies the promoted entry again.

| Phase | Work                                                                                            | Exit gate                                                              |
| ----- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 1     | `/v2` OpenAPI, schema 2, ID/state/error types, ACP SDK selection                                | contract tests agree with the approved requirements                    |
| 2     | SQLite schema/migrations, admission journal, event projections/read routes                      | restart and all offline GET tests pass without spawning any Agent      |
| 3     | owned stdio ACP runtime, capability negotiation, callbacks, Copilot login adapter               | fixture lifecycle/auth/policy tests pass; concurrent starts spawn once |
| 4     | lazy backend sessions, prompt/event persistence, exact cancellation                             | real Copilot prompt and tool event capture pass via `/v2`              |
| 5     | capability-gated resume/load, replay isolation, crash/unknown handling, idle lifecycle          | offline-read/restart/resume and injected-failure gates pass            |
| 6     | promote verified independent entry, update CLI/library/docs, remove legacy runtime/dependencies | package check and promoted installed-package acceptance pass           |

Phases 2 and 3 depend on phase 1 and can be developed independently. Phase 4
needs both, phase 5 depends on 4, and the final cutover needs all prior gates.
Use a separate private deployment root/port for acceptance. Do not mutate the
running legacy deployment or auto-import its credentials.

Reuse request validation, safe error handling, process ownership, data-root
locking, secret references/redaction, exclusive config creation, and native
device-login parsing where their semantics fit. Replace `NativeHost`,
`MultiHostClient`, AHP transport, AHPD/VS Code adapters, native URI routing, and
AHP authentication submission. Do not keep a dual-protocol abstraction merely to
preserve dead code.

This design-only change does not remove code or change dependencies. During
implementation remove `@microsoft/agent-host-protocol` and the AHP-specific
runtime after ACP acceptance, use the ACP SDK, and update public types through
`src/index.ts` while preserving the exports map and package files allowlist.
Keep old AHP verification evidence explicitly historical, not ACP acceptance.

## Acceptance gates

1. Service startup and every GET cause zero Agent spawns and zero ACP requests.
2. Session creation persists through service restart with no backend ID and zero
   Agent spawns.
3. Concurrent first executions on one Agent spawn exactly one process; busy
   submissions are rejected before dispatch with no extra backend prompt.
4. A real Copilot Turn returns the exact requested marker and all preceding
   message/tool events are durable before terminal status is visible.
5. With Agent processes stopped and the executable deliberately unavailable,
   service restart still permits local catalogue, detail, Turn, and event reads.
6. Event pages at limits 1, 100, and 1,000 preserve order and identity without
   duplicates/skips, both with and without Turn filtering. Interleaved Turns and
   unassigned events do not leak through the filter or consume its page limit.
   Invalid filters/limits/cursors fail explicitly; unknown and cross-Session
   Turn IDs return 404, while known empty Turns return empty pages.
7. Repeat identical Turn IDs never dispatch twice; changed prompts conflict.
   Fault injection on both sides of dispatch never silently replays work.
8. Advertised resume/load restores the same backend Session; absent capability
   fails explicitly while cached history stays readable.
9. Replay never duplicates the live transcript or attaches old events to a new
   Turn. Repeated identical legitimate messages remain distinct.
10. Cancellation waits for real terminal evidence; storage/process/transport
    failures preserve partial records and uncertain outcomes honestly.
11. Known credential values are absent from logs, stored event payloads, and
    HTTP/CLI output, including tool-result tests; permission denials are
    visible.
12. Stop/restart leaves no owned orphan process or transient transport secret.
    Unknown background activity is never treated as idle.
13. Authentication GETs issue zero ACP requests, including after restart.
    Restart/profile change/logout/auth challenge/known expiry invalidate cached
    success. No token or raw login output is persisted or returned; stale
    observations never suppress `auth_required`, trigger paid probes, or grant
    inbound HTTP access. Agent-driven and terminal methods follow different
    flows, and unsupported logout fails explicitly.

## Protocol references

- [ACP initialization and capabilities](https://agentclientprotocol.com/protocol/initialization)
- [ACP Session setup, load, and resume](https://agentclientprotocol.com/protocol/session-setup)
- [ACP prompt flow and updates](https://agentclientprotocol.com/protocol/prompt-turn)
- [ACP authentication methods and logout](https://agentclientprotocol.com/protocol/v1/authentication.md)

Implement against the selected SDK and negotiated capabilities, not assumptions
that every Agent has every feature in these evolving references.
