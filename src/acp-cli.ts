#!/usr/bin/env node
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigurationError, record, ServiceError } from "./acp-common.js";
import { loadConfig, validateConfig } from "./acp-config.js";

const help = `AHPlex ACP - on-demand Agents and durable Session history

Usage:
  ahplex serve --config FILE [--port N --listen-host ADDRESS --data-dir PATH]
  ahplex init --agent-command PATH --workspace PATH [--config FILE --profile PATH --login-account LOGIN --data-dir PATH --port N]
  ahplex health --url BASE/v2
  ahplex agents list|auth|login|auth-input|logout [--agent ID --method ID --input-file FILE|-]
  ahplex sessions list|create|get [--agent ID --session UUID --working-directory PATH]
  ahplex turns list|start|get|cancel --session UUID [--turn UUID --text-file FILE|-]
  ahplex events list --session UUID [--turn UUID --after N --limit N]

Client commands require --url BASE/v2 or AHPLEX_URL. Output is JSON.
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
    console.log(`ahplex ${metadata.version} (HTTP /v2, ACP v1)`);
    return;
  }
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(help);
    return;
  }
  const command = args[0];
  if (command === "serve") {
    const { start } = await import("./acp-server.js");
    const opts = options(
      args.slice(1),
      ["config", "port", "listen-host", "data-dir"],
      ["config"],
    );
    const file = opts.config ?? "";
    const config = await loadConfig(
      file,
      file === "-" ? await input("-") : undefined,
    );
    if (opts.port !== undefined) config.listen.port = Number(opts.port);
    if (opts["listen-host"] !== undefined)
      config.listen.host = opts["listen-host"];
    if (opts["data-dir"] !== undefined)
      config.dataDir = resolve(opts["data-dir"]);
    const service = await start(validateConfig(config));
    console.log(`ahplex ${config.instance} listening at ${service.url}`);
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
        "workspace",
        "config",
        "profile",
        "login-account",
        "data-dir",
        "port",
      ],
      ["agent-command", "workspace"],
    );
    const file = resolve(opts.config ?? "ahplex.json");
    const directory = resolve(opts["data-dir"] ?? ".ahplex");
    const workspace = resolve(opts.workspace ?? "");
    const executable = opts["agent-command"] ?? "";
    try {
      if (
        !(await stat(workspace)).isDirectory() ||
        !(await stat(executable)).isFile()
      )
        throw new ConfigurationError("Workspace and executable must exist");
    } catch {
      throw new ConfigurationError("Workspace and executable must exist");
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
            profileDir: resolve(
              opts.profile ?? resolve(directory, "copilot-profile"),
            ),
            workspaces: [workspace],
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
      await writeFile(file, JSON.stringify(config, null, 2) + "\n", {
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
  const opts = options(
    args.slice(group === "health" ? 1 : 2),
    commandOptions[key] ?? [],
  );
  const requireOption = (name: string): string => {
    const value = opts[name];
    if (value === undefined)
      throw new ConfigurationError(`--${name} is required`);
    return value;
  };
  let base: URL;
  try {
    base = new URL(opts.url ?? process.env.AHPLEX_URL ?? "");
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
    throw new ConfigurationError("--url or AHPLEX_URL must name BASE/v2");
  }
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
  const response = await fetch(
    base.toString().replace(/\/$/u, "") +
      path +
      (query.size ? `?${query.toString()}` : ""),
    {
      method,
      ...(value === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
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
    console.error(error instanceof Error ? error.message : "Operation failed");
    process.exitCode = error instanceof ConfigurationError ? 2 : 1;
  });
}
