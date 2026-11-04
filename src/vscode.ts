import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketTransport } from "@microsoft/agent-host-protocol/ws";
import { bounded, ConfigurationError, record, ServiceError } from "./common.js";
import { objectSchema, type HostConfig } from "./config.js";
import {
  codec,
  type HostAdapterFactory,
  type HostContext,
  type HostDriver,
} from "./extensions.js";
import { isolatedEnvironment, type OwnedProcess } from "./processes.js";

const ownedOptions = new Set([
  "--cli-data-dir",
  "--user-data-dir",
  "--server-data-dir",
  "--connection-token",
  "--connection-token-file",
  "--without-connection-token",
  "--host",
  "--port",
  "--socket-path",
  "--new-instance",
  "--foreground",
  "--replace",
  "--log",
]);

export const vscodeFactory: HostAdapterFactory<Record<string, never>> = {
  id: "vscode",
  options: codec(objectSchema({})),
  validate(config) {
    if (
      config.startup.args.some(
        (arg) =>
          ownedOptions.has(arg.split("=")[0] ?? "") ||
          ["agent", "host", "--"].includes(arg),
      )
    )
      throw new ConfigurationError(
        "/startup/args: conflicting or positional VS Code arguments",
      );
    if (/\.(?:cmd|bat)$/iu.test(config.startup.command))
      throw new ConfigurationError(
        "/startup/command: use native code-tunnel.exe, not a shell shim",
      );
    for (const name of Object.keys(config.startup.env)) {
      if (
        Object.hasOwn(isolatedEnvironment(""), name) &&
        !["PATH", "Path"].includes(name)
      )
        throw new ConfigurationError(
          "/startup/env: adapter-owned isolation setting",
        );
    }
  },
  create: (context, config) => new VscodeDriver(context, config),
};

class VscodeDriver implements HostDriver {
  private child: OwnedProcess | undefined;
  private endpoint: URL | undefined;
  private tokenFile: string | undefined;
  constructor(
    private readonly context: HostContext,
    private readonly config: HostConfig,
  ) {}

  async start(signal: AbortSignal): Promise<void> {
    if (this.child !== undefined) {
      this.child.check();
      return;
    }
    const root = this.context.dataDir;
    const run = join(root, "r", randomBytes(6).toString("hex"));
    const env = isolatedEnvironment(root);
    for (const name of [
      "tmp",
      "appdata",
      "localappdata",
      "config",
      "data",
      "cache",
      "cli",
      "server",
    ])
      await mkdir(join(root, name), { recursive: true, mode: 0o700 });
    await mkdir(join(run, "user-data"), { recursive: true, mode: 0o700 });
    for (const [key, value] of Object.entries(this.config.startup.env))
      env[key] =
        typeof value === "string"
          ? value
          : await this.context.secrets.resolve(value);
    const token = randomBytes(32).toString("hex");
    const tokenFile = join(run, "token");
    await writeFile(tokenFile, token, { flag: "wx", mode: 0o600 });
    this.tokenFile = tokenFile;
    await this.context.secrets.resolve({ source: "file", path: tokenFile });
    this.child = this.context.processes.spawn({
      command: this.config.startup.command,
      args: [
        "--cli-data-dir",
        join(root, "cli"),
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
        join(run, "user-data"),
        "--server-data-dir",
        join(root, "server"),
        "--connection-token-file",
        tokenFile,
        ...this.config.startup.args,
      ],
      env,
      signal,
      ...(this.config.startup.cwd === undefined
        ? {}
        : { cwd: this.config.startup.cwd }),
    });
    const directory = join(
      run,
      "user-data",
      "agent-host",
      "local-endpoint",
      "entries",
    );
    for (;;) {
      signal.throwIfAborted();
      this.child.check();
      const endpoint = await registryEndpoint(directory);
      if (endpoint !== undefined) {
        endpoint.searchParams.set("tkn", token);
        this.endpoint = endpoint;
        return;
      }
      await delay(25, undefined, { signal });
    }
  }

  async openTransport(signal: AbortSignal): Promise<WebSocketTransport> {
    this.child?.check();
    if (this.endpoint === undefined)
      throw new ServiceError("host_not_started", 503);
    // The SDK WebSocket connector has no AbortSignal; close late connections too.
    const pending = WebSocketTransport.connect(this.endpoint);
    void pending.then(
      async (transport) => {
        if (signal.aborted) await transport.close();
      },
      () => {},
    );
    return bounded(pending, signal);
  }

  async stop(): Promise<void> {
    await this.context.processes.stop();
    this.child = undefined;
    this.endpoint = undefined;
    if (this.tokenFile !== undefined) {
      await unlink(this.tokenFile);
      this.tokenFile = undefined;
    }
  }

  verifyAuthentication(): Promise<{ status: "unknown"; code: string }> {
    return Promise.resolve({
      status: "unknown",
      code: "auth_verification_unsupported",
    });
  }

  async dispose(): Promise<void> {
    await this.stop();
  }
}

export async function registryEndpoint(
  directory: string,
): Promise<URL | undefined> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw new ServiceError("host_registry_unavailable", 503);
  }
  if (entries.length === 0) return undefined;
  if (entries.length !== 1)
    throw new ServiceError("ambiguous_owned_registry", 503);
  let value: unknown;
  try {
    value = JSON.parse(
      await readFile(join(directory, entries[0] ?? ""), "utf8"),
    );
  } catch {
    throw new ServiceError("invalid_owned_registry", 503);
  }
  if (
    !record(value) ||
    value.schemaVersion !== 2 ||
    value.type !== "standalone" ||
    typeof value.instanceId !== "string" ||
    value.instanceId === "" ||
    !record(value.endpoint) ||
    value.endpoint.type !== "tcp" ||
    !["127.0.0.1", "::1", "localhost"].includes(String(value.endpoint.host)) ||
    typeof value.endpoint.port !== "number" ||
    !Number.isInteger(value.endpoint.port) ||
    value.endpoint.port < 1 ||
    value.endpoint.port > 65535
  )
    throw new ServiceError("unsupported_owned_registry", 503);
  const host =
    value.endpoint.host === "::1" ? "[::1]" : String(value.endpoint.host);
  return new URL(`ws://${host}:${value.endpoint.port}`);
}
