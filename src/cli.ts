#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  ConfigurationError,
  fields,
  record,
  ServiceError,
  text,
} from "./common.js";
import { loadConfig, parseJson, readStdin, type Overrides } from "./config.js";
import { start } from "./runtime.js";
import { humanOutput } from "./cli-output.js";
import { initialize } from "./init.js";

const HELP = `ahplex serve --config <file|-> [--listen-host ADDRESS] [--port N] [--instance ID] [--data-dir PATH]
ahplex init --runtime-root PATH --copilot-command PATH --workspace PATH [--config FILE]
ahplex health
ahplex hosts list|start|stop [--host ID]
ahplex sessions list|create --host ID [--provider ID --working-directory FILE-URI]
ahplex chats list|create --host ID --session URI
ahplex turns start|get|cancel --host ID --chat URI --turn ID [--text-file FILE|-]
ahplex auth begin|get|input --host ID [--method ID | --step ID --input-file FILE|-]
Client commands require --url BASE/v1 or AHPLEX_URL. --json emits only API bodies.
`;
const initFlags = [
  "runtime-root",
  "copilot-command",
  "workspace",
  "config",
  "data-dir",
  "node-command",
  "copilot-profile",
  "login-account",
  "instance",
  "port",
  "daemon-port",
];
const commands: Record<
  string,
  { method: string; path: string; required: string[] }
> = {
  health: { method: "GET", path: "health", required: [] },
  "hosts list": { method: "GET", path: "hosts", required: [] },
  "hosts start": { method: "POST", path: "start", required: ["host"] },
  "hosts stop": { method: "POST", path: "stop", required: ["host"] },
  "sessions list": { method: "GET", path: "sessions", required: ["host"] },
  "sessions create": {
    method: "POST",
    path: "sessions",
    required: ["host", "provider", "working-directory"],
  },
  "chats list": { method: "GET", path: "chats", required: ["host", "session"] },
  "chats create": {
    method: "POST",
    path: "chats",
    required: ["host", "session"],
  },
  "turns start": {
    method: "POST",
    path: "turns",
    required: ["host", "chat", "turn", "text-file"],
  },
  "turns get": {
    method: "GET",
    path: "turns",
    required: ["host", "chat", "turn"],
  },
  "turns cancel": {
    method: "POST",
    path: "turns/cancel",
    required: ["host", "chat", "turn"],
  },
  "auth begin": { method: "POST", path: "auth", required: ["host", "method"] },
  "auth get": { method: "GET", path: "auth", required: ["host"] },
  "auth input": {
    method: "POST",
    path: "auth/input",
    required: ["host", "step", "input-file"],
  },
};

const descriptions: Record<string, string> = {
  serve: "Run the service using one configuration file, or - for stdin.",
  init: "Create a private, static, on-demand Linux AHPD configuration, without starting or authenticating anything.",
  health: "Check whether the HTTP service is serving requests.",
  hosts: "List configured hosts or manage their owned processes.",
  sessions: "List or create native AHP working contexts on a host.",
  chats: "List or create conversation threads within a session.",
  turns: "Start, inspect or cancel an exact execution in a chat.",
  auth: "Begin upstream login, inspect its next step or submit requested input.",
};

function help(positionals: string[]): string {
  const command = positionals.slice(0, 2).join(" ");
  const group = positionals[0] ?? "";
  if (group === "serve")
    return `Usage: ${HELP.split("\n")[0]}\n\n${descriptions.serve}\nRelative config paths use the file directory; CLI --data-dir uses the current directory.\n`;
  if (group === "init")
    return `Usage: ahplex init --runtime-root PATH --copilot-command PATH --workspace PATH [options]\n\n${descriptions.init}\nRequired: --runtime-root installed prefix containing node_modules/@ahpd/{sdk,server,agent-acp}; --copilot-command native executable; --workspace existing trusted directory.\nOptions:\n  --config FILE          New file only (default: ./ahplex.json); parent must exist\n  --data-dir PATH        Dedicated service data (default: ./.ahplex)\n  --node-command PATH    Native Node executable (default: current process.execPath)\n  --copilot-profile PATH Explicit authorized profile, or new dedicated profile (default: DATA/copilot-profile)\n  --login-account LOGIN  Optional expected GitHub login; needed for native login receipt verification\n  --instance ID          Service identity (default: local)\n  --port N               Loopback API port, 0-65535 (default: 4280)\n  --daemon-port N        Distinct loopback AHPD port, 1-65535 (default: 19491)\n  --json                 Emit {config, host}, also in a TTY\n  --help, -h             Offline help; no setup side effects\nAll relative paths use the invocation directory. Requires preinstalled matching AHPD revision 1d52d06c65ec1006d548bad7c477e032b9dc6782 and Copilot 1.0.106; file checks do not verify provenance or credentials. No downloads, profile inspection, login, probe or service startup.\n`;
  const selected = commands[command];
  if (selected !== undefined) {
    const flags = selected.required
      .map((name) => `--${name} <${name}>`)
      .join(" ");
    return `Usage: ahplex ${command}${flags ? ` ${flags}` : ""} [--url <base/v1>] [--json]\n\n${descriptions[group] ?? ""}\nURL: --url or AHPLEX_URL is required.\n--json: exact API body, including in a TTY.\n--help, -h: show this help without making a request.\n${selected.required.includes("text-file") || selected.required.includes("input-file") ? "File input: use - to read stdin.\n" : ""}`;
  }
  if (descriptions[group] !== undefined) {
    const entries = Object.entries(commands)
      .filter(([name]) => name.startsWith(`${group} `))
      .map(
        ([name, spec]) =>
          `  ahplex ${name} ${spec.required.map((flag) => `--${flag} <${flag}>`).join(" ")}`,
      );
    return `${descriptions[group]}\n\nCommands:\n${entries.join("\n")}\n\nUse ahplex ${group} <command> --help for details.\nClient commands require --url <base/v1> or AHPLEX_URL.\n`;
  }
  return `AHPlex - owned AHP hosts, sessions, chats and turns\n\nUsage:\n${HELP}\nUse ahplex <group> <command> --help for details.\nTTY output is human-readable; redirected output retains the API body.\n`;
}

