import { AhpErrorCodes } from "@microsoft/agent-host-protocol";
import { RpcError } from "@microsoft/agent-host-protocol/client";

export class ServiceError extends Error {
  constructor(
    readonly code: string,
    readonly status = 502,
    message = code.replaceAll("_", " "),
  ) {
    super(message);
  }
}

export class ConfigurationError extends Error {}

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new ServiceError(
      "invalid_input",
      400,
      `${field} must be non-empty text`,
    );
  return value;
}

export function uri(value: unknown, field: string, protocol?: string): string {
  const raw = text(value, field);
  try {
    const parsed = new URL(raw);
    if (
      raw.trim() !== raw ||
      [...raw].some((character) => character.charCodeAt(0) <= 32) ||
      (protocol !== undefined && parsed.protocol !== protocol) ||
      (protocol === "file:" &&
        (!raw.startsWith("file:/") ||
          parsed.search !== "" ||
          parsed.hash !== ""))
    )
      throw new Error();
  } catch {
    throw new ServiceError(
      "invalid_input",
      400,
      `${field} must be an absolute URI`,
    );
  }
  return raw;
}

export function fields(
  value: unknown,
  keys: string[],
): Record<string, unknown> {
  if (
    !record(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    throw new ServiceError(
      "invalid_input",
      400,
      "Unexpected or missing fields",
    );
  return value;
}

export function upstream(
  error: unknown,
  fallback = "upstream_unavailable",
): ServiceError {
  if (error instanceof ServiceError) return error;
  if (error instanceof RpcError) {
    switch (error.code) {
      case AhpErrorCodes.AuthRequired:
        return new ServiceError("upstream_auth_required", 409);
      case AhpErrorCodes.TurnInProgress:
        return new ServiceError("chat_busy", 409);
      case AhpErrorCodes.SessionNotFound:
      case AhpErrorCodes.NotFound:
        return new ServiceError("resource_not_found", 404);
      case AhpErrorCodes.ProviderNotFound:
        return new ServiceError("provider_not_found", 404);
      default:
        return new ServiceError("upstream_rejected", 502);
    }
  }
  return new ServiceError(fallback, 503);
}

export function diagnostic(error: unknown): { code: string; message: string } {
  const safe = upstream(error);
  return { code: safe.code, message: safe.message };
}

export class Redactor {
  private readonly secrets = new Set<string>();

  add(secret: string): string {
    if (secret !== "") this.secrets.add(secret);
    return secret;
  }

  clean(value: string): string {
    for (const secret of [...this.secrets].sort((a, b) => b.length - a.length))
      value = value.replaceAll(secret, "[redacted]");
    return value;
  }

  json(value: unknown): string {
    const displayFields = new Set([
      "text",
      "title",
      "message",
      "content",
      "url",
      "userCode",
    ]);
    return JSON.stringify(value, (key, item: unknown) =>
      typeof item === "string" && displayFields.has(key)
        ? this.clean(item)
        : item,
    );
  }
}

export async function bounded<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        abort = () => {
          reject(new ServiceError("operation_cancelled", 503));
        };
        signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    if (abort !== undefined) signal.removeEventListener("abort", abort);
  }
}
