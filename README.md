# acplus

The npm package, CLI command and GitHub repository are named `acplus`. Client
configuration uses `ACPLUS_URL`; default files are `acplus.json` and `.acplus`.
There is no old command/environment alias. Historical Silvermoon records and Git
commits remain unchanged.

One ESM TypeScript package providing **on-demand ACP Agents and durable Session
history over HTTP**.

The repository implementation now uses `/v2` and connects directly to stable ACP
**wire v1**. It does not use AHP, AHPD, VS Code Agent Host, a compatibility
proxy, or a task queue. Previously published AHP packages remain unchanged. The
release candidate is `acplus@0.1.0-canary.20261109.1`, targeting npm `canary`;
the reserved package's `latest` placeholder is not this runtime.

After the release has passed registry and installation verification, install the
exact Canary:

```powershell
pnpm add --global acplus@0.1.0-canary.20261109.1
acplus --version
```

See [API](docs/API.md), [OpenAPI](docs/openapi.yaml), [CLI](docs/CLI.md),
[Agent configuration](docs/AGENT-CONFIG.md),
[requirements](docs/REQUIREMENTS.md), and [invariants](DESIGN-INVARIANTS.md).
Detailed design is available in [English](docs/ACP-DESIGN.md) and
[简体中文](docs/ACP-DESIGN.zh-CN.md). The repository-owned
[Silvermoon idea](.silvermoon/ideas/01M6ZA9HR2B1A5H9QYVRN0CKX0/outer/inner/ideal/Idea.md)
and its supporting documents track the implementation and external acceptance.

## Model

```text
HTTP /v2
  configured Agent
    local Session
      local Turns
      ordered Events
```

- Creating a Session only writes local metadata. First execution starts the
  configured Agent and creates its ACP Session.
- **Every GET is local-only**, including Session/Turn/event/auth queries.
  Stopped or unavailable Agents do not prevent reading committed history.
- A Turn is one prompt execution; Events record message/tool/state observations.
  Each Event belongs to a Session and optionally one same-Session Turn.
- Events support `turnId` filtering before pagination. Sequence cursors remain
  Session-wide; sparse filtered sequence values are normal.
- SQLite stores content and separate sanitized authentication observations.
  Credentials stay in the Agent's explicitly selected profile/store.
- One active prompt per Agent and Session; busy input is rejected, not queued.
  Identical Turn IDs/text never dispatch twice; changed input conflicts.
- A lost process/response is not proof of completion or cancellation. Unknown
  dispatch outcomes are retained and never automatically replayed.

## Install from this checkout

Use Node.js **22.13+** and pnpm **11.22+**:

```powershell
pnpm install
pnpm --config.verifyDepsBeforeRun=false check
pnpm build
node .\dist\acp-cli.js --help
```

The check flag avoids unrelated dependency reconciliation on this development
machine; formatting, lint, strict type checks, 90% coverage thresholds, build
and package-shape validation still run. CI uses `pnpm check`.

To create a local installable artifact without publishing:

```powershell
pnpm pack --pack-destination C:\private\artifacts
```

Install that explicit tarball into a separate prefix and retain its hash and
lockfile for acceptance. No local `npm publish`, including `--dry-run`. The
`files` allowlist contains `dist`, this README and LICENSE; repository `docs/`
and example files are not installed.

## Configure and run

The first verified integration is independent Copilot CLI **1.0.107** on Linux.
Provision the Agent separately. Native device login uses util-linux's
`/usr/bin/script`; generic ACP transport and fixture tests also run on Windows.
Other Agents need their own capability/authentication/tool/restart acceptance.

Choose an existing trusted workspace, a private configuration parent and
separate data/profile directories outside that workspace:

```bash
acplus init --agent-command "$(command -v copilot)" \
  --workspace /srv/work/project --data-dir /srv/acplus/state \
  --profile /srv/acplus/credentials/copilot --login-account YOUR-LOGIN \
  --config /srv/acplus/config.json --port 4280
acplus serve --config /srv/acplus/config.json
```

For an uninstalled checkout, replace `acplus` with
`node /absolute/checkout/dist/acp-cli.js`. Replace paths and `YOUR-LOGIN`
explicitly. `init` checks paths and exclusively creates a new schema-2 config
(0600 on Linux); it does not install, start, authenticate or probe an Agent. It
never overwrites an existing file/symlink or copies another profile.

The HTTP listener defaults to loopback. `--port 0` chooses an ephemeral port;
use the URL printed by `serve`. The data root has one owner. Canonical profile
directories are distinct within a service, and cooperating runtimes hold a
private profile lease across process/login ownership. A stale ownership file is
not silently deleted.

## Authentication

Ordinary execution requests do not submit provider credentials. Reuse a
deliberately selected authorized profile, or explicitly provision one:

