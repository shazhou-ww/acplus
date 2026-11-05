import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { ConfigurationError, record } from "./common.js";

export type SecretReference =
  { source: "env"; name: string } | { source: "file"; path: string };
export interface AuthenticationBinding {
  id: string;
  provider: string;
  resource: string;
  adapter: string;
  options: Record<string, unknown>;
}
export interface HostConfig {
  id: string;
  label: string;
  adapter: string;
  startup: {
    command: string;
    args: string[];
    env: Record<string, string | SecretReference>;
    cwd?: string;
  };
  lifecycle: {
    prepareOnStartup: boolean;
    onDemand: boolean;
    startupTimeoutMs: number;
  };
  options: Record<string, unknown>;
  authentication: AuthenticationBinding[];
}
export interface Config {
  $schema?: string;
  schemaVersion: 1;
  instance: string;
  dataDir: string;
  listen: { host: string; port: number };
  plugins?: { id: string; module: string; options: Record<string, unknown> }[];
  hosts: HostConfig[];
}
export interface Overrides {
  listenHost?: string;
  port?: number;
  instance?: string;
  dataDir?: string;
}

const nonempty = { type: "string", minLength: 1 };
const id = { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$" };
const options = { type: "object", additionalProperties: true };
export function objectSchema(
  properties: Record<string, unknown>,
  required = Object.keys(properties),
): Record<string, unknown> {
  return { type: "object", additionalProperties: false, properties, required };
}
export const secretSchema = {
  oneOf: [
    objectSchema({ source: { const: "env" }, name: nonempty }),
    objectSchema({ source: { const: "file" }, path: nonempty }),
  ],
};
const schema = objectSchema(
  {
    $schema: { type: "string" },
    schemaVersion: { const: 1 },
    instance: id,
    dataDir: nonempty,
    listen: objectSchema({
      host: nonempty,
      port: { type: "integer", minimum: 0, maximum: 65535 },
    }),
    plugins: {
      type: "array",
      items: objectSchema({ id, module: nonempty, options }),
    },
    hosts: {
      type: "array",
      items: objectSchema({
        id,
        label: nonempty,
        adapter: id,
        startup: objectSchema(
          {
            command: nonempty,
            args: { type: "array", items: { type: "string" } },
            env: {
              type: "object",
              additionalProperties: {
                oneOf: [{ type: "string" }, secretSchema],
              },
            },
            cwd: nonempty,
          },
          ["command", "args", "env"],
        ),
        lifecycle: objectSchema({
          prepareOnStartup: { type: "boolean" },
          onDemand: { type: "boolean" },
          startupTimeoutMs: {
            type: "integer",
            minimum: 1,
            maximum: 2_147_483_647,
          },
        }),
        options,
        authentication: {
          type: "array",
          items: objectSchema({
            id,
            provider: nonempty,
            resource: { type: "string", format: "uri" },
            adapter: id,
            options,
          }),
        },
      }),
    },
  },
  ["schemaVersion", "instance", "dataDir", "listen", "hosts"],
);
export const validator = new Ajv2020({ allErrors: true });
validator.addFormat("uri", {
  type: "string",
  validate: (value: string) => {
    try {
      return (
        new URL(value).protocol !== "" &&
        ![...value].some((character) => character.charCodeAt(0) <= 32)
      );
    } catch {
      return false;
    }
  },
});
const validate = validator.compile<Config>(schema);

function unique(values: string[], field: string): void {
  if (new Set(values).size !== values.length)
    throw new ConfigurationError(`${field}: duplicate identifiers`);
}

export function validateConfig(input: unknown): Config {
  if (!validate(input))
    throw new ConfigurationError(
      validate.errors
        ?.map(
          (error) =>
            `${error.instancePath || "/"}: ${error.message ?? "invalid"}`,
        )
        .join("; "),
    );
  unique(
    input.hosts.map((host) => host.id),
    "/hosts",
  );
  if (process.platform === "win32")
    unique(
      input.hosts.map((host) => host.id.toLowerCase()),
      "/hosts (Windows filesystem)",
    );
  unique(
    (input.plugins ?? []).map((plugin) => plugin.id),
    "/plugins",
  );
  for (const host of input.hosts)
    unique(
      host.authentication.map((binding) => binding.id),
      `/hosts/${host.id}/authentication`,
    );
  return input;
}

export function parseJson(source: string): unknown {
  try {
    return JSON.parse(source.replace(/^\uFEFF/u, ""));
  } catch {
    throw new ConfigurationError("Expected one complete UTF-8 JSON document");
  }
}

function paths(value: unknown, base: string): unknown {
  if (Array.isArray(value))
    return value.map((item: unknown) => paths(item, base));
  if (!record(value)) return value;
  if (value.source === "file" && typeof value.path === "string")
    return { ...value, path: resolve(base, value.path) };
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, paths(item, base)]),
  );
}

export async function loadConfig(
  source: string,
  overrides: Overrides = {},
  stdin: () => Promise<string> = readStdin,
  cwd = process.cwd(),
): Promise<Config> {
  for (const [name, value] of Object.entries(overrides))
    if (typeof value === "string" && value.trim() === "")
      throw new ConfigurationError(`${name}: must be non-empty`);
  let document: string;
  try {
    document =
      source === "-"
        ? await stdin()
        : await readFile(resolve(cwd, source), "utf8");
  } catch {
    throw new ConfigurationError("Unable to read configuration source");
  }
  const input = validateConfig(parseJson(document));
  const base = source === "-" ? cwd : dirname(resolve(cwd, source));
  const effective = validateConfig(paths(input, base));
  effective.instance = overrides.instance ?? effective.instance;
  effective.listen.host = overrides.listenHost ?? effective.listen.host;
  effective.listen.port = overrides.port ?? effective.listen.port;
  effective.dataDir =
    overrides.dataDir === undefined
      ? resolve(base, effective.dataDir)
      : resolve(cwd, overrides.dataDir);
  for (const plugin of effective.plugins ?? []) {
    if (
      !/\.(?:mjs|js)$/iu.test(plugin.module) ||
      (/^[a-z][a-z0-9+.-]*:/iu.test(plugin.module) &&
        !isAbsolute(plugin.module)) ||
      (!isAbsolute(plugin.module) &&
        !/^[.][\\/]|^[.][.][\\/]/u.test(plugin.module))
    )
      throw new ConfigurationError(
        "/plugins/module: expected explicit local .js/.mjs path",
      );
    plugin.module = resolve(base, plugin.module);
  }
  for (const host of effective.hosts) {
    if (/[\\/]/u.test(host.startup.command))
      host.startup.command = resolve(base, host.startup.command);
    if (host.startup.cwd !== undefined)
      host.startup.cwd = resolve(base, host.startup.cwd);
    for (const binding of host.authentication) {
      if (
        binding.adapter === "github-cli" &&
        typeof binding.options.command === "string" &&
        /[\\/]/u.test(binding.options.command)
      )
        binding.options.command = resolve(base, binding.options.command);
    }
  }
  return validateConfig(effective);
}

export async function readStdin(): Promise<string> {
  process.stdin.setEncoding("utf8");
  let result = "";
  for await (const chunk of process.stdin) result += String(chunk);
  return result;
}
