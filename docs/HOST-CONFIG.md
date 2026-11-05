# Static host configuration design

Status: implemented configuration format.

This configuration serves the [AHP-native MVP requirements](REQUIREMENTS.md). It
registers processes and login mechanisms, not Sessions, Chats, or queued work.

The [JSON Schema](host-config.schema.json) defines the common shape. The
[example](hosts.example.json) contains no secrets and demonstrates two on-demand
VS Code hosts, each with its own derived data directory. Paths, installed
executables, and credential references must be adjusted before actual use.

## One source, one immutable registry

`ahplex serve --config <file|->` reads one complete UTF-8 JSON document from a
file, or from stdin when the source is `-`. The source defines the entire host
registry; there is no multiple-file merge or implicit configuration search:

- `schemaVersion` identifies the configuration format, not the package version.
- `instance`, `dataDir`, and `listen` describe this service instance.
- `plugins` declares optional trusted ESM extension modules to load.
- `hosts` is the complete registered host list. An empty list is valid.
- Unknown common fields, duplicate host/plugin/binding IDs, unresolved adapters,
  missing startup definitions, and invalid adapter options fail before service
  startup.
- No HTTP API mutates this source or registry. Runtime state and plugin
  temporary files are stored separately and do not rewrite configuration.

Only `serve` supports explicit overrides for `instance`, `dataDir`,
`listen.host`, and `listen.port` through `--instance`, `--data-dir`,
`--listen-host`, and `--port`. Explicit flags take precedence over source
values; omitted flags do not replace them with CLI defaults. There are no CLI
overrides for hosts, plugins, credentials, or authentication bindings.

There is no standalone validation command. `serve` validates configuration on
startup and reports invalid fields before starting resources.

The source must pass structural schema validation before overrides; the final
effective configuration must also pass structural and semantic validation before
startup. The same rule applies to stdin. Overrides are in-memory replacements of
individual scalar fields, not source-file edits or a general deep merge.

JSON Schema validates common structure. A semantic validation pass additionally
checks uniqueness, identifier resolution, startup compatibility, options
schemas, cross-field constraints, and authentication compatibility.

## Common host fields

| Field            | Meaning                                                          |
| ---------------- | ---------------------------------------------------------------- |
| `id`             | Stable ID used as API `hostId`; unique within this instance      |
| `label`          | Display name, never used for routing                             |
| `adapter`        | Registered HostAdapter ID, initially `vscode`                    |
| `startup`        | Required executable, extra arguments, environment, and cwd       |
| `lifecycle`      | Startup preparation, on-demand preparation, and startup deadline |
| `options`        | Host-adapter-specific options, validated by that adapter         |
| `authentication` | Explicit provider/resource bindings to authentication adapters   |

Every registered host is owned by ahplex and requires `startup`. There is no
`mode` or top-level `connection` field. The adapter discovers the endpoint of
the process it starts; configuration cannot register an independently operated
endpoint or adopt an unrelated process.

`prepareOnStartup: true` explicitly requests connection preparation at service
startup, including starting that host's process. Otherwise the host remains
idle. `onDemand: true` allows Session/Chat creation, Turn submission, and login
operations to prepare it later; GET operations never start a process. Both
fields are explicit; there is no unconditional default host startup.

On-demand startup coalesces concurrent requests for the same host. An unexpected
process exit does not automatically authorize a restart. Connection retry uses
the SDK's transport reconnect behavior; automatic process-restart policies and
idle shutdown are deferred.

## One service data root

The top-level `dataDir` is the runtime-data root for this service instance. The
core derives host-scoped directories from it:

```text
<dataDir>\
  hosts\
    vscode-dev\
    another-host\
```

Use it for instance ownership/lock information, service-owned temporary files,
and isolated data for hosts. Adapters receive their assigned directory through
`HostContext`; they do not require a separate host-level `dataDir`. The built-in
VS Code adapter's initial `options` is an empty object.

`dataDir` is not a Session's `workingDirectories`, a configuration-path base, or
a promise of durable execution storage. Turn state belongs to the Host; ahplex's
observations and login attempts are not a durable journal. Registered host data
and ahplex-owned temporary resources belong under this root; unrelated host
installations are never adopted or migrated.

