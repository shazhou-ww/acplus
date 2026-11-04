# ahplex

A loopback-only HTTP session/task manager for **explicitly configured agent
services**. Services start on demand and each uses one long-lived ahpc bridge
connection. Provider accounts, model access, login and renewal belong to the
selected service/provider, not ahplex.

## Target architecture

[MVP requirements](docs/REQUIREMENTS.md) and
[design invariants](DESIGN-INVARIANTS.md) define a new, AHP-native design: a
single-package HTTP service that manages multiple owned hosts, bridges their
authentication, and exposes Sessions, Chats, and Turns. There is no separate
Task abstraction or service queue. All registered hosts are started and stopped
by ahplex; inbound access control belongs to an external gateway.

This is the target design, not the current feature set. The instructions below
describe the existing single-host implementation pending migration.

The target [HTTP API design](docs/API.md) includes an
[OpenAPI 3.1 contract](docs/openapi.yaml) and a generated
[HTML reference](docs/api.html). These versioned endpoints are a design draft,
not implemented routes.

Related target contracts cover the [CLI](docs/CLI.md),
[static Host configuration](docs/HOST-CONFIG.md), and
[internal Host/authentication extensions](docs/EXTENSIONS.md).

## Requirements and development

- Node.js >=22.13 and pnpm >=11.22.
- An actual supported service endpoint (see the capability matrix below).

```powershell
pnpm install
pnpm check
pnpm build
node .\dist\cli.js --help
node .\dist\cli.js --instance local --config .\services.json
# Installed package: ahplex --instance local --config .\services.json
```

Default HTTP address: `http://127.0.0.1:4280`; `--port 0` selects a free port.
Merely starting ahplex or declaring services does not start any backend.
`GET /health` reports the HTTP listener, **not backend readiness**.
`GET /services` lists configured IDs without starting them.

## Service configuration

The JSON schema is versioned and strict: unknown fields, duplicate
IDs/endpoints, unsupported bridge kinds and invalid launch/endpoint/lifecycle
combinations fail explicitly. Service IDs and `--instance` use 1–64 letters,
digits, `_` or `-`, starting with a letter/digit. Paths in launch context must
match the host OS.

Example `services.json` (replace the executable path and working directories).
This launches two independent schema-2 VS Code Agent Hosts, lazily:

```json
{
  "version": 1,
  "services": [
    {
      "id": "primary",
      "kind": "ahp-websocket",
      "lifecycle": "owned",
      "startupTimeoutMs": 60000,
      "endpoint": { "registry": true },
      "launch": {
        "executable": "C:\\Users\\you\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code-tunnel.exe",
        "args": [
          "--log",
          "off",
          "agent",
          "host",
          "--new-instance",
          "--foreground",
          "--host",
          "127.0.0.1",
          "--port",
          "0",
          "--user-data-dir",
          "{registryDirectory}\\user-data",
          "--server-data-dir",
          "{profileDirectory}\\server-data",
          "--connection-token-file",
          "{connectionTokenFile}"
        ],
        "cwd": "D:\\work\\primary",
        "environment": {
          "mode": "inherited",
          "inherit": [],
          "values": {}
        }
      }
    },
    {
      "id": "secondary",
      "kind": "ahp-websocket",
      "lifecycle": "owned",
      "startupTimeoutMs": 60000,
      "endpoint": { "registry": true },
      "launch": {
        "executable": "C:\\Users\\you\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code-tunnel.exe",
        "args": [
          "--log",
          "off",
          "agent",
          "host",
          "--new-instance",
          "--foreground",
          "--host",
          "127.0.0.1",
          "--port",
          "0",
          "--user-data-dir",
          "{registryDirectory}\\user-data",
          "--server-data-dir",
          "{profileDirectory}\\server-data",
          "--connection-token-file",
          "{connectionTokenFile}"
        ],
        "cwd": "D:\\work\\secondary",
        "environment": {
          "mode": "isolated",
          "inherit": [],
          "values": {}
        }
      }
    }
  ]
}
```

`launch.executable` and `launch.args` are passed to `spawn` without a shell;
argument boundaries, spaces and shell-looking text are preserved. Use a native
executable, not `code.cmd` or a shell command string. `cwd` is an explicit
absolute working directory. Arguments are service/provider inputs; ahplex does
not reinterpret provider flags. `startupTimeoutMs` is 1–300000 ms per startup
stage. Missing executables, early exits, unsupported registry entries, bridge
failure and readiness timeouts are failures, never successful service health.

