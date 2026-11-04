# Static host configuration design

Status: target design. The runtime does not load this format yet.

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

A future GitHub Device Flow plugin can be configured as:

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

This requires a registered plugin and verified Copilot-compatible OAuth setup;
the snippet is not a declaration that such a plugin is implemented. Its options
schema and accepted resources belong to the plugin.

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
