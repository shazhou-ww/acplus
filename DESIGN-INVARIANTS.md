# Design invariants

Status: target design, not implemented behavior. This document and
[MVP requirements](docs/REQUIREMENTS.md) replace the earlier task-centric
design. The README's runtime instructions describe existing code pending
replacement. Changes to these boundaries require an explicit design decision.

## 1. One service, native AHP resources

ahplex aggregates configured AHP hosts, owns their lifecycle, and bridges their
authentication. It provides a small HTTP surface over native Sessions, Chats,
and Turns, not a new execution platform.

- A Session is a working context containing Chats, not a Project.
- A Chat is a conversation thread; a Turn is one initiated execution cycle, not
  an individual model call or tool call.
- Preserve AHP Session/Chat URIs and turn IDs. Always scope them to a host;
  turns additionally belong to a specific Chat.
- Do not introduce Task/job resources, global ID aliases, or duplicate turn
  state machines.
- `defaultChat`, `origin`, and `interactivity` retain their separate AHP
  meanings. Do not assume the first Chat is default or that a non-default Chat
  is a subagent.
- AHP capabilities determine supported actions. Do not silently simulate an
  unsupported Chat operation by creating a different resource.

## 2. Static registry and owned processes

- Register hosts from one static config at startup, supplied by file or stdin.
  Host IDs are unique. No dynamic registration, hot reload, or endpoint
  discovery from unrelated editors/accounts.
- Every registered host has startup configuration and a start/stop adapter.
  There is no external/managed mode or attach-only host.
- Startup is explicit or on-demand according to configuration, not
  unconditional. Coalesce concurrent starts; require protocol readiness, not
  just a live PID.
- Reconnect a transport without spawning a duplicate process. Process restart is
  a separate lifecycle decision and must not silently replay work.
- Only terminate owned processes. Reject explicit stop while turns, unknown
  outcomes, or authentication are active; unknown host activity is not idle.
- Failure of one host does not stop unrelated hosts or the HTTP service.
- One `dataDir` owns runtime data, with `hosts\<hostId>` subdirectories.
  Different test/service instances use different roots. Directory separation is
  not an OS sandbox, and does not relocate agent working directories.

## 3. No task queue

- Submit to an explicitly selected Chat. One active turn per Chat; reject busy
  submissions rather than queueing them in ahplex.
- Concurrent requests must not race past the busy check. The host remains
  authoritative and can reject a submission accepted by local checks.
- Read/cancel the exact `(hostId, chat URI, turnId)`; never substitute "latest
  turn".
- Represent completed outcomes with AHP's `complete`, `cancelled`, and `error`.
  An active-turn projection may say `running`; that is not another AHP terminal
  state. Observation failure is an HTTP error, not a turn outcome.
- A lost connection or response cannot justify success, failure, cancellation,
  or automatic resubmission. Reconcile with host state before further writes.
- A known input/approval block must be visible. The MVP does not pretend to
  answer unsupported prompts or silently grant tool permissions.
- Durable execution records and automatic recovery are not promised.

## 4. Authentication bridge, not identity system

- Inbound API authentication, authorization, TLS, and network protection belong
  to the external gateway. ahplex is not a public unprotected endpoint or
  sandbox.
- Host transport credentials and provider resource authentication remain
  necessary. They are distinct from inbound access control.
- Host adapters discover requirements; configured authentication adapters supply
  credentials, run known login commands, or expose caller-facing interaction.
- One active login attempt per host. Bind it to the configured provider/resource
  and relevant connection; no global login or implicit cross-host token sharing.
- Caller-facing link/code/input steps are not evidence of success. Verify the
  target authentication; expire and clean up unfinished attempts.
- Do not copy ambient editor, OS, or CLI credentials. Use only explicit
  provisioning. Never return tokens or raw login output as status, or log
  sensitive input.
- API callers cannot register commands, plugin modules, endpoints, or OAuth
  clients.

## 5. Minimal public contract

- Expose only operations needed to select/prepare a host, authenticate, discover
  or create Sessions/Chats, and submit/read/cancel Turns.
- Return native resource identities at creation; omit request echoes and
  internal metadata. Polling is sufficient; no independent job/flow management
  API.
- Reads do not start hosts or authentication. Read authoritative host state when
  connected; do not silently present an unavailable catalogue as an empty list.
- Keep error codes actionable and distinguish upstream authentication from
  authentication to the HTTP service.
- Minimize concepts, not correctness: ownership checks, validation, exact
  correlation, and explicit error reporting are not optional.

## 6. Implementation boundary

- Use the official `@microsoft/agent-host-protocol` SDK. Do not launch ahpc as
  an internal server, copy its application layer, or rewrite its private source.
- Keep one ESM TypeScript package with separate internal Host/auth adapters. New
  host adapters must implement lifecycle ownership, not just connectivity.
- VS Code Agent Host is the initial integration. AHPD/ACP translation may be
  supplied by a later host adapter; ahplex does not implement ACP translation.
- No Web UI, public plugin SDK, monorepo, project manager, or independent
  scheduler is required for this MVP.
- `serve` validates file/stdin config and explicit overrides before starting
  resources. No standalone validation command is necessary.
