import { access, stat, writeFile } from "node:fs/promises";
import { constants, type Stats } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ahpdFactory, COPILOT_RESOURCE } from "./ahpd.js";
import { ConfigurationError, record } from "./common.js";
import { validateConfig, type Config } from "./config.js";

export interface InitOptions {
  runtimeRoot: string;
  copilotCommand: string;
  workspace: string;
  config?: string | undefined;
  dataDir?: string | undefined;
  nodeCommand?: string | undefined;
  copilotProfile?: string | undefined;
  loginAccount?: string | undefined;
  instance?: string | undefined;
  port?: string | undefined;
  daemonPort?: string | undefined;
}

function localPath(value: string, flag: string): string {
  if (
    value.trim() === "" ||
    value === "-" ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  )
    throw new ConfigurationError(`--${flag} requires a non-empty local path`);
  return resolve(value);
}

function port(value: string, flag: string, minimum: number): number {
  if (!/^\d+$/u.test(value) || Number(value) < minimum || Number(value) > 65535)
    throw new ConfigurationError(`--${flag} must be ${minimum}-65535`);
  return Number(value);
}

const inputErrors = ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"];

function filesystemFailure(
  error: unknown,
  expected: string[],
  flag: string,
  message: string,
): never {
  if (
    record(error) &&
    typeof error.code === "string" &&
    expected.includes(error.code)
  )
    throw new ConfigurationError(`--${flag}: ${error.code}: ${message}`, {
      cause: error,
    });
  throw error;
}

async function requiredPath(
  path: string,
  flag: string,
  kind: "file" | "directory" | "executable",
): Promise<void> {
  let info: Stats;
  try {
    info = await stat(path);
  } catch (error) {
    filesystemFailure(
      error,
      inputErrors,
      flag,
      `required ${kind} unavailable: ${path}`,
    );
  }
  if (kind === "directory" ? !info.isDirectory() : !info.isFile())
    throw new ConfigurationError(
      `--${flag}: required ${kind} unavailable (wrong file kind): ${path}`,
    );
  if (kind === "executable") {
    try {
      await access(path, constants.X_OK);
    } catch (error) {
      filesystemFailure(
        error,
        inputErrors,
        flag,
        `required executable unavailable: ${path}`,
      );
    }
  }
}

export async function initialize(
  options: InitOptions,
  platform: NodeJS.Platform = process.platform,
): Promise<{ config: string; host: string }> {
  if (platform !== "linux")
    throw new ConfigurationError(
      "init requires Linux; native AHPD is Linux-only",
    );
  const file = localPath(options.config ?? "ahplex.json", "config");
  const dataDir = localPath(options.dataDir ?? ".ahplex", "data-dir");
  const runtime = localPath(options.runtimeRoot, "runtime-root");
  const workspace = localPath(options.workspace, "workspace");
  const copilot = localPath(options.copilotCommand, "copilot-command");
  const node = localPath(
    options.nodeCommand ?? process.execPath,
    "node-command",
  );
  const profile = localPath(
    options.copilotProfile ?? join(dataDir, "copilot-profile"),
    "copilot-profile",
  );
  const apiPort = port(options.port ?? "4280", "port", 0);
  const daemonPort = port(options.daemonPort ?? "19491", "daemon-port", 1);
  if (apiPort === daemonPort)
    throw new ConfigurationError("--port and --daemon-port must differ");
  const packages = join(runtime, "node_modules", "@ahpd");
  const server = join(packages, "server", "dist", "main.js");
  const plugin = join(packages, "agent-acp");
  const config: Config = validateConfig({
    schemaVersion: 1,
    instance: options.instance ?? "local",
    dataDir,
    listen: { host: "127.0.0.1", port: apiPort },
    hosts: [
      {
        id: "ahpd",
        label: "Owned AHPD / Copilot",
        adapter: "ahpd",
        startup: { command: node, args: [server], env: {}, cwd: workspace },
        lifecycle: {
          prepareOnStartup: false,
          onDemand: true,
          startupTimeoutMs: 60000,
        },
        options: {
          port: daemonPort,
          plugin,
          copilotCommand: copilot,
          copilotProfileDir: profile,
          ...(options.loginAccount === undefined
            ? {}
            : { loginAccount: options.loginAccount }),
          trustedDirectories: [pathToFileURL(workspace).href],
          runtimeRevision: "1d52d06c65ec1006d548bad7c477e032b9dc6782",
        },
        authentication: [
          { id: "native-login", mode: "login" },
          { id: "reuse-native-login", mode: "reuse" },
        ].map(({ id, mode }) => ({
          id,
          provider: "copilot",
          resource: COPILOT_RESOURCE,
          adapter: "copilot-cli",
          options: { mode },
        })),
      },
    ],
  });
  for (const host of config.hosts)
    ahpdFactory.validate?.(host, ahpdFactory.options.parse(host.options));
  await requiredPath(workspace, "workspace", "directory");
  await requiredPath(node, "node-command", "executable");
  await requiredPath(copilot, "copilot-command", "executable");
  for (const path of [
    server,
    join(packages, "sdk", "dist", "index.js"),
    join(plugin, "dist", "index.js"),
    join(plugin, "package.json"),
  ])
    await requiredPath(path, "runtime-root", "file");
  const document = JSON.stringify(config, null, 2) + "\n";
  try {
    await writeFile(file, document, {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    filesystemFailure(
      error,
      [...inputErrors, "EEXIST", "EISDIR", "EROFS"],
      "config",
      "Unable to create exclusively; parent must exist, existing files and symlinks are never replaced",
    );
  }
  return { config: file, host: "ahpd" };
}
