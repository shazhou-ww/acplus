import { join } from "node:path";
import { MultiHostClient } from "@microsoft/agent-host-protocol/hosts";
import { Authentication } from "./authentication.js";
import { deviceFactory, tokenFactory } from "./auth-adapters.js";
import { Redactor, ServiceError } from "./common.js";
import { validateConfig, type Config } from "./config.js";
import { AdapterRegistry } from "./extensions.js";
import { githubCliFactory } from "./github-cli.js";
import { NativeHost } from "./native.js";
import { lockDirectory, ProcessOwner, Secrets } from "./processes.js";
import { serve } from "./server.js";
import { vscodeFactory } from "./vscode.js";

export class Service {
  readonly redactor = new Redactor();
  readonly hosts = new Map<
    string,
    { native: NativeHost; auth: Authentication }
  >();
  private readonly multi = new MultiHostClient();
  private closing: Promise<void> | undefined;
  private constructor(
    readonly config: Config,
    private readonly registry: AdapterRegistry,
    private readonly release: () => Promise<void>,
  ) {}

  private initialize(requestTimeoutMs: number, authTimeoutMs: number): void {
    const secrets = new Secrets(this.redactor);
    for (const host of this.config.hosts) {
      const processes = new ProcessOwner();
      const driver = this.registry.host(host.adapter).create(
        {
          hostId: host.id,
          dataDir: join(this.config.dataDir, "hosts", host.id),
          secrets,
          processes,
          logger: { event: () => {} },
          connection: (generation) =>
            this.select(host.id).native.connection(generation),
        },
        host,
      );
      const native = new NativeHost(
        host,
        driver,
        processes,
        this.multi,
        requestTimeoutMs,
      );
      this.hosts.set(host.id, {
        native,
        auth: new Authentication(
          native,
          this.registry,
          secrets,
          this.redactor,
          authTimeoutMs,
        ),
      });
    }
  }

  static async create(
    input: Config,
    options: {
      registry?: AdapterRegistry;
      requestTimeoutMs?: number;
      authTimeoutMs?: number;
    } = {},
  ): Promise<Service> {
    const config = validateConfig(structuredClone(input));
    const registry = options.registry ?? new AdapterRegistry();
    registry.addHostAdapter(vscodeFactory);
    registry.addAuthenticationAdapter(tokenFactory);
    registry.addAuthenticationAdapter(deviceFactory);
    registry.addAuthenticationAdapter(githubCliFactory());
    await registry.load(config);
    let release: (() => Promise<void>) | undefined;
    let service: Service | undefined;
    try {
      release = await lockDirectory(config.dataDir);
      service = new Service(config, registry, release);
      service.initialize(
        options.requestTimeoutMs ?? 30_000,
        options.authTimeoutMs ?? 600_000,
      );
      return service;
    } catch (error) {
      if (service !== undefined) await service.close();
      else {
        await release?.();
        await registry.dispose();
      }
      throw error;
    }
  }

  select(id: string) {
    if (this.closing !== undefined)
      throw new ServiceError("service_stopping", 503);
    const host = this.hosts.get(id);
    if (host === undefined) throw new ServiceError("host_not_found", 404);
    return host;
  }

  prepare(): void {
    for (const { native } of this.hosts.values())
      if (native.config.lifecycle.prepareOnStartup) native.start();
  }

  close(): Promise<void> {
    this.closing ??= this.shutdown();
    return this.closing;
  }

  private async shutdown(): Promise<void> {
    const outcomes = await Promise.allSettled(
      [...this.hosts.values()].map(async ({ native, auth }) => {
        try {
          await auth.close();
        } finally {
          await native.close();
        }
      }),
    );
    const cleanup = await Promise.allSettled([
      this.multi.shutdown(),
      this.registry.dispose(),
    ]);
    if (
      [...outcomes, ...cleanup].some((result) => result.status === "rejected")
    )
      throw new ServiceError("cleanup_failed_lock_retained", 503);
    await this.release();
  }
}

export async function start(
  config: Config,
): Promise<{ url: string; close(): Promise<void> }> {
  const service = await Service.create(config);
  try {
    const http = await serve(service);
    service.prepare();
    return http;
  } catch (error) {
    await service.close();
    throw error;
  }
}
