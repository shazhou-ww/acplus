import { Readable, Writable } from "node:stream";
import {
  client,
  methods,
  ndJsonStream,
  RequestError,
  type ClientConnection,
  type InitializeResponse,
  type PromptResponse,
} from "@agentclientprotocol/sdk";
import {
  diagnostic,
  profileIdentity,
  record,
  Redactor,
  serviceError,
  ServiceError,
  loginAccount,
} from "./acp-common.js";
import {
  AgentProcess,
  agentEnvironment,
  copilotLogin,
  waitFor,
} from "./acp-login.js";
import { acquireProfileLease, type ProfileLease } from "./acp-profile.js";
import type {
  AgentConfig,
  AuthMethodView,
  AuthStep,
  RuntimeHooks,
  Session,
} from "./acp-types.js";

const MAX_MESSAGE = 1024 * 1024;
const MAX_PENDING = 4 * MAX_MESSAGE;

export class AcpRuntime {
  status: "stopped" | "starting" | "ready" | "failed" | "idle_unknown" =
    "stopped";
  generation = 0;
  private starting: Promise<InitializeResponse> | undefined;
  private initialized: InitializeResponse | undefined;
  private connection: ClientConnection | undefined;
  private owned: AgentProcess | undefined;
  private lifetime = new AbortController();
  private closing: Promise<void> | undefined;
  private serial: Promise<unknown> = Promise.resolve();
  private updates: Promise<void> = Promise.resolve();
  private queuedBytes = 0;
  private queuedCount = 0;
  private receivedBytes = 0;
  private receivedCount = 0;
  private revision = 0;
  private replaySession: string | undefined;
  private active = 0;
  private readonly activity = new Map<string, "busy" | "idle" | "unknown">();
  private readonly detachedSessions = new Set<string>();
  private promptSession: string | undefined;
  private unsupportedActivity = false;
  private nativeAuthenticating = false;
  private nativePending: Promise<void> | undefined;
  private nativeController: AbortController | undefined;
  private profileLease: ProfileLease | undefined;
  private profilePending: Promise<ProfileLease> | undefined;
  private releaseProfileOnClose = true;
  private cleanupFailed = false;
  private idleTimer: NodeJS.Timeout | undefined;
  private readonly bindings = new Set<string>();
  private readonly identity: string;

  constructor(
    private readonly agent: AgentConfig,
    private readonly hooks: RuntimeHooks,
    private readonly redactor = new Redactor(),
  ) {
    this.identity = profileIdentity(agent);
  }

  get hasWork(): boolean {
    return (
      this.active > 0 ||
      this.queuedCount > 0 ||
      this.nativeAuthenticating ||
      this.detachedSessions.size > 0 ||
      [...this.activity.values()].some((value) => value !== "idle")
    );
  }

  methods(): AuthMethodView[] {
    const terminal = (method: unknown): boolean =>
      record(method) && method.type === "terminal";
    const advertised: AuthMethodView[] = (this.initialized?.authMethods ?? [])
      .filter((method) => !terminal(method))
      .map((method) => ({ id: method.id, name: method.name, type: "agent" }));
    if (this.agent.authentication?.type === "copilot")
      advertised.unshift({
        id: "native-login",
        name: "Copilot device login",
        type: "native",
      });
    return advertised;
  }

