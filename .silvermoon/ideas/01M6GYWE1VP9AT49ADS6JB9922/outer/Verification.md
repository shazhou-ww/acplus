# Real-environment verification

## Checked contract and outcome

These checks exercised the synchronized deployment contract
`94d1f01738756916ded08ee945f5352e807546a6` at primary commit
`57c16e03bcc7125ca25815336b9e52be76741136`, using the actual built
implementation accepted from commit `56d4f2c374d0fd60a70106d23ec08f77678316fc`.

**Deployment remains blocked.** Two real, independent owned Hosts and ahpc
workers reached HTTP transport readiness, but both session catalogue and session
creation failed with HTTP 502 `backend_request_failed`. A bounded native AHP
diagnostic against the explicitly operation-owned Host identified backend
`RpcError` responses `-32603` and `-32002`, both reporting
`Cannot call write after a stream was destroyed`.

No `-32007` or `auth/required` challenge was observed. This is a backend runtime
failure before authorization could be verified, **not proof of an
unauthenticated/expired-authorization requirement**. No session, task, turn or
agent answer was created. Native authorization, authenticated task correlation
and the required actionable unauthenticated case remain unproven.

## Versions, bounds and provenance

- Date: 2026-11-03. Successful two-Host transport run:
  `15:53:39.789Z`–`15:54:41.271Z` (23:53:39–23:54:41 UTC+08:00).
- Node.js `v24.11.1`; pnpm `11.22.0`.
- Installed native `code-tunnel.exe`: VS Code `1.144.1`, commit
  `261c84cb1eddf11235f9e2c921425e9663fbe556`.
- Actual dependency bridge: `@softov/ahpc` `0.9.0`, with
  `@microsoft/agent-host-protocol` `1.0.0`. No ahpd process or mocks.
- Used the package's built `start()` entry point and real loopback HTTP
  requests. Both service processes were launched and owned by ahplex.
- Startup timeout: 60000 ms per stage; HTTP deadline: 125000 ms. Native
  diagnostic operations had 15000 ms deadlines. Every invocation was closed in a
  `finally` block; no service remains running.
- HTTP access used a fresh random API transport token. Provider tokens were not
  injected, credential stores were not inspected, and editor authentication was
  neither copied nor treated as evidence. Transport token values and
  authenticated headers are omitted.

Sanitized raw observations, configurations and retained native profiles are in
the current session's files directory:

- `dv-261103/services.json`, `verification.json`,
  `native-error-diagnostic.json`, and `final-cleanup.json`.
- Earlier bounded attempts and native startup diagnostics:
  `config-driven-real-verification-20261103/`.

These session files are not package/repository deliverables or provider-login
proof. Only sanitized results are recorded here.

## Configuration actually exercised

The decisive run used a short session-files data root `dv-261103`, hub instance
`h`, and separate service IDs `one` and `two`. The executable was the installed
native binary under the user's local Microsoft VS Code installation.

`<VS_CODE_INSTALL>` and `<SESSION_FILES>` below redact machine-specific absolute
prefixes; they are **not ahplex substitutions**. The execution used absolute
paths. The three brace placeholders are actual ahplex substitutions.

```json
{
  "version": 1,
  "services": [
    {
      "id": "one",
      "kind": "ahp-websocket",
      "lifecycle": "owned",
      "startupTimeoutMs": 60000,
      "endpoint": { "registry": true },
      "launch": {
        "executable": "<VS_CODE_INSTALL>\\bin\\code-tunnel.exe",
        "args": [
          "--cli-data-dir",
          "{profileDirectory}\\cli-data",
          "--log",
          "info",
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
        "cwd": "<SESSION_FILES>\\dv-261103\\w-one",
        "environment": { "mode": "isolated", "inherit": [], "values": {} }
      }
    },
    {
      "id": "two",
      "kind": "ahp-websocket",
      "lifecycle": "owned",
      "startupTimeoutMs": 60000,
      "endpoint": { "registry": true },
      "launch": {
        "executable": "<VS_CODE_INSTALL>\\bin\\code-tunnel.exe",
        "args": [
          "--cli-data-dir",
          "{profileDirectory}\\cli-data",
          "--log",
          "info",
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
        "cwd": "<SESSION_FILES>\\dv-261103\\w-two",
        "environment": { "mode": "isolated", "inherit": [], "values": {} }
      }
    }
  ]
}
```

The fresh contexts had distinct persistent profile directories:
`dv-261103\h\services\one\profile` and `dv-261103\h\services\two\profile`. Each
contained a deliberately written `verification-marker.txt`; no native
credentials were pre-provisioned.