For parallel services or tests, use a distinct root for each instance/run,
optionally with `--port 0`. One root cannot be owned by concurrent service
processes, even if their configured instance names differ. Changing `--data-dir`
also relocates all derived host directories without editing individual hosts.
This isolates service-owned runtime data, not agent working directories or
deployment-supplied credential files.

After shutdown, tests may remove their exact, explicitly owned temporary root
once process cleanup succeeds. Never automatically delete an arbitrary
configured directory or treat data-directory separation as an OS sandbox.

## Host startup

`startup.command` is an executable path or an executable name resolved on the
service PATH. It is not a shell command string.

The adapter constructs required host-specific arguments, including endpoint and
connection-token settings where needed. `startup.args` contains only additional
arguments; conflicting adapter-owned options fail validation, not
last-write-wins. No shell interpolation, executable expression, or
request-derived argument expansion is performed.

`startup.env` contains literal non-secret strings or explicit secret references.
Credential injection must not be inferred from unrelated editor, OS, or CLI
login state. By default, child processes receive only a documented operational
allowlist plus adapter-owned isolation settings and configured entries, not the
service's entire environment.

The `vscode` adapter isolates instance data, launches a new independent Host,
and discovers its endpoint. It uses the core-assigned `<dataDir>\hosts\<hostId>`
directory rather than an adapter-specific path option. It must not replace
another host or read an editor's endpoint registry.

Every additional host adapter must implement process startup, endpoint
discovery, readiness checks, and owned-process cleanup. Generic AHP transport
stays in the SDK; a connection-only adapter is not part of this design. Merely
spawning a command does not make it a ready AHP host.

## Paths and secret references

Relative filesystem paths inside a file source are resolved against that file's
directory. For stdin (`--config -`), the source base is the invocation working
directory captured at command startup. This applies to the service data
directory, plugin modules, credential files, startup cwd, and explicit
executable paths.

A relative `--data-dir` override resolves against the invocation working
directory, not the file source's directory. It changes the service root and all
derived host directories; it does not relocate explicit plugin modules, startup
cwd, executable paths, or credential references. Absolute paths stay absolute.
Opaque `args` strings and literal environment values are not rewritten as paths.

`serve` validates its effective configuration after applying overrides. Empty or
malformed stdin supplied to `serve --config -` fails explicitly; no implicit
file fallback is attempted.

Only explicit `env` and `file` secret references are initially defined:

```json
{ "source": "env", "name": "AHPLEX_DEMO_GITHUB_TOKEN" }
```

```json
{ "source": "file", "path": ".\\secrets\\host-token" }
```

An environment reference reads exactly the named variable; it does not search
for alternative tokens. A file reference reads a UTF-8 credential and removes
one trailing newline, not arbitrary whitespace. Missing or empty values fail the
operation requiring them. Structural config validation does not read secrets.

Do not put credential literals into command arguments, configuration, logs, or
ordinary status responses. Secret resolution is scoped to the requesting host
and binding; sharing the same reference across hosts is explicit deployment
configuration, not implicit credential distribution.

## Authentication bindings

Each binding specifies:

- `id`: stable host-local method identifier exposed as API `methodId`.
- `provider`: provider ID, or `$host` for connection-level authentication.
- `resource`: the exact target resource URI.
- `adapter`: registered AuthenticationAdapter ID.
- `options`: adapter-specific configuration.

`GET /hosts` exposes only each binding's method ID, provider, and resource, not
its adapter options or credentials. `POST /hosts/{hostId}/auth` selects it using
only `methodId`. The MVP permits one active authentication attempt per host;
multiple bindings do not imply parallel login workflows.

No positional fallback or global login is defined. Dynamic AHP metadata
discovers requirements, but a login method is available only when an appropriate
configured or built-in adapter can satisfy that target. Unmatched requirements
are reported with no usable method, not silently handled by an unrelated
provider.

The initial `ahp-token` adapter accepts an explicit credential reference and
pushes it to an advertised AHP resource. It does not initiate GitHub login. Host
connection credentials are transport credentials, not provider tokens. The host
adapter provisions or resolves them as part of startup and uses them when
opening its transport; they are not a separate endpoint-registration option and
do not use this AHP provider-token adapter.

The built-in GitHub Device Flow adapter can be configured as:

```json
{
  "id": "copilot-browser",
  "provider": "copilotcli",
  "resource": "https://api.github.com",
  "adapter": "github-device",
  "options": {
    "clientId": "deployment-provisioned-oauth-application-id",
    "scopes": ["read:user", "user:email"]
  }
}
```

