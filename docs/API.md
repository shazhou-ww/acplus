# AHP-native MVP API

Status: implemented MVP contract. This replaces the earlier task-centric API.
Real-provider acceptance is tracked separately in the Silvermoon idea. Start
with [requirements](REQUIREMENTS.md) and [invariants](../DESIGN-INVARIANTS.md).
The [OpenAPI contract](openapi.yaml) is the machine-readable source;
[HTML reference](api.html) is generated from it.

## Resource model

```text
Host -> Session -> Chat -> Turn
```

These are AHP concepts, not ahplex jobs. A Session is a working context; a Chat
is a conversation thread; a Turn is one initiated execution cycle. No Task,
project API, global resource aliases, or service-side queue.

Every host operation names `hostId`. Session/Chat values are their native AHP
URIs, not an ahplex-generated ID mapped to another ID. Turn IDs are the actual
protocol IDs. Resource identity is `(hostId, URI)`; a turn is identified by
`(hostId, chat URI, turnId)`.

Pass resource URIs in JSON or URL-encoded query values, not path segments. This
avoids encoding slashes through HTTP gateways without inventing opaque aliases.
The HTTP shape is a small projection, not a byte-for-byte JSON-RPC proxy.

## Operations

All paths start with `/v1`. Fourteen operations cover the required journeys. The
count is a consequence of distinct needs, not a target to preserve from an
earlier draft.

| Method | Path                                           | Purpose / success response              |
| ------ | ---------------------------------------------- | --------------------------------------- |
| GET    | `/health`                                      | Service liveness; 204, no body          |
| GET    | `/hosts`                                       | Configured host choices and state       |
| POST   | `/hosts/{hostId}/start`                        | Start/connect; 202, no body             |
| POST   | `/hosts/{hostId}/stop`                         | Stop owned process; 202, no body        |
| POST   | `/hosts/{hostId}/auth`                         | Begin configured login; 202, no body    |
| GET    | `/hosts/{hostId}/auth`                         | Login progress and next action          |
| POST   | `/hosts/{hostId}/auth/input`                   | Answer login step; 202, no body         |
| GET    | `/hosts/{hostId}/sessions`                     | Native session summaries                |
| POST   | `/hosts/{hostId}/sessions`                     | Create Session; 201, `{resource}`       |
| GET    | `/hosts/{hostId}/chats?session=<uri>`          | `{defaultChat?, chats}`                 |
| POST   | `/hosts/{hostId}/chats`                        | Create ordinary Chat; 201, `{resource}` |
| POST   | `/hosts/{hostId}/turns`                        | Start Turn; 202, no body                |
| GET    | `/hosts/{hostId}/turns?chat=<uri>&turnId=<id>` | Exact Turn observation                  |
| POST   | `/hosts/{hostId}/turns/cancel`                 | Cancel exact Turn; 202, no body         |

### Payload discipline

- Host: `hostId`, `status`; providers only when ready, configured authMethods
  only when present, and error on failure. No model catalogue or internal PIDs.
- Session: `resource`, `title`, `provider`. Title identifies a human
  conversation context without returning its transcript or workspace
  configuration.
- Chat: `resource`, `title`, optional `origin` and `interactivity`. Catalogue
  `defaultChat` comes directly from the Session; no invented `isMain` field.
- Turn: `state`, optional `text`, `inputRequired`, and `error`. No echoed IDs,
  timestamp, usage, prompt copy, task result object, or raw tool content.
- Errors: `{error: {code, message}}`; no generic retryability claim.

Known provenance is forwarded as `user`, `fork`/`sideChat` with source
chat/turn, or `tool` with source chat/toolCallId. This does not expose a
complete internal hierarchy. Missing provenance remains absent. Missing
interactivity means full according to AHP. Default-chat membership is
independent of origin.

## Smallest useful execution

1. List hosts, then start the selected host when discovery is needed.
2. If upstream authentication is required, complete the host's configured
   method.
3. List sessions or create one with:

   ```json
   {
     "provider": "copilotcli",
     "workingDirectories": ["file:///D:/work/demo"]
   }
   ```

4. List that Session's chats. Use its explicit defaultChat or select a writable
   chat. If desired and supported, create an ordinary chat with
   `{session: uri}`. Never assume the first chat is default or substitute a new
   Session for Chat creation. The MVP does not request fork/sideChat creation.