class CliUsageError extends ConfigurationError {
  constructor(
    message: string,
    readonly usage: string,
  ) {
    super(message);
  }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  try {
    await run(args);
  } catch (error) {
    if (error instanceof ConfigurationError) {
      const firstOption = args.findIndex((arg) => arg.startsWith("-"));
      throw new CliUsageError(
        error.message,
        help(args.slice(0, firstOption < 0 ? args.length : firstOption)),
      );
    }
    throw error;
  }
}

async function run(args: string[]): Promise<void> {
  if (args.length === 0) {
    process.stdout.write(help([]));
    return;
  }
  if (args.length === 1 && args[0] === "--version") {
    const data: unknown = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    );
    if (!record(data) || typeof data.version !== "string")
      throw new Error("Invalid package metadata");
    process.stdout.write(`${data.version}\n`);
    return;
  }
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      tokens: true,
      options: {
        ...Object.fromEntries(
          [
            "config",
            "listen-host",
            "port",
            "instance",
            "data-dir",
            "url",
            "host",
            "provider",
            "working-directory",
            "session",
            "chat",
            "turn",
            "text-file",
            "method",
            "step",
            "input-file",
            "runtime-root",
            "copilot-command",
            "workspace",
            "node-command",
            "copilot-profile",
            "login-account",
            "daemon-port",
          ].map((name) => [name, { type: "string" as const }]),
        ),
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch {
    throw new ConfigurationError("Unknown or malformed command options");
  }
  const names = parsed.tokens
    .filter((token) => token.kind === "option")
    .map((token) => token.name);
  if (new Set(names).size !== names.length)
    throw new ConfigurationError("Repeated options are not allowed");
  if (parsed.positionals[0] === "init") {
    if (parsed.positionals.length !== 1)
      throw new ConfigurationError("init does not accept subcommands");
    if (
      names.some(
        (name) => !initFlags.includes(name) && !["json", "help"].includes(name),
      )
    )
      throw new ConfigurationError("Unexpected init option");
  }
  if (
    parsed.values.help === true ||
    (args.length === 1 &&
      descriptions[parsed.positionals[0] ?? ""] !== undefined &&
      !["serve", "health", "init"].includes(parsed.positionals[0] ?? ""))
  ) {
    process.stdout.write(help(parsed.positionals));
    return;
  }
  delete parsed.values.help;
  const json = parsed.values.json === true;
  delete parsed.values.json;
  await execute(parsed.positionals, parsed.values, json);
}

