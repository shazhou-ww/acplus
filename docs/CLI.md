# MVP CLI design

Status: implemented CLI contract. The CLI starts the service or acts as a thin
client of the [AHP-native HTTP API](API.md). The
[MVP requirements](REQUIREMENTS.md) define its scope.

## Service entry point

```text
ahplex serve --config <file|-> [--listen-host <address>] [--port <n>] [--instance <id>] [--data-dir <path>]
ahplex --help
ahplex --version
```

There is no standalone `validate` command. `serve` reads and validates
configuration on every startup; invalid configuration reports the field/reason
and exits with code 2 before listening, spawning hosts, or starting
authentication. Internal validation remains reusable without adding another
user-facing command.

`--config` is required: one UTF-8 JSON file, or `-` to read one document from
stdin through EOF. No implicit search path or multi-file merge. EOF completes
configuration input; it does not stop the running service.

### Overrides and paths

| Flag                      | Replaces      | Constraint                     |
| ------------------------- | ------------- | ------------------------------ |
| `--listen-host <address>` | `listen.host` | Non-empty bind address         |
| `--port <n>`              | `listen.port` | Integer 0-65535; 0 is explicit |
| `--instance <id>`         | `instance`    | Configuration identifier rules |
| `--data-dir <path>`       | `dataDir`     | Non-empty filesystem path      |

Only explicitly provided flags replace source values. Unknown/repeated flags
fail; parser defaults never replace config. No generic `--set`, array merging,
host/plugin/credential overrides, or source-file rewrites.

The source must pass structural validation. Apply overrides in memory, resolve
paths/plugins, and validate the effective configuration and adapter semantics
before startup. Trusted plugin modules may execute while loading their schemas;
validation does not run login commands, read secret contents, or connect hosts.

- File-relative paths use the configuration file's directory.
- Stdin-relative paths use the invocation working directory captured at startup.
- A CLI `--data-dir` path always uses the invocation working directory.
- The data-root override relocates derived `hosts\<hostId>` directories, not
  explicit plugin/executable/credential paths or session working directories.
- Empty, malformed, or multiple JSON documents fail explicitly. Stdin is
  consumed once, not reused for interactive service login.
- SIGINT/SIGTERM stop admission and clean up all service-owned host processes
  and resources. Unrelated processes are never adopted or terminated.

## HTTP client commands

Every client command accepts `--url <base-url>`, including `/v1`, or explicitly
configured `AHPLEX_URL`. No implicit localhost target. `--json` emits the API
body without adding fields; bodyless successes emit no JSON. Human-readable
summaries must distinguish acceptance from completion. Diagnostics go to stderr.

```text
ahplex health
ahplex hosts list
ahplex hosts start --host <hostId>
ahplex hosts stop --host <hostId>
ahplex sessions list --host <hostId>
ahplex sessions create --host <hostId> --provider <id> --working-directory <file-uri>
ahplex chats list --host <hostId> --session <session-uri>
ahplex chats create --host <hostId> --session <session-uri>
ahplex turns start --host <hostId> --chat <chat-uri> --turn <turnId> --text-file <file|->
ahplex turns get --host <hostId> --chat <chat-uri> --turn <turnId>
ahplex turns cancel --host <hostId> --chat <chat-uri> --turn <turnId>
ahplex auth begin --host <hostId> --method <methodId>
ahplex auth get --host <hostId>
ahplex auth input --host <hostId> --step <stepId> --input-file <file|->
```

Commands map one-to-one to HTTP operations. No Task commands, queue,
`hosts get`, `sessions get`, separate connect/disconnect, long-poll wrapper,
auth-flow history, authentication cancel, or global login/logout.

- Host selection is explicit for every resource operation. Session/Chat
  arguments are native AHP URIs; the CLI URL-encodes them when used as query
  values. Turn IDs are scoped to that host and chat. No service-generated alias
  or default-host routing.
- The caller generates a fresh turn ID before submission, using a UUID for
  example. The exact same ID is sent in AHP and used for
  observation/cancellation. A lost HTTP response must not trigger automatic
  resubmission.
- `chats create` creates an ordinary chat only when multipleChats is supported.
  `chats list` exposes defaultChat separately from origin and interactivity. The
  CLI never silently selects the first chat.
- A busy Chat returns a conflict. The CLI has no queue or automatic retry.
- Working directories are host-side file URIs, not automatically converted local
  paths. `--working-directory` becomes the sole item in the HTTP/AHP
  `workingDirectories` array. Prompt files contain UTF-8 text; `-` means stdin.
- Auth input is a UTF-8 JSON field-value map matching the current input step.
  The CLI adds `stepId` to the request. Treat all values as sensitive; never put
  tokens in flags or echo inputs.
- One active authentication attempt per host; callers coordinate login and poll
  its current status. The selected method already identifies provider/resource.
- Do not automatically retry writes or open a browser on the service machine.
  The caller polls ordinary GET endpoints and handles links on the user's
  device.
- Gateway-specific login is outside this CLI. Deployments use their own proxy/
  transport integration or another HTTP client when gateway credentials are
  needed.

Exit codes: 0 for a successful HTTP interaction (including 202 acceptance), 1
for transport/server errors, and 2 for invalid CLI input/configuration. Reading
a Turn whose state is `error` succeeds as a read; inspect its returned state. An
unavailable observation is an HTTP error, not a fabricated turn outcome.

## Examples

Commands for the current implementation:

```powershell
ahplex serve --config .\hosts.json
ahplex serve --config .\hosts.json --port 0 --data-dir .\state\test-run
Get-Content -Raw -Encoding UTF8 .\hosts.json | ahplex serve --config -
```

Piping a file does not preserve its directory as a path base. The producer must
emit UTF-8; older PowerShell versions may need UTF-8 `$OutputEncoding` for
non-ASCII JSON.

```powershell
$env:AHPLEX_URL = 'http://127.0.0.1:4280/v1'
ahplex hosts list --json
ahplex hosts start --host vscode-dev
ahplex hosts list --json
ahplex auth begin --host vscode-dev --method copilot-provisioned
ahplex auth get --host vscode-dev --json
ahplex sessions list --host vscode-dev --json
```

The former Task-based commands are not retained as compatibility aliases.
Interactive TUI, implicit chat/host selection, streaming, and standalone
validation are deferred until an actual use case requires them.
