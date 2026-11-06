# Internal extension contracts

Status: implemented internal integration contracts, not a published plugin SDK.

The [MVP requirements](REQUIREMENTS.md) and [native AHP API](API.md) define the
public model. These are internal integration contracts, not another resource
API.

The extension boundary has two axes:

1. A **host adapter** knows how to prepare a host, discover its endpoint, open
   its transport, and start/stop its service-owned process. Every registered
   host must implement this complete lifecycle.
2. An **authentication adapter** knows how to complete a configured
   authentication mechanism and bridge its interaction to an API caller.

Neither adapter owns HTTP routing, turn admission, the host registry, global
login state, or its own parallel AHP connection supervisor.

## Registration and loading

Built-in and configured plugins use the same registry. Register all plugins
before validating host references or starting any host.

```ts
interface ExtensionPlugin<TOptions> {
  apiVersion: 1;
  id: string;
  options: OptionsCodec<TOptions>;
  register(registry: AdapterRegistry, options: TOptions): void;
  dispose?(): Promise<void>;
}

interface OptionsCodec<T> {
  schema: Readonly<Record<string, unknown>>;
  parse(input: unknown): T;
}

interface AdapterRegistry {
  addHostAdapter<T>(factory: HostAdapterFactory<T>): void;
  addAuthenticationAdapter<T>(factory: AuthenticationAdapterFactory<T>): void;
}
```

These are interface sketches: supporting domain types are defined below and map
to the configuration schema and OpenAPI DTOs. The implementation is in
`src/extensions.ts`; these types are not a stable public plugin SDK.

- A module's default export is its plugin definition. Its ID must equal the
  configured plugin ID; `apiVersion` must match the loader's supported version.
- `OptionsCodec.schema` is a JSON Schema 2020-12 object. `parse` validates
  through that schema and returns the typed result; errors carry field paths. It
  must not silently default invalid inputs or disagree with the advertised
  schema.
- Host-adapter IDs are unique in their registry; authentication-adapter IDs are
  unique in theirs. Duplicate registrations, including built-in overrides, fail.
- Load explicit local ESM files from trusted static configuration. Do not fetch
  remote modules, install npm packages, discover directories, or load modules
  requested by HTTP callers.
- Registration is synchronous and side-effect-free apart from registry changes.
  It does not start commands, connect to hosts, resolve secrets, or begin login.
- Module initialization itself is trusted code, not sandboxed validation.
- `dispose` releases plugin-global resources after host/flow shutdown. Partial
  startup failures also dispose already loaded plugins; cleanup errors are
  surfaced rather than swallowed.

## Host adapter

```ts
interface HostAdapterFactory<TOptions> {
  id: string;
  options: OptionsCodec<TOptions>;
  create(
    context: HostContext,
    config: ResolvedHostConfig,
    options: TOptions,
  ): HostDriver;
}

interface HostDriver {
  start(signal: AbortSignal): Promise<void>;
  openTransport(signal: AbortSignal): Promise<AhpTransport>;
  stop(signal: AbortSignal): Promise<void>;
  verifyAuthentication(
    target: AuthTarget,
    signal: AbortSignal,
  ): Promise<AuthVerification>;
  dispose(): Promise<void>;
  configure?(
    handle: HostClientHandle,
    signal: AbortSignal,
    clientId: string,
  ): Promise<void>;
  authenticateNative?(
    context: AuthenticationContext,
    mode: "login" | "reuse",
    signal: AbortSignal,
  ): Promise<void>;
}
```

`AhpTransport` is the official SDK's transport interface. The core wraps
`openTransport` in a `MultiHostClient` transport factory. Plugins do not replace
the SDK with their own protocol stack.

### Supporting types and ownership

