import { randomBytes } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { ActionType } from "@microsoft/agent-host-protocol";
import type { HostClientHandle } from "@microsoft/agent-host-protocol/hosts";
import { WebSocketTransport } from "@microsoft/agent-host-protocol/ws";
import { bounded, ConfigurationError, record, ServiceError } from "./common.js";
import { objectSchema, type HostConfig } from "./config.js";
import {
  codec,
  type AuthenticationContext,
  type HostAdapterFactory,
  type HostContext,
  type HostDriver,
  type AuthTarget,
  type AuthVerification,
  type ExecutionObservation,
} from "./extensions.js";
import { nativeCopilotLogin } from "./copilot-cli.js";
import { isolatedEnvironment, type OwnedProcess } from "./processes.js";

export interface AhpdOptions {
  port: number;
  plugin: string;
  copilotCommand: string;
  copilotProfileDir: string;
  loginAccount?: string;
  trustedDirectories: string[];
  runtimeRevision: "1d52d06c65ec1006d548bad7c477e032b9dc6782";
}
export const COPILOT_RESOURCE = "https://api.github.com/repos";

export const ahpdFactory: HostAdapterFactory<AhpdOptions> = {
  id: "ahpd",
  options: codec(
    objectSchema(
      {
        port: { type: "integer", minimum: 1, maximum: 65535 },
        plugin: { type: "string", minLength: 1 },
        copilotCommand: { type: "string", minLength: 1 },
        copilotProfileDir: { type: "string", minLength: 1 },
        loginAccount: {
          type: "string",
          pattern: "^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$",
        },
        trustedDirectories: {
          type: "array",
          minItems: 1,
          uniqueItems: true,
          items: { type: "string", format: "uri", pattern: "^file:/" },
        },
        runtimeRevision: { const: "1d52d06c65ec1006d548bad7c477e032b9dc6782" },
      },
      [
        "port",
        "plugin",
        "copilotCommand",
        "copilotProfileDir",
        "trustedDirectories",
        "runtimeRevision",
      ],
    ),
  ),
  validate(config, options) {
    if (
      [options.plugin, options.copilotCommand, options.copilotProfileDir].some(
        (path) => !isAbsolute(path),
      ) ||
      /\.(?:cmd|bat)$/iu.test(config.startup.command) ||
      /\.(?:cmd|bat)$/iu.test(options.copilotCommand)
    )
      throw new ConfigurationError(
        "ahpd requires explicit native runtime paths",
      );
    // Arguments are only an executable prefix (e.g. node /locked/main.js).
    if (
      config.startup.args.length > 1 ||
      config.startup.args.some(
        (arg) => !isAbsolute(arg) || !/\.(?:mjs|js)$/iu.test(arg),
      ) ||
      Object.keys(config.startup.env).some(
        (key) => key !== "PATH" && key !== "Path",
      )
    )
      throw new ConfigurationError("ahpd owns startup flags and environment");
    for (const binding of config.authentication)
      if (
        binding.adapter !== "copilot-cli" ||
        binding.provider !== "copilot" ||
        binding.resource !== COPILOT_RESOURCE
      )
        throw new ConfigurationError(
          "ahpd requires native Copilot authentication",
        );
    for (const uri of options.trustedDirectories) {
      const url = new URL(uri);
      if (url.search !== "" || url.hash !== "" || url.username !== "")
        throw new ConfigurationError("ahpd requires plain trusted file URIs");
      try {
        fileURLToPath(url, { windows: false });
      } catch {
        throw new ConfigurationError(
          "ahpd requires local Linux workspace URIs",
        );
      }
    }
  },
  create: (context, config, options) =>
    new AhpdDriver(context, config, options),
};

export function ahpdEnvironment(
  root: string,
  profile: string,
): NodeJS.ProcessEnv {
  return {
    ...isolatedEnvironment(root),
    COPILOT_HOME: profile,
    COPILOT_AUTO_UPDATE: "false",
    GH_CONFIG_DIR: join(root, "gh"),
    DBUS_SESSION_BUS_ADDRESS: "disabled:",
    NO_COLOR: "1",
  };
}

