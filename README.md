# agenthub

A lightweight, loopback-only HTTP service for sessions and correlated tasks on
an **independent VS Code Agent Host**, using one long-lived ahpc HTTP adapter.
No Web UI, editor-host discovery, implicit credential discovery, npm publishing,
or release tagging.

## Requirements and development

- Node.js >=22.13, pnpm >=11.22.
- VS Code with `code agent host --new-instance --foreground` support. The
  endpoint-registry contract currently targets VS Code 1.144.1 (schema 2).
- An agent provider and an explicitly supplied resource credential for
  execution.

```powershell
pnpm install
pnpm check
pnpm pack
node .\dist\cli.js --help
node .\dist\cli.js --instance demo
# Installed package: agenthub --instance demo
```

Default HTTP address: `http://127.0.0.1:4280`. `--port 0` selects a free port.
Host and adapter always use separate ephemeral loopback ports; no use of the old
experiment's ports 9189 or 7432. On Windows, the default executable is the
native `code-tunnel.exe` beside `code.cmd` on PATH; override with
`--code-path 'C:\...\bin\code-tunnel.exe'`. Shell command strings are not
accepted.

The service owns a lock in `~/.agenthub/<instance>/`, isolated server and CLI
data, and a fresh endpoint registry for each run. Customize the root with
`--data-dir`. It launches with `--new-instance --foreground`, never `--replace`,
never reads the editor's registry, and never invokes a CLI per API request.
Instance names are mandatory and limited to letters, digits, `_`, and `-`.

### Real Host acceptance

`pnpm check` passes all 65 tests and the template's unchanged 90% coverage
thresholds, including format, lint, strict typecheck, build, and package-shape
validation. `pnpm pack`, an independent tarball installation, the installed
CLI's help/startup/shutdown, and frozen-lockfile installation have also been
verified.

A fresh VS Code 1.144.1 standalone Host and the actual ahpc 0.9.0 adapter have
been verified together: health, providers, empty session catalogue, explicit 401
on session creation without authentication, explicit attachment without
owning/stopping that Host, and owned-process cleanup. No authenticated agent
task has yet been verified because no dedicated provider credential was
supplied. Test fixtures never count as a real Host acceptance run. To run a real
program task, explicitly provision authentication below, submit the task, wait
for that exact task ID, then independently run the generated program and tests
from its working directory.

## Authentication

Three different credentials have different purposes:

1. The managed Host receives a freshly generated connection token through a
   private token file. This is unrelated to provider login; it is removed on
   shutdown and never printed.
2. The private ahpc HTTP adapter receives an independent random bearer token
   over IPC.
3. Agent provider authentication must be explicitly supplied:

   ```powershell
   # Supply these through your approved secret-injection mechanism:
   $env:AGENTHUB_AUTH_RESOURCE = '<resource advertised by /health>'
   # AGENTHUB_AUTH_TOKEN: a credential intentionally provisioned for this Host
   # AGENTHUB_API_TOKEN: optional bearer credential protecting the public API
   agenthub --instance demo
   ```

Without a provider credential, `/health` reports `authentication: "required"`
and advertises protected `resources`. Creating a session or executing a task is
refused with `auth_required`; authentication does not fall back to another
account. Invalid or expired credentials also report required. The service does
not initiate device login or copy login state from VS Code, gh, Copilot, ahpc
config, or the experiment. Restart with an explicitly provisioned credential
after login.

Child processes receive an allowlisted environment and private HOME, APPDATA,
XDG, VS Code CLI/server, and temporary directories. Ambient provider tokens,
ahpc recording/config environment, editor IPC, and `NODE_OPTIONS` are excluded.
Credentials are not written to logs or task-result files. Known configured
credentials and credential-named properties are redacted from public responses.
Do not include unrelated secrets in prompts: arbitrary agent-generated prose
cannot be universally recognized as sensitive.

All API routes, including health, require `Authorization: Bearer ...` when
`AGENTHUB_API_TOKEN` is configured. Without it, native programs running locally
can control this service. Browser Origin headers and unexpected Host headers are
rejected; there is no CORS support.

### Explicitly configured existing Host

```powershell
# Optional AGENTHUB_HOST_TOKEN is supplied through the environment.
agenthub --instance attached --host-url ws://127.0.0.1:45678
```

The URL must be an explicit loopback WebSocket endpoint without credentials,
query, or fragment. No default endpoint detection is performed. This Host is
**not owned** and will not be stopped. Its data isolation and exclusive access
are the operator's responsibility; do not point this at your editor Host.
Resource credentials remain explicitly required even if that Host has another
user signed in.

## HTTP API

JSON resources are not MCP tool envelopes. URL-encode opaque `sessionId` values
(they are usually provider URIs), not just the provider's UUID.

| Method | Route                                 | Meaning                                               |
| ------ | ------------------------------------- | ----------------------------------------------------- |
| GET    | `/health`                             | Live adapter/Host readiness, instance and auth status |
| GET    | `/agents`                             | Providers and models advertised by the Host           |
| GET    | `/sessions`                           | Known created sessions union the Host catalogue       |
| POST   | `/sessions`                           | Create `{provider, workingDirectory}`; return 201     |
| POST   | `/sessions/:sessionId/tasks`          | Submit `{text}`; return 202 with taskId               |
| GET    | `/tasks/:taskId`                      | Snapshot of that exact task                           |
| GET    | `/tasks/:taskId/wait?timeoutMs=30000` | Wait for that exact task                              |
| POST   | `/tasks/:taskId/cancel`               | Request cancellation; return 202                      |

PowerShell example (add an Authorization header if configured):