| Type                 | Contract                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `ResolvedHostConfig` | Validated common config; filesystem paths resolved; secret references remain unresolved                                         |
| `HostContext`        | Immutable hostId, scoped data directory, secret resolver, process owner, redacting logger, generation-checked connection access |
| `AuthTarget`         | Exact hostId, provider, resource, and optional connection generation                                                            |
| `AuthVerification`   | `authenticated`, `required`, or `unknown`, with display-safe diagnostic code                                                    |

`HostContext.processes` is a core-owned process service. Its spawn operation
takes an executable and argument array with `shell: false`, explicit
environment, and an abort signal, and returns a tracked owned-process handle.
Adapters retain these handles, not untracked child PIDs. The service can clean
them up if adapter startup fails. This ownership contract is not an OS sandbox.
Output is discarded by default. An explicit `output: "pipe"` allows a trusted
authentication adapter to privately parse stdout/stderr; it must bound output,
never forward raw diagnostics, and stop its handle on cancellation. Foreign
processes launched through WSL or another runtime additionally require a
deployment-verified lifetime-coupled launcher.

- The core assigns `HostContext.dataDir` as `<dataDir>\hosts\<hostId>`. Built-in
  adapters do not accept a duplicate data-root option. A service-level data-root
  override relocates these derived directories; explicit deployment credential
  paths remain outside that ownership contract.
- One driver instance is created per configured host, not per HTTP request.
- `create` does not start processes or open a connection.
- Core serializes/coalesces lifecycle transitions and blocks new admission
  during stop; the driver does not implement an execution queue.
- The HTTP API's `start` starts and connects the host; its `stop` disconnects
  and stops that owned process. Separate process/connection states remain
  internal; the public Host status is their minimal lifecycle projection. There
  is no ownership-mode discriminator or connection-only driver.
- `start` launches through the process service, waits for endpoint discovery,
  and fails explicitly on deadline or cancellation. The core separately requires
  the AHP handshake before marking the host connected.
- `openTransport` never starts a host. It opens a fresh transport for the SDK's
  initial connection or reconnect, using the endpoint and appropriate transport
  credential. Reconnect must not create another process.
- `stop` is required and only affects the driver's tracked process resources. A
  driver must not attach to or take ownership of an independently operated host.
- Driver `dispose` releases driver resources and is idempotent. Core closes SDK
  connections and stops owned processes before final driver disposal.
- Implementations retain ownership information until cleanup succeeds. Cleanup
  failures remain visible and must not permit unsafe reuse.
- Invalid startup/option combinations fail during configuration validation.

### Initial adapter

The initial `vscode` adapter starts an isolated standalone Host, discovers its
endpoint, and cleans up its owned processes. A later AHPD or other host adapter
must implement the same lifecycle. Generic AHP transport remains shared SDK
functionality; there is no `generic-ahp` attach-only adapter.

The opt-in built-in `ahpd` adapter now implements the same lifecycle using a
supplied pinned runtime. Optional `configure` applies only explicitly configured
workspace policy to each connected generation before readiness; the core passes
the current client identity for matching action acknowledgements. Optional
`authenticateNative` delegates a native login/reuse to the host-owned profile.
Its authentication context is generation-bound; it does not submit provider
tokens or replace `verifyAuthentication`. The authentication adapter's matching
context hook is unavailable on drivers that do not support native login. These
are narrow internal hooks, not a new public API or plugin SDK.
`SpawnOptions.input: "pipe"` is separately opt-in; trusted code may send only
validated protocol-specific choices, never arbitrary untrusted shell input.

Optional `invalidateAuthentication` clears driver-owned evidence on any auth
challenge or connection change. Optional `observeExecution` receives only a
caller-admitted Turn's `submitted` identity and a subsequently observed native
`complete` with nonempty agent markdown. The core associates the Chat with its
native Session provider; inability to associate leaves authorization unknown
without changing Turn admission. An adapter must require its matching submitted
ticket, provider, generation and challenge epoch; it cannot elevate historical
or synthetic user-only completion. AHPD uses this only to recognize a
caller-requested Copilot execution, never to launch a probe. Process owners can
accept a trusted adapter's static `setFailureCode` classification for a dead
child; raw stdout/stderr must never be used as that code or forwarded.

