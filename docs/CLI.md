# acplus CLI

The package and CLI command are named `acplus`; the checkout entry is
`node dist/cli.js`. ACP is the Agent protocol, not the CLI name. The CLI uses
HTTP `/v2` and stable ACP wire v1. No legacy `hosts`, `chats`, or `/v1`
compatibility.

```text
acplus --help
acplus --version
acplus serve [--config FILE] [--port N --listen-host ADDRESS --data-dir PATH]
acplus init --agent-command PATH [--config FILE --profile PATH --login-account LOGIN --data-dir PATH --port N]
acplus health --url BASE/v2
acplus agents list|auth|login|auth-input|logout [--agent ID --method ID --input-file FILE|-]
acplus sessions list|create|get [--agent ID --session UUID --working-directory PATH]
acplus sessions send SESSION "MESSAGE" [--turn UUID --no-wait --timeout-ms N]
acplus sessions delete SESSION [--yes]
acplus turns list|start|get|cancel --session SESSION [--turn UUID --text TEXT --text-file FILE|-]
acplus events list --session UUID [--turn UUID --after N --limit N]
```

## Conversation and output

```powershell
acplus sessions create --agent copilot --working-directory 'D:\Code\ahplex'
acplus sessions send SESSION "Explain this project. Do not change files."
acplus sessions send SESSION "Explain the entry point in more detail."
acplus sessions delete SESSION
```

Replace SESSION with the returned UUID or a unique prefix of at least eight
characters. Prefixes are resolved against the selected local data directory or
remote service, across all pages; ambiguous selectors fail rather than choosing
the latest or first Session. Session names and interactive chat are not added.

`sessions send` generates a Turn ID, submits once, waits, and prints the final
reply. The equivalent option form is
`sessions send --session SESSION --text "MESSAGE"`. Use `--text-file FILE|-`
instead for files or stdin; supplying both input forms fails. `turns start` also
accepts direct text and generates a Turn ID, but intentionally returns admission
without waiting. Explicit `--turn UUID` remains available for idempotent
automation.

Session/Turn IDs are printed to stderr before dispatch, including structured
`turn_submitting` JSON with `--json`. Keep that receipt: a failed/lost response
must be reconciled with `turns get` or retried with the same ID and exact text,
never a newly generated ID. The CLI does not silently retry admission.
`--no-wait` returns admission only. Waiting defaults to 300000 ms, configurable
with `--timeout-ms` (100..86400000). Timeout or Ctrl+C stops waiting, not the
Agent; use `turns cancel` to explicitly request cancellation. Waiting uses
committed local history or remote HTTP observations, not paid liveness probes.

All commands now default to human-readable output; **scripts must add
`--json`**. This intentionally changes the old default. JSON stdout remains a
single resource/page result, with progress and structured errors on stderr.
Version/help remain text. A waited send exits nonzero for
error/cancelled/unknown or a timeout; low-level `turns get` still succeeds when
observing a valid error/unknown record. Use `acplus sessions send --help`,
`acplus turns get --help`, etc. for focused usage instead of the entire command
catalogue.

`sessions delete` permanently removes only local Session/Turns/Events.
Interactive use requires typing `yes`; scripts must pass `--yes`. Projects,
credentials and Agent-owned backend history are not deleted. Active Agent work
or nonterminal/ unknown Turns block deletion; cancel and reconcile first.
Confirmation is not an automatic cancellation request. Deletion is not forensic
disk erasure and does not remove independent backups.

Explicit `--url BASE/v2` or `ACPLUS_URL` always selects HTTP, even on loopback.
It never enables fallback startup. With neither, Sessions/Turns list/get and
events list read committed SQLite directly; sessions create and turns start
discover/start a private background service; send/delete use the same writer.
Local Agent catalogue/auth/login/logout commands also discover/start that
service; auth input and cancellation require its existing owner, and health only
checks an existing service. None of these auth/status commands is an offline
database substitute or an implicit model execution.
Unknown/repeated/incomplete/irrelevant options fail before an HTTP request.
Output defaults to text, or JSON with `--json`. Exit codes: 0 for successful
observations/interactions, 1 for operation/HTTP errors, 2 for invalid CLI/config
input. Reading an `error` or `unknown` Turn is still a successful observation,
not a command-level execution success.

## Local service selection

Local sessions/turns/events commands accept `--config FILE` (default
`~/.acplus/acplus.yaml`) and `--data-dir PATH` (overrides YAML `dataDir`). Local
mode uses a config file, not `--config -`. No executable, credential read,
profile lease, writer lock or HTTP request is needed for a history query.
Storage must already exist with supported schema 2: missing/corrupt/unsupported
storage is an error, never fabricated empty history. All output, UUID/cursor/
integer validation, filters and pagination share the HTTP history helpers. Each
query sees a committed snapshot; successive commands/pages can differ. Stored
running/cancelling status is last-observed evidence, not liveness.

