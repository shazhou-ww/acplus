# acplus CLI

One package provides `acplus` (Human) and `acplus-ai` (Agent), backed by the
same execution core, configuration, durable history and local service. Checkout
entries are `node .\dist\cli.js` and `node .\dist\cli-ai.js`. ACP is the Agent
protocol, not the CLI name. Both entries use HTTP `/v2` and stable ACP wire v1.
No legacy `hosts`, `chats`, or `/v1` compatibility.

## Agent CLI: complete non-interactive contract

`acplus-ai --help` lists every command and option with output, exit and recovery
semantics; focused `COMMAND --help` remains available. No positional operands,
implicit latest target, Session prefixes or public foreground `serve` command.
The Human entry manages persistent foreground services. `_auto-serve` remains
internal to the shared automatic-service mechanism and absent from both helps.

```text
acplus-ai init --agent ID --agent-command PATH [--config FILE --profile PATH --login-account LOGIN --data-dir PATH --port N]
acplus-ai health
acplus-ai agent-list
acplus-ai agent-auth --agent ID [--confirm-storage yes|no]
acplus-ai agent-login --agent ID [--login-account GITHUB-LOGIN --method METHOD --wait-ms N --idle-grace-ms N]
acplus-ai agent-auth-input --agent ID --input-file FILE
acplus-ai agent-logout --agent ID
acplus-ai session-list [--agent ID --limit N --cursor CURSOR]
acplus-ai session-create --agent ID --working-directory PATH [--name NAME --idle-grace-ms N]
acplus-ai session-get --session UUID
acplus-ai session-send --session UUID --turn UUID (--text TEXT | --text-file FILE) [--wait-ms N --idle-grace-ms N]
acplus-ai session-delete --session UUID --yes [--idle-grace-ms N]
acplus-ai turn-list --session UUID [--limit N --cursor CURSOR]
acplus-ai turn-start --session UUID --turn UUID (--text TEXT | --text-file FILE) [--idle-grace-ms N]
acplus-ai turn-get --session UUID --turn UUID
acplus-ai turn-cancel --session UUID --turn UUID
acplus-ai event-list --session UUID [--turn UUID --after N --limit N]
```

All commands except `init` accept `--config FILE`, `--data-dir PATH`,
`--url BASE/v2`, and optional redundant `--json`; `init` accepts its listed
options plus `--json`. `--url` overrides `ACPLUS_URL` and never falls back to
local startup. Defaults and HTTP `/v2` response shapes match the Human entry.
List pagination uses `limit` 1..1000 (default 100), opaque `nextCursor` passed
as `--cursor`; event pagination uses nonnegative `--after` (default 0) and
returned `nextAfter`, with Session-wide sequences. A null cursor ends paging.

All Session and Turn selectors must be full lowercase UUIDs. Both `session-send`
and `turn-start` require caller-allocated `--turn UUID` before admission. They
submit once; no write retry. Default `session-send` and `agent-login` return
immediately with admission/current flow. Only these two commands accept
`--wait-ms` (100..86400000); the Human `--no-wait`/`--timeout-ms` spelling is
not part of the AI contract. `turn-start` always returns admission.

AI never reads stdin, creates readline, prompts or opens UI, including on TTY.
`--text-file -`, `--input-file -` and `--config -` fail before side effects.
Deletion requires `--yes`; authentication storage consent is never implied.
`agent-login` returns the operation ID/state and public step when available. On
pending/action_required, use `acplus-ai agent-auth --agent ID` with the same
service options, complete browser work externally, then submit the exact
requested JSON step via `agent-auth-input` or explicit storage consent via
`agent-auth --confirm-storage yes|no`. Do not start a replacement login flow.

On Linux, `agent-login --login-account YOUR-GITHUB-LOGIN` explicitly selects
verified native Copilot device login in the existing profile, even without a
configured authentication adapter. The value is an expected GitHub username, not
a credential; omit `--method` or use `native-login`. Configuration and profile
identity are not rewritten. Bootstrap failures refer to the AI command, and
stale evidence alone is not a request to log in again.

