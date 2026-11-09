#!/usr/bin/env node
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import {
  ConfigurationError,
  diagnostic,
  record,
  ServiceError,
  text,
  uuid,
} from "./acp-common.js";
import { loadConfig, validateConfig } from "./acp-config.js";
import { history, integer } from "./acp-history.js";
import { helpFor, printResult } from "./cli-display.js";
import type { Config } from "./acp-types.js";
import {
  defaultIdleGraceMs,
  localHeaders,
  localService,
  type LocalOwner,
} from "./local-service.js";

function options(args: string[], allowed: string[], required: string[] = []) {
  const result: Record<string, string> = {};
  for (let index = 0; index < args.length;) {
    const name = args[index];
    if (
      name === undefined ||
      !name.startsWith("--") ||
      !allowed.includes(name.slice(2)) ||
      Object.hasOwn(result, name.slice(2))
    )
      throw new ConfigurationError("Unknown, repeated, or incomplete option");
    if (["--json", "--yes", "--no-wait"].includes(name)) {
      result[name.slice(2)] = "true";
      index += 1;
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || (value.startsWith("--") && name !== "--text"))
      throw new ConfigurationError("Unknown, repeated, or incomplete option");
    result[name.slice(2)] = value;
    index += 2;
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

function localHistory(config: Config, path: string): Promise<unknown> {
  return import("./acp-store.js").then(({ Store }) => {
    const store = new Store(
      join(config.dataDir, "sessions.sqlite"),
      undefined,
      true,
    );
    try {
      return store.snapshot(() =>
        history(store, new URL(`/v2${path}`, "http://acplus.invalid"), (id) => {
          if (!config.agents.some((agent) => agent.id === id))
            throw new ServiceError("agent_not_found", 404);
        }),
      );
    } finally {
      store.close();
    }
  });
}

function isHelp(args: string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--help" || arg === "-h") return true;
    if (arg.startsWith("--") && !["--json", "--yes", "--no-wait"].includes(arg))
      index += 1;
  }
  return false;
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
  if (args.length === 0 || isHelp(args)) {
    console.log(
      helpFor(
        args.slice(
          0,
          args[0]?.startsWith("-") ? 0 : args[1]?.startsWith("-") ? 1 : 2,
        ),
      ),
    );
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
      "json",
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
    if (opts.json === "true")
      console.log(
        JSON.stringify({ instance: config.instance, url: service.url }),
      );
    else console.log(`acplus ${config.instance} listening at ${service.url}`);
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
        "agent",
        "agent-command",
        "config",
        "profile",
        "login-account",
        "data-dir",
        "port",
        "json",
      ],
      ["agent", "agent-command"],
    );
    const home = join(homedir(), ".acplus");
    const file = resolve(opts.config ?? join(home, "acplus.yaml"));
    const directory = resolve(opts["data-dir"] ?? join(home, "state"));
    const executable = opts["agent-command"] ?? "";
    const agentId = opts.agent ?? "";
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
            id: agentId,
            label: agentId,
            command: executable,
            profileDir: resolve(
              opts.profile ?? join(home, `${agentId}-profile`),
            ),
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
    printResult("init", { config: file }, opts.json === "true");
    return;
  }
  const group = args[0] ?? "";
  const action = group === "health" ? "" : (args[1] ?? "");
  const commandOptions: Record<string, string[]> = {
    health: ["url"],
    "agents:list": ["url"],
    "agents:auth": ["url", "agent", "confirm-storage"],
    "agents:login": ["url", "agent", "method", "no-wait", "timeout-ms"],
    "agents:auth-input": ["url", "agent", "input-file"],
    "agents:logout": ["url", "agent"],
    "sessions:list": ["url", "agent", "limit", "cursor"],
    "sessions:create": ["url", "agent", "working-directory", "name"],
    "sessions:get": ["url", "session"],
    "sessions:delete": ["url", "session", "yes"],
    "sessions:send": [
      "url",
      "session",
      "turn",
      "text",
      "text-file",
      "no-wait",
      "timeout-ms",
    ],
    "turns:list": ["url", "session", "limit", "cursor"],
    "turns:start": ["url", "session", "turn", "text", "text-file"],
    "turns:get": ["url", "session", "turn"],
    "turns:cancel": ["url", "session", "turn"],
    "events:list": ["url", "session", "turn", "after", "limit"],
  };
  const key = group === "health" ? "health" : `${group}:${action}`;
  if (!Object.hasOwn(commandOptions, key))
    throw new ConfigurationError("Unknown command");
  const rawOptions = args.slice(group === "health" ? 1 : 2);
  if (
    group === "sessions" &&
    ["send", "delete"].includes(action) &&
    rawOptions[0] !== undefined &&
    !rawOptions[0].startsWith("--")
  ) {
    const selector = rawOptions.shift() ?? "";
    let message: string | undefined;
    const next = rawOptions.at(0);
    if (action === "send" && next !== undefined && !next.startsWith("--"))
      message = rawOptions.shift();
    rawOptions.unshift("--session", selector);
    if (message !== undefined) rawOptions.push("--text", message);
  }
  const opts = options(rawOptions, [
    ...(commandOptions[key] ?? []),
    "config",
    "data-dir",
    "json",
    ...([
      "sessions:create",
      "turns:start",
      "sessions:send",
      "sessions:delete",
      "agents:login",
    ].includes(key)
      ? ["idle-grace-ms"]
      : []),
  ]);
  const requireOption = (name: string): string => {
    const value = opts[name];
    if (value === undefined)
      throw new ConfigurationError(`--${name} is required`);
    return value;
  };
  const requiredOptions: Record<string, string[]> = {
    "agents:auth": ["agent"],
    "agents:login": ["agent"],
    "agents:auth-input": ["agent", "input-file"],
    "agents:logout": ["agent"],
    "sessions:create": ["agent", "working-directory"],
    "sessions:get": ["session"],
    "sessions:delete": ["session"],
    "sessions:send": ["session"],
    "turns:list": ["session"],
    "turns:start": ["session"],
    "turns:get": ["session", "turn"],
    "turns:cancel": ["session", "turn"],
    "events:list": ["session"],
  };
  for (const name of requiredOptions[key] ?? []) requireOption(name);
  const json = opts.json === "true";
  if (
    opts["confirm-storage"] !== undefined &&
    !["yes", "no"].includes(opts["confirm-storage"])
  )
    throw new ConfigurationError(
      "--confirm-storage must be yes or no; credentials are never accepted here",
    );
  const outputKind = group === "health" ? "health" : `${group} ${action}`;
  const isSend = key === "sessions:send";
  const isStart = isSend || key === "turns:start";
  const waitTimeout = integer(opts["timeout-ms"], 300000, 100, 86400000);
  if (
    isStart &&
    (opts.text === undefined) === (opts["text-file"] === undefined)
  )
    throw new ConfigurationError(
      'Supply exactly one message: --text TEXT, --text-file FILE|-, or sessions send SESSION "MESSAGE"',
    );
  if (opts["no-wait"] === "true" && opts["timeout-ms"] !== undefined)
    throw new ConfigurationError(
      "--timeout-ms requires waiting; do not combine it with --no-wait",
    );
  if (isStart) {
    opts.turn = Object.hasOwn(opts, "turn")
      ? requireOption("turn")
      : randomUUID();
    uuid(opts.turn, "turnId");
  }
  let local: LocalOwner | undefined;
  let config: Config | undefined;
  const explicitUrl = opts.url ?? process.env.ACPLUS_URL;
  const file = opts.config ?? join(homedir(), ".acplus", "acplus.yaml");
  if (explicitUrl === undefined) {
    config = await loadConfig(file);
    if (opts["data-dir"] !== undefined)
      config.dataDir = resolve(opts["data-dir"]);
  }
  const remoteRequest = async (
    address: string,
    method: string,
    path: string,
    value?: unknown,
    timeoutMs = 30000,
  ): Promise<unknown> => {
    let base: URL;
    try {
      base = new URL(address);
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
    const response = await fetch(base.toString().replace(/\/$/u, "") + path, {
      method,
      headers: {
        ...(local === undefined
          ? {}
          : localHeaders(local, method, `/v2${path}`)),
        ...(value === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const raw = await response.text();
    let result: unknown = null;
    try {
      if (raw !== "") result = JSON.parse(raw) as unknown;
    } catch {
      if (!response.ok)
        throw new ServiceError("http_request_failed", response.status, raw);
      throw new ServiceError("invalid_http_response", 502);
    }
    if (!response.ok) {
      if (
        record(result) &&
        record(result.error) &&
        typeof result.error.code === "string" &&
        typeof result.error.message === "string"
      )
        throw new ServiceError(
          result.error.code,
          response.status,
          result.error.code === "agent_logout_unsupported"
            ? "This Agent does not support logout through ACP. Nothing was reported as logged out; use the Agent's own supported logout command with the selected profile. Session history is unchanged."
            : result.error.message,
        );
      throw new ServiceError("http_request_failed", response.status, raw);
    }
    return result;
  };
  const read = (path: string, timeoutMs = 30000): Promise<unknown> =>
    config === undefined
      ? remoteRequest(explicitUrl ?? "", "GET", path, undefined, timeoutMs)
      : localHistory(config, path);
  if (
    opts.session !== undefined &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
      opts.session,
    )
  ) {
    const prefix = opts.session.toLowerCase();
    if (!/^[0-9a-f]{8}[0-9a-f-]*$/u.test(prefix) || prefix.length >= 36)
      throw new ConfigurationError(
        "Session must be a UUID or a unique prefix of at least 8 characters",
      );
    const matches: string[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await read(
        `/sessions?limit=1000${cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`}`,
      );
      if (
        !record(page) ||
        !Array.isArray(page.items) ||
        (page.nextCursor !== null && typeof page.nextCursor !== "string")
      )
        throw new ServiceError("invalid_history_response", 502);
      for (const item of page.items) {
        if (!record(item) || typeof item.sessionId !== "string")
          throw new ServiceError("invalid_history_response", 502);
        if (item.sessionId.startsWith(prefix)) matches.push(item.sessionId);
      }
      cursor =
        typeof page.nextCursor === "string" ? page.nextCursor : undefined;
      if (cursor !== undefined && cursors.has(cursor))
        throw new ServiceError("invalid_history_response", 502);
      if (cursor !== undefined) cursors.add(cursor);
    } while (cursor !== undefined);
    const selected = matches[0];
    if (matches.length !== 1 || selected === undefined)
      throw new ServiceError(
        matches.length === 0
          ? "session_not_found"
          : "session_selector_ambiguous",
        matches.length === 0 ? 404 : 409,
        "Session selector must match exactly one Session; use a longer prefix or full UUID",
      );
    opts.session = selected;
  }
  if (key === "sessions:delete" && opts.yes !== "true") {
    if (!process.stdin.isTTY || !process.stderr.isTTY)
      throw new ConfigurationError(
        "Deletion requires --yes in non-interactive use",
      );
    const terminal = createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    try {
      const answer = await terminal.question(
        `Permanently delete Session ${requireOption("session")} and all its local history? Type yes: `,
      );
      if (answer.trim().toLowerCase() !== "yes")
        throw new ConfigurationError("Deletion cancelled");
    } finally {
      terminal.close();
    }
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
        value =
          opts.method === undefined
            ? {}
            : { methodId: text(opts.method, "method") };
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
    if (action === "send") {
      path += `/${requireOption("session")}/turns`;
      method = "POST";
      value = {
        turnId: opts.turn,
        text: text(
          opts.text ?? (await input(requireOption("text-file"))),
          "text",
        ),
      };
    } else if (action === "delete") {
      path += `/${requireOption("session")}`;
      method = "DELETE";
    } else if (action === "create") {
      method = "POST";
      value = {
        agentId: requireOption("agent"),
        workingDirectory: resolve(
          text(requireOption("working-directory"), "workingDirectory"),
        ),
        ...(opts.name === undefined ? {} : { name: text(opts.name, "name") }),
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
        turnId: opts.turn,
        text: text(
          opts.text ?? (await input(requireOption("text-file"))),
          "text",
        ),
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
  let address = explicitUrl;
  if (config !== undefined) {
    if (method === "GET" && ["sessions", "turns", "events"].includes(group)) {
      printResult(
        outputKind,
        await read(path + (query.size ? `?${query.toString()}` : "")),
        json,
      );
      return;
    }
    local = await localService(
      config,
      resolve(file),
      integer(opts["idle-grace-ms"], defaultIdleGraceMs, 100, 86400000),
      action !== "cancel" &&
        action !== "auth-input" &&
        opts["confirm-storage"] === undefined &&
        group !== "health",
    );
    address = local.url;
  }
  const requestPath = path + (query.size ? `?${query.toString()}` : "");
  if (isStart) {
    if (json)
      console.error(
        JSON.stringify({
          event: "turn_submitting",
          sessionId: opts.session,
          turnId: opts.turn,
        }),
      );
    else
      console.error(
        `Session: ${opts.session}\nTurn: ${opts.turn}\nKeep these IDs to reconcile a lost response; do not resend with a new Turn ID.`,
      );
  }
  const result = await remoteRequest(address ?? "", method, requestPath, value);
  if (key === "agents:auth" && opts["confirm-storage"] !== undefined) {
    if (
      !record(result) ||
      !record(result.flow) ||
      result.flow.status !== "action_required" ||
      !record(result.flow.step) ||
      result.flow.step.kind !== "input" ||
      typeof result.flow.step.stepId !== "string" ||
      !Array.isArray(result.flow.step.fields) ||
      result.flow.step.fields.length !== 1 ||
      result.flow.step.fields[0] !== "confirmPlaintextStorage"
    )
      throw new ServiceError(
        "auth_input_unavailable",
        409,
        "There is no active plaintext-storage consent step. Inspect agents auth; do not start a replacement login.",
      );
    await remoteRequest(address ?? "", "POST", `${path}/input`, {
      stepId: result.flow.step.stepId,
      values: { confirmPlaintextStorage: opts["confirm-storage"] },
    });
    const updated = await remoteRequest(address ?? "", "GET", path);
    printResult(outputKind, updated, json);
    return;
  }
  if (key === "agents:login") {
    if (
      !record(result) ||
      typeof result.operationId !== "string" ||
      typeof result.expiresAt !== "string" ||
      ![
        "pending",
        "action_required",
        "succeeded",
        "failed",
        "expired",
      ].includes(String(result.status))
    )
      throw new ServiceError(
        "invalid_auth_response",
        502,
        "The service did not return a valid login flow; inspect agents auth before retrying.",
      );
    let flow = result;
    const operationId = result.operationId;
    const deadline = Date.now() + waitTimeout;
    if (flow.status === "pending" && opts["no-wait"] !== "true") {
      if (!json)
        console.error(
          "Waiting for login instructions. No model prompt is being sent.",
        );
      while (flow.status === "pending") {
        const remaining = deadline - Date.now();
        if (remaining <= 0)
          throw new ServiceError(
            "auth_wait_timeout",
            408,
            `Stopped waiting for login ${operationId}. Run acplus agents auth --agent ${requireOption("agent")} with the same service options; do not start another login flow.`,
          );
        let observation: unknown;
        try {
          observation = await remoteRequest(
            address ?? "",
            "GET",
            path,
            undefined,
            Math.max(1, Math.min(30000, remaining)),
          );
        } catch (error) {
          if (Date.now() >= deadline)
            throw new ServiceError(
              "auth_wait_timeout",
              408,
              `Stopped waiting for login ${operationId}. Inspect agents auth with the same --agent and service options.`,
            );
          throw error;
        }
        if (
          !record(observation) ||
          !record(observation.flow) ||
          observation.flow.operationId !== operationId ||
          ![
            "pending",
            "action_required",
            "succeeded",
            "failed",
            "expired",
          ].includes(String(observation.flow.status))
        )
          throw new ServiceError(
            "auth_flow_changed",
            409,
            "The login flow is missing or changed; inspect agents auth before retrying.",
          );
        flow = observation.flow;
        if (flow.status === "pending")
          await new Promise((resolve) =>
            setTimeout(
              resolve,
              Math.max(1, Math.min(250, deadline - Date.now())),
            ),
          );
      }
    }
    printResult(
      outputKind,
      json ? flow : { ...flow, agentId: requireOption("agent") },
      json,
    );
    if (flow.status === "failed" || flow.status === "expired")
      process.exitCode = 1;
    return;
  }
  if (!isSend || opts["no-wait"] === "true") {
    printResult(
      outputKind,
      key === "sessions:delete" && json
        ? { sessionId: opts.session, deleted: true }
        : result,
      json,
    );
    return;
  }
  const deadline = Date.now() + waitTimeout;
  const turnPath = `/sessions/${requireOption("session")}/turns/${requireOption("turn")}`;
  const waitFailure = () =>
    new ServiceError(
      "turn_wait_timeout",
      408,
      `Stopped waiting; execution may continue. Session ${opts.session}, Turn ${opts.turn}. Query or cancel this exact Turn; do not resend with a new ID.`,
    );
  for (;;) {
    let current: unknown;
    try {
      current = await read(
        turnPath,
        Math.max(1, Math.min(30000, deadline - Date.now())),
      );
    } catch (error) {
      if (Date.now() >= deadline) throw waitFailure();
      throw error;
    }
    if (
      !record(current) ||
      current.sessionId !== opts.session ||
      current.turnId !== opts.turn ||
      typeof current.response !== "string" ||
      ![
        "accepted",
        "starting",
        "dispatching",
        "running",
        "cancelling",
        "complete",
        "cancelled",
        "error",
        "unknown",
      ].includes(String(current.state))
    )
      throw new ServiceError("invalid_turn_response", 502);
    if (
      ["complete", "cancelled", "error", "unknown"].includes(
        String(current.state),
      )
    ) {
      if (json) printResult("turns get", current, true);
      else if (current.state === "complete")
        console.log(current.response || "Completed (no text response).");
      else printResult("turns get", current, false);
      if (current.state !== "complete") process.exitCode = 1;
      return;
    }
    if (Date.now() >= deadline) throw waitFailure();
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(250, deadline - Date.now())),
    );
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
    if (process.argv.includes("--json"))
      console.error(JSON.stringify({ error: diagnostic(error) }));
    else
      console.error(
        error instanceof Error ? error.message : "Operation failed",
      );
    process.exitCode = error instanceof ConfigurationError ? 2 : 1;
  });
}
