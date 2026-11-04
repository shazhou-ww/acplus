# Installed-package real-host verification

## Result

Two real owned VS Code hosts passed startup, isolation, native Session/Chat
allocation, exact Turn observation, explicit missing-credential handling, and
cleanup checks. **A successful authenticated provider answer is not verified.**
Both submitted turns ended in native `error`; they were never reported complete.

The idea remains deploying with D-AC02 open. Do not submit or accept the Outer
World until an explicitly authorized real provider completes the harmless
prompt.

## Verified candidate and environment

- Implementation commit: `9eefe20d9522879a8a134929190a14904ef97059`.
- Accepted implementation world: `d47229eea25a113914f9ade8ce42d5df60f64e9f`.
- Deployment contract synchronized before this run at primary commit
  `c660b2cea93b638f4d1a4e08ffc34891dcfc82b7`, world
  `36f07e31581ae518c92276d623ec3ca15b1cb2ff`.
- Run: 2026-11-04 10:43:30 through 10:44:17 UTC.
- Windows; Node.js 24.11.1; native VS Code CLI 1.145.0, commit
  `3c0ec3a089398503a462029e7cc2a5749df5169a`.
- Independently installed local `ahplex@0.1.0` tarball, official AHP SDK 1.0.0.
  No npm publication or release tag.
- Two-host example configuration, ephemeral HTTP port, explicit short private
  root `D:\ahp-accept-358d0844`, startup deadline 180000 ms.
- Provider/OAuth application variables were absent. No editor, OS, `gh`, or
  other application's credentials were read or copied.

The test loaded the installed package's public `loadConfig` and `start` exports,
then exercised its real HTTP API. This is separate from the protocol/OAuth
fixtures documented by the implementation gate.

## Host lifecycle and isolation

| Check                   | Observation                                                                    |
| ----------------------- | ------------------------------------------------------------------------------ |
| Liveness                | HTTP 204 with no body                                                          |
| Gateway boundary        | No API token needed; an Origin header did not activate a legacy browser policy |
| Passive reads           | Both registered hosts stayed idle through GET queries                          |
| Readiness               | Session GET before startup returned 503 rather than starting a process         |
| Registration            | Unregistered host and removed Task route returned 404                          |
| Coalescing              | Six concurrent starts prepared the first host; the second remained idle        |
| Independence            | Explicitly starting the second produced a distinct native instance and port    |
| Native resource routing | A session queried through the other host returned 404                          |

| Host          | Native instance ID                     | Native port |
| ------------- | -------------------------------------- | ----------- |
| `vscode-dev`  | `c89bfc7b-cffb-4734-aa61-f6d8a4c92daf` | 51948       |
| `vscode-test` | `40894dd8-9fdf-4ab8-bb0b-7c2f1a86cf92` | 51960       |

Registry metadata was read only from the operation-owned roots. Transport-token
file contents were not included in evidence.

## Native resources and outcomes

For each host, Session creation returned 201, chat discovery returned 200, and
ordinary Chat creation returned 201 without changing the existing defaultChat.
Responses contained only the declared fields; native URIs were not replaced by
service aliases.

| Host          | Session URI                                         | Default Chat URI                                 | Caller-chosen Turn ID                  | Observed outcome |
| ------------- | --------------------------------------------------- | ------------------------------------------------ | -------------------------------------- | ---------------- |
| `vscode-dev`  | `ahp-session:/25762c87-57c1-4962-a848-0f3e767d54cb` | `ahp-chat:/1a9dcb14-9b88-4339-a214-1965758998c1` | `9c801f42-4ec5-4d7f-930f-781d7d9fae39` | `error`          |
| `vscode-test` | `ahp-session:/7d2c48a0-8c1a-434f-8b2e-161fec8e1b17` | `ahp-chat:/dd189580-d4b5-495f-9a0c-8e91e6346f33` | `2a46b9cf-8103-4660-94b3-549603c6d6f8` | `error`          |

Additional ordinary Chat URIs:

- `vscode-dev`: `ahp-chat:/42ea9111-529b-4b26-a802-8a8d7c6e1d79`.
- `vscode-test`: `ahp-chat:/a2d89fce-5f5b-45bf-8563-2d69a2f1fa5a`.

The harmless prompt requested exactly `AHPLEX_ACCEPTANCE_OK` and explicitly
prohibited tools and file changes. Each submission was acknowledged, then the
exact requested turn was observed through HTTP. Neither produced the required
successful answer. The minimal error projection does not establish a detailed
provider failure cause; no authenticated-execution claim is made.

## Authentication boundary

Starting `copilot-provisioned` on `vscode-dev` returned 202. Its named token
environment variable was absent, and polling returned `status: failed`,
`error.code: credential_unavailable`. The other host's auth status remained
idle. This proves explicit provisioning/error isolation, not a successful OAuth
flow.

The device-flow adapter and stale/negative/expired authentication paths are
covered by protocol/HTTP fixtures. Live device authorization still requires an
explicitly deployment-provisioned OAuth client ID and browser authorization, or
a deliberately supplied provider credential for the token adapter. Account
entitlement must then be verified through an actual successful Turn.

## Cleanup

Both host stop requests returned 202 and reached idle. The installed service
closed successfully afterward.

- Ten operation-owned processes were captured before shutdown; all had exited
  afterward, including both native supervisors and their agent runtimes.
- An unrelated Node test sentinel remained alive across service shutdown and was
  subsequently disposed by the test through its own process handle.
- The root ownership lock was absent.
- Zero generated transport-token files remained.
- Host data directories remained after service shutdown, as intended.

The test did not stop editor processes or issue process-name-based termination.
Runtime-data separation is not a filesystem sandbox or a claim that arbitrary
provider behavior is safe.

## Remaining acceptance prerequisite

Supply a usable provider credential explicitly through the configured reference,
or configure an appropriate OAuth application and complete the returned device
authorization interaction. Repeat D-S02 with a fresh caller-chosen turn ID and
verify native `complete` plus the expected harmless response. Only then can
D-AC02 and Outer World acceptance be completed.
