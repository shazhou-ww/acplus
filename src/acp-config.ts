import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { parseDocument } from "yaml";
import { ConfigurationError } from "./acp-common.js";
import type { Config } from "./acp-types.js";
export type { AgentConfig, Config, SecretReference } from "./acp-types.js";

const nonempty = { type: "string", minLength: 1 };
const object = (
  properties: Record<string, unknown>,
  required = Object.keys(properties),
) => ({ type: "object", additionalProperties: false, properties, required });
const secret = {
  oneOf: [
    nonempty,
    object({ source: { const: "env" }, name: nonempty }),
    object({ source: { const: "file" }, path: nonempty }),
  ],
};
export const schema = object(
  {
    schemaVersion: { const: 2 },
    instance: { ...nonempty, default: "local" },
    dataDir: nonempty,
    listen: {
      ...object(
        {
          host: { ...nonempty, default: "127.0.0.1" },
          port: { type: "integer", minimum: 0, maximum: 65535, default: 4280 },
        },
        [],
      ),
      default: { host: "127.0.0.1", port: 4280 },
    },
    agents: {
      type: "array",
      minItems: 1,
      items: object(
        {
          id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$" },
          label: { type: "string", default: "" },
          command: nonempty,
          args: {
            type: "array",
            items: { type: "string" },
            default: ["--acp"],
          },
          env: { type: "object", additionalProperties: secret, default: {} },
          profileDir: nonempty,
          workspaces: { type: "array", minItems: 1, items: nonempty },
          mcpServers: {
            type: "array",
            default: [],
            items: {
              oneOf: [
                object({
                  name: nonempty,
                  command: nonempty,
                  args: { type: "array", items: { type: "string" } },
                  env: {
                    type: "array",
                    items: object({
                      name: nonempty,
                      value: { type: "string" },
                    }),
                  },
                }),
                object({
                  type: { enum: ["http", "sse"] },
                  name: nonempty,
                  url: nonempty,
                  headers: {
                    type: "array",
                    items: object({
                      name: nonempty,
                      value: { type: "string" },
                    }),
                  },
                }),
              ],
            },
          },
          startupTimeoutMs: {
            type: "integer",
            minimum: 100,
            maximum: 300000,
            default: 30000,
          },
          idleTimeoutMs: {
            type: "integer",
            minimum: 0,
            maximum: 86400000,
            default: 0,
          },
          permission: { enum: ["deny", "allow"], default: "deny" },
          authentication: object({
            type: { const: "copilot" },
            loginAccount: {
              type: "string",
              pattern: "^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$",
            },
          }),
        },
        ["id", "command", "profileDir", "workspaces"],
      ),
    },
  },
  ["schemaVersion", "dataDir", "agents"],
);
const validate = new Ajv2020({
  allErrors: true,
  useDefaults: true,
}).compile<Config>(schema);

export function validateConfig(input: unknown, base = process.cwd()): Config {
  const candidate: unknown = structuredClone(input);
  if (!validate(candidate))
    throw new ConfigurationError(
      validate.errors
        ?.map((error) => `${error.instancePath || "/"}: ${error.message}`)
        .join("; "),
    );
  candidate.dataDir = resolve(base, candidate.dataDir);
  const ids = new Set<string>();
  const profiles = new Set<string>();
  for (const agent of candidate.agents) {
    if (
      ids.has(agent.id) ||
      !isAbsolute(agent.command) ||
      /\.(?:cmd|bat)$/iu.test(agent.command)
    )
      throw new ConfigurationError(
        "Agent IDs must be unique and commands native absolute paths",
      );
    ids.add(agent.id);
    agent.profileDir = resolve(base, agent.profileDir);
    const profile =
      process.platform === "win32"
        ? agent.profileDir.toLowerCase()
        : agent.profileDir;
    if (profiles.has(profile))
      throw new ConfigurationError("Agents must not share credential profiles");
    profiles.add(profile);
    agent.workspaces = agent.workspaces.map((path) => resolve(base, path));
    for (const value of Object.values(agent.env))
      if (typeof value !== "string" && value.source === "file")
        value.path = resolve(base, value.path);
  }
  return candidate;
}

export async function loadConfig(
  file: string,
  stdin?: string,
): Promise<Config> {
  let raw: unknown;
  try {
    const document = parseDocument(
      file === "-" ? (stdin ?? "") : await readFile(file, "utf8"),
    );
    if (document.errors.length > 0 || document.warnings.length > 0)
      throw new ConfigurationError("Invalid YAML document");
    raw = document.toJS({ maxAliasCount: 100 });
  } catch {
    throw new ConfigurationError("Cannot read a valid YAML configuration");
  }
  return validateConfig(
    raw,
    file === "-" ? process.cwd() : dirname(resolve(file)),
  );
}