export class AhpdDriver implements HostDriver {
  private child: OwnedProcess | undefined;
  private endpoint: URL | undefined;
  private tokenFile: string | undefined;
  private epoch = 0;
  private evidence:
    { generation: number; epoch: number; account?: string } | undefined;
  private readonly executions = new Map<
    string,
    { turnId: string; generation: number; epoch: number }
  >();
  constructor(
    private readonly context: HostContext,
    private readonly config: HostConfig,
    private readonly options: AhpdOptions,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  async start(signal: AbortSignal): Promise<void> {
    if (this.platform !== "linux")
      throw new ServiceError("host_platform_unsupported", 503);
    if (this.child !== undefined) {
      this.child.check();
      return;
    }
    const root = this.context.dataDir;
    const directory = join(root, "config", "ahpd");
    for (const path of [
      ...["tmp", "appdata", "localappdata", "data", "cache", "gh"].map((name) =>
        join(root, name),
      ),
      join(directory, "agents"),
      this.options.copilotProfileDir,
    ])
      await mkdir(path, { recursive: true, mode: 0o700 });
    const token = randomBytes(32).toString("hex");
    const tokenFile = join(root, "connection-token");
    await writeFile(tokenFile, token, { mode: 0o600, flag: "wx" });
    this.tokenFile = tokenFile;
    await this.context.secrets.resolve({ source: "file", path: tokenFile });
    const configFile = join(directory, "config.json");
    await writeFile(
      configFile,
      JSON.stringify({
        host: "127.0.0.1",
        port: this.options.port,
        connectionTokenFile: tokenFile,
        sessions: "file",
        paths: this.options.trustedDirectories.map((uri) =>
          fileURLToPath(uri, { windows: false }),
        ),
        plugins: [this.options.plugin],
        updateCheck: false,
      }),
      { mode: 0o600 },
    );
    await writeFile(
      join(directory, "agents", "copilot.json"),
      JSON.stringify({
        id: "copilot",
        name: "Copilot CLI",
        engine: "acp",
        owner: "host",
        config: {
          command: this.options.copilotCommand,
          args: ["--acp"],
          hostTools: false,
          env: {
            COPILOT_HOME: this.options.copilotProfileDir,
            COPILOT_AUTO_UPDATE: "false",
          },
        },
      }),
      { mode: 0o600 },
    );
    signal.throwIfAborted();
    this.child = this.context.processes.spawn({
      command: this.config.startup.command,
      args: [
        ...this.config.startup.args,
        "--config-file",
        configFile,
        "--no-cwd",
      ],
      env: this.environment(),
      signal,
      output: "pipe",
      ...(this.config.startup.cwd === undefined
        ? {}
        : { cwd: this.config.startup.cwd }),
    });
    let tail = "";
    const classify = (chunk: Buffer): void => {
      tail = (tail + chunk.toString("utf8")).slice(-4096);
      for (const [pattern, code] of [
        [/--no-cwd serves only what/u, "host_configuration_paths_required"],
        [/EADDRINUSE|address already in use/iu, "host_port_in_use"],
        [
          /ERR_MODULE_NOT_FOUND|ERR_UNSUPPORTED_DIR_IMPORT|Cannot find (?:module|package)/u,
          "host_runtime_module_unavailable",
        ],
      ] as const)
        if (pattern.test(tail)) this.child?.setFailureCode(code);
    };
    this.child.child.stdout?.on("data", classify);
    this.child.child.stderr?.on("data", classify);
    this.endpoint = new URL(`ws://127.0.0.1:${this.options.port}`);
    this.endpoint.searchParams.set("tkn", token);
  }

  async openTransport(signal: AbortSignal): Promise<WebSocketTransport> {
    if (this.endpoint === undefined)
      throw new ServiceError("host_not_started", 503);
    for (;;) {
      signal.throwIfAborted();
      this.child?.check();
      const pending = WebSocketTransport.connect(this.endpoint);
      void pending.then(
        async (transport) => {
          if (signal.aborted) await transport.close();
        },
        () => {},
      );
      try {
        return await bounded(pending, signal);
      } catch {
        signal.throwIfAborted();
        await delay(50, undefined, { signal });
      }
    }
  }

  async configure(
    handle: HostClientHandle,
    signal: AbortSignal,
    clientId: string,
  ): Promise<void> {
    const events = handle.rawClient().events();
    try {
      const sent = handle.dispatch("ahp-root://", {
        type: ActionType.RootConfigChanged,
        config: {
          workspaceTrust: {
            enabled: true,
            trustedUris: this.options.trustedDirectories,
          },
        },
      });
      await bounded(
        (async () => {
          for await (const { channel, event } of events) {
            handle.checkAlive();
            if (
              event.type !== "action" ||
              channel !== "ahp-root://" ||
              event.params.origin?.clientId !== clientId ||
              event.params.origin.clientSeq !== sent.clientSeq ||
              event.params.action.type !== ActionType.RootConfigChanged
            )
              continue;
            if (event.params.rejectionReason !== undefined)
              throw new ServiceError("workspace_trust_rejected", 409);
            return;
          }
          throw new ServiceError("workspace_trust_unconfirmed", 503);
        })(),
        signal,
      );
    } finally {
      await events.return?.();
    }
  }

  async authenticateNative(
    context: AuthenticationContext,
    mode: "login" | "reuse",
    signal: AbortSignal,
  ): Promise<void> {
    const handle = this.authenticationHandle(context.target);
    if (mode === "login") {
      this.invalidateAuthentication();
      const epoch = this.epoch;
      const receipt = await nativeCopilotLogin(
        context,
        this.options.copilotCommand,
        this.environment(),
        signal,
        this.platform,
      );
      handle.checkAlive();
      this.authenticationHandle(context.target);
      if (epoch !== this.epoch)
        throw new ServiceError("upstream_auth_required", 409);
      if (
        receipt.authenticated &&
        receipt.account !== undefined &&
        this.options.loginAccount?.toLowerCase() ===
          receipt.account.toLowerCase()
      )
        this.evidence = {
          generation: handle.generation,
          epoch,
          account: receipt.account,
        };
    }
  }

  private environment(): NodeJS.ProcessEnv {
    const env = ahpdEnvironment(
      this.context.dataDir,
      this.options.copilotProfileDir,
    );
    for (const [key, value] of Object.entries(this.config.startup.env))
      if (typeof value === "string") env[key] = value;
    return env;
  }

  invalidateAuthentication(): void {
    this.epoch++;
    this.evidence = undefined;
    this.executions.clear();
  }

  observeExecution(observation: ExecutionObservation): void {
    if (observation.provider !== "copilot") return;
    try {
      this.context.connection(observation.generation).checkAlive();
    } catch {
      return;
    }
    if (observation.phase === "submitted") {
      this.executions.set(observation.chat, {
        turnId: observation.turnId,
        generation: observation.generation,
        epoch: this.epoch,
      });
    } else {
      const pending = this.executions.get(observation.chat);
      if (
        pending?.turnId !== observation.turnId ||
        pending.generation !== observation.generation ||
        pending.epoch !== this.epoch
      )
        return;
      this.executions.delete(observation.chat);
      this.evidence = { generation: observation.generation, epoch: this.epoch };
    }
  }

  private authenticationHandle(target: AuthTarget): HostClientHandle {
    if (
      target.hostId !== this.context.hostId ||
      target.provider !== "copilot" ||
      target.resource !== COPILOT_RESOURCE ||
      target.generation === undefined
    )
      throw new ServiceError("auth_target_unsupported", 409);
    return this.context.connection(target.generation);
  }

  async verifyAuthentication(
    target: AuthTarget,
    signal: AbortSignal,
  ): Promise<AuthVerification> {
    const handle = this.authenticationHandle(target);
    const epoch = this.epoch;
    const pending = handle.rawClient().subscribe("ahp-root://");
    void pending.then(
      async ({ subscription }) => {
        if (signal.aborted) await subscription.close();
      },
      () => {},
    );
    const { result, subscription } = await bounded(pending, signal);
    await subscription.close();
    handle.checkAlive();
    this.authenticationHandle(target);
    if (epoch !== this.epoch) return { status: "unknown" };
    if (result.snapshot === undefined)
      throw new ServiceError("auth_invalid_response", 502);
    const state = result.snapshot.state;
    if (
      !("agents" in state) ||
      !state.agents.some(
        (agent) =>
          agent.provider === "copilot" &&
          agent.protectedResources?.some(
            (resource) => resource.resource === COPILOT_RESOURCE,
          ),
      )
    )
      throw new ServiceError("auth_target_not_advertised", 409);
    const config: unknown = state.config;
    const values: unknown = record(config) ? config.values : undefined;
    const account: unknown = record(values)
      ? values["ahpd.copilotAccount"]
      : undefined;
    if (account !== undefined) {
      if (record(account) && account.status === "signedOut") {
        this.invalidateAuthentication();
        return { status: "required" };
      }
      if (
        record(account) &&
        account.status === "signedIn" &&
        typeof account.observedAt === "number" &&
        account.observedAt > 0 &&
        account.observedAt <= Date.now()
      )
        return { status: "authenticated" };
      this.invalidateAuthentication();
      return { status: "unknown" };
    }
    return this.evidence?.generation === handle.generation &&
      this.evidence.epoch === this.epoch
      ? { status: "authenticated" }
      : { status: "unknown", code: "auth_verification_unsupported" };
  }

  async stop(): Promise<void> {
    this.invalidateAuthentication();
    await this.context.processes.stop();
    this.child = undefined;
    this.endpoint = undefined;
    if (this.tokenFile !== undefined) {
      await unlink(this.tokenFile);
      this.tokenFile = undefined;
    }
  }

  async dispose(): Promise<void> {
    await this.stop();
  }
}
