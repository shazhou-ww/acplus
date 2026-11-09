import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { RequestError } from "@agentclientprotocol/sdk";
import type { AgentConfig, ErrorInfo } from "./acp-types.js";
import { ServiceError } from "./errors.js";
export { ConfigurationError, ServiceError } from "./errors.js";

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function diagnostic(error: unknown): ErrorInfo {
  const failure = serviceError(error);
  return { code: failure.code, message: failure.message };
}

export function serviceError(error: unknown): ServiceError {
  if (error instanceof ServiceError) return error;
  if (error instanceof RequestError) {
    if (error.code === -32000)
      return new ServiceError("agent_auth_required", 409);
    if (error.code === -32601)
      return new ServiceError("agent_method_unsupported", 409);
    return new ServiceError("agent_request_failed", 502);
  }
  return new ServiceError("operation_failed", 503);
}

export function uuid(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
      value,
    )
  )
    throw new ServiceError("invalid_input", 400, `${field} must be a UUID`);
  return value;
}

export function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new ServiceError(
      "invalid_input",
      400,
      `${field} must be non-empty text`,
    );
  return value;
}

export function profileIdentity(agent: AgentConfig): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        id: agent.id,
        command: agent.command,
        args: agent.args,
        profileDir: agent.profileDir,
        env: agent.env,
        authentication: agent.authentication,
      }),
    )
    .digest("hex");
}

export async function workspace(
  agent: AgentConfig,
  directory: string,
): Promise<string> {
  if (!isAbsolute(directory))
    throw new ServiceError("workspace_not_allowed", 403);
  let canonical: string;
  let roots: string[];
  try {
    canonical = await realpath(directory);
    roots = await Promise.all(agent.workspaces.map((root) => realpath(root)));
    if (!(await stat(canonical)).isDirectory())
      throw new ServiceError("workspace_unavailable", 400);
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    throw new ServiceError("workspace_unavailable", 400);
  }
  if (
    !roots.some((root) => {
      const child = relative(root, canonical);
      return (
        child === "" ||
        (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`))
      );
    })
  )
    throw new ServiceError("workspace_not_allowed", 403);
  return canonical;
}

export class Redactor {
  private readonly values = new Set<string>();
  add(value: string): string {
    if (value !== "") this.values.add(value);
    return value;
  }
  clean(value: string): string {
    for (const secret of [...this.values].sort((a, b) => b.length - a.length))
      value = value.replaceAll(secret, "[redacted]");
    return value;
  }
  json(value: unknown): string {
    return JSON.stringify(value, (_key, item: unknown) =>
      typeof item === "string" ? this.clean(item) : item,
    );
  }
}