Only these literal substitutions are supported in executable/arguments and
environment values:

- `{registryDirectory}`: a fresh private per-run directory; the launched service
  must write schema-2 endpoint entries under its `user-data` directory.
- `{profileDirectory}`: a persistent, service-specific profile directory.
- `{connectionTokenFile}`: ahplex's private generated **transport** token file.

The working directory is not substituted. Unknown brace placeholders fail
validation. Ahplex neither adds launcher flags to explicit configuration nor
chooses another executable, endpoint, account or profile as a fallback.

### Identity context

`environment.mode` is required:

- `inherited` preserves the calling account's HOME/USERPROFILE, APPDATA,
  LOCALAPPDATA, XDG config/data/cache and explicit VS Code CLI/server data
  variables. It does **not** copy token stores or guarantee this provider
  supports persistent native login.
- `isolated` sets those paths to the service's **persistent** profile. A fresh
  profile normally has no login; ahplex does not pretend otherwise. Shutdown
  never deletes this profile or its native identity data.

Both modes retain only basic executable/OS search context by default, not the
entire ambient environment. `environment.inherit` explicitly names additional
environment variables to pass; a missing named variable is an error.
`environment.values` sets explicit string overrides (including empty strings).
Use these for service-owned context, not a new ahplex authentication policy.
Keep secrets outside checked-in files and use approved native provisioning. The
bridge worker itself always has a restricted environment: editor IPC, ambient
provider tokens, `NODE_OPTIONS`, and ahpc wire-recording settings are not
implicitly inherited.

### Explicit attachment

An attached service has no `launch` and is never stopped by ahplex:

```json
{
  "version": 1,
  "services": [
    {
      "id": "external",
      "kind": "ahp-websocket",
      "lifecycle": "attached",
      "startupTimeoutMs": 60000,
      "endpoint": {
        "url": "ws://127.0.0.1:45678",
        "tokenEnv": "MY_SERVICE_CONNECTION_TOKEN"
      }
    }
  ]
}
```

Omit `tokenEnv` only when that endpoint needs no connection token. A configured
reference must resolve to a nonempty environment variable; its value is not
stored in configuration. URLs must be explicit loopback WebSocket root
endpoints, without URL credentials, query or fragment. No editor registry,
arbitrary signed-in Host discovery or credential transfer occurs. Access
exclusivity and native service authorization are the operator's responsibility.
Authentication performed by another AHP client is not necessarily shared with
this connection.

### Actual supported protocols and authorization

| Service/transport                                                                         | Support                                                                              |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| AHP WebSocket compatible with `@softov/ahpc` 0.9.0 / `@microsoft/agent-host-protocol` 1.0 | Supported bridge protocol, configured as `ahp-websocket`                             |
| Owned VS Code standalone Host, private schema-2 TCP registry                              | Supported discovery contract; VS Code 1.144.1 was the original verified version      |
| Explicit existing loopback AHP WebSocket endpoint                                         | Supported attachment; never owned                                                    |
| Owned fixed URL, ACP/stdio, arbitrary executable protocols, OpenAI HTTP                   | Not supported; separate adapters would be needed                                     |
| `ahpd` executable                                                                         | Not required or launched; this package embeds ahpc's live AHP client and HTTP bridge |
| Interactive OAuth/device login, tool approvals or token acquisition relay                 | Not implemented by this HTTP bridge                                                  |

There is **no ahplex provider login prerequisite** or synthetic
`authentication: configured` flag. Operations reach the selected backend even
when ahplex has no provider token. Service health reports
`authentication: "backend"` (authorization delegated, **not proof of login**) or
`"required"` after an observed backend challenge. Transport readiness is not
successful authorized execution.

AHP may require a client to acquire a resource token and deliver it using
`authenticate`; `auth/required` and JSON-RPC `-32007` identify such
requirements. Tokens may be scoped to an AHP connection and expiry requires the
provider's native renewal flow. This bridge does not acquire tokens, drive
browsers or silently reuse an expired token. A persisted native provider context
is usable only if that provider actually honors it for this independently
started Host. An editor window being signed in proves nothing about a new Host.

Backend authentication failures return `backend_authentication_required` and
service health names the native authorization action. If the combination
requires unsupported client interaction, use its supported native client or
provision an explicitly supported service context; do not mine editor
credentials. Unknown backend messages are replaced with safe error codes.