Stdout contains one JSON result, including `null` for acknowledgement-only
responses. Stderr contains independently parseable JSON Lines:
`{event:"turn_submitting",sessionId,turnId}` before Turn dispatch,
`{error:{code,message}}` on failure, and
`{event:"runtime_warning",name,message}` for Node runtime warnings. No progress
text/ANSI is mixed in. `--help`/`-h` and `--version`/`-V` are text exceptions.
Interrupted processes need not produce final JSON.

Exit codes: 0 successful observation/admission; 1 operation failure, login
failed/expired, wait timeout or non-complete terminal Turn; 2 invalid input. An
observation of `error` or `unknown` via `turn-get` is still exit 0. Explicit
waiting returns terminal Turn `complete` (0) or `cancelled`/`error`/`unknown`
(1). Timeout or disconnect stops waiting, not execution; cancellation requires
`acplus-ai turn-cancel --session UUID --turn UUID`. After ambiguous admission,
preserve the stderr receipt and reconcile through `acplus-ai turn-get` using the
original ID/text. Never generate a new ID as an automatic retry; `unknown` is
not completed, failed or safe-to-retry.

## Human CLI: compatible grouped commands

```text
acplus --help
acplus --version
acplus serve [--config FILE] [--port N --listen-host ADDRESS --data-dir PATH]
acplus init --agent ID --agent-command PATH [--config FILE --profile PATH --login-account LOGIN --data-dir PATH --port N]
acplus health --url BASE/v2
acplus agents list|auth|login|auth-input|logout [--agent ID --method ID --input-file FILE|-]
acplus agents auth --agent ID [--confirm-storage yes|no]
acplus agents login --agent ID [--login-account GITHUB-LOGIN --method METHOD --no-wait --timeout-ms N]
acplus agents logout --agent ID
acplus sessions list|create|get [--agent ID --session UUID --working-directory PATH --name NAME]
acplus sessions send SESSION "MESSAGE" [--turn UUID --no-wait --timeout-ms N]
acplus sessions delete SESSION [--yes]
acplus turns list|start|get|cancel --session SESSION [--turn UUID --text TEXT --text-file FILE|-]
acplus events list --session UUID [--turn UUID --after N --limit N]
```

## Conversation and output

```powershell
acplus sessions create --agent copilot --working-directory 'D:\Code\ahplex' --name "Project review"
acplus sessions send SESSION "Explain this project. Do not change files."
acplus sessions send SESSION "Explain the entry point in more detail."
acplus sessions delete SESSION
```

Replace SESSION with the returned UUID or a unique prefix of at least eight
characters. Prefixes are resolved against the selected local data directory or
remote service, across all pages; ambiguous selectors fail rather than choosing
the latest or first Session. Optional `sessions create --name NAME` supplies a
nonblank display name, shown in list/get output and JSON `name`. Duplicate names
are allowed and names are never selectors; send/get/delete still require UUIDs
or unique prefixes. Unnamed Sessions omit the optional field and existing
history remains readable without migration. Interactive chat is not added.

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
and the Agent profile to `~/.acplus/<ID>-profile` (`copilot-profile` for ID
`copilot`). The Agent ID is required, not inferred or defaulted; it becomes the
generated `id` and initial `label`. IDs are 1..64 ASCII letters, digits,
underscores or hyphens, starting with a letter or digit. Existing configs are
not renamed; use their existing IDs when creating Sessions. All three explicit
flags override their defaults independently. `init` does not select a workspace:
each Session supplies an existing `--working-directory` at creation. Relative
CLI paths are also accepted and resolve against the invoking shell's current
directory, not the config file or background service directory. The CLI sends
the resulting absolute path even with an explicit remote URL; that path must
exist on the server. The HTTP API itself still requires an absolute host
directory. `--workspace` is not accepted. `serve` without `--config` reads the
fixed home path; it never scans the current directory or migrates an old config.
`--config -` reads YAML from stdin. It does not install software, launch an
Agent, log in, query a credential store, or send a paid probe. Provide an
existing executable, and select a private data root/profile outside future
Session work directories. Existing files and symlinks are not overwritten.