  ensure(): Promise<InitializeResponse> {
    if (this.cleanupFailed)
      return Promise.reject(new ServiceError("owned_cleanup_failed"));
    if (this.nativeAuthenticating)
      return Promise.reject(new ServiceError("agent_auth_in_progress", 409));
    if (this.identity !== profileIdentity(this.agent)) {
      this.hooks.invalidated("profile");
      return this.close().then(() => {
        throw new ServiceError("agent_profile_changed", 409);
      });
    }
    if (this.starting !== undefined) return this.starting;
    if (this.initialized !== undefined && this.connection !== undefined)
      return Promise.resolve(this.initialized);
    this.starting = this.start().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async start(): Promise<InitializeResponse> {
    if (this.closing !== undefined) await this.closing;
    this.status = "starting";
    this.generation++;
    if (this.generation > 1) this.hooks.invalidated("restart");
    this.lifetime = new AbortController();
    this.receivedBytes = 0;
    this.receivedCount = 0;
    const lifetime = this.lifetime;
    const timeout = setTimeout(() => {
      lifetime.abort(new ServiceError("agent_startup_timeout"));
    }, this.agent.startupTimeoutMs);
    try {
      await this.reserveProfile();
      lifetime.signal.throwIfAborted();
      const env = await waitFor(
        agentEnvironment(this.agent, this.redactor),
        lifetime.signal,
      );
      lifetime.signal.throwIfAborted();
      const owned = new AgentProcess(this.agent.command, this.agent.args, env);
      this.owned = owned;
      const app = client({ name: "acplus" });
      app.onRequest(
        methods.client.session.requestPermission,
        async ({ params }) => {
          if (lifetime !== this.lifetime || lifetime.signal.aborted)
            return { outcome: { outcome: "cancelled" as const } };
          const option =
            this.agent.permission === "allow"
              ? params.options.find((item) => item.kind === "allow_once")
              : undefined;
          await this.callback(
            () => this.hooks.permission(params.sessionId, option !== undefined),
            lifetime,
          );
          return {
            outcome:
              option === undefined
                ? { outcome: "cancelled" as const }
                : { outcome: "selected" as const, optionId: option.optionId },
          };
        },
      );
      app.onRequest("*", () => {
        throw RequestError.methodNotFound("unsupported");
      });
      app.onNotification(methods.client.session.update, ({ params }) => {
        if (lifetime !== this.lifetime || lifetime.signal.aborted) return;
        if (
          (params.update.sessionUpdate === "tool_call" ||
            params.update.sessionUpdate === "tool_call_update") &&
          record(params.update.rawInput) &&
          params.update.rawInput.detach === true
        ) {
          this.unsupportedActivity = true;
          this.detachedSessions.add(params.sessionId);
        }
        if (
          [
            "agent_message_chunk",
            "agent_thought_chunk",
            "tool_call",
            "tool_call_update",
            "plan",
          ].includes(params.update.sessionUpdate) &&
          this.promptSession !== params.sessionId &&
          this.replaySession !== params.sessionId &&
          this.activity.get(params.sessionId) !== "busy"
        )
          this.activity.set(params.sessionId, "unknown");
        const source =
          params.sessionId === this.replaySession ? "replay" : "live";
        this.enqueue(JSON.stringify(params).length, async () => {
          if (params.update.sessionUpdate === "agent_thought_chunk") {
            this.hooks.event("agent_thought_unsupported");
            return;
          }
          await this.hooks.update(params.sessionId, params.update, source);
        });
      });
      app.onNotification("*", ({ params, method }) => {
        if (lifetime !== this.lifetime || lifetime.signal.aborted) return;
        this.enqueue(JSON.stringify(params ?? null).length, () => {
          if (
            (method === "_github.com/copilot/sessionEvent" ||
              method === "github.com/copilot/sessionEvent") &&
            record(params) &&
            typeof params.sessionId === "string" &&
            typeof params.type === "string"
          ) {
            if (
              params.type === "session.idle" &&
              params.agentId === undefined &&
              (!record(params.data) || params.data.mode !== "autopilot")
            ) {
              this.activity.set(params.sessionId, "idle");
              this.hooks.event("agent_activity_idle");
            } else if (
              [
                "assistant.turn_start",
                "subagent.started",
                "system.notification",
              ].includes(params.type)
            ) {
              this.activity.set(params.sessionId, "busy");
              this.hooks.event("agent_activity_busy");
            } else {
              this.activity.set(params.sessionId, "unknown");
              this.hooks.event("agent_activity_unknown");
            }
          } else {
            this.unsupportedActivity = true;
            this.hooks.event("agent_notification_unsupported");
          }
          this.idle();
          return Promise.resolve();
        });
      });
      const connection = app.connect(
        ndJsonStream(
          Writable.toWeb(owned.child.stdin),
          Readable.toWeb(owned.child.stdout),
          { maxMessageBytes: MAX_MESSAGE },
        ),
      );
      this.connection = connection;
      // Drain diagnostics without forwarding transcript, credentials, or raw stderr.
      owned.child.stderr.on("data", () => {});
      owned.child.once("error", () => {
        this.fail(new ServiceError("agent_spawn_failed"), lifetime);
      });
      owned.child.once("exit", () => {
        this.fail(new ServiceError("agent_disconnected"), lifetime);
      });
      void connection.closed.then(() => {
        this.fail(new ServiceError("agent_disconnected"), lifetime);
      });
      const response = await this.request(() =>
        connection.agent.request(
          methods.agent.initialize,
          {
            protocolVersion: 1,
            clientCapabilities: {
              fs: { readTextFile: false, writeTextFile: false },
              terminal: false,
              _meta: {
                "github.com/copilot": {
                  events: [
                    "session.idle",
                    "session.background_tasks_changed",
                    "assistant.turn_start",
                    "subagent.started",
                    "system.notification",
                  ],
                },
              },
            },
            clientInfo: { name: "acplus", version: "1" },
          },
          this.options(lifetime.signal),
        ),
      );
      if (response.protocolVersion !== 1)
        throw new ServiceError("agent_protocol_unsupported", 502);
      if (lifetime.signal.aborted) throw new ServiceError("agent_disconnected");
      this.initialized = response;
      this.status = "ready";
      this.idle();
      return response;
    } catch (error) {
      const failure =
        lifetime.signal.reason instanceof ServiceError
          ? lifetime.signal.reason
          : serviceError(error);
      this.fail(failure, lifetime);
      await this.close();
      this.status = "failed";
      throw failure;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async reserveProfile(): Promise<void> {
    if (this.profileLease !== undefined) return;
    this.profilePending ??= acquireProfileLease(this.agent.profileDir)
      .then((lease) => {
        this.profileLease = lease;
        return lease;
      })
      .finally(() => {
        this.profilePending = undefined;
      });
    await this.profilePending;
  }

  private options(signal = this.lifetime.signal) {
    return { cancellationSignal: signal, stopWaitingOnCancel: true };
  }

  private async request<T>(operation: () => Promise<T>): Promise<T> {
    const lifetime = this.lifetime;
    try {
      const result = await operation();
      if (lifetime !== this.lifetime || lifetime.signal.aborted)
        throw new ServiceError("agent_disconnected");
      return result;
    } catch (error) {
      const failure = lifetime.signal.aborted
        ? new ServiceError("agent_disconnected")
        : serviceError(error);
      if (failure.code === "agent_auth_required")
        this.hooks.invalidated("auth_required");
      throw failure;
    }
  }

  private enqueue(bytes: number, operation: () => Promise<void>): void {
    this.receivedBytes += bytes;
    this.receivedCount++;
    if (
      this.queuedBytes + bytes > MAX_PENDING ||
      this.queuedCount >= 1024 ||
      this.receivedBytes > 64 * MAX_MESSAGE ||
      this.receivedCount > 65_536
    ) {
      this.fail(new ServiceError("agent_notification_overflow"), this.lifetime);
      return;
    }
    this.queuedBytes += bytes;
    this.queuedCount++;
    const lifetime = this.lifetime;
    this.updates = this.updates
      .then(async () => {
        try {
          if (!lifetime.signal.aborted)
            await waitFor(
              operation(),
              AbortSignal.any([lifetime.signal, AbortSignal.timeout(30_000)]),
            );
        } finally {
          this.queuedBytes -= bytes;
          this.queuedCount--;
          this.idle();
        }
      })
      .catch(() => {
        this.fail(new ServiceError("agent_update_failed"), lifetime);
      });
  }

  private async callback(
    operation: () => Promise<void>,
    lifetime: AbortController,
  ): Promise<void> {
    this.active++;
    try {
      await waitFor(
        operation(),
        AbortSignal.any([lifetime.signal, AbortSignal.timeout(30_000)]),
      );
    } catch {
      this.fail(new ServiceError("agent_callback_failed"), lifetime);
      throw new ServiceError("agent_callback_failed");
    } finally {
      this.active--;
      this.idle();
    }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const revision = this.revision;
    this.active++;
    this.clearIdle();
    const result = this.serial.then(async () => {
      try {
        if (revision !== this.revision) throw new ServiceError("agent_closed");
        return await operation();
      } finally {
        this.active--;
        this.idle();
      }
    });
    this.serial = result.catch(() => {});
    return result;
  }

  attach(session: Session): Promise<string> {
    return this.serialize(async () => {
      if (
        session.profileIdentity !== this.identity ||
        session.agentId !== this.agent.id
      )
        throw new ServiceError("session_profile_mismatch", 409);
      const initialized = await this.ensure();
      const connection = this.connection!;
      const lifetime = this.lifetime;
      if (session.backendSessionId === null) {
        const result = await this.request(() =>
          connection.agent.request(
            methods.agent.session.new,
            {
              cwd: session.workingDirectory,
              mcpServers: this.agent.mcpServers,
            },
            this.options(),
          ),
        );
        await waitFor(this.updates, lifetime.signal);
        if (lifetime !== this.lifetime)
          throw new ServiceError("agent_disconnected");
        this.bindings.add(result.sessionId);
        return result.sessionId;
      }
      const id = session.backendSessionId;
      if (this.bindings.has(id)) return id;
      const params = {
        sessionId: id,
        cwd: session.workingDirectory,
        mcpServers: this.agent.mcpServers,
      };
      if (initialized.agentCapabilities?.sessionCapabilities?.resume != null)
        await this.request(() =>
          connection.agent.request(
            methods.agent.session.resume,
            params,
            this.options(),
          ),
        );
      else if (initialized.agentCapabilities?.loadSession === true) {
        this.replaySession = id;
        try {
          await this.request(() =>
            connection.agent.request(
              methods.agent.session.load,
              params,
              this.options(),
            ),
          );
          await waitFor(this.updates, lifetime.signal);
        } finally {
          this.replaySession = undefined;
        }
      } else throw new ServiceError("session_resume_unsupported", 409);
      await waitFor(this.updates, lifetime.signal);
      lifetime.signal.throwIfAborted();
      if (lifetime !== this.lifetime)
        throw new ServiceError("agent_disconnected");
      this.bindings.add(id);
      return id;
    });
  }

  prompt(
    backendSessionId: string,
    text: string,
    onDispatch?: () => void,
  ): Promise<PromptResponse> {
    return this.serialize(async () => {
      await this.ensure();
      const lifetime = this.lifetime;
      if (!this.bindings.has(backendSessionId))
        throw new ServiceError("session_not_attached", 409);
      this.assertPromptAttribution(backendSessionId);
      await waitFor(this.updates, lifetime.signal);
      this.assertPromptAttribution(backendSessionId);
      lifetime.signal.throwIfAborted();
      if (lifetime !== this.lifetime || this.connection === undefined)
        throw new ServiceError("agent_disconnected");
      const connection = this.connection;
      const params = {
        sessionId: backendSessionId,
        prompt: [{ type: "text" as const, text }],
      };
      // Reserve JSON-RPC framing and request-id overhead.
      if (
        Buffer.byteLength(JSON.stringify(params), "utf8") + 1024 >
        MAX_MESSAGE
      )
        throw new ServiceError("agent_request_too_large", 413);
      this.promptSession = backendSessionId;
      let result: PromptResponse;
      try {
        result = await this.request(() => {
          onDispatch?.();
          return connection.agent.request(
            methods.agent.session.prompt,
            params,
            this.options(),
          );
        });
      } finally {
        this.promptSession = undefined;
      }
      await waitFor(this.updates, lifetime.signal);
      if (lifetime !== this.lifetime || lifetime.signal.aborted)
        throw new ServiceError("agent_disconnected");
      return result;
    });
  }

  private assertPromptAttribution(backendSessionId: string): void {
    // ACP has no verified prompt identity for unsolicited session updates.
    const activity = this.activity.get(backendSessionId);
    if (
      activity === "busy" ||
      activity === "unknown" ||
      this.detachedSessions.has(backendSessionId)
    )
      throw new ServiceError("session_background_ambiguous", 409);
  }

  private async authenticationPreflight(): Promise<void> {
    const check = (): void => {
      for (const id of new Set([
        ...this.activity.keys(),
        ...this.detachedSessions,
      ]))
        this.assertPromptAttribution(id);
    };
    check();
    if (this.connection !== undefined)
      await waitFor(this.updates, this.lifetime.signal);
    check();
  }

  async cancel(backendSessionId: string): Promise<void> {
    if (this.connection === undefined)
      throw new ServiceError("agent_not_running", 409);
    await this.request(() =>
      this.connection!.agent.notify(methods.agent.session.cancel, {
        sessionId: backendSessionId,
      }),
    );
  }

  authenticate(
    methodId: string | undefined,
    onStep: (step: AuthStep) => void,
    requestInput: (
      step: Extract<AuthStep, { kind: "input" }>,
      signal: AbortSignal,
    ) => Promise<Record<string, string>>,
    signal: AbortSignal,
    expectedLoginAccount?: string,
  ): Promise<void> {
    if (expectedLoginAccount !== undefined) loginAccount(expectedLoginAccount);
    if (
      expectedLoginAccount !== undefined &&
      methodId !== undefined &&
      methodId !== "native-login"
    )
      return Promise.reject(
        new ServiceError(
          "invalid_input",
          400,
          "An expected login account selects native-login; do not combine it with an Agent RPC method",
        ),
      );
    return this.serialize(async () => {
      const nativeAuthentication =
        expectedLoginAccount === undefined
          ? this.agent.authentication
          : { type: "copilot" as const, loginAccount: expectedLoginAccount };
      let selectedMethod = methodId;
      if (expectedLoginAccount !== undefined) selectedMethod = "native-login";
      if (
        selectedMethod === undefined &&
        process.platform === "linux" &&
        nativeAuthentication?.type === "copilot"
      )
        selectedMethod = "native-login";
      signal.throwIfAborted();
      await this.authenticationPreflight();
      signal.throwIfAborted();
      if (
        selectedMethod === "native-login" &&
        nativeAuthentication?.type === "copilot"
      ) {
        this.nativeAuthenticating = true;
        const authLifetime = new AbortController();
        this.nativeController = authLifetime;
        const combined = AbortSignal.any([
          signal,
          authLifetime.signal,
          AbortSignal.timeout(600_000),
        ]);
        try {
          await this.shutdown(true);
          combined.throwIfAborted();
          await this.reserveProfile();
          combined.throwIfAborted();
          this.hooks.invalidated("authentication");
          this.lifetime = authLifetime;
          this.nativePending = copilotLogin(
            { ...this.agent, authentication: nativeAuthentication },
            await waitFor(
              agentEnvironment(this.agent, this.redactor),
              combined,
            ),
            onStep,
            requestInput,
            combined,
          );
          await this.nativePending;
          combined.throwIfAborted();
          this.hooks.authenticated("native_device_login");
          return;
        } catch (error) {
          await this.close();
          throw error;
        } finally {
          if (!this.cleanupFailed) this.nativePending = undefined;
          this.nativeController = undefined;
          this.nativeAuthenticating = false;
        }
      }
      await this.ensure();
      await this.authenticationPreflight();
      signal.throwIfAborted();
      const available = this.methods().filter((item) => item.type === "agent");
      if (selectedMethod === undefined) {
        if (available.length !== 1)
          throw new ServiceError(
            "auth_method_required",
            409,
            available.length === 0
              ? "The Agent advertises no supported login methods. Check its authentication adapter and selected profile."
              : `More than one login method is available. Choose --method from: ${available.map((item) => item.id).join(", ")}`,
          );
        selectedMethod = available[0]?.id;
      }
      const method = this.methods().find(
        (item) => item.id === selectedMethod && item.type === "agent",
      );
      if (method === undefined)
        throw new ServiceError(
          "auth_method_unsupported",
          409,
          `Unsupported login method. Supported Agent methods: ${available.map((item) => item.id).join(", ") || "none"}. Use agents auth to inspect methods.`,
        );
      this.hooks.invalidated("authentication");
      const combined = AbortSignal.any([signal, this.lifetime.signal]);
      try {
        await this.request(() =>
          this.connection!.agent.request(
            methods.agent.authenticate,
            { methodId: method.id },
            this.options(combined),
          ),
        );
        combined.throwIfAborted();
      } catch (error) {
        if (combined.aborted) {
          await this.close();
          throw new ServiceError("auth_cancelled", 409);
        }
        if (
          serviceError(error).code === "agent_auth_required" &&
          method.id === "copilot-login"
        )
          throw new ServiceError(
            "auth_bootstrap_required",
            409,
            "Copilot's ACP login method did not provide a device flow for this profile. On Linux, run agents login with --login-account YOUR-GITHUB-LOGIN to start verified native device login in the selected profile. This is your expected GitHub username, not a token. Do not retry the same copilot-login RPC.",
          );
        throw error;
      }
      this.hooks.authenticated("agent_authenticate");
    });
  }

  logout(): Promise<void> {
    return this.serialize(async () => {
      await this.authenticationPreflight();
      const initialized = await this.ensure();
      await this.authenticationPreflight();
      if (initialized.agentCapabilities?.auth?.logout == null)
        throw new ServiceError("agent_logout_unsupported", 409);
      await this.request(() =>
        this.connection!.agent.request(
          methods.agent.logout,
          {},
          this.options(),
        ),
      );
      this.hooks.invalidated("logout");
    });
  }

  private fail(error: ServiceError, lifetime: AbortController): void {
    if (lifetime !== this.lifetime || lifetime.signal.aborted) return;
    lifetime.abort(error);
    this.status = "failed";
    this.initialized = undefined;
    this.bindings.clear();
    this.hooks.disconnected(diagnostic(error));
    void this.close().catch(() => {
      this.hooks.event("owned_cleanup_failed");
    });
  }

  private clearIdle(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private idle(): void {
    this.clearIdle();
    if (
      this.connection === undefined ||
      this.lifetime.signal.aborted ||
      this.initialized === undefined
    )
      return;
    if (this.active > 0 || this.queuedCount > 0) {
      this.status = "ready";
      return;
    }
    if (
      this.unsupportedActivity ||
      this.activity.size === 0 ||
      [...this.activity.values()].includes("unknown") ||
      [...this.bindings].some((id) => !this.activity.has(id))
    ) {
      this.status = "idle_unknown";
      return;
    }
    this.status = "ready";
    if ([...this.activity.values()].includes("busy")) return;
    if (this.agent.idleTimeoutMs > 0)
      this.idleTimer = setTimeout(() => {
        void this.close().catch(() => {
          this.hooks.event("owned_cleanup_failed");
        });
      }, this.agent.idleTimeoutMs);
  }

  close(): Promise<void> {
    this.nativeController?.abort(new ServiceError("agent_closed"));
    return this.shutdown(false);
  }

  private shutdown(retainProfile: boolean): Promise<void> {
    if (!retainProfile) this.releaseProfileOnClose = true;
    if (this.closing !== undefined) return this.closing;
    this.releaseProfileOnClose = !retainProfile;
    this.revision++;
    this.clearIdle();
    this.lifetime.abort(new ServiceError("agent_closed"));
    this.connection?.close(new ServiceError("agent_closed"));
    this.connection = undefined;
    this.initialized = undefined;
    this.bindings.clear();
    this.activity.clear();
    this.detachedSessions.clear();
    this.unsupportedActivity = false;
    const owned = this.owned;
    const nativePending = this.nativePending;
    const profilePending = this.profilePending;
    this.closing = (async () => {
      await Promise.all([
        owned?.stop(),
        nativePending?.catch((error: unknown) => {
          if (serviceError(error).code === "owned_cleanup_failed") throw error;
        }),
        profilePending?.catch(() => {}),
      ]);
      if (this.owned === owned) this.owned = undefined;
      if (this.releaseProfileOnClose) {
        await this.profileLease?.release();
        this.profileLease = undefined;
      }
      this.status = "stopped";
    })()
      .catch((error: unknown) => {
        this.cleanupFailed = true;
        this.status = "failed";
        throw error;
      })
      .finally(() => {
        this.closing = undefined;
      });
    return this.closing;
  }
}
