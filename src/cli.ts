#!/usr/bin/env node
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { ConfigurationError, record, ServiceError } from "./acp-common.js";
import { loadConfig, validateConfig } from "./acp-config.js";
import { history, integer } from "./acp-history.js";
import {
  defaultIdleGraceMs,
  localHeaders,
  localService,
  type LocalOwner,
} from "./local-service.js";

const help = `acplus - on-demand Agents and durable Session history

Usage:
  acplus serve [--config FILE] [--port N --listen-host ADDRESS --data-dir PATH]
  acplus init --agent-command PATH [--config FILE --profile PATH --login-account LOGIN --data-dir PATH --port N]
  acplus health --url BASE/v2
  acplus agents list|auth|login|auth-input|logout [--agent ID --method ID --input-file FILE|-]
  acplus sessions list|create|get [--agent ID --session UUID --working-directory PATH]
  acplus turns list|start|get|cancel --session UUID [--turn UUID --text-file FILE|-]
  acplus events list --session UUID [--turn UUID --after N --limit N]

Without a URL, sessions/turns list|get and events list read committed SQLite.
Local sessions create and turns start discover/start a private background service.
Local turns cancel requires the live owner; it never starts a replacement.
Local options: --config FILE --data-dir PATH --idle-grace-ms N (100..86400000;
default 30000, only automatically launched services). Output is JSON.
--url BASE/v2 or ACPLUS_URL always uses HTTP only. Agents/health require a URL.
Default YAML config: ~/.acplus/acplus.yaml; data: ~/.acplus/state.
All reads and Session creation are local. Login is explicit, not a paid probe.
Login returns a flow; use agents auth to inspect public link/code and input steps.
`;

function options(args: string[], allowed: string[], required: string[] = []) {
  const result: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (
      name === undefined ||
      !name.startsWith("--") ||
      !allowed.includes(name.slice(2)) ||
      Object.hasOwn(result, name.slice(2)) ||
      value === undefined ||
      value.startsWith("--")
    )
      throw new ConfigurationError("Unknown, repeated, or incomplete option");
    result[name.slice(2)] = value;
  }
  if (required.some((name) => !Object.hasOwn(result, name)))
    throw new ConfigurationError(`Required options: ${required.join(", ")}`);
  return result;
}

async function input(file: string): Promise<string> {
  if (file !== "-") {
    if ((await stat(file)).size > 1048576)
      throw new ConfigurationError("Input exceeds 1 MiB");
    return readFile(file, "utf8");
  }
  let result = "";
  for await (const chunk of process.stdin) {
    if (!Buffer.isBuffer(chunk)) throw new ConfigurationError("Invalid stdin");
    result += chunk.toString("utf8");
    if (Buffer.byteLength(result) > 1048576)
      throw new ConfigurationError("Input exceeds 1 MiB");
  }
  return result;
}

function print(value: unknown): void {
  if (value !== null) console.log(JSON.stringify(value));
}