`pnpm check` supplies automated contract evidence, **not** a real authorized
agent execution. A successful harmless real question, exact task correlation, an
independent unauthenticated/expired case and process/profile preservation are
external deployment checks. No authenticated execution is claimed here.

### Existing CLI options and compatibility

Without `--config`, `--instance NAME` declares a single lazy service with ID
`NAME`, using the native `code-tunnel.exe` on Windows (`code` elsewhere).
`--code-path` overrides that executable; `--host-url` instead explicitly
attaches. `AHPLEX_HOST_TOKEN` supplies the legacy connection token. The default
launcher uses `--new-instance --foreground`, a fresh private registry,
persistent service profile and **inherited identity context**, not a new
identity HOME.

Legacy optional `AHPLEX_AUTH_RESOURCE` + `AHPLEX_AUTH_TOKEN` still explicitly
deliver a caller-provisioned AHP credential, together, on connection; they are
never required before forwarding operations and are not an OAuth implementation.
Expired credentials are not automatically replayed on an authentication
challenge. Do not copy credentials from an editor. With `--config`, legacy
`--code-path`, `--host-url`, host/provider credential variables and programmatic
`startupTimeoutMs` are rejected rather than silently ignored.

`--data-dir` still changes the default `~/.ahplex` root. `--instance` now names
the hub namespace: locks, service profiles, private registries and bridges live
under `<root>/<instance>/services/<service-id>/`. Older data directories are not
automatically imported or deleted. `AHPLEX_API_TOKEN` remains optional local
HTTP access protection, distinct from provider authorization.

**HTTP migration:** all backend routes now require `/services/<id>` even in
single-service mode; unscoped backend requests fail `explicit_service_required`.
CLI startup means the HTTP listener is available, not that a service has
started. Old package/credential prefixes and old data roots are not
automatically read.

## HTTP API

All routes bind to loopback. Browser Origin headers and unexpected Host headers
are rejected, without CORS. When `AHPLEX_API_TOKEN` is configured, every route
requires its bearer Authorization header. Otherwise local native programs may
control the service. Known supplied secrets and credential-named properties are
redacted from responses; arbitrary secret text in prompts cannot be recognized
universally.

| Method   | Route                                              | Meaning                                                                     |
| -------- | -------------------------------------------------- | --------------------------------------------------------------------------- |
| GET      | `/health`                                          | Listener only; starts nothing                                               |
| GET      | `/services`                                        | Configured IDs; starts nothing                                              |
| GET      | `/services/:id/health`                             | Start/select service; actual bridge readiness and backend auth observations |
| GET      | `/services/:id/agents`                             | Backend providers/models                                                    |
| GET/POST | `/services/:id/sessions`                           | Catalogue or create `{provider, workingDirectory}`                          |
| POST     | `/services/:id/sessions/:sessionId/tasks`          | Submit `{text}`; 202 with taskId                                            |
| GET      | `/services/:id/tasks/:taskId`                      | That service's exact task                                                   |
| GET      | `/services/:id/tasks/:taskId/wait?timeoutMs=30000` | Bounded correlated wait                                                     |
| POST     | `/services/:id/tasks/:taskId/cancel`               | Request correlated cancellation                                             |

```powershell
$base = 'http://127.0.0.1:4280/services/primary'
Invoke-RestMethod "$base/health"
Invoke-RestMethod "$base/agents"
$session = Invoke-RestMethod "$base/sessions" -Method Post `
  -ContentType 'application/json' `
  -Body (@{ provider = 'copilotcli'; workingDirectory = 'D:\work\primary' } |
    ConvertTo-Json)
$id = [uri]::EscapeDataString($session.sessionId)
$task = Invoke-RestMethod "$base/sessions/$id/tasks" -Method Post `
  -ContentType 'application/json' `
  -Body (@{ text = 'Reply with a short greeting. Do not change any files.' } |
    ConvertTo-Json)
Invoke-RestMethod "$base/tasks/$($task.taskId)/wait?timeoutMs=30000"
```

Service startup is deduplicated across concurrent requests. Different services
have different locks, bridges, task managers and sessions, even if opaque
backend session IDs coincide. Failed starts are latched until hub restart: no
retry storm or silent fallback. A service ID is always part of a resource's
identity; use the same service prefix for creation, submission, polling and
cancellation. URL-encode opaque session IDs, which are commonly provider URIs.

