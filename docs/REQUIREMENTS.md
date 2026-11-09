# ACP HTTP service requirements

Status: implemented repository requirements for the direct ACP `/v2` entry, not
an npm release. See [API.md](API.md) and the [ACP design](ACP-DESIGN.md);
published legacy packages remain unchanged.

## Product

ahplex provides a standard HTTP interface for configured ACP Agents. It owns
their processes, starts them only for execution, and persistently records
Sessions and their content so read-only requests do not need a running Agent. It
is not an AHP host aggregator or a general task queue.

## Approved scope

- Direct ACP over owned stdio processes; Copilot CLI is the first integration.
- New `/v2` API and configuration schema 2; no `/v1` compatibility.
- Build and verify an independent entry in the same package before replacing the
  old entry; no compatibility shim or permanent dual-stack runtime.
- Session creation is local-only; first execution creates the backend Session.
- Persist user/Agent messages, tool calls/results, and execution observations.
- Exclude authentication secrets and raw login transcripts.
- All HTTP GET operations read local state without contacting an Agent.
- Operator-provisioned Agent credentials, not per-request client credentials.
- Explicit HTTP/CLI authentication bridging and separately cached sanitized
  observations; Agent profile credentials are not copied into Session records.

## Concepts

```text
Configured Agent -> local Session -> local Turn / ordered Events
```

| Concept | Meaning                                                                                |
| ------- | -------------------------------------------------------------------------------------- |
| Agent   | a statically configured executable/profile/policy, with an owned on-demand ACP runtime |
| Session | a durable local conversation identity, optionally bound to one opaque ACP Session ID   |
| Turn    | a caller-identified prompt execution with durable observations                         |
| Event   | a sequenced persisted message, tool, or state observation                              |

No synthetic Chat, AHP resource URI, Task/job model, or implicit replacement
Session. Local identities survive backend availability changes.

## Required journeys

### R1. Configure and provision an Agent

The operator supplies a native command/argument array, explicit dedicated
profile, allowed workspace roots, tool policy, and authentication mechanism.
Requests can select configured Agents/workspaces but cannot register commands,
profiles, environment overrides, MCP endpoints, or provider configurations.
Device login displays only the public link/code and explicit storage choice;
successful login is distinct from successful model execution.

Provide operator-protected explicit authentication routes. Follow advertised
agent-driven versus terminal flows, with tested native adapters where needed.
Keep sanitized method/result/time/expiry observations separate from credentials
and Session content. Authentication GETs are local; stale historical success
does not imply current validity or caller authorization. Restart/reconnection,
profile/account changes, logout, auth challenges, and known expiry invalidate
current evidence. Reuse saved credentials when possible without automatically
requesting human login or issuing hidden paid verification probes.

### R2. Create and discover local Sessions

Creating a Session validates its Agent and workspace, allocates a local ID, and
persists it without spawning an Agent. List/detail requests remain available
after service restart and with the Agent executable unavailable. Backend IDs
remain internal binding metadata rather than the HTTP resource identity.

### R3. Execute on demand

Durably admit a caller-identified Turn, then start/initialize the configured
Agent and create or restore the backend Session. Coalesce concurrent starts.
Initially allow one active prompt per configured Agent and one active Turn per
Session; reject busy submissions before dispatch rather than queueing them.
Different configured Agents can run independently.

### R4. Preserve and query content

Persist incoming content incrementally, maintaining message boundaries, tool
IDs/status patches, sequence order, and observation time. All GET endpoints use
local data; no live fallback, implicit synchronization, or startup. Expose
pagination, optional Turn filtering, and explicit history completeness/gaps.
Unfiltered event reads include Session-level events; a Turn filter returns only
that Session's matching Turn events, retaining their Session-wide sequence.
Known partial history is not an empty complete history or proof that execution
failed. Terminal status is visible only after preceding updates are durably
committed.

### R5. Continue after runtime restart

Retain local history independently of backend history. Restore the same backend
Session only through advertised ACP resume/load support, isolating replay from
new events. Missing capability or backend history returns an explicit error.
Never replay cached prompts or create a new Session as silent recovery.

### R6. Observe and cancel exact work

Queries and cancellation use exact local Session/Turn IDs. Duplicate IDs with
identical input do not dispatch again; changed input conflicts. A lost response,
process, transport, or service does not imply success/failure/cancellation.
Persist dispatch uncertainty and block conflicting work until reliable
reconciliation. Cancellation waits for genuine execution-ending evidence.

### R7. Manage callbacks and idle runtimes

Advertise only implemented ACP capabilities. Permission requests follow explicit
configured policy, defaulting to denial; unsupported interactions fail visibly.
Filesystem and terminal handlers enforce configured roots and limits. Idle
shutdown requires known quiescence, including tracked background work. Terminate
only owned processes and preserve uncertainty on interrupted execution.

## Deployment and migration boundary

- Keep one ESM TypeScript package, `src/index.ts` public exports, `test/` tests,
  `dist/` generated files, and the package exports/files shape.
- Use the official ACP SDK and the private `node:sqlite` store, with explicit
  schema checks and no external database dependency.
- One service owns its data root; separate configurations cannot share active
  Agent credential profiles.
- External gateways provide inbound authentication, authorization, and TLS.
  Workspace separation and tool policy are not OS sandboxing.
- Replace AHP/VS Code/AHPD dependencies and adapters only as part of the tested
  implementation cutover. This redesign does not change the running `/v1` code.
- Do not silently import old configuration, credential stores, AHP URIs, or
  histories. Any future import must be explicit and preserve provenance.

## Initial non-goals

Dual AHP/ACP execution, `/v1` compatibility, arbitrary backend registration,
task queues, automatic uncertain-work replay, exactly-once backend execution,
synthetic Chat/fork semantics, interactive permission/user-question UI, Web UI,
SSE, model pickers, and a public plugin ecosystem.

Caching is not backend context reconstruction. Durable admission is not a
promise to resume an interrupted job automatically. History persistence does not
prove backend availability or complete visibility into detached work.

## Acceptance

The measurable gates in [ACP-DESIGN.md](ACP-DESIGN.md#acceptance-gates) cover
zero-spawn local reads/creation, real execution, event persistence/pagination,
capability-gated continuation, cancellation, crash/storage failure, credential
redaction, and owned-process cleanup. Legacy AHP acceptance is historical and
cannot substitute for any ACP gate.
