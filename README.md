# ahplex

One ESM TypeScript package for managing **owned AHP hosts**, their upstream
authentication, and native **Sessions → Chats → Turns** over HTTP. There is no
Task API, queue, worker HTTP bridge, ahpc dependency, or private SDK patch.

The fourteen `/v1` operations in [OpenAPI](docs/openapi.yaml) are implemented.
See [API](docs/API.md), [CLI](docs/CLI.md),
[configuration](docs/HOST-CONFIG.md), [requirements](docs/REQUIREMENTS.md), and
[invariants](DESIGN-INVARIANTS.md). Real-provider acceptance is tracked
separately from the implemented contract; verification limits are described
below.

## Install and run

Requires Node.js 22.13+ and pnpm 11.22+:

```powershell
pnpm install
pnpm check
pnpm build
node .\dist\cli.js --help
node .\dist\cli.js serve --config .\docs\hosts.example.json --port 0 --data-dir D:\ahp-demo
```

For an installed package, replace `node .\dist\cli.js` with `ahplex`. There is
no default configuration or implicit HTTP client target. The example registers
two on-demand VS Code hosts; adjust their `startup.command` to the installed
**native `code-tunnel.exe`**, not `code.cmd`. No host starts merely because the
listener starts unless `prepareOnStartup` explicitly requests it.

```powershell
Get-Content -Raw -Encoding UTF8 .\hosts.json | ahplex serve --config -
ahplex serve --config .\hosts.json --listen-host 127.0.0.1 --port 0 --instance demo --data-dir D:\ahp-demo
```

EOF completes stdin configuration, not service lifetime. File-relative paths use
the config directory; stdin-relative paths and a relative CLI `--data-dir` use
the invocation directory. Overrides are explicit scalars and never rewrite the
source. Unknown/repeated flags and invalid configurations fail before listening
or spawning, with exit code 2. There is no `validate` command.

### Opt-in Linux AHPD headless backend