```bash
acplus agents login --agent copilot --method native-login \
  --url http://127.0.0.1:4280/v2
acplus agents auth --agent copilot --url http://127.0.0.1:4280/v2
```

Login returns an expiring flow. Inspect it for the public device URL/code,
complete browser authorization, and inspect it again. If explicit plaintext
storage consent is requested, submit the exact step ID:

```bash
printf '%s' '{"stepId":"COPY-EXACT-ID","values":{"confirmPlaintextStorage":"yes"}}' |
  acplus agents auth-input --agent copilot --input-file - \
    --url http://127.0.0.1:4280/v2
```

Do not send tokens/passwords to this endpoint or put them in command history.
Raw login output is never published or persisted. Agent-driven ACP methods use
the advertised `authenticate(methodId)` flow; terminal methods require their
supported adapter and are not sent to that RPC. Unsupported methods/logout fail
explicitly.

Cached authentication is **last-observed evidence**, not perpetual validity.
Restart/reconnect, profile changes, explicit auth/logout, challenges and known
expiry invalidate current evidence. No hidden paid model probe runs. Successful
login is not a Copilot entitlement/billing guarantee.

## Run and query a Session

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

Replace placeholders with local UUIDs, choosing the Turn ID before sending.
Client commands require `--url BASE/v2` or `ACPLUS_URL`. JSON output describes
observations: HTTP 202 means durable admission, not execution success. Terminal
status appears only after preceding updates are committed.

Known background ambiguity is fenced before another same-Session prompt.
Cancellation targets exact work and waits for real terminal evidence. Backend
continuation uses only advertised resume/load; history is never silently
replayed as reconstructed model/tool context. Replayed history is separately
sourced with no invented local Turn association.

## Safety and supported limits

- External gateways own inbound authentication, resource authorization and TLS.
  This service is not an unprotected public endpoint or built-in multi-tenant
  identity system. Operator auth routes and Agent/Session/history access must be
  protected.
- Workspace/profile separation and tool permissions are **not an OS sandbox**.
  Use a dedicated account/container/VM for stronger isolation.
- Permission defaults to deny; deliberate `allow` selects one-call approval. No
  unimplemented filesystem/terminal client capability is advertised.
- Known secrets are redacted before content persistence. Arbitrary Agent/tool
  output can contain other sensitive workspace data; protect the database,
  backups and gateway logs.
- Request input is limited to 1 MiB; event pages default to 100 and cap at
  1,000. Records expose observation time/sequence and honest coverage.
- Default automatic idle timeout is disabled. Configured idle exit requires
  known quiescence, not merely a resolved foreground prompt.
- SQLite schema 2 rejects unshipped earlier development databases. There is no
  automatic old AHP/schema-1 import or configuration migration.
- `node:sqlite` emits an experimental warning on the tested Node 22/24 versions.
  It does not cause an Agent startup or change the persistence contract.

## Public package surface

Runtime exports remain `start`, `loadConfig`, `validateConfig`,
`ConfigurationError` and `ServiceError`. Public configuration/resource types are
exported from `src/index.ts`. The package remains one ESM package, with the
existing exports map and files allowlist. The normal `acplus` bin now points at
the verified direct ACP entry; there is no permanent dual-stack launcher.

## Publishing

Publishing is separate from this implementation. Use GitHub Trusted Publishing
OIDC, never long-lived npm tokens:

The private guard is removed for the explicitly approved Canary release. The
acplus Trusted Publisher must use the repository below; validate it through the
nonpublishing Actions diagnostic before pushing the release tag.

- Organization/user: `shazhou-ww`
- Repository: `acplus`
- Workflow: `publish-npm.yaml`
- Environment: `npm`

Only an explicitly approved `v<package.version>` tag on `main` triggers
publication. Choose a new version for a future release; never move/reuse a
pushed tag or overwrite a published version. Stable releases use npm `latest`;
`X.Y.Z-canary.DATE.SEQUENCE` versions use `canary`, not `latest`.

Run diagnostics and registry/install verification through GitHub Actions:

```powershell
gh workflow run publish-npm.yaml --ref main
gh workflow run publish-npm.yaml --ref main -f verify-version=VERSION
```

Replace `VERSION` with an existing release. Inspect actual registry/install
results after failed/cancelled runs; cancellation is not proof that publication
did not happen. Never run local `npm publish`, including dry runs, or work
around corporate publishing restrictions.

Derived with `git-lineage` from `preset-npm-package`, preserving source history
`6c693e8c8aa178224439e86ee2b904995c97bfb2` and birth
`d74a661c6955cef5907624eb8ba130a646217174`. `.git-lineage.yaml` records the
parent.

## License

MIT.