5. Choose a fresh turn ID before sending:

   ```json
   {
     "chat": "ahp-chat:/example",
     "turnId": "99888d8a-73d2-48dd-9a7f-d650388704f9",
     "text": "Explain the entry point."
   }
   ```

6. Poll that chat/turn ID, or send `{chat, turnId}` to `/turns/cancel`.

Session creation confirms allocation through RPC and native snapshots. VS Code
may retain `lifecycle=creating` until first-send provider materialization.
Returning 201 does not invent a ready lifecycle or send a probe turn; allocated
Chats remain discoverable before that first execution.

Client-chosen turn IDs are native AHP identifiers, not a second idempotency
protocol. They let a caller query an ambiguous submission even if its HTTP
response is lost. No automatic replay is promised; an observed existing ID is a
conflict, not permission to rerun it.

## Admission and observation

One active turn per Chat; busy input returns `409 chat_busy` without dispatch.
Admission is serialized per Chat, and host rejections still prevail after local
checks. Different chats can execute concurrently when the provider permits.
There is no `queued` state and no ahplex Task registry.

`running` is the HTTP projection of `ChatState.activeTurn`; completed states
retain AHP's `complete`, `cancelled`, and `error`. Text is a minimal
concatenation of markdown response parts, not the whole structured transcript.
Known user-input or tool-approval blocks add `inputRequired: true`. Answering
those blocks is not implemented by this MVP; the caller can cancel rather than
wait blindly.

A disconnected/unobservable host returns an HTTP error, not a fabricated Turn
state. An ambiguous dispatch uses `502 turn_outcome_unknown`; later reads query
the same native ID. Do not admit further writes to that chat until the ambiguity
is reconciled. A cancellation must never target a different active turn.

Read from activeTurn or retained/fetched history. Incomplete history is not
proof of absence: return `503 turn_state_unavailable` when it cannot be
resolved. Only confirmed absence returns 404. Host-side durability is
host-dependent; ahplex adds no durable turn store or background recovery
scheduler.

## Host lifecycle and login

All hosts come from static configuration and are started/stopped by ahplex. GET
never launches a process or login. Resource reads require a ready connection;
unavailability is an error, not an empty/stale aggregate. POST operations can
prepare the selected host when its onDemand configuration permits.

Concurrent starts coalesce. Stop rejects active work/authentication and unknown
host activity; no force-stop. Host failures are independent. Service health does
not require every host to be ready, and protocol readiness does not imply login.

Authentication selects `{methodId}` from that host's configured choices. Poll
`/auth`: a link step exposes `{kind: "link", url, userCode?}`; an input step
exposes `{kind: "input", stepId, fields}`. Submit exact requested values with
stepId. A finite attempt expiry releases its owned commands/resources.

One active attempt per host; no flow resources, history, global account, or
global logout. The caller handles user interaction; the adapter handles OAuth/
command/protocol specifics and actual success verification. Tokens are never
status output. Stale input and stale connection-bound success are rejected.

## Explicit non-goals

Queueing, scheduled work, global session catalogues, task abstractions, model
selection, attachments, transcript streaming, tool approvals, fork/sideChat
creation, moving/deleting resources, dynamic host registration, generic RPC
passthrough, and exactly-once or durable recovery guarantees.

The service owns no inbound identity or access-control system; deployment
gateways provide it. Upstream auth errors use 409, not an inbound-login 401.
Responses use `Cache-Control: no-store`; gateways must not log authentication
input bodies. Lists must not silently truncate.

## Generate the reference

Run from the repository root:

```powershell
npm exec --yes --package=@redocly/cli@2.0.0 -- redocly lint docs\openapi.yaml --extends minimal
npm exec --yes --package=@redocly/cli@2.0.0 -- redocly bundle docs\openapi.yaml --output docs\.openapi.bundle.json
if ($LASTEXITCODE -eq 0) {
  node docs\render-api-docs.js docs\.openapi.bundle.json docs\api.html
}
Remove-Item -LiteralPath docs\.openapi.bundle.json
```

The HTML embeds the contract and uses a pinned ReDoc CDN script. It needs
JavaScript/network access, but no ahplex or Host process. It is reference
documentation, not an operational Web UI.
