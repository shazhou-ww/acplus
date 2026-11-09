# ACP CLI

The independent entry is initially `node dist/acp-cli.js`; after promotion the
same implementation is the normal `acplus` command. It uses HTTP `/v2` and
stable ACP wire v1. No legacy `hosts`, `chats`, or `/v1` compatibility.

```text
acplus --help
acplus --version
acplus serve [--config FILE] [--port N --listen-host ADDRESS --data-dir PATH]
acplus init --agent-command PATH --workspace PATH [--config FILE --profile PATH --login-account LOGIN --data-dir PATH --port N]
acplus health --url BASE/v2
acplus agents list|auth|login|auth-input|logout [--agent ID --method ID --input-file FILE|-]
acplus sessions list|create|get [--agent ID --session UUID --working-directory PATH]
acplus turns list|start|get|cancel --session UUID [--turn UUID --text-file FILE|-]
acplus events list --session UUID [--turn UUID --after N --limit N]
```

Client commands require `--url BASE/v2` or `ACPLUS_URL`; no implicit HTTP
target. Unknown/repeated/incomplete/irrelevant options fail before an HTTP
request. Output is JSON except offline help/version and the service's startup
URL. Exit codes: 0 for successful HTTP interactions, 1 for operation/HTTP
errors, 2 for invalid CLI/config input. Reading an `error` or `unknown` Turn is
still a successful observation, not a command-level execution success.

`init` exclusively writes YAML (0600 on Linux), defaulting to
`~/.acplus/acplus.yaml`. It creates only the default parent `~/.acplus` (0700 on
Linux); explicit custom parents must exist. Data defaults to `~/.acplus/state`
and the Copilot profile to `~/.acplus/copilot-profile`. All three explicit flags
override their defaults independently. `serve` without `--config` reads the
fixed home path; it never scans the current directory or migrates an old config.
`--config -` reads YAML from stdin. It does not install software, launch an
Agent, log in, query a credential store, or send a paid probe. Provide an
existing executable and workspace, and select a private data root/profile
outside the workspace. Existing files and symlinks are not overwritten.

```bash
acplus init --agent-command "$(command -v copilot)" \
  --workspace /srv/work/project --data-dir /srv/acplus/state \
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