## Native resource handling stays in the core

The official SDK handles AHP commands, dispatch, subscriptions, and reducers.
The core preserves Session/Chat URIs and actual turn IDs under the owning host.
Plugins must not translate them into independent jobs or remap a request to a
different/default chat.

The core reads `defaultChat`, `origin`, and `interactivity` from AHP state. It
checks multipleChats before ordinary chat creation and writable/idle state
before turn dispatch. Admission is serialized per chat, but busy submissions
fail instead of being queued. A successful dispatch must still be acknowledged
by the host. Observation errors never become synthetic TurnState values.

## Authentication adapter

```ts
interface AuthenticationAdapterFactory<TOptions> {
  id: string;
  options: OptionsCodec<TOptions>;
  create(options: TOptions): AuthenticationAdapter;
}

interface AuthenticationAdapter {
  run(context: AuthenticationContext, signal: AbortSignal): Promise<void>;
}

interface AuthenticationContext {
  readonly target: AuthTarget;
  readonly expiresAt: string;
  readonly secrets: SecretResolver;
  readonly processes: FlowProcessOwner;
  readonly logger: RedactingLogger;

  publishStep(step: LinkStepContent): void;
  requestInput(step: InputStepContent, signal: AbortSignal): Promise<AuthInput>;
  submitCredential(
    credential: UpstreamCredential,
    signal: AbortSignal,
  ): Promise<AuthVerification>;
  verifyAuthentication(signal: AbortSignal): Promise<AuthVerification>;
}
```

Each attempt gets its own adapter instance, with at most one active attempt per
host. Reusable mechanisms do not share mutable per-account state through a
global singleton. Flow identity and connection generations are internal, not
public API fields. The built-in `github-cli` factory keeps only a service-local
profile/account binding and admission lease, not a token cache. Identical
configured profiles reject concurrent attempts instead of racing login/export;
secrets remain in the explicitly provisioned native CLI store until privately
exported per attempt.

| Type                 | Contract                                                                           |
| -------------------- | ---------------------------------------------------------------------------------- |
| `LinkStepContent`    | OpenAPI link step: URL and optional userCode; device/browser details stay internal |
| `InputStepContent`   | OpenAPI input step without stepId; exact field names, all treated as sensitive     |
| `AuthInput`          | Current stepId and write-only field-value map, validated by the core               |
| `UpstreamCredential` | In-memory token, optional granted scopes and absolute expiry; never a status DTO   |
| `SecretResolver`     | Reads only explicit env/file references; never searches ambient credentials        |
| `FlowProcessOwner`   | Tracks login commands and temporary resources belonging to this flow               |
| `RedactingLogger`    | Structured diagnostics excluding secrets and raw authentication output             |

The core owns the host's current attempt, internal identity, deadline, input
routing, and shutdown/expiry cancellation. The adapter owns mechanism-specific
steps and validation. Public status contains only status, methodId, the current
step, and any error. There is no flow history or public cancellation operation.

### Interaction rules

1. The core resolves the configured host-local binding selected by API
   `methodId`. It validates the provider/resource target and establishes an AHP
   connection first when that method requires one. A transport login can run
   before it.
2. The adapter calls `publishStep` to expose device/browser instructions, or
   awaits `requestInput` for exact fields. Core assigns input step IDs that are
   never reused between attempts and enforces a finite deadline. Link steps need
   no ID because they accept no input. Expiry and OAuth polling details stay
   internal; an expired attempt is exposed as expired.
3. API input is accepted only for the active input step and exact field set. The
   core resolves that step's pending promise. It never writes arbitrary input
   into an unspecified process stdin.