```bash
acplus init --agent copilot --agent-command "$(command -v copilot)" \
  --data-dir /srv/acplus/state \
  --profile /srv/acplus/credentials/copilot --login-account YOUR-LOGIN \
  --config /srv/acplus/config.yaml --port 4280
acplus serve --config /srv/acplus/config.yaml
```

Provision only when needed:

```bash
# First-time Copilot login on Linux when init omitted --login-account:
acplus agents login --agent copilot --login-account YOUR-GITHUB-LOGIN
# Otherwise, use the configured adapter or supported Agent method:
acplus agents login --agent copilot
acplus agents auth --agent copilot
```

`YOUR-GITHUB-LOGIN` is the account you expect to authorize in the browser, not
your OS username, Agent ID, token or password. `login --login-account`
explicitly selects the Linux native Copilot adapter for this operation in the
existing selected profile; no need to re-run init or edit YAML. It does not
change config, profile paths or existing Session bindings. Do not combine it
with an Agent RPC method such as `--method copilot-login`; omit method or
specify `native-login`. The receipt must match the expected account before
success is recorded.

An unconfigured fresh Copilot profile may advertise `copilot-login` while its
ACP authenticate RPC returns `agent_auth_required` without a device URL. This is
a bootstrap failure, not instructions to repeat that same RPC. The CLI reports
`auth_bootstrap_required` with the native command above. There is no automatic
credential copying, browser authorization, storage consent or native fallback.

Login starts one explicit expiring flow and, by default, waits for public device
URL/code, a storage-consent step or a terminal result. It prints the browser
action and the exact follow-up command, rather than only pending metadata. Open
the shown URL, enter the device code, then run `agents auth` with the same Agent
and service-selection options. A terminal login failure or expiry returns
nonzero. `--no-wait` returns the initial flow immediately; `--timeout-ms` bounds
instruction waiting (default 300000 ms, range 100..86400000). A timeout stops
waiting, not the login flow; inspect `agents auth` instead of starting another
login.

`--method` is optional: the service chooses its configured Copilot native
adapter when supported on that host, otherwise the sole advertised Agent-driven
method. No method is inferred from the Agent ID. If several choices exist, the
flow fails with their IDs so the caller can explicitly select `--method`.
Unsupported terminal methods are not sent as ACP authentication RPCs.
Initialization may start the Agent but does not execute a model prompt.

`agents auth` displays last-observed status, evidence freshness, available
methods and the current actionable flow. Historical success is not a live
login/billing check. `agents logout` waits for the Agent's supported logout
adapter to confirm success and states that history/projects are unchanged;
unsupported logout is a clear error, never a fake local logout or credential
wipe.

If a storage-consent step appears, choose yes only if you accept plaintext
credential storage, otherwise no:

```bash
acplus agents auth --agent copilot --confirm-storage yes
# Or explicitly decline:
acplus agents auth --agent copilot --confirm-storage no
acplus agents auth --agent copilot
```

Complete the browser step first, then answer a displayed storage-consent step,
then inspect status again until it says `succeeded` (or an explicit failure).
Never re-run login merely because auth reports stale/unknown after an idle
service restart: those are cached-observation states, not a credential check. An
authorized profile can still serve subsequent execution.

Human follow-up commands include the original explicit `--config`, `--data-dir`
or URL, so copying a suggested command continues the same flow rather than
silently switching to the home default. JSON output remains the API flow/
observation and does not include CLI-only continuation metadata.

Do not send tokens/passwords to this endpoint or put them in command history.
The CLI fetches the exact currently active step before submitting consent and
requires the real existing service owner. A missing/changed step fails without
starting a new flow. Low-level `agents auth-input --input-file FILE|-` remains
available for automation with an explicit step ID, but ordinary use needs no
JSON. Copilot native terminal login currently requires Linux util-linux
`script`. Configured saved credentials can serve ordinary execution without
repeated human login. Cached success remains an observation, not perpetual
validity.

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
