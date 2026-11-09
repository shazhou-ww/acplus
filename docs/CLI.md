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
acplus turns list|start|get|cancel --session UUID [--turn UUID --text-file FILE|-]
acplus events list --session UUID [--turn UUID --after N --limit N]
```

Explicit `--url BASE/v2` or `ACPLUS_URL` always selects HTTP, even on loopback.
It never enables fallback startup. With neither, Sessions/Turns list/get and
events list read committed SQLite directly; sessions create and turns start
discover/start a private background service; turns cancel requires its live
owner and never starts a replacement. Agents and health still require a URL.
Unknown/repeated/incomplete/irrelevant options fail before an HTTP request.
Output is JSON except offline help/version and the service's startup URL. Exit
codes: 0 for successful observations/interactions, 1 for operation/HTTP errors,
2 for invalid CLI/config input. Reading an `error` or `unknown` Turn is still a
successful observation, not a command-level execution success.

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

For local sessions create/turns start, `--idle-grace-ms N` selects the grace of
a newly launched service, default **30000 ms**, range **100..86400000**. It does
not change an existing service. The service uses an ephemeral loopback port and
one canonical-data-directory writer; first callers can race safely. Startup
readiness is bounded to 15 seconds, with explicit startup/ownership/ discovery
errors. Native detached startup works on Windows and Linux, independent of
caller lifetime. Private owner-only discovery and HMAC proof/signatures prevent
trusting a PID or arbitrary port listener.

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
  --session SESSION-UUID --turn CALLER-TURN-UUID --text-file prompt.txt
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
acplus agents login --agent copilot --method native-login \
  --url http://127.0.0.1:4280/v2
acplus agents auth --agent copilot --url http://127.0.0.1:4280/v2
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

Create a local Session and execute:

```bash
acplus sessions create --agent copilot --working-directory /srv/work/project \
  --url http://127.0.0.1:4280/v2
printf '%s' 'Reply with exactly OK. Do not use tools.' |
  acplus turns start --session SESSION-UUID --turn CALLER-TURN-UUID \
    --text-file - --url http://127.0.0.1:4280/v2
acplus turns get --session SESSION-UUID --turn CALLER-TURN-UUID \
  --url http://127.0.0.1:4280/v2
acplus events list --session SESSION-UUID --turn CALLER-TURN-UUID \
  --after 0 --limit 100 --url http://127.0.0.1:4280/v2
```

Replace placeholders with actual local UUIDs; choose the Turn ID before sending
so an ambiguous HTTP response can be reconciled without replay. Reads and
Session creation never start the Agent. Event pagination uses Session-wide
sequences and optional exact Turn filtering; sparse filtered sequences are
normal. Cancellation targets the exact Session/Turn and waits for genuine
terminal evidence, not merely a sent cancel notification.

Use the [API contract](API.md) and [Agent configuration](AGENT-CONFIG.md) for
field semantics and deployment boundaries.
