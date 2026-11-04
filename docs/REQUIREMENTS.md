# MVP requirements

Status: MVP requirement baseline for the native implementation. This replaces
the earlier task-centric drafts; compatibility with the old HTTP/CLI design is
not a requirement. [API.md](API.md) and [openapi.yaml](openapi.yaml) specify the
public contract; [design invariants](../DESIGN-INVARIANTS.md) constrain
implementation. Silvermoon records implementation and real-environment
acceptance separately.

## Product

ahplex is one HTTP service that lets a caller use several AHP hosts without
managing their processes, AHP connections, or authentication interactions
itself. It is a host manager and a small AHP client, not a new agent execution
model.

## Native concepts

```text
ahplex
  Host
    Session
      Chat
        Turn
```

| Concept | Meaning                                                                                     |
| ------- | ------------------------------------------------------------------------------------------- |
| Host    | A configured AHP server process whose lifecycle ahplex owns                                 |
| Session | AHP working context: provider, working directories, configuration, and chats; not a Project |
| Chat    | A conversation thread with its own history and active turn                                  |
| Turn    | A message-initiated execution cycle, potentially including many model/tool calls            |

Use the Host's Session/Chat URIs and actual AHP turn IDs. Host identity remains
part of every lookup because different hosts can expose identical URIs. There is
no additional Task, job ID, global session alias, or project-management model.

`Session.defaultChat` names the default input destination, not the first chat or
a universal parent. `Chat.origin` records creation provenance, and
`Chat.interactivity` controls interaction. These are separate concepts. Missing
origin means unknown; missing interactivity means full per AHP. Never infer
subagent status from list indentation or a chat title.

## Required user journeys

### R1. Select and prepare a host

Read the configured host list, select a host, and start it when needed.
Concurrent startup requests must not produce duplicate processes. AHP connection
and provider discovery must succeed before the host is ready. Login is a
separate condition. The host can be stopped when no work or authentication is
active. Stop affects only the process owned by ahplex. One failed host must not
disable the others.

### R2. Complete upstream authentication

Discover configured login methods for that host, start one, and receive the next
user-facing link/code or requested input. The API caller handles the browser or
input UI; an adapter performs the corresponding protocol or login-command steps.
The result must reach ahplex's real AHP connection or verified host-side state.
One active attempt per host is enough for the MVP; attempts expire and clean up.
This is not authentication to ahplex and not a global login account.

### R3. Find or create a session and chat

List a ready host's sessions or create one for a provider and one working
directory. List its chats and defaultChat, then explicitly select a writable
chat. Create an ordinary new chat when the provider advertises AHP
multipleChats. If unsupported, report that rather than creating another Session
as a substitute. Existing fork/side/tool chats can be discovered; creating those
variants is deferred.

### R4. Run and observe a turn

Send plain text to an explicit chat, inspect that exact turn's state and text,
and request cancellation when needed. Use a caller-chosen AHP turnId so that a
lost HTTP response does not lose the execution's identity.

There is no service queue. If that chat is busy, reject the submission before
dispatch with `chat_busy`. Other chats may progress independently where
supported by the host. A busy response is not a promise of future admission.

Turn state comes from the host, not a second task state machine. An unavailable
observation is an error, not evidence that the turn failed or completed. Never
blindly replay an ambiguously accepted turn. A turn blocked on unsupported tool
approval/user input must be reported as requiring input, not silently shown as
making progress. In the MVP the caller can cancel it; answering those requests
is a future API surface.

## Deployment boundary

- One package; official AHP SDK for protocol behavior.
- Registered hosts come from one static configuration supplied by file or stdin.
  All hosts are owned by ahplex; no attach-only mode or dynamic registration.
- Host startup/discovery/cleanup and authentication mechanisms have separate
  internal adapter contracts. VS Code is the first host integration, not the
  only possible host implementation.
- A service-level dataDir provides isolated per-host runtime data and test
  roots. It is not the agent working directory or a durable execution database.
- External gateways own inbound authentication and access control. ahplex still
  validates input, respects ownership, and does not leak credentials.
- `serve` validates configuration before startup; no separate validation
  command.

## Not in the MVP

Own task abstraction, task queue, scheduled jobs, cross-host routing policies,
durable recovery, exactly-once delivery, global session catalogues, transcript
streaming, fork/side-chat creation, chat moves, project management, model
pickers, tool-approval UI, arbitrary AHP passthrough, dynamic plugins, or public
plugin SDK.

Host-side history may survive a restart, but availability depends on the host.
ahplex does not promise to persist turn state, authentication attempts, or a job
journal. Its shutdown must not be confused with a successful agent completion.

## Acceptance criteria

1. Two configured hosts can start independently; a failure of one is observable
   without stopping the other. Concurrent requests launch a host only once.
2. Authentication instructions are tied to the selected host/method. Stale input
   is rejected and success requires actual upstream confirmation.
3. Session and Chat identities survive HTTP round trips unchanged. Equal
   resource URIs on different hosts cannot collide.
4. A session can expose its default chat and another ordinary chat. Their origin
   and interactivity are not conflated with defaultChat membership.
5. One busy chat rejects new turns; an idle chat can proceed. Nothing is queued
   in an ahplex-specific execution model.
6. Reading or cancelling turn A never targets turn B. Connection loss yields
   explicit uncertainty, not a fabricated final state or an automatic replay.
7. Unsupported multipleChats and user-input/tool-approval operations fail or are
   surfaced explicitly. A test fixture does not establish real-host support.
8. Success payloads contain only identities or observations needed by the
   caller. No duplicate IDs, timestamps, internal connection generations, or
   credentials.
