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
    const value: unknown = await response.json();
    if (Array.isArray(value)) {
      if (!response.ok) throw new HubError("adapter_request_failed");
      return value;
    }
    const data = object(value);
    if (data.error === "auth_required")
      throw new HubError("auth_required", 401);
    if (!response.ok || data.error !== undefined)
      throw new HubError("adapter_request_failed");
    return data.result === undefined ? data : data.result;
  }
}
