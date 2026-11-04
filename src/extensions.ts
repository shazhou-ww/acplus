import { pathToFileURL } from "node:url";
import type { AhpTransport } from "@microsoft/agent-host-protocol/client";
import type { HostClientHandle } from "@microsoft/agent-host-protocol/hosts";
import type { Config, HostConfig, SecretReference } from "./config.js";
import { validator } from "./config.js";
import { ConfigurationError, record } from "./common.js";
import type { ProcessOwner } from "./processes.js";

export interface OptionsCodec<T> {
  schema: Readonly<Record<string, unknown>>;
  parse(input: unknown): T;
}
export interface AuthTarget {
  hostId: string;
  provider: string;
  resource: string;
  generation?: number;
}
export type AuthVerification = {
  status: "authenticated" | "required" | "unknown";
  code?: string;
};
export interface UpstreamCredential {
  token: string;
  scopes?: string[];
  expiresAt?: string;
}
export interface RedactingLogger {
  event(code: string): void;
}
export interface SecretResolver {
  resolve(reference: SecretReference): Promise<string>;
}
export interface HostContext {
  readonly hostId: string;
  readonly dataDir: string;
  readonly secrets: SecretResolver;
  readonly processes: ProcessOwner;
  readonly logger: RedactingLogger;
  connection(generation?: number): HostClientHandle;
}
export interface HostDriver {
  start(signal: AbortSignal): Promise<void>;
  openTransport(signal: AbortSignal): Promise<AhpTransport>;
  stop(signal: AbortSignal): Promise<void>;
  verifyAuthentication(
    target: AuthTarget,
    signal: AbortSignal,
  ): Promise<AuthVerification>;
  dispose(): Promise<void>;
}
export interface HostAdapterFactory<T> {
  id: string;
  options: OptionsCodec<T>;
  validate?(config: HostConfig, options: T): void;
  create(context: HostContext, config: HostConfig, options: T): HostDriver;
}
export interface LinkStepContent {
  kind: "link";
  url: string;
  userCode?: string;
}
export interface InputStepContent {
  kind: "input";
  fields: string[];
}
export interface AuthInput {
  stepId: string;
  values: Record<string, string>;
}
export interface AuthenticationContext {
  readonly target: AuthTarget;
  readonly expiresAt: string;
  readonly secrets: SecretResolver;
  readonly processes: ProcessOwner;
  readonly logger: RedactingLogger;
  publishStep(step: LinkStepContent): void;
  requestInput(step: InputStepContent, signal: AbortSignal): Promise<AuthInput>;
  submitCredential(
    credential: UpstreamCredential,
    signal: AbortSignal,
  ): Promise<AuthVerification>;
  verifyAuthentication(signal: AbortSignal): Promise<AuthVerification>;
}
export interface AuthenticationAdapter {
  run(context: AuthenticationContext, signal: AbortSignal): Promise<void>;
}
export interface AuthenticationAdapterFactory<T> {
  id: string;
  options: OptionsCodec<T>;
  create(options: T): AuthenticationAdapter;
}
export interface ExtensionPlugin<T> {
  apiVersion: 1;
  id: string;
  options: OptionsCodec<T>;
  register(registry: AdapterRegistry, options: T): void;
  dispose?(): Promise<void>;
}

export function codec<T>(schema: Record<string, unknown>): OptionsCodec<T> {
  const validate = validator.compile<T>(schema);
  return {
    schema,
    parse(input) {
      if (!validate(input))
        throw new ConfigurationError(
          validate.errors
            ?.map(
              (error) =>
                `${error.instancePath || "/"}: ${error.message ?? "invalid"}`,
            )
            .join("; "),
        );
      return input;
    },
  };
}

function parseOptions<T>(options: OptionsCodec<T>, input: unknown): T {
  codec(options.schema).parse(input);
  return options.parse(input);
}

export class AdapterRegistry {
  private readonly hosts = new Map<
    string,
    {
      validate(config: HostConfig): void;
      create(context: HostContext, config: HostConfig): HostDriver;
    }
  >();
  private readonly auth = new Map<
    string,
    (options: unknown) => AuthenticationAdapter
  >();
  private readonly plugins: ExtensionPlugin<unknown>[] = [];

  addHostAdapter<T>(factory: HostAdapterFactory<T>): void {
    if (this.hosts.has(factory.id))
      throw new ConfigurationError("Duplicate host adapter");
    this.hosts.set(factory.id, {
      validate: (config) => {
        factory.validate?.(
          config,
          parseOptions(factory.options, config.options),
        );
        parseOptions(factory.options, config.options);
      },
      create: (context, config) =>
        factory.create(
          context,
          config,
          parseOptions(factory.options, config.options),
        ),
    });
  }

  addAuthenticationAdapter<T>(factory: AuthenticationAdapterFactory<T>): void {
    if (this.auth.has(factory.id))
      throw new ConfigurationError("Duplicate authentication adapter");
    this.auth.set(factory.id, (options) =>
      factory.create(parseOptions(factory.options, options)),
    );
  }

  host(id: string) {
    const factory = this.hosts.get(id);
    if (factory === undefined)
      throw new ConfigurationError("Unresolved host adapter");
    return factory;
  }

  authentication(id: string, options: unknown): AuthenticationAdapter {
    const factory = this.auth.get(id);
    if (factory === undefined)
      throw new ConfigurationError("Unresolved authentication adapter");
    return factory(options);
  }

  async load(config: Config): Promise<void> {
    try {
      for (const item of config.plugins ?? []) {
        const module: unknown = await import(pathToFileURL(item.module).href);
        if (
          !record(module) ||
          !isPlugin(module.default) ||
          module.default.id !== item.id
        )
          throw new ConfigurationError("Invalid plugin definition or ID");
        const plugin = module.default;
        this.plugins.push(plugin);
        plugin.register(this, parseOptions(plugin.options, item.options));
      }
      for (const host of config.hosts) {
        this.host(host.adapter).validate(host);
        for (const binding of host.authentication)
          this.authentication(binding.adapter, binding.options);
      }
    } catch (error) {
      await this.dispose();
      if (error instanceof ConfigurationError) throw error;
      throw new ConfigurationError(
        "Plugin loading or adapter validation failed",
      );
    }
  }

  async dispose(): Promise<void> {
    const outcomes = await Promise.allSettled(
      this.plugins.reverse().map(async (plugin) => {
        await plugin.dispose?.();
      }),
    );
    this.plugins.length = 0;
    if (outcomes.some((result) => result.status === "rejected"))
      throw new ConfigurationError("Plugin cleanup failed");
  }
}

function isPlugin(value: unknown): value is ExtensionPlugin<unknown> {
  return (
    record(value) &&
    value.apiVersion === 1 &&
    typeof value.id === "string" &&
    record(value.options) &&
    record(value.options.schema) &&
    typeof value.options.parse === "function" &&
    typeof value.register === "function" &&
    (value.dispose === undefined || typeof value.dispose === "function")
  );
}