export async function run(args: string[]): Promise<void> {
  if (args.length === 1 && (args[0] === "--version" || args[0] === "-V")) {
    const metadata: unknown = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    );
    if (!record(metadata) || typeof metadata.version !== "string")
      throw new ServiceError("package_metadata_unavailable", 503);
    console.log(`acplus ${metadata.version} (HTTP /v2, ACP v1)`);
    return;
  }
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(help);
    return;
  }
  const command = args[0];
  if (command === "serve" || command === "_auto-serve") {
    const { start, startManaged } = await import("./acp-server.js");
    const opts = options(args.slice(1), [
      "config",
      "port",
      "listen-host",
      "data-dir",
      ...(command === "_auto-serve" ? ["idle-grace-ms"] : []),
    ]);
    const file = opts.config ?? join(homedir(), ".acplus", "acplus.yaml");
    const config = await loadConfig(
      file,
      file === "-" ? await input("-") : undefined,
    );
    if (opts.port !== undefined) config.listen.port = Number(opts.port);
    if (opts["listen-host"] !== undefined)
      config.listen.host = opts["listen-host"];
    if (opts["data-dir"] !== undefined)
      config.dataDir = resolve(opts["data-dir"]);
    const service =
      command === "_auto-serve"
        ? await startManaged(
            validateConfig({
              ...config,
              listen: { host: "127.0.0.1", port: 0 },
            }),
            integer(opts["idle-grace-ms"], defaultIdleGraceMs, 100, 86400000),
          )
        : await start(validateConfig(config));
    if (command === "_auto-serve" && process.connected) process.disconnect?.();
    console.log(`acplus ${config.instance} listening at ${service.url}`);
    let stopping = false;
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      void service.close().then(
        () => {
          process.exitCode = 0;
        },
        (error: unknown) => {
          console.error(
            error instanceof ServiceError ? error.code : "cleanup_failed",
          );
          process.exitCode = 1;
        },
      );
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    return;
  }
  if (command === "init") {
    const opts = options(
      args.slice(1),
      [
        "agent-command",
        "config",
        "profile",
        "login-account",
        "data-dir",
        "port",
      ],
      ["agent-command"],
    );
    const home = join(homedir(), ".acplus");
    const file = resolve(opts.config ?? join(home, "acplus.yaml"));
    const directory = resolve(opts["data-dir"] ?? join(home, "state"));
    const executable = opts["agent-command"] ?? "";
    try {
      if (!(await stat(executable)).isFile())
        throw new ConfigurationError("Agent executable must exist");
    } catch {
      throw new ConfigurationError("Agent executable must exist");
    }
    const config = validateConfig(
      {
        schemaVersion: 2,
        instance: "local",
        dataDir: directory,
        listen: { host: "127.0.0.1", port: Number(opts.port ?? 4280) },
        agents: [
          {
            id: "copilot",
            label: "Copilot CLI",
            command: executable,
            profileDir: resolve(opts.profile ?? join(home, "copilot-profile")),
            ...(opts["login-account"] === undefined
              ? {}
              : {
                  authentication: {
                    type: "copilot",
                    loginAccount: opts["login-account"],
                  },
                }),
          },
        ],
      },
      dirname(file),
    );
    try {
      if (opts.config === undefined)
        await mkdir(home, { recursive: true, mode: 0o700 });
      await writeFile(file, stringify(config), {
        flag: "wx",
        mode: 0o600,
      });
    } catch {
      throw new ConfigurationError(
        "Configuration must be a new file in an existing directory",
      );
    }
    print({ config: file });
    return;
  }
  const group = args[0] ?? "";
  const action = group === "health" ? "" : (args[1] ?? "");
  const commandOptions: Record<string, string[]> = {
    health: ["url"],
    "agents:list": ["url"],
    "agents:auth": ["url", "agent"],
    "agents:login": ["url", "agent", "method"],
    "agents:auth-input": ["url", "agent", "input-file"],
    "agents:logout": ["url", "agent"],
    "sessions:list": ["url", "agent", "limit", "cursor"],
    "sessions:create": ["url", "agent", "working-directory"],
    "sessions:get": ["url", "session"],
    "turns:list": ["url", "session", "limit", "cursor"],
    "turns:start": ["url", "session", "turn", "text-file"],
    "turns:get": ["url", "session", "turn"],
    "turns:cancel": ["url", "session", "turn"],
    "events:list": ["url", "session", "turn", "after", "limit"],
  };
  const key = group === "health" ? "health" : `${group}:${action}`;
  if (!Object.hasOwn(commandOptions, key))
    throw new ConfigurationError("Unknown command");
  const opts = options(args.slice(group === "health" ? 1 : 2), [
    ...(commandOptions[key] ?? []),
    ...(["sessions", "turns", "events"].includes(group)
      ? ["config", "data-dir"]
      : []),
    ...(["sessions:create", "turns:start"].includes(key)
      ? ["idle-grace-ms"]
      : []),
  ]);
  const requireOption = (name: string): string => {
    const value = opts[name];
    if (value === undefined)
      throw new ConfigurationError(`--${name} is required`);
    return value;
  };
  let path = "";
  let method = "GET";
  let value: unknown;
  const query = new URLSearchParams();
  if (group === "health") path = "/health";
  else if (group === "agents") {
    if (action === "list") path = "/agents";
    else {
      path = `/agents/${encodeURIComponent(requireOption("agent"))}/auth`;
      if (action === "login") {
        method = "POST";
        value = { methodId: requireOption("method") };
      } else if (action === "auth-input") {
        path += "/input";
        method = "POST";
        try {
          value = JSON.parse(await input(requireOption("input-file")));
        } catch {
          throw new ConfigurationError("Expected JSON auth input");
        }
      } else if (action === "logout") {
        path += "/logout";
        method = "POST";
        value = {};
      }
    }
  } else if (group === "sessions") {
    path = "/sessions";
    if (action === "create") {
      method = "POST";
      value = {
        agentId: requireOption("agent"),
        workingDirectory: requireOption("working-directory"),
      };
    } else if (action === "get") path += `/${requireOption("session")}`;
    else if (action === "list") {
      if (opts.agent !== undefined) query.set("agentId", opts.agent);
    }
  } else if (group === "events") {
    path = `/sessions/${requireOption("session")}/events`;
    if (opts.turn !== undefined) query.set("turnId", opts.turn);
    if (opts.after !== undefined) query.set("after", opts.after);
  } else if (group === "turns") {
    path = `/sessions/${requireOption("session")}/turns`;
    if (action === "start") {
      method = "POST";
      value = {
        turnId: requireOption("turn"),
        text: await input(requireOption("text-file")),
      };
    } else if (action === "get") path += `/${requireOption("turn")}`;
    else if (action === "cancel") {
      path += `/${requireOption("turn")}/cancel`;
      method = "POST";
      value = {};
    }
  }
  for (const name of ["limit", "cursor"])
    if (opts[name] !== undefined) query.set(name, opts[name]);
  let local: LocalOwner | undefined;
  const explicitUrl = opts.url ?? process.env.ACPLUS_URL;
  let address = explicitUrl;
  if (
    explicitUrl === undefined &&
    ["sessions", "turns", "events"].includes(group)
  ) {
    const file = opts.config ?? join(homedir(), ".acplus", "acplus.yaml");
    const config = await loadConfig(file);
    if (opts["data-dir"] !== undefined)
      config.dataDir = resolve(opts["data-dir"]);
    if (method === "GET") {
      const { Store } = await import("./acp-store.js");
      const store = new Store(
        join(config.dataDir, "sessions.sqlite"),
        undefined,
        true,
      );
      try {
        print(
          store.snapshot(() =>
            history(
              store,
              new URL(
                `/v2${path}?${query.toString()}`,
                "http://acplus.invalid",
              ),
              (id) => {
                if (!config.agents.some((agent) => agent.id === id))
                  throw new ServiceError("agent_not_found", 404);
              },
            ),
          ),
        );
      } finally {
        store.close();
      }
      return;
    }
    local = await localService(
      config,
      resolve(file),
      integer(opts["idle-grace-ms"], defaultIdleGraceMs, 100, 86400000),
      action !== "cancel",
    );
    address = local.url;
  }
  let base: URL;
  try {
    base = new URL(address ?? "");
    if (
      !["http:", "https:"].includes(base.protocol) ||
      base.pathname.replace(/\/$/u, "") !== "/v2" ||
      base.username ||
      base.password ||
      base.search ||
      base.hash
    )
      throw new Error();
  } catch {
    throw new ConfigurationError("--url or ACPLUS_URL must name BASE/v2");
  }
  const requestPath = path + (query.size ? `?${query.toString()}` : "");
  const response = await fetch(
    base.toString().replace(/\/$/u, "") +
      path +
      (query.size ? `?${query.toString()}` : ""),
    {
      method,
      headers: {
        ...(local === undefined
          ? {}
          : localHeaders(local, method, `/v2${requestPath}`)),
        ...(value === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(value === undefined
        ? {}
        : {
            body: JSON.stringify(value),
          }),
      signal: AbortSignal.timeout(30000),
    },
  );
  const raw = await response.text();
  if (!response.ok)
    throw new ServiceError("http_request_failed", response.status, raw);
  if (raw !== "") {
    let result: unknown;
    try {
      result = JSON.parse(raw);
    } catch {
      throw new ServiceError("invalid_http_response", 502);
    }
    print(result);
  }
}

if (
  process.argv[1] !== undefined &&
  (await realpath(resolve(process.argv[1]))) === fileURLToPath(import.meta.url)
) {
  void run(process.argv.slice(2)).catch((error: unknown) => {
    if (process.connected) {
      process.send?.({
        error:
          error instanceof ServiceError
            ? error.code
            : "local_service_configuration_failed",
      });
      process.disconnect?.();
    }
    console.error(error instanceof Error ? error.message : "Operation failed");
    process.exitCode = error instanceof ConfigurationError ? 2 : 1;
  });
}
