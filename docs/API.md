# ACP HTTP /v2 API

This is the contract for the independent ACP entry. HTTP `/v2` uses the stable
ACP **wire protocol v1**, not the SDK's experimental ACP v2 entry. The service
owns local Session/Turn IDs and persists selected Agent events. All GET
operations read SQLite or local runtime observations; they never start an Agent,
authenticate, or fetch backend history.

The public HTTP contract and exported `start(config)` remain persistent.
Separately, the [CLI local mode](CLI.md#local-service-selection) can read the
same committed Session/Turn/event shapes without HTTP, and privately discover/
launch an idle-managed service for execution. Its owner discovery/challenge/
request-signature protocol is internal and is not a new public API. Explicit URL
clients never perform discovery/startup; use explicit `serve` for ordinary HTTP,
Agent authentication and health. Offline history does not prove liveness or
cancel work, mutate/reconcile storage, or keep an automatic service alive.

## Resources and identity

```text
configured Agent -> local Session -> Turns and ordered Events
```

Session IDs are service-generated UUIDs. Turn IDs are caller-generated UUIDs,
unique within a Session. Backend ACP Session IDs and profile bindings remain
internal. `backendBound` means a binding was recorded, not that the backend is
currently online or still has the conversation.

Every Event belongs to one Session and zero or one Turn in that same Session.
Session/configuration/replay/late uncorrelated events have `turnId: null`. Do
not treat a Turn as one model call: it may include multiple tool/model steps.

## Operations

All paths below are prefixed by `/v2`.

| Method | Path                                                          | Result                                                          |
| ------ | ------------------------------------------------------------- | --------------------------------------------------------------- |
| GET    | `/health`                                                     | 204 after a local store readiness query                         |
| GET    | `/agents`                                                     | configured choices, local runtime state and cached observations |
| GET    | `/agents/{agentId}/auth`                                      | sanitized cached auth and active-flow progress                  |
| POST   | `/agents/{agentId}/auth`                                      | 202, explicit login flow                                        |
| POST   | `/agents/{agentId}/auth/input`                                | 202, exact non-secret storage-consent step                      |
| POST   | `/agents/{agentId}/auth/logout`                               | 202 on supported upstream logout                                |
| POST   | `/sessions`                                                   | 201, local Session only                                         |
| GET    | `/sessions?agentId=...&cursor=...&limit=...`                  | local catalogue page                                            |
| GET    | `/sessions/{sessionId}`                                       | local metadata and history coverage                             |
| GET    | `/sessions/{sessionId}/events?turnId=...&after=...&limit=...` | ordered durable event page                                      |
| POST   | `/sessions/{sessionId}/turns`                                 | 202, durable admission or identical existing Turn               |
| GET    | `/sessions/{sessionId}/turns?cursor=...&limit=...`            | local Turn page                                                 |
| GET    | `/sessions/{sessionId}/turns/{turnId}`                        | persisted execution observation                                 |
| POST   | `/sessions/{sessionId}/turns/{turnId}/cancel`                 | 202, exact cancellation                                         |

See [OpenAPI](openapi.yaml) for the machine contract. Requests require
`application/json`, exact allowed fields, and at most 1 MiB. Unknown/repeated
query parameters fail explicitly. Responses use `Cache-Control: no-store`; the
service-side durable store is distinct from browser/proxy HTTP caching.

## Session creation and execution

```json
{
  "agentId": "copilot",
  "workingDirectory": "/srv/work/project"
}
```

Creation validates the configured Agent and an existing absolute host directory,
canonicalizes that directory, and persists a Session without spawning. No
synthetic Chat is created. Each Session independently chooses its working
directory; Agent configuration does not impose a workspace-root allowlist. The
directory is checked again before execution. Relative paths fail with
`invalid_input`; missing paths or non-directories fail with
`workspace_unavailable`.

Submit to `/sessions/{sessionId}/turns`:

```json
{
  "turnId": "b5a2e47f-00cd-4af8-8178-88015beac5f0",
  "text": "Explain the entry point. Do not modify files."
}
```

HTTP 202 means admission was committed before background execution begins. It
does not promise startup, authorization, model success, or completion. The first
Turn starts/initializes the Agent and creates its ACP Session. Subsequent Turns
reuse the bound Session or negotiated resume/load support.

One active prompt is admitted per configured Agent and per Session. Busy input
is rejected, not queued. A backend may still reject an admitted Turn during
preflight; query that exact Turn for the resulting observation. Identical IDs
and original text return the existing Turn without dispatch; changed text
returns `409 turn_id_conflict`.

States are `accepted`, `starting`, `dispatching`, `running`, `cancelling`,
`complete`, `cancelled`, `error`, and `unknown`. `response` concatenates only
Agent text chunks; selected tool/configuration content remains typed Events.
Stop reasons are preserved. `complete` means execution ended, not that its
requested task succeeded; refusals and limits must be interpreted separately.

Before the actual RPC handoff, an undispatched Turn can be cancelled locally.
After handoff, cancellation waits for the pending prompt's real terminal
evidence. A late normal completion remains normal completion. Unknown outcomes
cannot be cancelled as if their active work were known, and they block
conflicting execution without an automatic replay.

## Event filtering and pagination

`turnId` is optional. Omit it for all Session events, including unassigned
events. Supply it to select only that Session's matching Turn; a missing or
cross-Session Turn returns 404, while a known Turn with no matching events
returns an empty page.

Filtering happens before limiting. `after` is an exclusive cursor over the
Session-wide committed sequence, not a filtered-row index. Sparse sequences are
normal. Limits default to 100 and range from 1 to 1,000. Keep the filter
unchanged when paging:

```text
GET /v2/sessions/{sessionId}/events?turnId={turnId}&after=42&limit=100
```

`nextAfter` indicates more currently matching records. For later polling, retain
the last returned sequence or the Session watermark `lastSequence`. An empty
current page does not prove that a running Turn will emit no more events.
Catalogue cursors are opaque and scoped; do not synthesize offsets.

Records expose observation time, sequence, and coverage. Local records describe
what this service observed, not every action ever performed by the Agent.
Replayed history is separately sourced, with no invented local Turn association.
A complete current Turn does not establish complete historical Session coverage.

## Authentication

Authentication endpoints require operator authorization at the external gateway.
Ordinary execution requests do not carry provider tokens.

Begin with `{"methodId":"native-login"}` for the configured Copilot adapter, or
an advertised Agent-driven method. Inspect GET auth for public device URL/code
and exact input steps. POST auth/input accepts only:

```json
{
  "stepId": "COPY-THE-EXACT-STEP-ID",
  "values": { "confirmPlaintextStorage": "yes" }
}
```

It is not a password/token ingestion endpoint. Raw terminal login output is not
returned or persisted. Copilot terminal login is a Linux-specific adapter using
util-linux `script`; unsupported terminal/Agent methods fail explicitly. ACP
Agent-driven methods use `authenticate(methodId)`; terminal methods use a
separate configured program and reconnect, never that RPC.

GET auth returns `lastKnownStatus`, `verifiedAt`, known `expiresAt` or null,
`freshness`, evidence/invalidation reason, sanitized methods and an ephemeral
flow. Past success is not a perpetual guarantee. Restart, reconnect, explicit
login/logout, profile changes, challenges, and known expiry invalidate current
evidence. There is no hidden paid verification request. Unknown activity blocks
conflicting authentication when the runtime has actually observed uncertain
work; missing generic activity capabilities alone do not make a fresh
login/logout impossible.

## Recovery, ownership and limits

SQLite schema 2 is independent of configuration schema 2. Unshipped older
development databases are explicitly rejected, not silently reinterpreted. Use a
fresh private data root for cutover; no legacy AHP import is automatic.

On restart, undispatched `accepted`/`starting` records terminate as not
dispatched; records with unresolved dispatch intent become `unknown`. Cache
reads remain available with the Agent executable absent. Backend continuation
uses only advertised resume/load support; absence yields
`session_resume_unsupported`. Loading history is not proof of an interrupted
prompt's outcome.

Known ambiguous background work is fenced before another same-Session prompt.
Generic ACP does not identify every undisclosed late background output. No
synthetic completion, prompt identity, or background-job API is promised.
Automatic idle exit requires known quiescence; default idle timeout is disabled.
Explicit service shutdown closes only owned processes.

Profile leases exclude cooperating service runtimes across data roots. They
never copy credentials or automatically clear stale ownership files.
Paths/policy are not an OS sandbox. Keep credential profiles outside trusted
workspaces and use a dedicated OS account/container for stronger protection.
This is a private service, not a built-in multi-tenant identity/authorization
system; the gateway must protect Session/history resources and Agent use.

Failures use `{ "error": { "code": "...", "message": "..." } }` and meaningful
HTTP status. Storage failures do not become empty history or a claimed
completion. No write is automatically retried.