For local sessions create/send, turns start or agents login, `--idle-grace-ms N`
selects the grace of a newly launched service, default **30000 ms**, range
**100..86400000**. It does not change an existing service. The service uses an
ephemeral loopback port and one canonical-data-directory writer; first callers
can race safely. Startup readiness is bounded to 15 seconds, with explicit
startup/ownership/ discovery errors. Native detached startup works on Windows
and Linux, independent of caller lifetime. Windows discovery/account/ACL helper
processes run with hidden windows, as do the background service and Agent.
Private owner-only discovery and HMAC proof/signatures prevent trusting a PID or
arbitrary port listener.

Automatic idle shutdown stops admission before draining accepted requests. No
pending prompt, authentication flow, observed/ambiguous Agent background work or
request is interrupted by the grace timer. Durable terminal events precede idle
cleanup, Agent shutdown and data/profile ownership release. Requests rejected
during shutdown fail explicitly; a lost write response is ambiguous, not an
invitation to silently replay. Reconcile committed history; retry Turn admission
only with the original caller-selected ID/text.

Offline reads neither keep a service alive nor reconcile interrupted execution.
Normal idle expiry permits fresh automatic startup and supported ACP
load/resume. Unknown results are retained and history is never replayed as a new
prompt. Abrupt-crash/foreign ownership files are not removed based on process
IDs: resolve that explicit ownership failure separately. Explicit `serve` stays
persistent, including when local commands reuse its loopback listener.

```bash
unset ACPLUS_URL
acplus sessions create --config /srv/acplus/config.yaml \
  --idle-grace-ms 1500 --agent copilot --working-directory /srv/work/project
acplus turns start --config /srv/acplus/config.yaml \
  --session SESSION-UUID --text-file prompt.txt
acplus turns get --config /srv/acplus/config.yaml \
  --session SESSION-UUID --turn CALLER-TURN-UUID
acplus events list --config /srv/acplus/config.yaml \
  --session SESSION-UUID --turn CALLER-TURN-UUID --after 0 --limit 100
```

Keep data, config and profile paths private and outside the workspace. An
explicit URL takes precedence over all local-selection options. The managed
`service.json`/identity endpoint/request signature protocol is internal, not a
supported SDK/API facade; use explicit `serve` for ordinary HTTP/auth clients.

`init` exclusively writes YAML (0600 on Linux), defaulting to
`~/.acplus/acplus.yaml`. It creates only the default parent `~/.acplus` (0700 on
Linux); explicit custom parents must exist. Data defaults to `~/.acplus/state`
and the Copilot profile to `~/.acplus/copilot-profile`. All three explicit flags
override their defaults independently. `init` does not select a workspace: each
Session supplies an existing absolute `--working-directory` at creation.
`--workspace` is not accepted. `serve` without `--config` reads the fixed home
path; it never scans the current directory or migrates an old config.
`--config -` reads YAML from stdin. It does not install software, launch an
Agent, log in, query a credential store, or send a paid probe. Provide an
existing executable, and select a private data root/profile outside future
Session work directories. Existing files and symlinks are not overwritten.

```bash
acplus init --agent-command "$(command -v copilot)" \
  --data-dir /srv/acplus/state \
  --profile /srv/acplus/credentials/copilot --login-account YOUR-LOGIN \
  --config /srv/acplus/config.yaml --port 4280
acplus serve --config /srv/acplus/config.yaml
```

Provision only when needed:

```bash
acplus agents login --agent copilot --method native-login
acplus agents auth --agent copilot
```

Login starts an explicit expiring flow; inspect auth for the device URL/code,
then complete authorization in your browser. If a storage-consent step appears,
submit its exact step ID with only the allowed value:

```bash
printf '%s' '{"stepId":"COPY-EXACT-ID","values":{"confirmPlaintextStorage":"yes"}}' |
  acplus agents auth-input --agent copilot --input-file - \
    --url http://127.0.0.1:4280/v2
```

Do not send tokens/passwords to this endpoint or put them in command history.
Copilot native terminal login currently requires Linux util-linux `script`.
Configured saved credentials can serve ordinary execution without repeated human
login. Cached success remains an observation, not perpetual validity.

For automation, explicitly select JSON and an idempotency ID:

```bash
acplus sessions create --agent copilot --working-directory /srv/work/project \
  --json
printf '%s' 'Reply with exactly OK. Do not use tools.' |
  acplus turns start --session SESSION-UUID --turn CALLER-TURN-UUID \
    --text-file - --json
acplus turns get --session SESSION-UUID --turn CALLER-TURN-UUID \
  --json
acplus events list --session SESSION-UUID --turn CALLER-TURN-UUID \
  --after 0 --limit 100 --json
```

Explicit IDs are optional for ordinary sending; automatic callers may choose
their own before sending so an ambiguous response can be reconciled. Reads and
Session creation never start the Agent. Event pagination uses Session-wide
sequences and optional exact Turn filtering; sparse filtered sequences are
normal. Cancellation targets the exact Session/Turn and waits for genuine
terminal evidence, not merely a sent cancel notification.

Use the [API contract](API.md) and [Agent configuration](AGENT-CONFIG.md) for
field semantics and deployment boundaries.