This requires a deployment-provisioned OAuth application and verified
Copilot-compatible authorization. No client ID or existing login is inferred.
The snippet is not evidence that the deployment is authorized; the adapter owns
its options schema and accepted resources.

### Official GitHub CLI handoff

`github-cli` uses the official GitHub CLI OAuth application; deployments need
not register an application or supply a client ID. The following is a binding
template, **not a bundled launcher or an assertion of runtime isolation**:

```json
{
  "id": "github-login",
  "provider": "copilotcli",
  "resource": "https://api.github.com",
  "adapter": "github-cli",
  "options": {
    "command": ".\\launch-gh.exe",
    "args": [],
    "profileDir": "/opt/ahplex/profiles/copilot",
    "account": "YOUR-GITHUB-LOGIN",
    "mode": "login",
    "isolation": "dedicated-runtime"
  }
}
```

All six options are required; there are no ambient/default credentials.
`command` is an executable (never a shell command or `.cmd`/`.bat` shim), `args`
is its fixed prefix, and only the adapter appends known `gh auth` commands. API
callers cannot choose an executable, arguments, profile, account or OAuth
identity. File-relative command paths resolve against the config source; prefix
arguments are opaque.

**Unlike local filesystem options, `profileDir` is an absolute path in the
launcher's execution environment**, not a path for ahplex to open or rewrite.
For the Linux example it remains `/opt/ahplex/profiles/copilot` even when ahplex
runs on Windows. The launcher must set `GH_CONFIG_DIR` to exactly that path;
`gh auth status` must identify `<profileDir>/hosts.yml` as its credential
source. Another file, environment token or keyring source is rejected.

`isolation: "dedicated-runtime"` is an explicit deployment trust assertion, not
a sandbox created or proven by ahplex. Before enabling it:

- Provision a fresh, private profile in a dedicated execution environment; never
  point at an existing editor/gh/Copilot profile. Do not share it with another
  service instance or unrelated `gh` commands.
- Prevent OS keychain access. Windows `gh --insecure-storage` still reads and
  modifies global keychain entries; changing HOME/GH_CONFIG_DIR is insufficient.
  The adapter rejects direct native Windows `gh`/`gh.exe`. A trusted Windows
  launcher may enter a dedicated Linux runtime with no credential service.
- Clear ambient credentials, debug settings, browser and clipboard helpers in
  that runtime. The adapter itself passes only the operational allowlist,
  isolation paths, explicit `GH_CONFIG_DIR`, `GH_PROMPT_DISABLED=1`, disabled
  browser names, no-color settings and `DBUS_SESSION_BUS_ADDRESS=disabled:`. A
  cross-OS launcher must establish the equivalent environment (e.g. `env -i`),
  not reintroduce defaults.
- Forward only gh's stdout/stderr without writing raw output to logs. Keep the
  pipe non-interactive; do not open a browser. Return gh's exit status.
- Couple all foreign subprocesses to launcher lifetime. ahplex terminates its
  owned local PID tree on timeout/reconnect/shutdown; this alone is **not**
  proof that WSL/remote children died. A wrapper must stop its foreign gh when
  its caller exits, and deployment must verify timeout/shutdown cleanup.

For example, a pre-provisioned WSL runtime can be selected with
`command: "C:\\Windows\\System32\\wsl.exe"` and fixed arguments
`--distribution <dedicated-name> --exec <owned-lifetime-wrapper>`. That wrapper
can run
`/usr/bin/env -i HOME=<private-home> PATH=/opt/gh/bin:/usr/bin:/bin GH_CONFIG_DIR=<profileDir> GH_PROMPT_DISABLED=1 GH_BROWSER=ahplex-browser-disabled BROWSER=ahplex-browser-disabled DBUS_SESSION_BUS_ADDRESS=disabled: NO_COLOR=1 /opt/gh/bin/gh "$@"`.
It must also implement the lifetime rule; plain `wsl.exe --exec gh` is not a
substitute for verified cleanup.

The adapter calls:

1. For `mode: "login"` only:
   `gh auth login --hostname github.com --web --git-protocol https    --skip-ssh-key --insecure-storage --clipboard=false --scopes read:user,user:email`.
   Only the recognized GitHub device URL and one-time user code are exposed.