```powershell
$base = 'http://127.0.0.1:4280'
Invoke-RestMethod "$base/health"
Invoke-RestMethod "$base/agents"
$session = Invoke-RestMethod "$base/sessions" -Method Post `
  -ContentType 'application/json' `
  -Body (@{ provider = 'copilotcli'; workingDirectory = 'D:\work\demo' } |
    ConvertTo-Json)
$id = [uri]::EscapeDataString($session.sessionId)
$task = Invoke-RestMethod "$base/sessions/$id/tasks" -Method Post `
  -ContentType 'application/json' `
  -Body (@{ text = 'Write a small Python temperature converter and test it.' } |
    ConvertTo-Json)
Invoke-RestMethod "$base/tasks/$($task.taskId)"
Invoke-RestMethod "$base/tasks/$($task.taskId)/wait?timeoutMs=30000"
Invoke-RestMethod "$base/tasks/$($task.taskId)/cancel" -Method Post
```

### Session and task semantics

- A created empty session is retained in the service's known-session registry
  even when absent from the Host catalogue before its first turn. `hostVisible`
  means **present in the latest catalogue**, not existence or task success.
  `running` describes current activity, independently of existence. Call list or
  create before submitting to a session.
- Task states: `queued`, `running`, `completed`, `failed`, `cancelled`.
  Submissions in a session are serialized; separate sessions can execute
  concurrently. `running` starts at dispatch, not at a provider acknowledgement.
- Each task has its own `taskId`, `sessionId`, and caller-assigned `turnId`.
  Completion requires that exact turn in that exact session's history. Idle,
  unrelated turns, and another waiter's completion are not success signals.
- A terminal wait returns `200 {task, timedOut:false}`. A wait deadline returns
  **408** `{task, timedOut:true}` and leaves the task running/queued. Allowed
  wait timeout: 0 through 120000 ms. Disconnecting a waiter also leaves it
  alone. Repeat the wait or GET later. A failed task's terminal wait is HTTP 200
  **with task.status="failed"**, never a successful task result.
- `result` preserves the complete ahpc turn response: ID, role, state, time,
  message, text, error, and tool summaries as provided by ahpc. It is not a raw
  filesystem snapshot or a full tool-output archive.
- Cancelling queued work never touches the Host. Running cancellation records
  `cancelRequested`; it only becomes `cancelled` when that turn's history
  confirms cancellation. A racing completion may truthfully win. The adapter
  checks the active turn ID again before cancelling, so it cannot cancel a
  different turn.
- A task paused for permission/input stays running. This first version never
  auto-approves tools and has no permission/question answering API. Use a
  separately configured client for explicit interaction, or cancel the task.
- Readiness failure is HTTP 503; missing authentication is 401; invalid input is
  400/413/415; missing resource is 404. Errors use `{error:{code}}` without raw
  upstream messages, tokens, or subprocess output.
- An owned subprocess exit fails pending tasks with an explicit
  `*_outcome_unknown` error and makes health unavailable. This means agent
  outcome is unknown, not that remote effects have been rolled back.

## Stop, recovery, and limits

Stop with Ctrl+C or SIGTERM. Shutdown closes outstanding waits, terminates only
the adapter and Host process trees created by this invocation, removes the
connection token, and releases the instance lock. Windows tree termination uses
the exact owned PID, never an image/process name. An explicitly attached Host is
left running; its in-flight task may continue after service shutdown.

Session/task tracking and results are **in memory**. No prompts, responses, or
credentials are journaled by agenthub. Restart loses task IDs and known empty
sessions, but managed Host server data remains in the instance directory.
Recover visible sessions with `/sessions`; recover historical work using an
explicitly authenticated Host client, not by resubmitting a lost task blindly.
The first version retains at most 10000 tasks and refuses further submissions
with 503 `task_capacity`; it does not silently evict tracked results.

After an unclean kill, `owner.lock` may remain. Do not remove it automatically:
verify the recorded PID and any associated processes really belong to this
instance and have stopped. If necessary stop those exact owned PIDs, then remove
that instance's stale lock and connection-token file before restarting. Never
kill all `Code`, `node`, or agent processes. Cleanup errors retain the lock and
report failure rather than pretend shutdown succeeded.

**This is not an OS sandbox.** Agents/tools run with this service account's
filesystem, network, process, and OS credential-store privileges. Environment
and data-directory separation are not protection against a malicious provider or
tool accessing another directory/OS credential store. Use a dedicated OS
account, container, or VM for stronger isolation. Only grant work in directories
you intend to expose.

## Compatibility and template lineage

`@softov/ahpc` 0.9.0 is the sole runtime dependency, needed for its AHP client
and HTTP adapter. The package pins the version and registers a fail-closed Node
ESM load hook **only inside the owned adapter worker**. It corrects all three
directory URI conversions using `pathToFileURL`, permits an explicit turn ID,
and guards cancellation with that ID. It never writes to `node_modules`. Exact
source markers are checked; an unexpected upstream version fails startup rather
than silently dropping the fix. Tests cover compatibility, Windows escaping, and
task correlation. Review/remove this shim when upstream supports these hooks.

Derived with `git-lineage` from `preset-npm-package` main, preserving history:
source `6c693e8c8aa178224439e86ee2b904995c97bfb2`, birth
`d74a661c6955cef5907624eb8ba130a646217174`. The original agenthub origin is
unchanged. `.git-lineage.yaml` records the immediate parent; run
`git-lineage update` only on a clean worktree for future template merges.

The template's strict TypeScript, ESM export map, published-file allowlist,
ESLint, Prettier, Vitest/V8 90% thresholds, build, publint, CI, and Trusted
Publishing workflows remain in place. Keep `private: true` until a separate,
intentional publishing setup. This implementation does not publish npm or push
release tags.

## License

MIT. ahpc is an MIT-licensed external dependency.