Earlier attempts under longer session paths returned HTTP 503
`{"error":{"code":"startup_timeout"}}` for both service selections, first with
20000 ms and then 60000 ms startup bounds. A separate bounded native startup
diagnostic reported readiness after 21653 ms. The short-path configuration above
reached readiness for both services. Path length is a possible contributor, not
an established root cause; changing log level alone did not resolve the
long-path failures.

One isolated native startup diagnostic announced the native default supervisor
log path `<USERPROFILE>\.vscode-server\cli\agent-host-stable.log`. That external
file was not inspected or removed. The decisive run explicitly selected separate
CLI data directories. Environment context selection is not an OS sandbox.

## Exact HTTP observations

Listener: `http://127.0.0.1:53688` during the decisive run, now closed.

Before any service selection:

| Request                               | HTTP | Body                                              |
| ------------------------------------- | ---- | ------------------------------------------------- |
| `GET /health`                         | 200  | `{"status":"listening","services":["one","two"]}` |
| `GET /services`                       | 200  | `{"services":["one","two"]}`                      |
| `GET /agents`                         | 400  | `{"error":{"code":"explicit_service_required"}}`  |
| `GET /services/not-configured/health` | 404  | `{"error":{"code":"service_not_found"}}`          |

A process-tree snapshot after listener health/catalogue requests found **zero
owned service or bridge descendants**. The first selection started only `one`;
the second started `two`. Actual selected identities and registry endpoints:

| Service | HTTP readiness time (UTC) | Host instance ID                       | Native PID | WebSocket port | Owned bridge PID |
| ------- | ------------------------- | -------------------------------------- | ---------- | -------------- | ---------------- |
| `one`   | `15:54:08.374Z`           | `d125dbbe-1899-4f15-9d93-a2e749fb9dac` | 28696      | 53703          | 43364            |
| `two`   | `15:54:34.459Z`           | `7222d8cc-da88-4adb-b985-2602e5622edc` | 44244      | 53742          | 27332            |

Both `GET /services/<id>/health` requests returned HTTP 200 with this shape,
using their respective exact `instance` and Host `instanceId` above:

```json
{
  "instance": "one",
  "status": "ready",
  "authentication": "backend",
  "resources": [
    {
      "resource": "https://api.github.com",
      "name": "GitHub Copilot",
      "scopes": ["read:user", "user:email"]
    },
    {
      "resource": "https://api.github.com/repos",
      "name": "GitHub Repository",
      "scopes": ["repo"]
    }
  ],
  "host": {
    "owned": true,
    "instanceId": "d125dbbe-1899-4f15-9d93-a2e749fb9dac"
  }
}
```

The `two` response differed only in those two identity fields.
`authentication: "backend"` did not claim successful provider login. Both
provider catalogues returned HTTP 200 with the exact body:

```json
{
  "agents": [
    {
      "provider": "copilotcli",
      "name": "Copilot",
      "description": "Copilot SDK agent running in the local agent host process",
      "models": []
    },
    {
      "provider": "claude",
      "name": "Claude",
      "description": "Claude agent backed by the Anthropic Claude Agent SDK",
      "models": []
    }
  ]
}
```

Actual forwarding attempts:

| UTC             | Request                       | HTTP | Exact response body                           |
| --------------- | ----------------------------- | ---- | --------------------------------------------- |
| `15:54:09.846Z` | `GET /services/one/sessions`  | 502  | `{"error":{"code":"backend_request_failed"}}` |
| `15:54:09.865Z` | `POST /services/one/sessions` | 502  | `{"error":{"code":"backend_request_failed"}}` |
| `15:54:35.957Z` | `GET /services/two/sessions`  | 502  | `{"error":{"code":"backend_request_failed"}}` |
| `15:54:35.975Z` | `POST /services/two/sessions` | 502  | `{"error":{"code":"backend_request_failed"}}` |

POST bodies were
`{"provider":"copilotcli","workingDirectory":"<absolute session-files>\\dv-261103\\w-one"}`
and the corresponding `w-two` path. Subsequent service-health requests remained
HTTP 200 with their original, different Host identities, not fabricated
successful session/task results.

Because neither session creation succeeded, no question was submitted. The
planned no-file-change question was: “Reply with exactly
AHPLEX_NATIVE_CHECK_20261103. Do not use tools, inspect credentials, or change
any files.” There are **no session/task/turn IDs or agent answers to
correlate**. Distinct Host identities, ports and workers demonstrate
transport-instance separation, but session/task cross-routing and the required
authentication failure case are not proven by these results.

