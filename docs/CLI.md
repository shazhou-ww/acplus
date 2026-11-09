# ACP CLI

The independent entry is initially `node dist/acp-cli.js`; after promotion the
same implementation is the normal `ahplex` command. It uses HTTP `/v2` and
stable ACP wire v1. No legacy `hosts`, `chats`, or `/v1` compatibility.

```text
ahplex --help
ahplex --version
ahplex serve --config FILE [--port N --listen-host ADDRESS --data-dir PATH]
ahplex init --agent-command PATH --workspace PATH [--config FILE --profile PATH --login-account LOGIN --data-dir PATH --port N]
ahplex health --url BASE/v2
ahplex agents list|auth|login|auth-input|logout [--agent ID --method ID --input-file FILE|-]
ahplex sessions list|create|get [--agent ID --session UUID --working-directory PATH]
ahplex turns list|start|get|cancel --session UUID [--turn UUID --text-file FILE|-]
ahplex events list --session UUID [--turn UUID --after N --limit N]
```

Client commands require `--url BASE/v2` or `AHPLEX_URL`; no implicit HTTP
target. Unknown/repeated/incomplete/irrelevant options fail before an HTTP
request. Output is JSON except offline help/version and the service's startup
URL. Exit codes: 0 for successful HTTP interactions, 1 for operation/HTTP
errors, 2 for invalid CLI/config input. Reading an `error` or `unknown` Turn is
still a successful observation, not a command-level execution success.

`init` exclusively creates a new config file (0600 on Linux) in an existing
parent directory. It does not install software, launch an Agent, log in, query a
credential store, or send a paid probe. Provide an existing executable and
workspace, and select a private data root/profile outside the workspace.
Existing files and symlinks are not overwritten.

```bash
ahplex init --agent-command "$(command -v copilot)" \
  --workspace /srv/work/project --data-dir /srv/ahplex/state \
  --profile /srv/ahplex/credentials/copilot --login-account YOUR-LOGIN \
  --config /srv/ahplex/config.json --port 4280
ahplex serve --config /srv/ahplex/config.json
```

Provision only when needed:

```bash
ahplex agents login --agent copilot --method native-login \
  --url http://127.0.0.1:4280/v2
ahplex agents auth --agent copilot --url http://127.0.0.1:4280/v2
```

Login starts an explicit expiring flow; inspect auth for the device URL/code,
then complete authorization in your browser. If a storage-consent step appears,
submit its exact step ID with only the allowed value:

```bash
printf '%s' '{"stepId":"COPY-EXACT-ID","values":{"confirmPlaintextStorage":"yes"}}' |
  ahplex agents auth-input --agent copilot --input-file - \
    --url http://127.0.0.1:4280/v2
```

Do not send tokens/passwords to this endpoint or put them in command history.
Copilot native terminal login currently requires Linux util-linux `script`.
Configured saved credentials can serve ordinary execution without repeated human
login. Cached success remains an observation, not perpetual validity.

Create a local Session and execute:

```bash
ahplex sessions create --agent copilot --working-directory /srv/work/project \
  --url http://127.0.0.1:4280/v2
printf '%s' 'Reply with exactly OK. Do not use tools.' |
  ahplex turns start --session SESSION-UUID --turn CALLER-TURN-UUID \
    --text-file - --url http://127.0.0.1:4280/v2
ahplex turns get --session SESSION-UUID --turn CALLER-TURN-UUID \
  --url http://127.0.0.1:4280/v2
ahplex events list --session SESSION-UUID --turn CALLER-TURN-UUID \
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
