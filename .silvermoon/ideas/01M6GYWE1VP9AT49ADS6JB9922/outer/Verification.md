# Real-environment verification

## Current outcome and evidence index

**Deployment is blocked on provider-native authorization, not the historical
stream-destroyed failure.** A fresh short ordinary CLI cache restores real
session operations without junctions, code patches or editor changes. Both
previously tested isolated instances submitted real tasks whose exact returned
turns failed with `No GitHub OAuth token or Copilot HMAC key provided`.

The pinned Microsoft Server Host explicitly disables logged-in-user discovery
for Copilot; its SDK translates that choice to `--no-auto-login`. A standalone
Copilot CLI login therefore cannot be assumed to authorize this AHP connection.
Claude's native SDK has now been provisioned and tested separately in an
inherited native account context: its probe reported no usable account or API
key, and HTTP session creation returned an actionable authorization requirement.
No credentials were extracted, transferred or supplied.

- [Final native-auth and ordinary short-cache findings](#final-native-auth-and-ordinary-short-cache-findings):
  public shipped authentication contract and the simpler verified recipe.
- [Actual Claude SDK/native-account test](#claude-native-sdk-provisioning-and-actual-account-result):
  native provisioning succeeded; the selected native account lacks
  authorization. The earlier availability-only check is historical.
- [Real task failures and exact correlations](#working-cli-configuration-and-native-failure):
  two isolated native Hosts, task submission, exact turn results and cross-route
  rejection.
- [Restart and cleanup](#restart-persistence-and-cleanup): independent native
  session persistence and owned-process preservation checks.
- [Historical path diagnosis](#proven-windows-executable-path-failure): original
  long-path spawn failure versus identical launchable executables.

No authenticated answer has been demonstrated. `D-S01`, `D-S02` and `D-AC01`
remain unchecked; `D-AC02`, `D-S03` and `D-AC03` have the recorded real proof.
The original run details below are retained as historical observations, followed
by their resolution and the latest authorization findings.

## Historical first-run contract and outcome

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

## Follow-up: short-path runtime and real authorization failure

### Contract, provenance and bounds

The follow-up checked synchronized deployment revision
`5a5ce2132e769f3d44bef487fefcc94315603387` at primary commit
`3f30a2eb0551837b34589ae7a0f7ed5ea5277970`. No implementation, Ideal, Inner,
README, dependency or installed-editor files were changed.

Checks ran on 2026-11-03, `16:12Z`–`16:21Z`; native logs use UTC+08:00 and
therefore show November 4. The bridge remained actual ahpc `0.9.0` and AHP
`1.0.0`, using the accepted built package and real HTTP, with no mocks.

The downloaded Microsoft Server was identified independently of the installed
CLI: both report `1.144.1`, commit `261c84cb1eddf11235f9e2c921425e9663fbe556`.
The Server's own `node.exe` reports `v24.22.1`; the ahplex harness used Node
`v24.11.1`. Its bundled `@github/copilot-sdk-win32-x64` package reports
`1.0.27-unstable.40031404408.gba6c003`.

Only previously downloaded, operation-owned Microsoft Server **code** was
copied, from
`dv-261103\h\services\one\profile\cli-data\servers\Stable-261c84cb1eddf11235f9e2c921425e9663fbe556\server`
to `ms-261104` under the session-files directory. No editor profile, native
authorization data or unrelated application data was copied. Ordinary local
shipped-code, help and owned-log inspection was used; no REA evidence is claimed
because its client was unavailable.

### Proven Windows executable-path failure

The original existing bundled `copilot-runtime.exe` has a 279-character absolute
path and is 780920 bytes. An isolated probe using the **Server's own Node
v24.22.1** produced:

| Executable spelling/context                 | Length | Actual result                                    |
| ------------------------------------------- | ------ | ------------------------------------------------ |
| Original path, isolated environment         | 279    | Spawn `ENOENT`; executable did not start         |
| Original path, safe Windows variables added | 279    | Spawn `ENOENT`; executable did not start         |
| Same original path with `\\?\` prefix       | 283    | Executable started; rejected `--version`, exit 1 |
| Short owned platform-package copy           | 141    | Executable started; rejected `--version`, exit 1 |
| Short owned complete Server copy            | 184    | Executable started; rejected `--version`, exit 1 |

The safe-variable comparison added only available `SystemRoot`, `windir`,
`SystemDrive`, `ComSpec` and `PATHEXT` values. It did not inherit authentication
variables. All three executable copies have identical SHA-256:

```text
bbedde1c2a2c862c8da0e4933671c867589775cd1bbdfbeb2ea8b9852c797ac8
```

Exit 1 is **not** a successful version query: it proves that the binary was
launched and parsed its unsupported argument, unlike spawn `ENOENT`. The owned
historical Host logs select the original long executable immediately before
provider initialization fails. The later live Hosts select the 184-character
copied executable and successfully create sessions and execute task attempts.
Together these observations identify a length-sensitive Windows runtime-launch
failure behind the earlier stream-destroyed symptom. They do not establish a
universal path-length threshold or a machine-wide Windows policy setting.

Missing ambient Windows variables were not the demonstrated cause: the working
live comparison retained `environment.mode: "isolated"`, `inherit: []` and
`values: {}`. No product source patch or machine-wide setting change was needed.

### Direct Microsoft Server entrypoint comparison

The direct-entrypoint attempt used the copied Microsoft's Server, **not** the
unrelated Coder code-server product. Its Microsoft `bin\code-server.cmd` wraps
the same `node.exe out\server-main.js` entrypoint.

The exact argument structure, with session-specific absolute prefixes redacted,
was:

```text
<SESSION_FILES>\ms-261104\node.exe
  <SESSION_FILES>\ms-261104\out\server-main.js
  --start-server --host 127.0.0.1 --port 0 --agent-host-port 49823
  --connection-token-file <SESSION_FILES>\dr-261104\connection-token
  --user-data-dir <SESSION_FILES>\dr-261104\user-data
  --server-data-dir <SESSION_FILES>\dr-261104\server-data
  --disable-telemetry --log info
```

It used `isolatedEnvironment(dr-261104)` without extra inheritance. Owned PID
42448 exited with code 1 before opening AHP. Its explicit native diagnostic was:

```text
To accept the license terms, start the server with --accept-server-license-terms
```

No license-acceptance flag was supplied and no direct-Server live success is
claimed. The generated transport-token file was removed and port 49823 was
closed. Selecting this direct entrypoint would additionally require appropriate
operator acceptance of its license terms. The existing CLI supervisor workflow
below did run successfully without changing the current editor.

### Working CLI configuration and native failure

The real working run used hub `h`, data root `<SESSION_FILES>\cc-261104`, and
the same two-service schema documented above. Its only launch-argument
replacement was a separate short CLI cache directory for each service:

| Service | CLI cache directory  | Working directory                 |
| ------- | -------------------- | --------------------------------- |
| `one`   | `<SESSION_FILES>\c1` | `<SESSION_FILES>\cc-261104\w-one` |
| `two`   | `<SESSION_FILES>\c2` | `<SESSION_FILES>\cc-261104\w-two` |

For each fresh operation-owned cache, the native expected directory
`servers\Stable-261c84cb1eddf11235f9e2c921425e9663fbe556\server` was an owned
directory junction to the copied public code at `<SESSION_FILES>\ms-261104`.
Sharing immutable code did not share profiles, registries, sessions or
authentication. Native logs independently confirm both selected the copied
184-character runtime executable. This is the verified operational workaround,
not a claim that arbitrary cache layouts or runtime overrides were tested.

Each configured owned launch used the installed native
`<VS_CODE_INSTALL>\bin\code-tunnel.exe` with:

```text
--cli-data-dir <SESSION_FILES>\c1
--log info agent host --new-instance --foreground
--host 127.0.0.1 --port 0
--user-data-dir {registryDirectory}\user-data
--server-data-dir {profileDirectory}\server-data
--connection-token-file {connectionTokenFile}
```

For service `two`, only the cache path changed to `c2` and its configured
working directory changed to `w-two`. Environment remained isolated with no
extra inheritance or values. Startup bound was 60000 ms and HTTP deadline 125000
ms. The `<SESSION_FILES>` and `<VS_CODE_INSTALL>` prefixes are documentation
redactions, not ahplex substitutions; execution used absolute paths. The three
brace placeholders remain actual ahplex substitutions.

The run lasted `16:16:22.450Z`–`16:16:53.899Z`. Before service selection,
`GET /health` returned HTTP 200
`{"status":"listening","services":["one","two"]}` and `GET /services` returned
HTTP 200 `{"services":["one","two"]}`; the monitored harness had no owned
service descendants before selection.

Both real service health requests then returned HTTP 200 `status: "ready"` with
different native identities:

| Service | Native instance ID                     | Supervisor PID | Native endpoint |
| ------- | -------------------------------------- | -------------- | --------------- |
| `one`   | `b972b335-bd7f-4074-9363-26ca03f420b5` | 23568          | 127.0.0.1:64462 |
| `two`   | `6402b9db-d933-433d-b707-ad797733aef9` | 38124          | 127.0.0.1:64486 |

For **each** service, the real requests returned:

- `GET /services/<id>/agents`: HTTP 200, providers `copilotcli` and `claude`.
- `GET /services/<id>/sessions`: HTTP 200, initially `{"sessions":[]}`.
- `POST /services/<id>/sessions` with
  `{"provider":"copilotcli","workingDirectory":"<the service's actual working directory>"}`:
  HTTP 201 with a real independent native session.
- `POST /services/<id>/sessions/<encoded-session-id>/tasks`: HTTP 202. The exact
  harmless request body was
  `{"text":"Reply with exactly AHPLEX_NATIVE_CHECK_20261104. Do not use tools, inspect credentials, or change any files."}`.
- `GET /services/<id>/tasks/<task-id>/wait?timeoutMs=10000`: HTTP 200,
  `timedOut: false`, terminal `status: "failed"`, `error: "turn_failed"`.

The exact task correlations were:

| Service | Session ID                                         | Task ID                              | Submitted and returned turn ID       |
| ------- | -------------------------------------------------- | ------------------------------------ | ------------------------------------ |
| `one`   | `copilotcli:/2bc8a82c-8e0e-4f8d-bf50-2d4d5ec22477` | 98cb89f6-66e4-4cfe-9fd6-cc9d05bb03c5 | 566f388c-4065-49ef-82e8-22ae79149c6b |
| `two`   | `copilotcli:/9924942a-d5bf-433f-a2f6-f7161102b3a8` | 66e78c5c-42d1-4de3-b307-3617b8114a20 | daf541ee-2090-423b-b6fc-6e3d3bbb023d |

Both returned exact submitted turn IDs, `role: "agent"`, `state: "failed"`,
empty answer text, and `tools: []`. The native terminal error was identical:

```text
Execution failed: InvalidArg, No GitHub OAuth token or Copilot HMAC key provided
```

The owned native `agenthost.log` files independently recorded this query error.
Fetching service one's task through service two, and vice versa, returned HTTP
404 `{"error":{"code":"task_not_found"}}`. Thus failure forwarding, exact
task/turn correlation, actionable missing authorization and task-map isolation
were demonstrated without acquiring any credential.

This backend reports its authorization requirement **inside the failed turn**,
not as HTTP 401, AHP `-32007` or `auth/required`. Health remains `ready` with
`authentication: "backend"` and advertised GitHub resource scopes even after the
failure. Neither health nor successful session creation proves authorized
inference.

### Restart, persistence and cleanup

A second bounded invocation, `16:18:50.795Z`–`16:19:02.433Z`, restarted the same
two private contexts without credentials or additional tasks. Both session
catalogues returned HTTP 200. Each contained exactly its own prior session above
with `hostVisible: true`, and neither contained the other service's session.
Native session persistence and service identity separation therefore survived
shutdown, not merely an empty marker directory.

Fresh native identities were `31b8e894-2e61-4a92-9d01-9b86de8ff2f5` for `one`
(PID 34836, port 54711) and `273933ae-3e50-4d73-9626-ae94536b7991` for `two`
(PID 44996, port 54717). Discovery selected the live identities despite earlier
private schema-2 registry records remaining in their operation-owned run
directories. Registry token fields are not published here.

Both invocation-finally blocks closed ahplex and its owned trees. The first
observed 20 descendants, including real `copilot-runtime.exe` PIDs 4264 and
28968; the restart observed another 20, including runtime PIDs 9380 and 8632.
All were gone after their respective shutdowns. Each service lock and generated
`connection-token` file, plus the hub lock, was absent; both persistent profile
markers remained unchanged.

An independent final check at `16:20:47.322Z` found **none** of these 41
observed follow-up PIDs alive:

```text
42448, 23568, 27720, 50988, 19924, 25380, 32340, 7156, 21548,
4264, 21088, 38124, 43028, 508, 7828, 38820, 39576, 49400,
30360, 28968, 49380, 34836, 32740, 36788, 41688, 49980, 34796,
26432, 48736, 44996, 50944, 3900, 38288, 18060, 46628, 784,
40700, 9380, 15488, 8632, 6508
```

Checked owned ports 49823, 64457, 54705, 64462, 54711, 54717 and 64486 were all
closed. All 17 pre-existing Code PIDs listed in the historical shutdown proof
remained unchanged. No current editor or unrelated Host was attached, restarted,
updated or terminated. Persistent profiles, native sessions, owned code copies
and the two owned cache junctions remain retained; no service remains running.

Sanitized bounded-run evidence remains in session storage:

- `cc-261104\services.json`, `verification.json`, `restart.json`,
  `path-probe.json`, and `final-cleanup.json`.
- `dr-261104\verification.json` for the direct-entrypoint license guard.
- `dv-261103\owned-server-copy.json` and `copilot-path-diagnostic.json` for copy
  provenance and initial path probes.

### Current blocker and ledger interpretation

The previous stream-destroyed startup blocker is resolved by the demonstrated
short owned code-path arrangement. The remaining real inference blocker is the
native provider's explicit missing GitHub OAuth/Copilot HMAC authorization. No
authenticated answer, token renewal or persistence of an authenticated identity
was demonstrated.

Recovery requires a documented, independently authorized native method that this
Host/provider actually honors for this bridge connection, followed by rerunning
the exact harmless task. An editor login or another AHP client's authorization
is not proof. If the supported method requires client-mediated
`authenticate(resource, token)`, this configuration-driven HTTP bridge does not
acquire or relay that login; a separately authorized integration would be
needed. No credential-store inspection, previous experiment credential reuse,
`gh` token extraction or provider-token injection was attempted.

- `D-AC02`: now complete: both task routing and persisted native session
  catalogues remain isolated, and both unauthorized tasks return the exact
  actionable backend requirement.
- `D-S03` and `D-AC03`: remain complete, with stronger restart/session-retention
  and independent cleanup evidence.
- `D-S01`, `D-S02` and `D-AC01`: remain unchecked pending supported native
  authorization and a real successful harmless answer. The attempted question
  and exact failed-turn correlation are evidence, not authenticated success.

This remains a blocked deployment, not a submission or acceptance. The
historical stream-destroyed symptom is no longer the active diagnosis.

## Final native-auth and ordinary short-cache findings

These narrower checks followed the same synchronized deployment revision
`5a5ce2132e769f3d44bef487fefcc94315603387`. They did not alter source, native
runtime code, dependency manifests, installed applications, global settings or
license acceptance. The parent independently maintains the canonical Deployment
summary; this evidence does not record a lifecycle transition.

### Supported native authentication constraint

Public shipped code from Microsoft Server `1.144.1`, commit
`261c84cb1eddf11235f9e2c921425e9663fbe556`, establishes why selecting an already
logged-in standalone CLI profile is not sufficient for this provider:

1. In `out\vs\platform\agentHost\node\agentHostMain.js`, Copilot's client
   startup constructs `let q={useLoggedInUser:!1,gitHubToken:D,...}` at
   character offset 2507893 in the shipped minified file. `!1` is JavaScript
   `false`; credential sources provide `D`, rather than the Host enabling
   discovery of native CLI login state. The Host also selects its own
   `COPILOT_HOME`.
2. The bundled `@github/copilot-sdk\dist\client.js` preserves an explicitly
   supplied `useLoggedInUser` value. Although its normal default is true when no
   token is supplied, the Host overrides that default. The SDK's runtime-launch
   branch adds `--no-auto-login` when the option is false.
3. Copilot's public provider method `async authenticate(resource, token, ...)`,
   at offset 2487990 in that same Host file, accepts the configured Copilot
   resource and calls `_applyGitHubToken(token || undefined, ...)`. That updates
   the provider's in-memory `_githubCredentials`. The inspected credential
   object initializes without a token and requests refresh through its caller;
   it does not implement standalone CLI credential-store discovery.

These are ordinary shipped-code observations, corroborated by the real
missing-authorization task results above, not a modified or experimental
authentication implementation. Changing environment inheritance or merely
pointing HOME at a native CLI login does not change the explicit
`useLoggedInUser: false` policy.

The installed standalone GitHub Copilot CLI reports `1.0.100`. Only safe help
and version operations were invoked; an advertised update was **not** installed.
Its `copilot login --help` describes:

- Browser OAuth on a local desktop, or device-code OAuth in remote/headless
  environments. Device-code mode is not unattended authorization: a person still
  has to approve the grant.
- `--with-token` for an already provided token, or existing
  `COPILOT_GITHUB_TOKEN`, `GH_TOKEN` or `GITHUB_TOKEN` environment credentials.
- Securely stored native login state after a completed login. The Agent did not
  inspect that storage, and this Host's explicit no-auto-login policy is why its
  presence would not establish authorization of our AHP connection.

`code-tunnel tunnel user --help` explicitly identifies its login as login to the
**port forwarding service**, not Copilot authorization. The standalone Host help
exposes transport-token options but no browser/device Copilot login workflow. No
login, token-status shortcut with undocumented behavior, credential file
inspection, editor attachment, `gh auth token`, previous POC-token reuse or
native `agent endpoints` enumeration was performed.

**Supported constraint for this pinned build:** Copilot inference needs a valid
credential delivered through the provider/client authentication path; the
shipped AHP Host does not automatically use an existing standalone Copilot CLI
login. A token can be supplied programmatically if independently obtained and
explicitly authorized, but that is not zero-input native login and is not
provided by this configuration-driven bridge. Interactive OAuth approval or a
separately authorized credential-acquisition/client-authentication integration
remains an external requirement. No authorized, already available credential
source for that integration was established here. This conclusion is scoped to
the tested Host/provider, not every possible future native provider.

### Simpler verified workaround: a short ordinary CLI cache

The new run at `16:26:00.101Z`–`16:26:32.035Z` started from an **empty ordinary
directory** `<SESSION_FILES>\c3`. It did not seed, copy or junction the cache.
The installed native CLI populated its Server cache through its normal workflow,
using the same launch arguments documented above with:

- `--cli-data-dir <SESSION_FILES>\c3`;
- hub instance `h`, data root `<SESSION_FILES>\sc-261104`, service ID `native`,
  and working directory `<SESSION_FILES>\sc-261104\workspace`;
- isolated environment, no inherited entries or explicit values;
- a 180000 ms startup bound and 195000 ms HTTP deadline.

The native cache's
`servers\Stable-261c84cb1eddf11235f9e2c921425e9663fbe556\server` was verified as
a regular directory, not a symbolic link/junction. Its package/product reported
Server `1.144.1` and the expected commit. Its actual bundled runtime path was
**240 characters**, 780920 bytes, with the same SHA-256 recorded above. The
owned native log confirms that this ordinary cache executable was selected.

Real HTTP outcomes:

| Request                          | Result                                                                      |
| -------------------------------- | --------------------------------------------------------------------------- |
| `GET /health`                    | HTTP 200, listener-only `{"status":"listening","services":["native"]}`      |
| `GET /services/native/health`    | HTTP 200, `ready`, owned instance `da542cd1-a05f-4dc0-aeee-d20f06e38f8e`    |
| `GET /services/native/sessions`  | HTTP 200, `{"sessions":[]}`                                                 |
| `POST /services/native/sessions` | HTTP 201, native session `copilotcli:/2abd09a5-4cc8-4ea1-8cbd-6c826784b94f` |

The session request used `provider: "copilotcli"` and that service's actual
working directory. No additional inference task or authentication attempt was
needed to repeat the already established authorization failure.

**Prefer this simpler operational recipe:** choose a short private absolute CLI
cache location for each configured service and let the native CLI populate it
normally. The earlier owned junction/copy arrangement is diagnostic evidence,
not a permanent requirement. Shortening an overall ahplex data directory may
also shorten an expanded per-profile cache path, but that alternative was not
separately tested; the directly proven change is the native CLI cache location.
No general path-length guarantee is claimed.

The final invocation observed these ten operation-owned descendants, including
the real native Copilot runtime:

```text
45996, 32548, 17572, 41856, 45084, 50364, 39856, 32396, 47968, 24376
```

All were gone after shutdown. Listener port 53308 and native port 50398 were
closed. Service/hub locks and the generated connection-token file were absent,
the new private profile/cache remained, and all 17 pre-existing Code PIDs were
preserved. Safe synchronous help/version commands had also completed; no
operation-owned service was left running.

An independent aggregate check at `16:31:37.879Z` found all **51** known owned
PIDs from the follow-up attempts gone and all nine observed ports closed. All 17
pre-existing Code PIDs remained present.

Reusable sanitized session evidence is under `sc-261104`: `services.json`,
`verification.json`, `native-auth-source.json`, `native-auth-contract.json`,
`native-auth-supported-contract.json` and `final-cleanup.json`. No missing
authenticated-success criterion was checked by these final findings.

## Final alternative-provider check: Claude

This is the historical pre-provisioning check. The following
[actual native SDK test](#claude-native-sdk-provisioning-and-actual-account-result)
supersedes its missing-SDK blocker after the parent expanded provisioning scope.

The bounded check at `16:33Z`–`16:34Z` assessed the advertised `claude` provider
separately; Copilot's no-auto-login constraint must **not** be generalized to
every provider.

The same Microsoft Server `1.144.1` shipped source supports both Claude
transport modes:

- `_ensureAuthenticated(model)` returns `{kind: "native"}` when the selected
  transport is not `proxy`; proxy mode instead requires its authenticated
  Copilot proxy handle.
- `_defaultTransportMode()` reads the `allowSignedOutWhenUsable` root setting
  and existing native setup state. Its selector returns proxy unless that
  setting is true, no GitHub proxy token is present, and an existing usable
  native setup has been detected. Explicit model-provider selection also
  participates in transport choice.
- Native query startup uses `GTe(false)`, preserving the native process
  environment while clearing VS Code/Electron-specific variables. Proxy mode
  instead constructs a restricted environment and supplies its own proxy URL and
  proxy authorization. Thus a deliberately selected standalone native context
  could be relevant for Claude; this source does not establish that such a
  context is available or authorized here.

`Get-Command` found **zero** commands for `claude`, `claude.exe` and
`claude.cmd`. Executable-only existence checks also returned false for:

```text
%USERPROFILE%\.local\bin\claude.exe
%APPDATA%\npm\claude.cmd
%LOCALAPPDATA%\Microsoft\WinGet\Links\claude.exe
```

These are bounded discovery results, not a claim that every location on the
machine was searched. No executable was available to invoke supported
version/help/auth-status commands. Native login status therefore remains
**unknown**, not established as signed out. No token/config store or editor
credential was inspected.

The earlier operation-owned short-cache Host's native log independently recorded
at `00:26:24.905` UTC+08:00:

```text
[Claude] SDK not downloaded yet; deferring the migratable chat list
```

The catalogue entry alone is not proof of an installed, authorized Claude
runtime. Under the explicit no-install/no-new-login limits, no SDK download, new
account, browser/device grant, credential acquisition, inherited-context Host or
Claude inference attempt was started. This alternative requires an available
supported Claude runtime and an independently authorized standalone native
context before a real native-mode HTTP roundtrip can be verified.

Only Verification.md was edited for this final route. Public source snippets and
bounded discovery evidence are retained in session files
`sc-261104\claude-auth-source.json` and `claude-alternative.json`. Independent
`claude-cleanup.json` at `16:34:13.723Z` confirms no new Host was started, all
51 earlier observed owned PIDs remain gone, all nine observed ports remain
closed, and all 17 pre-existing Code PIDs remain present. No
authenticated-success ledger criterion changed.

## Claude native SDK provisioning and actual account result

The expanded-scope run at `16:40:29.378Z`–`16:40:53.342Z` used an actual owned
short-cache Microsoft Server Host, not a mock or editor Host. Exact
configuration is retained as `cl-261104\services.json` in session storage.

- Service `claude`, hub `h`, data root `<SESSION_FILES>\cl-261104`.
- Native CLI cache `<SESSION_FILES>\c3`; explicit private Server data
  `<SESSION_FILES>\cs`; owned registry and generated transport-token file.
- `environment.mode: "inherited"`, `inherit: []`. The intentional account
  context was normal standalone native HOME/USERPROFILE, not an editor profile.
  Explicit noncredential values pinned `VSCODE_CLI_DATA_DIR` and
  `VSCODE_AGENT_FOLDER` to the owned directories above. No blanket ambient
  environment or credential-variable forwarding was used.
- Boolean-only preflight found all of `ANTHROPIC_API_KEY`,
  `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`
  and `COPILOT_GITHUB_TOKEN` absent. No values were exposed or injected.

An auxiliary AHP client attached only to that operation-owned Host and sent the
shipped native root configuration action, not provider credentials:

```json
{
  "type": "root/configChanged",
  "config": {
    "allowSignedOutWhenUsable": true,
    "vscode.agentSdkSetup.downloadRequest": {
      "agent": "claude",
      "request": "<unique request ID>"
    }
  }
}
```

The native downloader successfully provisioned Claude SDK **0.3.304**, target
`win32-x64`, from
`https://main.vscode-cdn.net/agent-sdk/claude/0.3.304/win32-x64.tgz`:
**135322354 bytes in 9 seconds**. Its cache is operation-owned
`<SESSION_FILES>\cs\data\agent-host\sdk-cache`. No standalone/global CLI,
current editor, repository dependency or runtime source was installed, updated
or patched; no server-license-acceptance flag was supplied.

The actual native SDK then checked its own account. The Agent did not inspect
credential stores or print account identities. The exact owned Host log at
`00:40:46.980` UTC+08:00 was:

```text
[Claude] Native account check: setUp=false, provider=firstParty, tokenSource=none, apiKeySource=absent
```

Native account detection was therefore exercised, not inferred from a missing
global executable. With no usable native setup, the shipped transport selector
fell back to its Copilot proxy. Exact real HTTP results:

| Request                          | Result                                                                              |
| -------------------------------- | ----------------------------------------------------------------------------------- |
| `GET /health`                    | HTTP 200, listener-only `{"status":"listening","services":["claude"]}`              |
| `GET /services/claude/health`    | HTTP 200, initially `ready`, native instance `a6f2786d-4ea8-484b-802d-9438860d29f4` |
| `GET /services/claude/agents`    | HTTP 200; `copilotcli` and `claude`, neither advertising authorized models          |
| `POST /services/claude/sessions` | HTTP 401, `{"error":{"code":"backend_authentication_required"}}`                    |
| `GET /services/claude/health`    | HTTP 200, `authentication: "required"`, with the native-authorization action below  |

The session body selected `provider: "claude"` and the owned workspace. Health's
exact action was:

```text
Use the selected service/provider native authorization workflow; client-mediated AHP token acquisition is not implemented by this bridge.
```

The fallback advertises GitHub resource scopes; this is not a fabricated direct
Anthropic OAuth challenge. No Claude session, task or answer was created. The
remaining prerequisite is a usable independently authorized Claude native
account/service credential, or a separately authorized proxy credential
integration. Existing standalone Claude authorization could be honored by native
mode, but this actual selected context had none. New interactive login, token
acquisition, editor credential reuse or unchanged retries were not attempted.
Authenticated-success criteria remain unchecked.

The ten monitored owned descendants, including supervisor PID 22284 and native
runtime PID 20660, exited after shutdown. Listener 61636 and native endpoint
61640 closed, service/hub locks and the generated token file were removed, and
owned profiles plus SDK/cache data remained.

An aggregate check considered 61 historical owned PID numbers. PID 6508,
previously an already-exited owned `conhost.exe`, briefly belonged to an
unrelated `msedgewebview2`; it was **not touched**. A follow-up identity lookup
found that replacement gone naturally. The `16:44:57.618Z` recheck found no
matches for any of the 61 historical PID numbers or owned SDK executables. All
11 observed ports were checked closed and all 17 pre-existing Code PIDs remained
present. PID-number reuse was not treated as ownership.

Sanitized evidence is retained in `cl-261104\verification.json`,
`final-cleanup.json` and `final-cleanup-recheck.json`. Only Verification.md
changed in this final attempt; no lifecycle or authenticated-success ledger
claim was made.