## Native backend diagnostic and recovery condition

From `15:55:48.536Z` to `15:55:55.120Z`, the check restarted only the previously
operation-owned `one` context, selected its exact fresh schema-2 registry entry,
and opened a second explicit ahpc connection to that owned Host. It did not
search for or attach to an editor/unrelated Host.

The diagnostic Host was instance `ffa6922d-ece0-4c03-b93a-be0f957dc35d`, PID
16900, on loopback port 57699. Native operations, with no authentication
injection, returned:

| Native AHP operation             | Error type | Numeric code | Sanitized native message                                                  |
| -------------------------------- | ---------- | ------------ | ------------------------------------------------------------------------- |
| `listSessions`                   | `RpcError` | `-32603`     | `RPC error -32603: Error: Cannot call write after a stream was destroyed` |
| `createSession` for `copilotcli` | `RpcError` | `-32002`     | `RPC error -32002: Cannot call write after a stream was destroyed`        |

The first error's remaining stack referenced the owned downloaded runtime's
`vscode-jsonrpc/lib/common/connection.js:1089:44`. It is not an authentication
challenge. Observed native authorization notifications: **none**.

Recovery requires a native backend/provider runtime that keeps its channel alive
and can list/create sessions in the selected isolated context. The underlying
runtime failure was not resolved or attributed to missing credentials. After
that prerequisite is repaired, authorize through the provider's supported native
workflow and rerun the harmless exact-task test plus an independent
unauthenticated/expired case. If that combination requires client-mediated token
acquisition, the current embedded HTTP bridge does not implement that
interaction; another supported native workflow or an explicitly designed
integration is needed. Reading/copying editor credentials is not a recovery
step.

## Shutdown and preservation proof

The decisive run recorded all 16 observed owned descendants before shutdown:

| Process                   | PID   | Parent PID |
| ------------------------- | ----- | ---------- |
| `code-tunnel.exe`         | 28696 | 28800      |
| `conhost.exe`             | 29924 | 28696      |
| bridge `node.exe`         | 43364 | 28800      |
| `conhost.exe`             | 13764 | 43364      |
| `cmd.exe`                 | 12804 | 28696      |
| `conhost.exe`             | 33104 | 12804      |
| native runtime `node.exe` | 49948 | 12804      |
| native runtime `node.exe` | 28212 | 49948      |
| `code-tunnel.exe`         | 44244 | 28800      |
| `conhost.exe`             | 42004 | 44244      |
| bridge `node.exe`         | 27332 | 28800      |
| `conhost.exe`             | 20108 | 27332      |
| `cmd.exe`                 | 12240 | 44244      |
| `conhost.exe`             | 20704 | 12240      |
| native runtime `node.exe` | 30100 | 12240      |
| native runtime `node.exe` | 49340 | 30100      |

`28800` was the bounded verification harness, not a pre-existing editor.
Shutdown at `15:54:41.271Z` reported no remaining owned descendants and no
cleanup error. Native startup diagnostics were also stopped by their exact owned
PID and process tree; the attached diagnostic connection was closed before its
owning ahplex invocation.

Final independent cleanup verification at `15:58:47.488Z` checked 27 observed
owned PIDs across monitored attempts and diagnostics, including 16900, 46868 and
51468: **none remained**. All checked operation-owned native/listener ports were
closed: 53703, 53742, 57699, 56418, 53688, 56442 and 58779.

Pre-existing Code PIDs captured before launch and found intact after shutdown:

```text
8792, 9148, 11280, 16612, 21712, 25980, 27756, 29588, 29996,
31220, 34576, 35852, 36848, 41852, 47148, 47588, 48988
```

No name-based termination, editor attachment or credential-store inspection was
performed. Each service ownership lock and generated `connection-token` file,
plus the hub lock, was absent after shutdown. Both persistent profile
directories and their exact verification marker contents remained. Earlier
attempts' persistent profiles were also retained. Private per-run registry
metadata remains in session storage; its transport-token fields are not
published here. No authenticated identity had been established, so credential
renewal/persistence itself is not claimed as tested.

## Ledger interpretation

- `D-S03` and `D-AC03`: complete for observed owned shutdown, unrelated editor
  preservation and persistent profile retention.
- `D-S01`: incomplete because native authorization was not established.
- `D-S02`, `D-AC01` and `D-AC02`: incomplete; no authenticated answer/task
  correlation or actionable native authentication failure was obtained.

This evidence is a blocked deployment result, not a submission or acceptance.
