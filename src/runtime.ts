import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HttpAdapter } from "./adapter.js";
import { checkStartup, HubError, localUrl, object, string } from "./common.js";
import {
  instanceId,
  validateConfig,
  type HubConfig,
  type ServiceConfig,
} from "./config.js";
import {
  endpointFromRegistry,
  instanceDirectory,
  isolatedEnvironment,
  nativeCode,
  OwnedProcess,
  waitReady,
} from "./processes.js";
import { serveHub, type ServiceRouter } from "./server.js";
import { TaskManager } from "./tasks.js";

export interface StartOptions {
  instance: string;
  config?: HubConfig;
  dataDir?: string;
  port?: number;
  codePath?: string;
  hostUrl?: string;
  hostToken?: string;
  authResource?: string;
  authToken?: string;
  apiToken?: string;
  startupTimeoutMs?: number;
  signal?: AbortSignal;
}

function environment(
  service: ServiceConfig,
  profile: string,
  expand: (value: string) => string,
): NodeJS.ProcessEnv {
  const env = isolatedEnvironment(profile);
  const context = service.launch?.environment;
  if (context?.mode === "inherited") {
    for (const key of [
      "HOME",
      "USERPROFILE",
      "APPDATA",
      "LOCALAPPDATA",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_CACHE_HOME",
      "VSCODE_CLI_DATA_DIR",
      "VSCODE_AGENT_FOLDER",
    ]) {
      delete env[key];
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
  }
  for (const key of context?.inherit ?? []) {
    if (process.env[key] === undefined)
      throw new HubError("configured_environment_variable_missing", 503);
    env[key] = process.env[key];
  }
  for (const [key, value] of Object.entries(context?.values ?? {}))
    env[key] = expand(value);
  return env;
}

async function connectService(
  service: ServiceConfig,
  root: string,
  options: StartOptions,
  secrets: string[],
): Promise<
  Awaited<ReturnType<ServiceRouter["select"]>> & { close(): Promise<void> }
> {
  const owned = await instanceDirectory(root, service.id);
  const children: OwnedProcess[] = [];
  const profile = join(owned.directory, "profile");
  const registry = join(owned.directory, "runs", randomUUID());
  const tokenPath = join(owned.directory, "connection-token");
  let tokenWritten = false;
  let manager: TaskManager | undefined;
  let failure: string | undefined;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      await manager?.close();
      let failed = false;
      for (const child of [...children].reverse()) {
        try {
          await child.stop();
        } catch {
          failed = true;
        }
      }
      if (tokenWritten) {
        try {
          await unlink(tokenPath);
        } catch {
          failed = true;
        }
      }
      if (failed) throw new HubError("cleanup_failed_lock_retained", 503);
      try {
        await owned.release();
      } catch {
        throw new HubError("cleanup_failed_lock_retained", 503);
      }
    })();
    return closing;
  };
  const unexpectedExit = (): void => {
    failure = "child_exited";
    manager?.failAll("child_exited_outcome_unknown");
    for (const child of children)
      void child.stop().catch(() => {
        failure = "child_cleanup_failed";
      });
  };
  try {
    checkStartup(options.signal);
    await Promise.all(
      [
        "tmp",
        "appdata",
        "localappdata",
        "config",
        "data",
        "cache",
        "cli-data",
        "server-data",
      ].map((name) =>
        mkdir(join(profile, name), { recursive: true, mode: 0o700 }),
      ),
    );
    const expand = (value: string): string =>
      value
        .replaceAll("{registryDirectory}", registry)
        .replaceAll("{profileDirectory}", profile)
        .replaceAll("{connectionTokenFile}", tokenPath);
    let url = "url" in service.endpoint ? service.endpoint.url : undefined;
    let connectionToken = options.hostToken ?? "";
    if ("url" in service.endpoint && service.endpoint.tokenEnv !== undefined) {
      const value = process.env[service.endpoint.tokenEnv];
      if (value === undefined || value === "")
        throw new HubError("connection_token_environment_missing", 503);
      connectionToken = value;
    }
    let hostInstanceId: string | undefined;
    let host: OwnedProcess | undefined;
    if (service.launch !== undefined) {
      if ("registry" in service.endpoint) {
        connectionToken = randomBytes(32).toString("hex");
        await mkdir(join(registry, "user-data"), {
          recursive: true,
          mode: 0o700,
        });
        await writeFile(tokenPath, connectionToken, {
          flag: "wx",
          mode: 0o600,
        });
        tokenWritten = true;
      }
      const env = environment(service, profile, expand);
      for (const key of [
        ...service.launch.environment.inherit,
        ...Object.keys(service.launch.environment.values),
      ]) {
        if (
          /token|secret|password|credential|authorization|api_?key/i.test(key)
        )
          secrets.push(env[key] ?? "");
      }
      host = new OwnedProcess(
        expand(service.launch.executable),
        service.launch.args.map(expand),
        env,
        unexpectedExit,
        false,
        service.launch.cwd,
      );
      children.push(host);
      if ("registry" in service.endpoint) {
        await waitReady(
          host,
          async () => {
            const entry = await endpointFromRegistry(registry);
            if (entry === undefined) return false;
            let record: Record<string, unknown>;
            try {
              record = object(JSON.parse(await readFile(entry, "utf8")));
            } catch {
              throw new HubError("unsupported_host_registry", 503);
            }
            const endpoint = object(record.endpoint);
            if (
              record.schemaVersion !== 2 ||
              record.type !== "standalone" ||
              endpoint.type !== "tcp" ||
              typeof endpoint.port !== "number" ||
              !Number.isInteger(endpoint.port) ||
              endpoint.port < 1 ||
              endpoint.port > 65535
            )
              throw new HubError("unsupported_host_registry", 503);
            hostInstanceId = string(record.instanceId);
            url = localUrl(
              `ws://${string(endpoint.host)}:${endpoint.port}`,
              "ws:",
            ).href;
            return true;
          },
          service.startupTimeoutMs,
          options.signal,
        );
      }
    }
    if (url === undefined) throw new HubError("host_endpoint_missing", 503);
    const adapterToken = randomBytes(32).toString("hex");
    secrets.push(connectionToken, adapterToken, options.authToken ?? "");
    const adapter = new OwnedProcess(
      process.execPath,
      [fileURLToPath(new URL("./adapter-worker.js", import.meta.url))],
      isolatedEnvironment(profile),
      unexpectedExit,
      true,
    );
    children.push(adapter);
    let adapterPort: number | undefined;
    let adapterFailed = false;
    adapter.child.on("message", (message: unknown) => {
      const value = object(message);
      if (value.type === "failed") adapterFailed = true;
      if (
        value.type === "ready" &&
        typeof value.port === "number" &&
        Number.isInteger(value.port) &&
        value.port > 0 &&
        value.port <= 65535
      )
        adapterPort = value.port;
    });
    adapter.child.send({
      url,
      connectionToken,
      apiToken: adapterToken,
      instance: service.id,
      ...(options.authResource === undefined
        ? {}
        : { authResource: options.authResource }),
      ...(options.authToken === undefined
        ? {}
        : { authToken: options.authToken }),
    });
    await waitReady(
      adapter,
      () => {
        host?.check();
        if (adapterFailed) throw new HubError("bridge_connection_failed", 503);
        return Promise.resolve(adapterPort !== undefined);
      },
      service.startupTimeoutMs,
      options.signal,
    );
    const client = new HttpAdapter(
      `http://127.0.0.1:${String(adapterPort)}`,
      adapterToken,
    );
    const initial = object(await client.call("hub_status", {}));
    if (initial.instance !== service.id)
      throw new HubError("adapter_identity_mismatch", 503);
    if (initial.status !== "ready") throw new HubError("bridge_not_ready", 503);
    host?.check();
    adapter.check();
    if (failure !== undefined) throw new HubError(failure, 503);
    manager = new TaskManager(client);
    return {
      manager,
      health: async () => {
        let health: Record<string, unknown>;
        try {
          if (failure !== undefined) throw new Error(failure);
          health = object(await client.call("hub_status", {}));
          if (health.status !== "ready") failure = "host_unavailable";
        } catch {
          failure ??= "adapter_unavailable";
          health = {};
        }
        if (failure !== undefined) {
          manager?.failAll(`${failure}_outcome_unknown`);
          health = { status: "unavailable", error: failure };
        }
        return {
          ...health,
          instance: service.id,
          host: {
            owned: service.lifecycle === "owned",
            ...(hostInstanceId === undefined
              ? {}
              : { instanceId: hostInstanceId }),
          },
        };
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

async function legacyConfig(options: StartOptions): Promise<HubConfig> {
  return validateConfig({
    version: 1,
    services: [
      {
        id: options.instance,
        kind: "ahp-websocket",
        lifecycle: options.hostUrl === undefined ? "owned" : "attached",
        startupTimeoutMs: options.startupTimeoutMs ?? 60_000,
        endpoint:
          options.hostUrl === undefined
            ? { registry: true }
            : { url: options.hostUrl },
        ...(options.hostUrl !== undefined
          ? {}
          : {
              launch: {
                executable: options.codePath ?? (await nativeCode()),
                args: [
                  "--log",
                  "off",
                  "agent",
                  "host",
                  "--new-instance",
                  "--foreground",
                  "--host",
                  "127.0.0.1",
                  "--port",
                  "0",
                  "--user-data-dir",
                  join("{registryDirectory}", "user-data"),
                  "--server-data-dir",
                  join("{profileDirectory}", "server-data"),
                  "--connection-token-file",
                  "{connectionTokenFile}",
                ],
                cwd: process.cwd(),
                environment: { mode: "inherited", inherit: [], values: {} },
              },
            }),
      },
    ],
  });
}

export async function start(options: StartOptions): Promise<{
  url: string;
  directory: string;
  close(): Promise<void>;
}> {
  checkStartup(options.signal);
  instanceId(options.instance);
  if (
    (options.authResource === undefined) !==
    (options.authToken === undefined)
  )
    throw new HubError("auth_resource_and_token_required_together", 400);
  if (
    options.config !== undefined &&
    [
      options.codePath,
      options.hostUrl,
      options.hostToken,
      options.authResource,
      options.authToken,
      options.startupTimeoutMs,
    ].some((value) => value !== undefined)
  )
    throw new HubError("configuration_legacy_options_conflict", 400);
  const config =
    options.config === undefined ? undefined : validateConfig(options.config);
  const owned = await instanceDirectory(
    options.dataDir ?? join(homedir(), ".ahplex"),
    options.instance,
  );
  const entries = new Map<
    string,
    Promise<Awaited<ReturnType<typeof connectService>>>
  >();
  const abort = new AbortController();
  const startupSignal =
    options.signal === undefined
      ? abort.signal
      : AbortSignal.any([options.signal, abort.signal]);
  const secrets: string[] = [];
  let stopped = false;
  const router: ServiceRouter = {
    services: () =>
      config?.services.map((service) => service.id) ?? [options.instance],
    select: (id) => {
      if (stopped)
        return Promise.reject(new HubError("service_unavailable", 503));
      if (!router.services().includes(id))
        return Promise.reject(new HubError("service_not_found", 404));
      let pending = entries.get(id);
      if (pending === undefined) {
        pending = (async () => {
          const current = config ?? (await legacyConfig(options));
          const service = current.services.find((item) => item.id === id);
          if (service === undefined)
            throw new HubError("service_not_found", 404);
          return connectService(
            service,
            join(owned.directory, "services"),
            { ...options, signal: startupSignal },
            secrets,
          );
        })();
        entries.set(id, pending);
      }
      return pending;
    },
    close: async () => {
      stopped = true;
      abort.abort();
      let failed = false;
      for (const pending of entries.values()) {
        let selected: Awaited<typeof pending>;
        try {
          selected = await pending;
        } catch (error) {
          if (
            error instanceof HubError &&
            error.code === "cleanup_failed_lock_retained"
          )
            failed = true;
          continue;
        }
        try {
          await selected.close();
        } catch {
          failed = true;
        }
      }
      if (failed) throw new HubError("cleanup_failed_lock_retained", 503);
    },
  };
  let hub: Awaited<ReturnType<typeof serveHub>>;
  try {
    hub = await serveHub(router, {
      ...(options.port === undefined ? {} : { port: options.port }),
      ...(options.apiToken === undefined ? {} : { token: options.apiToken }),
      secrets,
    });
  } catch (error) {
    await owned.release();
    throw error;
  }
  if (options.signal?.aborted === true) {
    await hub.close();
    try {
      await owned.release();
    } catch {
      throw new HubError("cleanup_failed_lock_retained", 503);
    }
    throw new HubError("startup_cancelled", 503);
  }
  let closing: Promise<void> | undefined;
  return {
    url: hub.url,
    directory: owned.directory,
    close: () => {
      closing ??= (async () => {
        await hub.close();
        await owned.release();
      })();
      return closing;
    },
  };
}