2. `gh auth status --hostname github.com --active --json hosts --no-refresh`.
   Exit zero alone is insufficient: state must be success, the active account
   must match `account`, the source must match this profile, and known expiry
   must be in the future. Both `read:user` and `user:email` must be granted;
   missing grants fail before token export/AHP submission. JSON scopes use the
   raw comma-separated OAuth header, not gh's human-readable quoted display.
   Unexpected quote characters are rejected, never passed as scope contents.
   GitHub's normalized `user` grant implies these two subscopes; ahplex includes
   those documented implications for Host literal scope matching.
3. `gh auth token --hostname github.com --user <account> --no-refresh`,
   privately captured, followed by AHP `authenticate` on the actual service
   connection. No raw secret files or system credential databases are read by
   ahplex.

The integration was checked against gh **2.103.3** and Copilot CLI **1.0.96-2**
help/source. Older versions missing these flags fail explicitly. Official
contracts: [gh login](https://cli.github.com/manual/gh_auth_login),
[gh token export](https://cli.github.com/manual/gh_auth_token),
[gh JSON status](https://cli.github.com/manual/gh_auth_status),
[Copilot authentication](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli).
`copilot login --help` explicitly lists OAuth tokens from the GitHub CLI app. gh
requests its normal `repo`, `read:org`, `gist` scopes **plus explicitly
requested `read:user`, `user:email`**; Copilot subscription, organization
policy/SSO and actual Host acceptance remain prerequisites. ahplex does not
embed gh's OAuth client ID or perform OAuth on its behalf. The pinned VS Code
build advertises the latter two scopes in
[`gitHubCopilotResource`](https://github.com/microsoft/vscode/blob/a717861c07586a53d83b80d742cd3f59b20a6273/src/vs/platform/agentHost/common/githubEndpoints.ts);
[`AgentHostAuthenticationService._getAuthToken`](https://github.com/microsoft/vscode/blob/a717861c07586a53d83b80d742cd3f59b20a6273/src/vs/platform/agentHost/node/agentHostAuthenticationService.ts)
uses literal scope containment in its stored-token lookup. Do not assume gh's
default grant satisfies that contract. See also
[GitHub scope normalization](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps#normalized-scopes)
and
[gh JSON versus display formatting](https://github.com/cli/cli/blob/v2.103.3/pkg/cmd/auth/status/status.go).

To authorize two hosts, install this `github-login` binding on the first, plus a
`github-reuse` binding with identical options except `mode: "reuse"` on **each**
selected host. The second host needs only `github-reuse`. Call login on the
first, wait for `succeeded`, then call reuse on the second. Identical
launcher/profile bindings are serialized by rejection (`auth_profile_busy`), not
queued; conflicting configured accounts for that profile fail validation. An
unbound host cannot use this authorization. Different launchers/path aliases are
not inferred to name the same profile; deployment must not alias them.

Credentials remain in gh's dedicated **plaintext** file store, protected by
deployment OS permissions, and transiently in ahplex's memory/redactor. No token
is returned by the HTTP/CLI status surface or placed in arguments. Reuse never
triggers login, switches account, or refreshes behind the caller's back.
Expired/missing/revoked credentials require an explicit login. Connection
replacement clears successful state; explicitly reuse to validate and bind the
new service connection. Authentication rejection invalidates the relevant
success even when reported as an RPC error rather than a notification. Neither
reconnect nor login replays Turns. Service shutdown releases owned processes,
not GitHub authorization or the credential profile.

## Trusted plugins

`plugins` contains `{ id, module, options }` entries. `module` is an explicit
relative or absolute local ESM `.js`/`.mjs` file path, not a remote URL or an
npm package to install. Plugins are loaded once at startup and cannot be
hot-swapped. Built-in adapters need no plugin entry.

Plugins are trusted in-process code with the service's OS privileges. They are
not sandboxed. Loading one is a deployment decision, never an API caller action.
See [extension contracts](EXTENSIONS.md) for registration and ownership rules.

## Validate the common schema

From the repository root:

```powershell
npm exec --yes --package=ajv-cli@5.0.0 --package=ajv-formats@3.0.1 -- ajv validate --spec=draft2020 -c ajv-formats -s docs\host-config.schema.json -d docs\hosts.example.json
```

This validates only the documented common schema/example, not executable paths,
credentials, plugin modules, or actual host readiness.
