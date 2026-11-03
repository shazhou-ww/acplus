import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HttpAdapter } from "./adapter.js";
import { checkStartup, HubError, localUrl, object, string } from "./common.js";
import {
  endpointFromRegistry,
  instanceDirectory,
  isolatedEnvironment,
  nativeCode,
  OwnedProcess,
  waitReady,
} from "./processes.js";
import { serveHub } from "./server.js";
import { TaskManager } from "./tasks.js";

export interface StartOptions {
  instance: string;
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

export async function start(options: StartOptions): Promise<{
  url: string;
  directory: string;
  close(): Promise<void>;
}> {
  checkStartup(options.signal);
  if (
    (options.authResource === undefined) !==
    (options.authToken === undefined)
  ) {
    throw new HubError("auth_resource_and_token_required_together", 400);
  }
  if (options.hostUrl !== undefined) localUrl(options.hostUrl, "ws:");
  const owned = await instanceDirectory(
    options.dataDir ?? join(homedir(), ".ahplex"),
    options.instance,
  );
  const children: OwnedProcess[] = [];
  let manager: TaskManager | undefined;
  let hub: Awaited<ReturnType<typeof serveHub>> | undefined;
  let health: Record<string, unknown> = {
    status: "starting",
    authentication: "required",
  };
  let closing: Promise<void> | undefined;
  const tokenPath = join(owned.directory, "connection-token");
  const registryDirectory = join(owned.directory, "runs", randomUUID());
  let tokenWritten = false;
  let hostInstanceId: string | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      manager?.failAll("service_stopped_outcome_unknown");
      const errors: unknown[] = [];
      for (const child of [...children].reverse()) {
        try {
          await child.stop();
        } catch (error) {
          errors.push(error);
        }
      }
      try {
        await hub?.close();
      } catch (error) {
        errors.push(error);
      }
      if (tokenWritten) {
        try {
          await unlink(tokenPath);
        } catch (error) {
          errors.push(error);
        }
      }
      // Retain the ownership lock if cleanup failed, to prevent unsafe reuse.
      if (errors.length > 0)
        throw new HubError("cleanup_failed_lock_retained", 503);
      await owned.release();
    })();
    return closing;
  };
  const unexpectedExit = (): void => {
    health = {
      status: "unavailable",
      authentication: "unknown",
      error: "child_exited",
    };
    manager?.failAll("child_exited_outcome_unknown");
    // Keep the HTTP health endpoint available; close only the processes we own.
    for (const child of children) {
      void child.stop().catch(() => {
        health = { ...health, error: "child_cleanup_failed" };
      });
    }
  };
  try {
    const env = isolatedEnvironment(owned.directory);
    await mkdir(join(registryDirectory, "user-data"), {
      recursive: true,
      mode: 0o700,
    });
    await Promise.all(
      ["tmp", "appdata", "localappdata", "server-data", "cli-data"].map(
        (name) =>
          mkdir(join(owned.directory, name), { recursive: true, mode: 0o700 }),
      ),
    );
    let url = options.hostUrl;
    let connectionToken = options.hostToken ?? "";
    const timeout = options.startupTimeoutMs ?? 60_000;
    if (url === undefined) {
      connectionToken = randomBytes(32).toString("hex");
      await writeFile(tokenPath, connectionToken, { flag: "wx", mode: 0o600 });
      tokenWritten = true;
      const executable = options.codePath ?? (await nativeCode());
      const host = new OwnedProcess(
        executable,
        [
          "--cli-data-dir",
          join(owned.directory, "cli-data"),
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
          join(registryDirectory, "user-data"),
          "--server-data-dir",
          join(owned.directory, "server-data"),
          "--connection-token-file",
          tokenPath,
        ],
        env,
        unexpectedExit,
      );
      children.push(host);
      await waitReady(
        host,
        async () => {
          const entry = await endpointFromRegistry(registryDirectory);
          if (entry === undefined) return false;
          const value: unknown = JSON.parse(await readFile(entry, "utf8"));
          const record = object(value);
          // VS Code endpoint entries use an explicit WebSocket address.
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
          const hostname = string(endpoint.host);
          url = localUrl(`ws://${hostname}:${endpoint.port}`, "ws:").href;
          return true;
        },
        timeout,
        options.signal,
      );
    }
    if (url === undefined) throw new HubError("host_endpoint_missing", 503);
    const adapterToken = randomBytes(32).toString("hex");
    const adapter = new OwnedProcess(
      process.execPath,
      [fileURLToPath(new URL("./adapter-worker.js", import.meta.url))],
      env,
      unexpectedExit,
      true,
    );
    children.push(adapter);
    let adapterPort: number | undefined;
    adapter.child.on("message", (message: unknown) => {
      const value = object(message);
      if (value.type === "ready" && typeof value.port === "number")
        adapterPort = value.port;
    });
    adapter.child.send({
      url,
      connectionToken,
      apiToken: adapterToken,
      instance: options.instance,
      ...(options.authResource === undefined
        ? {}
        : { authResource: options.authResource }),
      ...(options.authToken === undefined
        ? {}
        : { authToken: options.authToken }),
    });
    await waitReady(
      adapter,
      () => Promise.resolve(adapterPort !== undefined),
      timeout,
      options.signal,
    );
    const client = new HttpAdapter(
      `http://127.0.0.1:${String(adapterPort)}`,
      adapterToken,
    );
    health = object(await client.call("hub_status", {}));
    if (health.instance !== options.instance)
      throw new HubError("adapter_identity_mismatch", 503);
    manager = new TaskManager(client);
    hub = await serveHub(manager, {
      ...(options.port === undefined ? {} : { port: options.port }),
      ...(options.apiToken === undefined ? {} : { token: options.apiToken }),
      secrets: [connectionToken, adapterToken, options.authToken ?? ""],
      health: async () => {
        if (health.status !== "unavailable") {
          try {
            health = object(await client.call("hub_status", {}));
          } catch {
            health = {
              status: "unavailable",
              authentication: "unknown",
              error: "adapter_unavailable",
            };
            manager?.failAll("adapter_unavailable_outcome_unknown");
          }
        }
        return {
          ...health,
          instance: options.instance,
          host: {
            owned: options.hostUrl === undefined,
            ...(hostInstanceId === undefined
              ? {}
              : { instanceId: hostInstanceId }),
          },
        };
      },
    });
    checkStartup(options.signal);
    return { url: hub.url, directory: owned.directory, close };
  } catch (error) {
    await close();
    throw error;
  }
}
