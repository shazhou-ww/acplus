import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  equalSecret,
  HubError,
  object,
  publicError,
  redact,
  string,
} from "./common.js";
import type { TaskManager } from "./tasks.js";

export interface ServerOptions {
  port?: number;
  token?: string;
  secrets?: string[];
  health?: () => Record<string, unknown> | Promise<Record<string, unknown>>;
}

export interface ServiceRouter {
  services(): string[];
  select(id: string): Promise<{
    manager: TaskManager;
    health(): Promise<Record<string, unknown>>;
  }>;
  close(): Promise<void>;
}

async function body(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  if (request.headers["content-type"]?.split(";")[0] !== "application/json") {
    throw new HubError("json_content_type_required", 415);
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  let tooLarge = false;
  for await (const chunk of request) {
    const buffer: Buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(String(chunk));
    bytes += buffer.length;
    if (bytes > 1_000_000) {
      tooLarge = true;
      chunks.length = 0;
    } else chunks.push(buffer);
  }
  if (tooLarge) throw new HubError("body_too_large", 413);
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HubError("invalid_json", 400);
  }
  return object(value);
}

export async function serveHub(
  source: TaskManager | ServiceRouter,
  options: ServerOptions = {},
): Promise<{ server: Server; url: string; close(): Promise<void> }> {
  const server = createServer((request, response) => {
    const send = (status: number, value: unknown): void => {
      if (response.destroyed) return;
      response.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      response.end(
        JSON.stringify(
          redact(value, [
            ...(options.secrets ?? []),
            ...(options.token === undefined ? [] : [options.token]),
          ]),
        ),
      );
    };
    void (async () => {
      try {
        const address = server.address() as AddressInfo;
        if (
          request.headers.origin !== undefined ||
          ![`127.0.0.1:${address.port}`, `localhost:${address.port}`].includes(
            request.headers.host ?? "",
          )
        )
          throw new HubError("browser_or_invalid_host_forbidden", 403);
        if (
          options.token !== undefined &&
          !equalSecret(
            request.headers.authorization ?? "",
            `Bearer ${options.token}`,
          )
        )
          throw new HubError("auth_required", 401);
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        let path: string[];
        try {
          path = url.pathname
            .split("/")
            .filter(Boolean)
            .map(decodeURIComponent);
        } catch {
          throw new HubError("invalid_resource_path", 400);
        }
        const method = request.method;
        let manager: TaskManager;
        let getHealth = options.health;
        if ("select" in source) {
          if (method === "GET" && url.pathname === "/services") {
            send(200, { services: source.services() });
            return;
          }
          if (method === "GET" && url.pathname === "/health") {
            send(200, { status: "listening", services: source.services() });
            return;
          }
          if (path[0] !== "services" || path[1] === undefined)
            throw new HubError("explicit_service_required", 400);
          const selected = await source.select(path[1]);
          manager = selected.manager;
          getHealth = () => selected.health();
          path = path.slice(2);
        } else manager = source;
        const route = `/${path.join("/")}`;
        if (method === "GET" && route === "/health") {
          const health = (await getHealth?.()) ?? { status: "ready" };
          send(health.status === "unavailable" ? 503 : 200, health);
        } else if (method === "GET" && route === "/agents") {
          send(200, { agents: await manager.agents() });
        } else if (method === "GET" && route === "/sessions") {
          send(200, { sessions: await manager.listSessions() });
        } else if (method === "POST" && route === "/sessions") {
          send(201, await manager.createSession(await body(request)));
        } else if (
          method === "POST" &&
          path.length === 3 &&
          path[0] === "sessions" &&
          path[2] === "tasks"
        ) {
          const input = await body(request);
          send(202, manager.submit(string(path[1]), string(input.text)));
        } else if (path[0] === "tasks" && path[1] !== undefined) {
          const taskId = path[1];
          if (method === "GET" && path.length === 2)
            send(200, manager.get(taskId));
          else if (
            method === "POST" &&
            path.length === 3 &&
            path[2] === "cancel"
          ) {
            send(202, manager.cancel(taskId));
          } else if (
            method === "GET" &&
            path.length === 3 &&
            path[2] === "wait"
          ) {
            const timeout = Number(
              url.searchParams.get("timeoutMs") ?? "30000",
            );
            if (
              !Number.isInteger(timeout) ||
              timeout < 0 ||
              timeout > 120_000
            ) {
              throw new HubError("invalid_wait_timeout", 400);
            }
            const controller = new AbortController();
            const disconnect = (): void => {
              controller.abort();
            };
            response.once("close", disconnect);
            const result = await manager.wait(
              taskId,
              timeout,
              controller.signal,
            );
            response.removeListener("close", disconnect);
            send(result.timedOut ? 408 : 200, result);
          } else throw new HubError("not_found", 404);
        } else throw new HubError("not_found", 404);
      } catch (error) {
        const safe = publicError(error);
        send(safe.status, { error: { code: safe.code } });
      }
    })();
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 4280, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      try {
        await source.close();
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) reject(error);
            else resolve();
          });
          server.closeAllConnections();
        });
      }
    },
  };
}