The built-in `ahpd` adapter owns a supplied AHPD executable and uses the same
official Microsoft AHP client SDK as the VS Code adapter. It does not embed
AHPD, install packages, implement ACP, or change existing VS Code deployments.
The [explicit Ubuntu example](docs/ahpd.example.json) uses the patched
`0.15.0-rc.1` SDK/server/ACP build at upstream-fix commit
`1d52d06c65ec1006d548bad7c477e032b9dc6782` and Copilot `1.0.106`. The operator
must provision and verify that exact build; `runtimeRevision` records the
required provenance, not a binary-integrity verification.
[softov/ahpd#246](https://github.com/softov/ahpd/pull/246) has merged, but the
additional recorded Turn identity repair in
[softov/ahpd#250](https://github.com/softov/ahpd/pull/250) is also required.
Update SDK and ACP together. No official release containing both fixes is
presumed. Do not substitute floating `main`, `0.14.0`, or the earlier
Session-only fix build.

#### Prepare an external runtime, then initialize locally

The installed npm package includes `init` and this quickstart; repository
`docs/` and example templates are **not** installed. `init` is a local,
noninteractive config writer, not an installer. Linux runtime preparation
requires Node.js **22.18+** (the supplied server's requirement), pnpm 11.22+,
Git, npm and util-linux `/usr/bin/script` for device login.

One standard source-to-local-tarballs setup follows. These commands download
dependencies and build external software deliberately; `ahplex init` never does
so. Choose a new private deployment root and retain its lockfiles and tarballs.
No npm publishing is involved.

```bash
set -euC
umask 077
BASE="$HOME/ahplex-local"
mkdir "$BASE"
mkdir "$BASE/artifacts" "$BASE/workspace" "$BASE/runtime"
git init "$BASE/source"
git -C "$BASE/source" remote add origin https://github.com/shazhou-ww/ahpd.git
git -C "$BASE/source" fetch --depth 1 origin 1d52d06c65ec1006d548bad7c477e032b9dc6782
git -C "$BASE/source" checkout --detach FETCH_HEAD
test "$(git -C "$BASE/source" rev-parse HEAD)" = 1d52d06c65ec1006d548bad7c477e032b9dc6782
pnpm --dir "$BASE/source" install --frozen-lockfile
pnpm --dir "$BASE/source/packages/sdk" pack --pack-destination "$BASE/artifacts"
pnpm --dir "$BASE/source/packages/agent-acp" pack --pack-destination "$BASE/artifacts"
pnpm --dir "$BASE/source/packages/server" pack --pack-destination "$BASE/artifacts"
cat > "$BASE/runtime/package.json" <<'JSON'
{
  "name": "ahplex-local-runtime",
  "private": true,
  "type": "module",
  "dependencies": {
    "@ahpd/sdk": "file:../artifacts/ahpd-sdk-0.15.0-rc.1.tgz",
    "@ahpd/server": "file:../artifacts/ahpd-server-0.15.0-rc.1.tgz",
    "@ahpd/agent-acp": "file:../artifacts/ahpd-agent-acp-0.15.0-rc.1.tgz",
    "@microsoft/agent-host-protocol": "1.0.0",
    "zod": "4.5.4"
  },
  "overrides": {
    "@ahpd/sdk": "$@ahpd/sdk"
  }
}
JSON
npm install --prefix "$BASE/runtime"
npm install --prefix "$BASE/copilot-cli" --save-exact @github/copilot@1.0.106
npm --prefix "$BASE/runtime" ls @ahpd/sdk @ahpd/server @ahpd/agent-acp
```

Keep all three AHPD packages from that same commit: the version string
`0.15.0-rc.1` alone does not identify the patched bytes. Confirm server and ACP
resolve the same supplied SDK, not a nested registry replacement. The targeted
`$@ahpd/sdk` override binds that supplied prerelease SDK: ACP's `>=0.14 <1` peer
range otherwise excludes `0.15.0-rc.1`. It does not globally disable peer
checks. The private manifest also pins protocol `1.0.0` and `zod` `4.5.4` for
this assembly.

The script deliberately refuses an existing `BASE` and existing output files. If
you already have matched local tarballs, create a new private root with
`artifacts`, `workspace` and `runtime` directories, place the three files in
`artifacts`, then use the same private manifest and install commands. Keep the
resulting runtime lockfile. See repository
[runtime preparation](docs/AHPD-RUNTIME.md) for the layout and checks.

Replace `YOUR-LOGIN` below with the expected GitHub account. Trust only a
workspace you deliberately choose; static workspace trust is **not a sandbox**.

```bash
ahplex init --help
ahplex init --runtime-root "$BASE/runtime" \
  --copilot-command "$BASE/copilot-cli/node_modules/.bin/copilot" \
  --workspace "$BASE/workspace" --login-account YOUR-LOGIN \
  --config "$BASE/ahplex.json" --data-dir "$BASE/state" \
  --port 4291 --daemon-port 19491 --json
ahplex serve --config "$BASE/ahplex.json"
```

`init` checks only explicit local paths and the small installed-prefix layout.
It uses the actual running Node executable by default (`--node-command` can
select another), writes one host `ahpd`, and never starts VS Code or AHPD,
downloads software, reads/discovers/copies credentials, or tests authorization.
The config is exclusively created (0600 on Linux); existing files, including
symlinks, are never replaced. Its parent must already exist. Relative inputs
resolve from the invocation directory. Defaults are `./ahplex.json`,
`./.ahplex`, loopback API port 4280 and daemon port 19491. Use distinct data
roots, profiles and ports for independent deployments. `--port 0` requests an
ephemeral API port; use the URL subsequently printed by `serve`. Redirected
output or `--json` emits only `{"config":"<absolute file>","host":"ahpd"}`; TTY
output instead explains the next step without claiming login success.

The default profile is a dedicated `DATA/copilot-profile` path, created only
when the host starts. To select an **already-authorized** profile explicitly,
add `--copilot-profile /absolute/chosen/profile` (and optionally
`--login-account chosen-login`); do not share it with another active service. No
profile content is inspected by `init`. Configuration is not authentication.

This opt-in Linux path is the headless recommendation **only for the exact
locked build after its recorded deployment gate is accepted**. Unit tests or a
successful build alone do not establish that result. Existing VS Code
configurations are not migrated or started alongside it automatically. See
[AHPD configuration and native login](docs/HOST-CONFIG.md#ahpd). The real
HTTP/CLI, restart/history, compatibility evidence and supported limits are
recorded in the
[deployment verification](.silvermoon/ideas/01M6QHPFJ8GF5A9A5Y945FY8BH/outer/Verification.md).
The example uses generic deployment placeholders. Supply dedicated absolute
paths and your expected GitHub `loginAccount`. An explicitly authorized
experimental profile may be bound for reuse; never discover or copy another
user's credentials. For fresh login, use a new dedicated `copilotProfileDir`.

```bash
ahplex hosts start --host ahpd --url http://127.0.0.1:4291/v1
ahplex auth begin --host ahpd --method native-login --url http://127.0.0.1:4291/v1
ahplex auth get --host ahpd --url http://127.0.0.1:4291/v1 --json
```

For an explicitly selected authorized profile, request
`--method reuse-native-login` instead. Reuse may honestly report
`auth_verification_unsupported` until a separately requested genuine completed
Turn supplies current-generation evidence; no paid probe is sent. Sessions use
provider `copilot` and a trusted `file:///...` workspace URI, not VS Code's
`copilotcli`. Starting the listener alone leaves this host idle
(`onDemand:true`, `prepareOnStartup:false`).

The initial AHPD driver requires a dedicated Linux runtime; other native
platforms fail explicitly to avoid accidentally using a shared system keychain.
Native device login requires Linux's installed `/usr/bin/script` (util-linux).
It displays only the device link/code and an explicit plaintext-storage choice;
it never records or forwards the raw terminal transcript. Windows/macOS AHPD
startup returns `host_platform_unsupported`; a dedicated Linux runtime must be
provisioned explicitly, not silently launched. Bind provider `copilot` to its
advertised resource `https://api.github.com/repos`, not `$host` transport auth.
Login/reuse succeeds only with current provider account evidence, or a strict
native OAuth receipt after explicitly approved storage, matching `loginAccount`
and exit 0. Otherwise authorization stays unknown. A normal caller-requested
Turn with native complete and genuine agent markdown can establish
generation-scoped execution authorization for later reuse. AHPlex never submits
an implicit billable probe. OAuth authentication is not a Copilot entitlement or
billing-account guarantee.

### Data and process ownership

One configured `dataDir` is locked across all instance names. Host data lives
under `hosts\<hostId>` beneath it. Use a distinct, **short absolute root** for
each deployment/test. VS Code's downloaded server executable can fail at long
Windows paths; the adapter supplies an explicit private `--cli-data-dir`. It
also supplies isolated server data, a fresh private schema-2 endpoint registry,
`--new-instance --foreground`, a loopback ephemeral host port, and a generated
transport credential file. It never consults an editor registry. There are no
junctions, implicit inherited profiles, external endpoints, or attach mode.

The default child environment contains only PATH/Path, SystemRoot/SYSTEMROOT,
WINDIR, ComSpec and PATHEXT, plus host-owned HOME, USERPROFILE, APPDATA,
LOCALAPPDATA, TMP/TEMP/TMPDIR, XDG config/data/cache, VSCODE_CLI_DATA_DIR and
VSCODE_AGENT_FOLDER paths. Explicit `startup.env` entries add deployment
settings or secret references; adapter-owned isolation settings cannot be
overridden. Native executable arguments are passed without a shell. Conflicting
adapter-owned arguments are rejected.

Concurrent starts coalesce. Protocol/discovery readiness is separate from
provider login: a successful handshake and root/provider snapshot permit login
even when the session catalogue requires authentication. Catalogue reads still
return the upstream-authentication error rather than an empty list. Transport
reconnection never launches another process or replays a turn. Failed startup
affects only that host. Explicit stop rejects active turns, host background
work, authentication, and unknown activity.

SIGINT/SIGTERM clean up owned processes and generated transport credentials,
then release the root lock. Normal host data is retained. Cleanup failure keeps
the lock and prevents unsafe reuse. After an unclean kill, inspect the lock PID
and owned process tree before manually removing a stale lock; never kill
processes by name or automatically delete an arbitrary data root.

## Native client workflow

Set the URL printed by `serve`, including `/v1`:

```powershell
$env:AHPLEX_URL = 'http://127.0.0.1:4280/v1'
ahplex health
ahplex hosts list --json
ahplex hosts start --host vscode-dev
ahplex hosts list --json
ahplex sessions create --host vscode-dev --provider copilotcli --working-directory file:///D:/work/demo --json
```

Creation returns only `{ "resource": "<native-session-uri>" }`. The directory is
a host-side file URI, not a local client path.

VS Code can keep an allocated empty session's native lifecycle at `creating`
until the first send materializes the provider. ahplex confirms the creation RPC
and authoritative session/default-chat snapshots; it neither waits for an unsent
turn nor fabricates a `ready` lifecycle. Such provisional chats remain
discoverable, and idle provisional sessions do not prevent owned-host stop.
Discover chats explicitly:

```powershell
ahplex chats list --host vscode-dev --session 'ahp-session:/returned-uri' --json
ahplex chats create --host vscode-dev --session 'ahp-session:/returned-uri' --json
```

`defaultChat` is separate from chat `origin` and `interactivity`. Ordinary
creation requires the selected provider's `multipleChats` capability; it never
substitutes a new session. Read-only and hidden chats reject submissions.

```powershell
$turn = [guid]::NewGuid().ToString()
Set-Content -Encoding UTF8 .\prompt.txt 'Reply with a short greeting. Do not change files.'
ahplex turns start --host vscode-dev --chat 'ahp-chat:/selected-uri' --turn $turn --text-file .\prompt.txt
ahplex turns get --host vscode-dev --chat 'ahp-chat:/selected-uri' --turn $turn --json
ahplex turns cancel --host vscode-dev --chat 'ahp-chat:/selected-uri' --turn $turn
```

`--text-file -` reads stdin. The caller chooses the **actual AHP turn ID**
before submission. HTTP 202 means the host acknowledged that exact dispatch, not
that the turn finished. A busy chat returns `chat_busy`; nothing is queued.
Different chats can progress independently where the provider allows it.

Turn observations expose only `state`, optional markdown `text`,
`inputRequired: true`, and a display-safe error. Terminal states are native
`complete`, `cancelled`, and `error`; `running` projects `activeTurn`. Tool
approval/input blocks are visible but cannot be answered through this MVP.
Cancellation names the exact chat and turn and never targets a newer turn.

A lost connection/acknowledgement returns `turn_outcome_unknown`, not a terminal
outcome. Inspect the same chat/turn ID; do not blindly retry. Unresolved
dispatch blocks further writes to that chat. Missing/incomplete history and
unavailable observations are errors, never fabricated success or empty
catalogues. There is no durable ahplex execution journal.

Client `--json` emits the API body unchanged, or nothing for bodyless success.
In a TTY, the default presentation uses tables for lists and readable Turn/login
status, links, and verification codes. Redirected output remains the API body.
Use `ahplex <group> <command> --help` for command-specific usage; invalid
arguments automatically print relevant help to stderr with exit code 2. Exit
codes are 0 for successful HTTP interactions, 1 for transport/server errors, and
2 for invalid CLI/config input. Reading an `error` Turn is still a successful
read. No writes are automatically retried.

## Explicit upstream authentication

Standalone VS Code Agent Host does **not** make ambient editor/CLI login
available to this service connection. ahplex never searches ambient editor, OS,
`gh`, or other applications' credentials. The explicit `github-cli` integration
below accesses only a dedicated deployment-provisioned profile, through official
CLI interfaces.

`GET /hosts` advertises only configured host-local method IDs, providers and
resource URIs. `ahp-token` reads an explicitly named environment variable or
UTF-8 credential file. File reads remove one final newline, not other
whitespace. Missing/empty credentials fail the attempt.

```json
{
  "id": "copilot-provisioned",
  "provider": "copilotcli",
  "resource": "https://api.github.com",
  "adapter": "ahp-token",
  "options": {
    "credential": { "source": "env", "name": "AHPLEX_DEMO_GITHUB_TOKEN" }
  }
}
```

```powershell
ahplex auth begin --host vscode-dev --method copilot-provisioned
ahplex auth get --host vscode-dev --json
```

The credential is sent by typed AHP `authenticate` to the advertised resource on
the actual, generation-checked service connection. The AHP success reply means
the host accepted/validated it; an RPC auth rejection is not success. Models
existing, command exit zero, and displaying a user code are not evidence of
authentication. No real agent turn is used as a login probe.

### Official GitHub CLI login, without registering an OAuth app

`github-cli` bridges the official `gh auth login --web` device flow and
`gh auth token` export to AHP `authenticate`. Only VS Code's `copilotcli`
provider and `https://api.github.com` are supported. Users see a GitHub link and
one-time user code, never a password/token prompt in ahplex. The flow explicitly
requests `read:user,user:email` in addition to gh's default scopes, and checks
the granted scopes before submission to the Host.

This requires **a dedicated no-keychain execution environment and an explicit
profile/account**. On Windows, use a trusted launcher into an isolated Linux
runtime, not the current user's `gh.exe`. `GH_CONFIG_DIR`, `HOME`, and
`--insecure-storage` do **not** isolate an OS keychain: gh can still access or
modify its global entries. Native Windows gh is rejected. See the exact
[configuration and launcher contract](docs/HOST-CONFIG.md#official-github-cli-handoff).

Configure `mode: "login"` to request user authorization; configure another
host-local method with `mode: "reuse"` and the **same launcher, profileDir,
account** for explicit reuse on either selected host:

```powershell
ahplex auth begin --host vscode-a --method github-login
ahplex auth get --host vscode-a --json
# Open only the returned GitHub URL; enter its userCode.
# Wait for succeeded, then explicitly authorize the second connection:
ahplex auth begin --host vscode-b --method github-reuse
ahplex auth get --host vscode-b --json
```

`reuse` verifies the pinned account, credential source and expiry again;
missing/revoked credentials fail without another profile or login fallback.
After reconnect, explicitly call `github-reuse` again. No credentials are
broadcast and no Turns are replayed. Use the native Session/Chat/Turn commands
above to independently verify each exact Turn reaches `complete`.

Custody: gh writes plaintext credentials in the dedicated profile because
keychain access is disabled. Protect that runtime/profile with OS permissions.
ahplex captures the official token export privately in memory and passes it only
to the selected connection; it neither parses secret files nor publishes raw CLI
output. Shutdown does not revoke GitHub authorization or delete the profile.
Fixture tests are not evidence of real authorized execution.

### GitHub device authorization

The built-in `github-device` adapter is usable with an **explicitly
deployment-provisioned OAuth application's client ID**:

```json
{
  "id": "copilot-browser",
  "provider": "copilotcli",
  "resource": "https://api.github.com",
  "adapter": "github-device",
  "options": {
    "clientId": "YOUR-REGISTERED-OAUTH-APPLICATION-ID",
    "scopes": ["read:user", "user:email"]
  }
}
```

It uses GitHub's device authorization/token endpoints, publishes only the
verification link and user-facing code, honors polling/slow-down/expiry, checks
granted scopes, and submits the credential through the bound AHP connection. It
does not embed an editor/`gh` client ID, open a service-machine browser, or
reuse another app's identity. Your OAuth app must permit device authorization;
Copilot-compatible scopes/account entitlement and live verification remain
deployment prerequisites. **No real authenticated execution is claimed.**

One attempt per host is allowed. Attempts expire after at most ten minutes,
cancel on shutdown, and release owned resources. Input steps have fresh random
step IDs and exact field sets. Input is write-only:

```powershell
ahplex auth input --host vscode-dev --step '<current-step-id>' --input-file .\sensitive-input.json
```

The file contains a JSON string map, or use `--input-file -`. Auth statuses
never include tokens, OAuth device codes, or command stdout. Known credential
expiry, upstream challenges and connection replacement invalidate stale success.
Reconnection does not silently reauthenticate.

### Local ESM extensions

Trusted local `.js`/`.mjs` plugins are loaded once from static config:

```json
{ "id": "company", "module": ".\\plugins\\company.mjs", "options": {} }
```

They default-export
`{apiVersion: 1, id, options: {schema, parse}, register, dispose?}`. `id` must
match configuration. Options schemas are validated before `parse`; duplicate
built-in or plugin adapter IDs fail. `register` adds host and/or authentication
factories following [internal contracts](docs/EXTENSIONS.md). Host factories may
additionally implement `validate(config, parsedOptions)` for startup cross-field
constraints. Factories/registration must not start resources.

Host drivers implement owned `start`, `openTransport`, `stop`,
`verifyAuthentication`, and `dispose`. The core supplies generation-checked
connection access, a secret resolver, and tracked process ownership.
Authentication adapters use `publishStep`, `requestInput`, `submitCredential`,
and `verifyAuthentication`; returning without verified authentication fails.
Commands can only originate in trusted deployment modules/configuration, never
HTTP requests. Plugins are in-process trusted code, not sandboxed or a stable
published plugin SDK.

## Deployment and verification limits

An external gateway owns inbound authentication, authorization, TLS and network
access control. ahplex has **no inbound token, CORS or Origin-protection
layer**. All responses use `Cache-Control: no-store`; gateways must not log
authentication input bodies. Input validation, secret redaction, process
ownership and native resource correlation remain enforced. Do not expose an
unprotected listener.

Automated tests use the official SDK with JSON-RPC transport fixtures, HTTP
conformance, an owned real subprocess/WebSocket boundary, CLI file/stdin
configuration, and mocked OAuth endpoints. These prove orchestration behavior,
not real-provider multiple-chat support, OAuth entitlement, or authenticated
execution. The official SDK version is pinned to 1.0.0; host protocol
negotiation must succeed before readiness. Unsupported host/protocol
combinations are not silently treated as ready.

For a real two-host check, use a short fresh root, the two-host example, and
native CLI commands above. Start each independently, verify one failure does not
affect the other, inspect auth before explicit provisioning, discover actual
provider capabilities, and test busy rejection/exact cancellation with a
harmless prompt. Re-list both hosts after stopping one. Keep fixture evidence
separate from live authenticated evidence.

Directory/env isolation is **not an OS sandbox**. Providers and trusted plugins
retain the service account's privileges. Use a dedicated account/container/VM
for stronger isolation. Native host history may survive restart; ahplex's
in-memory authentication attempts and uncertainty observations do not.

## Development and publication

Public package exports are deliberately limited to `start`, `loadConfig`,
`validateConfig`, common configuration types, `ConfigurationError`, and
`ServiceError`. `exports` and the `files` allowlist retain their package shape.
The project `tsconfig.json` disables `verbatimModuleSyntax` because the official
SDK publishes ambient `const enum` discriminants; imports remain ESM, with enum
values compiled by TypeScript rather than cast or patched.

```powershell
pnpm --config.verifyDepsBeforeRun=false check
```

The flag avoids this machine's unrelated dependency reconciliation. The check
still runs formatting, strict ESLint/TypeScript, 90% coverage thresholds, build
and publint. No thresholds are lowered.

The manifest defines the candidate version; changing it does not publish a
release. Only a matching `v<package.version>` tag on `main` triggers
publication. Trusted Publishing uses GitHub OIDC:

- Organization/user: `shazhou-ww`
- Repository: `ahplex`
- Workflow: `publish-npm.yaml`
- Environment: `npm`

Configure that Trusted Publisher on npm and intentionally push a matching
release tag when releasing. Do not introduce long-lived npm tokens.

Stable versions publish to `latest`; `X.Y.Z-canary.DATE.SEQUENCE` versions
publish to `canary` without changing the stable channel. To try a Canary:

```bash
npm install -g ahplex@canary
ahplex --version
```

Use GitHub Actions for publishing and registry verification; do not run local
publishing commands, including dry runs. Before pushing an approved release tag,
check candidate availability and run the nonpublishing OIDC diagnostic:

```powershell
gh workflow run publish-npm.yaml --ref main -f check-version=0.1.1-canary.20261106.1
gh workflow run publish-npm.yaml --ref main
```

Availability is established only by valid successful registry metadata, never by
a failed network request. `check-version` and `verify-version` are mutually
exclusive. To verify an existing release without publishing again:

```powershell
gh workflow run publish-npm.yaml --ref main -f verify-version=0.1.0
```

Derived with `git-lineage` from `preset-npm-package`, preserving source history
`6c693e8c8aa178224439e86ee2b904995c97bfb2` and birth
`d74a661c6955cef5907624eb8ba130a646217174`. `.git-lineage.yaml` records the
parent. Repository-owned ideas remain managed by Silvermoon under `.silvermoon`;
implementation does not change their lifecycle.

## License

MIT.