async function execute(
  positionals: string[],
  values: Record<string, string | boolean | (string | boolean)[] | undefined>,
  json: boolean,
): Promise<void> {
  const get = (name: string): string => {
    const value = values[name];
    if (typeof value !== "string" || value === "")
      throw new ConfigurationError(
        `--${name} is required and must be non-empty`,
      );
    return value;
  };
  const command = positionals.join(" ");
  if (command === "init") {
    const optional = (name: string): string | undefined =>
      values[name] === undefined ? undefined : get(name);
    const result = await initialize({
      runtimeRoot: get("runtime-root"),
      copilotCommand: get("copilot-command"),
      workspace: get("workspace"),
      config: optional("config"),
      dataDir: optional("data-dir"),
      nodeCommand: optional("node-command"),
      copilotProfile: optional("copilot-profile"),
      loginAccount: optional("login-account"),
      instance: optional("instance"),
      port: optional("port"),
      daemonPort: optional("daemon-port"),
    });
    process.stdout.write(
      json || !process.stdout.isTTY
        ? `${JSON.stringify(result)}\n`
        : `Created ${JSON.stringify(result.config)} (host: ahpd).\nNo service started and authentication remains unverified.\nNext: ahplex serve --config '${result.config.replaceAll("'", "'\\''")}'\n`,
    );
    return;
  }
  if (command === "serve" && !json) {
    const allowed = ["config", "listen-host", "port", "instance", "data-dir"];
    if (Object.keys(values).some((key) => !allowed.includes(key)))
      throw new ConfigurationError("Unexpected serve option");
    const overrides: Overrides = {};
    if (values["listen-host"] !== undefined)
      overrides.listenHost = get("listen-host");
    if (values.instance !== undefined) overrides.instance = get("instance");
    if (values["data-dir"] !== undefined) overrides.dataDir = get("data-dir");
    if (values.port !== undefined) {
      const port = get("port");
      if (!/^\d+$/u.test(port) || Number(port) > 65535)
        throw new ConfigurationError("--port must be 0-65535");
      overrides.port = Number(port);
    }
    const config = await loadConfig(get("config"), overrides);
    let running: Awaited<ReturnType<typeof start>> | undefined;
    const interrupted = new AbortController();
    const stop = (): void => {
      interrupted.abort();
      if (running !== undefined) {
        void running.close().then(
          () => {
            process.removeListener("SIGINT", stop);
            process.removeListener("SIGTERM", stop);
          },
          () => {
            process.stderr.write("ahplex: cleanup_failed_lock_retained\n");
            process.exitCode = 1;
          },
        );
      }
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      running = await start(config);
      if (interrupted.signal.aborted) stop();
      else
        process.stdout.write(
          `ahplex ${config.instance} listening at ${running.url}\n`,
        );
    } catch (error) {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      throw error;
    }
    return;
  }
  const spec = commands[command];
  if (spec === undefined)
    throw new ConfigurationError("Unknown command; use --help");
  if (
    Object.keys(values).some(
      (key) => !spec.required.includes(key) && key !== "url",
    )
  )
    throw new ConfigurationError("Unexpected command option");
  for (const key of spec.required) get(key);
  let url: URL;
  try {
    const base = values.url === undefined ? process.env.AHPLEX_URL : get("url");
    if (base === undefined) throw new Error();
    url = new URL(base.replace(/\/$/u, "") + "/");
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      !url.pathname.endsWith("/v1/")
    )
      throw new Error();
  } catch {
    throw new ConfigurationError("Provide --url or AHPLEX_URL ending in /v1");
  }
  url.pathname += spec.required.includes("host")
    ? `hosts/${encodeURIComponent(get("host"))}/${spec.path}`
    : spec.path;
  let input: unknown;
  switch (command) {
    case "sessions create":
      input = {
        provider: get("provider"),
        workingDirectories: [get("working-directory")],
      };
      break;
    case "chats create":
      input = { session: get("session") };
      break;
    case "chats list":
      url.searchParams.set("session", get("session"));
      break;
    case "turns start":
      input = {
        chat: get("chat"),
        turnId: get("turn"),
        text: await inputFile(get("text-file")),
      };
      break;
    case "turns get":
      url.searchParams.set("chat", get("chat"));
      url.searchParams.set("turnId", get("turn"));
      break;
    case "turns cancel":
      input = { chat: get("chat"), turnId: get("turn") };
      break;
    case "auth begin":
      input = { methodId: get("method") };
      break;
    case "auth input": {
      const map = parseJson(await inputFile(get("input-file")));
      if (
        !record(map) ||
        Object.keys(map).length === 0 ||
        Object.values(map).some((item) => typeof item !== "string")
      )
        throw new ConfigurationError(
          "Auth input must be a non-empty JSON string map",
        );
      input = { stepId: get("step"), values: map };
      break;
    }
  }
  const response = await fetch(url, {
    method: spec.method,
    redirect: "error",
    signal: AbortSignal.timeout(120_000),
    ...(input === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        }),
  });
  const raw = await response.text();
  if (!response.ok) {
    let code = `HTTP ${response.status}`;
    try {
      const error = fields(fields(parseJson(raw), ["error"]).error, [
        "code",
        "message",
      ]);
      const reported = text(error.code, "code");
      if (/^[a-z][a-z0-9_]{0,80}$/u.test(reported)) code = reported;
    } catch {
      /* Gateways need not return the ahplex error shape. */
    }
    throw new ServiceError(code, response.status, code);
  }
  if (json) {
    if (raw !== "") process.stdout.write(`${raw}\n`);
  } else
    process.stdout.write(
      raw === ""
        ? response.status === 202
          ? "Accepted; poll for progress.\n"
          : "OK\n"
        : process.stdout.isTTY
          ? humanOutput(command, parseJson(raw))
          : `${raw}\n`,
    );
}

async function inputFile(path: string): Promise<string> {
  try {
    return path === "-" ? await readStdin() : await readFile(path, "utf8");
  } catch {
    throw new ConfigurationError("Unable to read input file");
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  void main().catch((error: unknown) => {
    process.stderr.write(
      `ahplex: ${error instanceof ConfigurationError ? error.message : error instanceof ServiceError ? error.code : "request_failed"}\n`,
    );
    if (error instanceof CliUsageError)
      process.stderr.write(`\n${error.usage}`);
    process.exitCode = error instanceof ConfigurationError ? 2 : 1;
  });
}
