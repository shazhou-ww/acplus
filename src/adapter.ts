import { HubError, object } from "./common.js";

export interface Adapter {
  call(name: string, input: Record<string, unknown>): Promise<unknown>;
}

export class HttpAdapter implements Adapter {
  constructor(
    private readonly base: string,
    private readonly token: string,
  ) {}

  async call(name: string, input: Record<string, unknown>): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${this.base}/api/${name}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(35_000),
      });
    } catch {
      throw new HubError("adapter_unavailable", 503);
    }
    if (response.status === 401) throw new HubError("auth_required", 401);
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new HubError("adapter_invalid_response", 502);
    }
    if (Array.isArray(value)) {
      if (!response.ok) throw new HubError("adapter_request_failed");
      return value;
    }
    const data = object(value);
    if (data.error === "backend_authentication_required")
      throw new HubError("backend_authentication_required", 401);
    if (data.error === "backend_capability_unsupported")
      throw new HubError("backend_capability_unsupported", 501);
    if (
      typeof data.error === "string" &&
      [
        "host_unavailable",
        "session_refused",
        "session_unavailable",
        "session_busy",
        "backend_request_failed",
      ].includes(data.error)
    )
      throw new HubError(
        data.error,
        data.error === "host_unavailable" ? 503 : 502,
      );
    if (!response.ok || data.error !== undefined)
      throw new HubError("adapter_request_failed");
    return data.result === undefined ? data : data.result;
  }
}
