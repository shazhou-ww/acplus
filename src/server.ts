import { createServer, type IncomingMessage } from "node:http";
import {
  diagnostic,
  fields,
  record,
  ServiceError,
  text,
  upstream,
  uri,
} from "./common.js";
import type { Service } from "./runtime.js";

async function body(request: IncomingMessage, keys: string[]) {
  if (
    !request.headers["content-type"]
      ?.split(";")[0]
      ?.trim()
      .toLowerCase()
      .includes("application/json")
  )
    throw new ServiceError("invalid_input", 400, "Expected application/json");
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    if (!Buffer.isBuffer(chunk)) throw new ServiceError("invalid_input", 400);
    bytes += chunk.length;
    if (bytes > 1_048_576)
      throw new ServiceError(
        "invalid_input",
        400,
        "Request body exceeds 1 MiB",
      );
    chunks.push(chunk);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ServiceError("invalid_input", 400, "Expected one JSON object");
  }
  return fields(value, keys);
}

async function route(
  service: Service,
  request: IncomingMessage,
): Promise<{ status: number; value?: unknown }> {
  const url = new URL(request.url ?? "", "http://ahplex.invalid");
  const method = request.method;
  if (method === "GET" && url.pathname === "/v1/health") return { status: 204 };
  if (method === "GET" && url.pathname === "/v1/hosts")
    return {
      status: 200,
      value: await Promise.all(
        [...service.hosts.values()].map(({ native }) => native.view()),
      ),
    };
  const match =
    /^\/v1\/hosts\/([^/]+)\/(start|stop|auth|auth\/input|sessions|chats|turns|turns\/cancel)$/u.exec(
      url.pathname,
    );
  if (match?.[1] === undefined || match[2] === undefined)
    throw new ServiceError("route_not_found", 404);
  let id: string;
  try {
    id = decodeURIComponent(match[1]);
  } catch {
    throw new ServiceError("invalid_input", 400);
  }
  const { native, auth } = service.select(id);
  const query = (...keys: string[]): Record<string, string> => {
    if (
      [...url.searchParams.keys()].length !== keys.length ||
      keys.some((key) => url.searchParams.getAll(key).length !== 1)
    )
      throw new ServiceError("invalid_input", 400);
    return Object.fromEntries(
      keys.map((key) => [key, text(url.searchParams.get(key), key)]),
    );
  };
  const operation = `${method ?? ""} ${match[2]}`;
  switch (operation) {
    case "POST start":
      native.start();
      return { status: 202 };
    case "POST stop":
      await native.stop();
      return { status: 202 };
    case "GET auth":
      return { status: 200, value: auth.get() };
    case "POST auth": {
      const value = await body(request, ["methodId"]);
      auth.begin(text(value.methodId, "methodId"));
      return { status: 202 };
    }
    case "POST auth/input": {
      const value = await body(request, ["stepId", "values"]);
      if (
        !record(value.values) ||
        Object.keys(value.values).length === 0 ||
        Object.values(value.values).some((item) => typeof item !== "string")
      )
        throw new ServiceError("invalid_input", 400);
      const values = Object.fromEntries(
        Object.entries(value.values).map(([key, item]) => [key, String(item)]),
      );
      auth.input(text(value.stepId, "stepId"), values);
      return { status: 202 };
    }
    case "GET sessions":
      return { status: 200, value: await native.listSessions() };
    case "POST sessions": {
      const value = await body(request, ["provider", "workingDirectories"]);
      if (
        !Array.isArray(value.workingDirectories) ||
        value.workingDirectories.length !== 1
      )
        throw new ServiceError(
          "invalid_input",
          400,
          "workingDirectories must contain one file URI",
        );
      return {
        status: 201,
        value: await native.createSession(text(value.provider, "provider"), [
          uri(value.workingDirectories[0], "workingDirectories", "file:"),
        ]),
      };
    }
    case "GET chats":
      return {
        status: 200,
        value: await native.listChats(uri(query("session").session, "session")),
      };
    case "POST chats": {
      const value = await body(request, ["session"]);
      return {
        status: 201,
        value: await native.createChat(uri(value.session, "session")),
      };
    }
    case "GET turns": {
      const value = query("chat", "turnId");
      return {
        status: 200,
        value: await native.getTurn(
          uri(value.chat, "chat"),
          text(value.turnId, "turnId"),
        ),
      };
    }
    case "POST turns": {
      const value = await body(request, ["chat", "turnId", "text"]);
      await native.startTurn(
        uri(value.chat, "chat"),
        text(value.turnId, "turnId"),
        text(value.text, "text"),
      );
      return { status: 202 };
    }
    case "POST turns/cancel": {
      const value = await body(request, ["chat", "turnId"]);
      await native.cancelTurn(
        uri(value.chat, "chat"),
        text(value.turnId, "turnId"),
      );
      return { status: 202 };
    }
    default:
      throw new ServiceError("route_not_found", 404);
  }
}

export async function serve(
  service: Service,
): Promise<{ url: string; close(): Promise<void> }> {
  let closing: Promise<void> | undefined;
  const server = createServer((request, response) => {
    response.setHeader("cache-control", "no-store");
    void route(service, request).then(
      ({ status, value }) => {
        response.statusCode = status;
        if (value !== undefined)
          response.setHeader("content-type", "application/json; charset=utf-8");
        response.end(
          value === undefined ? undefined : service.redactor.json(value),
        );
      },
      (error: unknown) => {
        const safe = upstream(error);
        response.statusCode = safe.status;
        response.setHeader("content-type", "application/json; charset=utf-8");
        response.end(service.redactor.json({ error: diagnostic(safe) }));
      },
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(
      service.config.listen.port,
      service.config.listen.host,
      () => {
        server.removeListener("error", reject);
        resolve();
      },
    );
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new ServiceError("listen_failed", 503);
  const host =
    address.family === "IPv6" ? `[${address.address}]` : address.address;
  return {
    url: `http://${host}:${address.port}/v1`,
    close() {
      closing ??= (async () => {
        const stopped = new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error === undefined) resolve();
            else reject(error);
          });
        });
        try {
          await service.close();
        } finally {
          server.closeAllConnections();
          await stopped;
        }
      })();
      return closing;
    },
  };
}
