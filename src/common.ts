import { timingSafeEqual } from "node:crypto";
import { isAbsolute, win32 } from "node:path";
import { pathToFileURL } from "node:url";

export class HubError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 502,
  ) {
    super(code);
  }
}

export function checkStartup(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw new HubError("startup_cancelled", 503);
}

export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HubError("invalid_object", 400);
  }
  return value as Record<string, unknown>;
}

export function string(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new HubError("invalid_string", 400);
  }
  return value;
}

export function localUrl(value: string, protocol: "http:" | "ws:"): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HubError("invalid_endpoint", 400);
  }
  if (
    url.protocol !== protocol ||
    !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.pathname !== "/"
  ) {
    throw new HubError("explicit_loopback_endpoint_required", 400);
  }
  return url;
}

export function directoryUri(path: string): string {
  if (!isAbsolute(path) && !win32.isAbsolute(path)) {
    throw new HubError("absolute_directory_required", 400);
  }
  return pathToFileURL(path, { windows: win32.isAbsolute(path) }).href;
}

export function equalSecret(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function publicError(error: unknown): HubError {
  return error instanceof HubError
    ? error
    : new HubError("internal_error", 500);
}

export function redact(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") {
    return secrets.reduce(
      (text, secret) =>
        secret === "" ? text : text.split(secret).join("[redacted]"),
      value,
    );
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /token|authorization|password|secret|credential|api_?key/i.test(key)
          ? "[redacted]"
          : redact(item, secrets),
      ]),
    );
  }
  return value;
}