4. OAuth adapters validate state, audience/resource, expiry, and callback
   binding as required by their mechanism. Device token polling honors
   authorization-server intervals and cancellation. Browser results arrive
   through the dedicated input step, not a generic trusted callback URL supplied
   by the caller.
5. `submitCredential` performs the appropriate typed AHP operation against the
   intended generation-checked service connection. Adapters do not create a
   second short-lived AHP connection for this purpose.
6. Independent login commands may instead establish host-side login state and
   use `verifyAuthentication`. Command exit zero alone does not establish
   success.
7. `run` returns only after `authenticated` verification. `unknown` is not
   success: perform a supported non-mutating verification or fail explicitly
   with `auth_verification_unsupported`. Do not start a real agent turn as a
   probe.
8. The core marks the flow succeeded only after authenticated verification.
   Missing verification, a stale generation, rejected input, or command failure
   cannot be converted into a success-shaped response.
9. Abort/expiry rejects pending input, stops only flow-owned commands, clears
   active steps, and releases sensitive intermediate state. It does not stop the
   host or silently revoke another flow's established authentication.

Host-side verification is capability-specific: AHP does not provide a universal
query for every provider's login status. A host driver that cannot verify a
particular independent login mechanism reports unknown. Unsupported login must
remain visible rather than being inferred from models existing or a token merely
being accepted by a command.

### Attempt ownership and connection changes

Flows are bound to `(hostId, provider, resource)` and, when relevant, a
connection generation. The core prevents concurrent attempts for the entire
host. Binding credentials to another generation requires explicit revalidation;
otherwise the flow fails with `auth_connection_changed`.

Starting after completion replaces the last status. Callers must coordinate
login; the shared host-scoped status slot does not identify independent caller
workflows. Known credential expiry or connection replacement clears stale
success. `idle` does not assert that a provider needs no authentication.

The core serializes input/expiry/completion races: an expired or aborted attempt
cannot later become succeeded through a delayed callback. Cleanup releases only
attempt-owned resources and does not claim to revoke upstream authorization.

### Authentication mechanisms

- `ahp-token`: resolve a configured secret reference and submit it for an
  advertised AHP resource. No interactive login is implied.
- Built-in `github-device`: deployment-provisioned OAuth application, device
  authorization, caller-visible user code, private token polling, and validated
  submission to the configured target.
- Built-in `github-cli`: official gh device login and supported token export,
  with an explicitly trusted no-keychain runtime, dedicated profile and pinned
  account. `login` and `reuse` are explicit host-local choices; export source,
  CLI state and known expiry are validated before AHP submission. Raw stdout and
  stderr are bounded and filtered, not streamed to callers. See
  [configuration, custody and launcher requirements](HOST-CONFIG.md#official-github-cli-handoff).
- Optional host/provider-specific command adapters: fixed login
  executable/arguments, explicit supported interaction parsing, and independent
  verification.

There is deliberately no universal "run any login command and stream stdout"
adapter. Each command integration must define its parsing, inputs, cancellation,
and success criteria.

## Example registration

```ts
export default {
  apiVersion: 1,
  id: "company-integrations",
  options: pluginOptions,
  register(registry, options) {
    registry.addHostAdapter(companyHostFactory(options));
    registry.addAuthenticationAdapter(githubDeviceFactory(options));
  },
} satisfies ExtensionPlugin<CompanyPluginOptions>;
```

With corresponding static configuration:

```json
{
  "plugins": [
    {
      "id": "company-integrations",
      "module": ".\\plugins\\company-integrations.mjs",
      "options": {}
    }
  ]
}
```

`companyHostFactory`, `githubDeviceFactory`, and their option codecs are
illustrative plugin code, not shipped implementations. Host entries then select
registered adapter IDs; authentication bindings select mechanisms independently.
Nothing about this mechanism requires a monorepo or independently published npm
packages. If a public plugin ecosystem is introduced later, version and document
this boundary before promising third-party binary/source compatibility.
