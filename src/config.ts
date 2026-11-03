import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { HubError, localUrl, object, string } from "./common.js";

export interface ServiceConfig {
  id: string;
  kind: "ahp-websocket";
  endpoint: { url: string; tokenEnv?: string } | { registry: true };
  launch?: {
    executable: string;
    args: string[];
    cwd: string;
    environment: {
      mode: "inherited" | "isolated";
      inherit: string[];
      values: Record<string, string>;
    };
  };
  startupTimeoutMs: number;
  lifecycle: "owned" | "attached";
}

export interface HubConfig {
  version: 1;
  services: ServiceConfig[];
}

function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new HubError("unknown_configuration_field", 400);
}

function texts(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string"))
    throw new HubError("invalid_configuration_array", 400);
  return value as string[];
}

function environmentNames(names: string[]): string[] {
  if (names.some((name) => !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)))
    throw new HubError("invalid_environment_name", 400);
  return names;
}

export function instanceId(value: unknown): string {
  const id = string(value);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id))
    throw new HubError("invalid_instance", 400);
  return id;
}

export function validateConfig(value: unknown): HubConfig {
  const root = object(value);
  keys(root, ["version", "services"]);
  if (
    root.version !== 1 ||
    !Array.isArray(root.services) ||
    root.services.length === 0
  )
    throw new HubError("invalid_service_configuration", 400);
  const ids = new Set<string>();
  const endpoints = new Set<string>();
  const services = root.services.map((raw): ServiceConfig => {
    const row = object(raw);
    keys(row, [
      "id",
      "kind",
      "endpoint",
      "launch",
      "startupTimeoutMs",
      "lifecycle",
    ]);
    const id = instanceId(row.id);
    if (ids.has(id)) throw new HubError("duplicate_service_id", 400);
    ids.add(id);
    if (row.kind !== "ahp-websocket")
      throw new HubError("unsupported_bridge_kind", 400);
    const endpoint = object(row.endpoint);
    keys(endpoint, ["url", "tokenEnv", "registry"]);
    let connection: ServiceConfig["endpoint"];
    if (
      endpoint.registry === true &&
      endpoint.url === undefined &&
      endpoint.tokenEnv === undefined
    )
      connection = { registry: true };
    else if (
      endpoint.registry === undefined &&
      typeof endpoint.url === "string"
    )
      connection = {
        url: localUrl(endpoint.url, "ws:").href,
        ...(endpoint.tokenEnv === undefined
          ? {}
          : { tokenEnv: string(endpoint.tokenEnv) }),
      };
    else throw new HubError("invalid_service_endpoint", 400);
    if ("url" in connection) {
      if (endpoints.has(connection.url))
        throw new HubError("duplicate_service_endpoint", 400);
      endpoints.add(connection.url);
    }
    const timeout = row.startupTimeoutMs;
    if (
      typeof timeout !== "number" ||
      !Number.isInteger(timeout) ||
      timeout < 1 ||
      timeout > 300_000
    )
      throw new HubError("invalid_startup_timeout", 400);
    if (row.lifecycle !== "owned" && row.lifecycle !== "attached")
      throw new HubError("invalid_service_lifecycle", 400);
    let launch: ServiceConfig["launch"];
    if (row.launch !== undefined) {
      const input = object(row.launch);
      keys(input, ["executable", "args", "cwd", "environment"]);
      const environment = object(input.environment);
      keys(environment, ["mode", "inherit", "values"]);
      if (environment.mode !== "inherited" && environment.mode !== "isolated")
        throw new HubError("invalid_environment_mode", 400);
      const values = object(environment.values);
      environmentNames(Object.keys(values));
      if (Object.values(values).some((entry) => typeof entry !== "string"))
        throw new HubError("invalid_environment_values", 400);
      const cwd = string(input.cwd);
      if (!isAbsolute(cwd))
        throw new HubError("absolute_launch_cwd_required", 400);
      const args = texts(input.args);
      const executable = string(input.executable);
      if (
        [executable, cwd, ...args, ...(Object.values(values) as string[])].some(
          (entry) =>
            entry.includes("\0") ||
            /\{(?!registryDirectory\}|profileDirectory\}|connectionTokenFile\})[a-zA-Z_][a-zA-Z0-9_]*\}/.test(
              entry,
            ),
        )
      )
        throw new HubError("invalid_launch_value", 400);
      launch = {
        executable,
        args,
        cwd,
        environment: {
          mode: environment.mode,
          inherit: environmentNames(texts(environment.inherit)),
          values: values as Record<string, string>,
        },
      };
    }
    if (
      (row.lifecycle === "owned") !== (launch !== undefined) ||
      ("registry" in connection && launch === undefined)
    )
      throw new HubError("launch_lifecycle_mismatch", 400);
    if (row.lifecycle === "owned" && "url" in connection)
      throw new HubError("owned_registry_endpoint_required", 400);
    return {
      id,
      kind: "ahp-websocket",
      endpoint: connection,
      ...(launch === undefined ? {} : { launch }),
      startupTimeoutMs: timeout,
      lifecycle: row.lifecycle,
    };
  });
  return { version: 1, services };
}

export async function loadConfig(path: string): Promise<HubConfig> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(resolve(path), "utf8"));
  } catch {
    throw new HubError("configuration_read_failed", 400);
  }
  return validateConfig(value);
}