Sessions created empty remain known even before appearing in the backend
catalogue; `hostVisible` means catalogue visibility, not success. Tasks are
`queued`, `running`, `completed`, `failed` or `cancelled`; submissions serialize
per session and can run concurrently in different sessions. Completion requires
the caller-assigned exact `turnId` in the exact session history, never idle
state or an unrelated turn. A terminal wait returns HTTP 200 with the actual
task status; a failed task is **not** a successful result. Timeout returns HTTP
408 with `{task,timedOut:true}` and leaves work intact. Wait limits are 0–120000
ms; disconnecting a waiter leaves the task intact.

Queued cancellation is local. Running cancellation is confirmed only by that
turn's history; racing completion may win. Cancellation never targets another
turn. Permission/input pauses stay running: no automatic tool approval or
permission-answering API is implemented. Unsupported backend operations fail
explicitly. Authentication requirements, connection loss, cancellation and
failed turns remain distinct; an owned process exit fails pending tasks with an
explicit `*_outcome_unknown`, not a fabricated answer or rollback claim.

## Shutdown, recovery and limits

Ctrl+C/SIGTERM closes outstanding waits, terminates only this invocation's owned
service/bridge process trees, removes generated transport tokens and releases
locks. Windows termination uses exact owned PIDs, never process names.
Attachments and unrelated editor/agent processes remain running. Native profile
directories are persistent and never removed. Shutdown is idempotent; cleanup
failure is reported and retains ownership locks to prevent unsafe reuse.

Task tracking is in memory (maximum 10000 tasks per service); restarting loses
task IDs and known empty sessions, not native service data. Prompts/results are
not journaled by ahplex. Recover the backend catalogue explicitly and never
blindly resubmit lost work. After an unclean kill, inspect the recorded PID and
associated owned processes before manually removing stale locks/tokens. Never
kill all Code, node or agent processes.

**This is not an OS sandbox.** Providers/tools retain the OS account's
filesystem, network and credential-store privileges. Environment/profile
separation is not protection against a malicious provider. Use a dedicated OS
account, container or VM when stronger isolation is needed.

## Compatibility and template lineage

`@softov/ahpc` 0.9.0 is the sole runtime dependency. A fail-closed in-memory
Node ESM hook, only inside the owned bridge worker, corrects three directory URI
conversions, supplies caller-assigned turn IDs and guards cancellation by ID. It
never changes `node_modules`; unexpected source markers fail startup.
Review/remove this shim when upstream supports the hooks.

Derived with `git-lineage` from `preset-npm-package` main, preserving history:
source `6c693e8c8aa178224439e86ee2b904995c97bfb2`, birth
`d74a661c6955cef5907624eb8ba130a646217174`. The origin is
`https://github.com/shazhou-ww/ahplex.git`; `.git-lineage.yaml` records the
parent.

Strict ESM/TypeScript, exports/files boundaries, ESLint, Prettier, Vitest/V8 90%
coverage thresholds, build, publint, CI and Trusted Publishing remain in place.
The package is configured for public npm publication; releases still require an
intentional version-tag push. This work does not publish npm or tag releases.

### Trusted Publishing configuration

For npm package `ahplex`, configure the GitHub Actions Trusted Publisher:

- Organization/user: `shazhou-ww`
- Repository: `ahplex`
- Workflow filename: `publish-npm.yaml`
- Environment: `npm`

The existing [publish workflow](.github/workflows/publish-npm.yaml) uses OIDC;
do not introduce a long-lived npm token. The `private` safeguard has been
removed for `ahplex@0.1.0`. This change does not publish the package: a matching
release tag must be explicitly pushed to trigger publication.

## Silvermoon

Repository ideas use Silvermoon v2 under [`.silvermoon/`](./.silvermoon/), with
primary `https://github.com/shazhou-ww/ahplex.git`, branch `main`, and content
language English (`en-US`). Install Silvermoon globally and register its
canonical personal skill; never add a project dependency or local skill copy.

```powershell
npm install --global silvermoon
silvermoon-link-skill
silvermoon whats-next --audience agent
silvermoon list-ideas --audience agent
silvermoon create-idea --audience agent
```

Continue a selected idea using an explicit ULID or alias. Validate with
`silvermoon check --worktree --audience agent` before staging and
`silvermoon check --staged --audience agent` before committing. Acceptance
targets the exact submitted revision synchronized to primary.

## License

MIT. ahpc is an MIT-licensed external dependency.
