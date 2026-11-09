import { createServer, type IncomingMessage } from "node:http";
import {
  diagnostic,
  record,
  ServiceError,
  serviceError,
  text,
  uuid,
} from "./acp-common.js";
import { Service } from "./acp-service.js";
import type { Config, Session } from "./acp-types.js";

async function body(request: IncomingMessage, keys: string[]) {
  if (
    request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !==
    "application/json"
  )
    throw new ServiceError("invalid_input", 400, "Expected application/json");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    if (!Buffer.isBuffer(chunk)) throw new ServiceError("invalid_input", 400);
    size += chunk.length;
    if (size > 1048576)
      throw new ServiceError("invalid_input", 400, "Request exceeds 1 MiB");
    chunks.push(chunk);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ServiceError("invalid_input", 400, "Expected one JSON object");
  }
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

function integer(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined) return fallback;
  if (!/^\d+$/u.test(raw)) throw new ServiceError("invalid_input", 400);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new ServiceError("invalid_input", 400);
  return value;
}

function publicSession(session: Session) {
  return {
    sessionId: session.sessionId,
    agentId: session.agentId,
    workingDirectory: session.workingDirectory,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    observedAt: session.observedAt,
    lastSequence: session.lastSequence,
    coverage: session.coverage,
    backendBound: session.backendSessionId !== null,
  };
}

async function route(service: Service, request: IncomingMessage) {
  service.assertReady();
  const url = new URL(request.url ?? "", "http://ahplex.invalid");
  const method = request.method ?? "";
  const query = (...names: string[]) => {
    const result: Record<string, string> = {};
    for (const name of url.searchParams.keys()) {
      if (!names.includes(name) || url.searchParams.getAll(name).length !== 1)
        throw new ServiceError("invalid_input", 400);
      result[name] = text(url.searchParams.get(name), name);
    }
    return result;
  };
  if (url.pathname === "/v2/health" && method === "GET") {
    query();
    service.health();
    return { status: 204 };
  }
  if (url.pathname === "/v2/agents" && method === "GET") {
    query();
    return { status: 200, value: service.listAgents() };
  }
  const agentMatch = /^\/v2\/agents\/([^/]+)\/auth(?:\/(input|logout))?$/u.exec(
    url.pathname,
  );
  if (agentMatch !== null) {
    query();
    let agentId: string;
    try {
      agentId = decodeURIComponent(agentMatch[1] ?? "");
    } catch {
      throw new ServiceError("invalid_input", 400);
    }
    const operation = agentMatch[2];
    if (method === "GET" && operation === undefined)
      return { status: 200, value: service.auth(agentId) };
    if (method === "POST" && operation === undefined) {
      const value = await body(request, ["methodId"]);
      return {
        status: 202,
        value: service.beginAuth(agentId, text(value.methodId, "methodId")),
      };
    }
    if (method === "POST" && operation === "input") {
      const value = await body(request, ["stepId", "values"]);
      if (
        !record(value.values) ||
        Object.values(value.values).some((item) => typeof item !== "string")
      )
        throw new ServiceError("invalid_input", 400);
      const values = Object.fromEntries(
        Object.entries(value.values).map(([key, item]) => [
          key,
          text(item, key),
        ]),
      );
      service.authInput(agentId, text(value.stepId, "stepId"), values);
      return { status: 202 };
    }
    if (method === "POST" && operation === "logout") {
      await body(request, []);
      await service.logout(agentId);
      return { status: 202 };
    }
  }
  if (url.pathname === "/v2/sessions") {
    if (method === "POST") {
      query();
      const value = await body(request, ["agentId", "workingDirectory"]);
      return {
        status: 201,
        value: publicSession(
          await service.createSession(
            text(value.agentId, "agentId"),
            text(value.workingDirectory, "workingDirectory"),
          ),
        ),
      };
    }
    if (method === "GET") {
      const value = query("agentId", "cursor", "limit");
      if (value.agentId !== undefined) service.select(value.agentId);
      const result = service.store.listSessions({
        limit: integer(value.limit, 100, 1, 1000),
        ...(value.agentId === undefined ? {} : { agentId: value.agentId }),
        ...(value.cursor === undefined ? {} : { cursor: value.cursor }),
      });
      return {
        status: 200,
        value: { ...result, items: result.items.map(publicSession) },
      };
    }
  }
  const match =
    /^\/v2\/sessions\/([^/]+)(?:\/(events|turns)(?:\/([^/]+)(?:\/(cancel))?)?)?$/u.exec(
      url.pathname,
    );
  if (match === null) throw new ServiceError("route_not_found", 404);
  const sessionId = uuid(match[1], "sessionId");
  const operation = match[2];
  const turnId = match[3] === undefined ? undefined : uuid(match[3], "turnId");
  if (method === "GET" && operation === undefined) {
    query();
    return {
      status: 200,
      value: publicSession(service.store.getSession(sessionId)),
    };
  }
  if (method === "GET" && operation === "events" && turnId === undefined) {
    const value = query("turnId", "after", "limit");
    return {
      status: 200,
      value: service.store.listEvents(sessionId, {
        limit: integer(value.limit, 100, 1, 1000),
        after: integer(value.after, 0, 0, Number.MAX_SAFE_INTEGER),
        ...(value.turnId === undefined
          ? {}
          : { turnId: uuid(value.turnId, "turnId") }),
      }),
    };
  }
  if (operation === "turns") {
    if (method === "POST" && turnId === undefined) {
      query();
      const value = await body(request, ["turnId", "text"]);
      return {
        status: 202,
        value: await service.submit(
          sessionId,
          uuid(value.turnId, "turnId"),
          text(value.text, "text"),
        ),
      };
    }
    if (method === "GET" && turnId === undefined) {
      const value = query("cursor", "limit");
      return {
        status: 200,
        value: service.store.listTurns(sessionId, {
          limit: integer(value.limit, 100, 1, 1000),
          ...(value.cursor === undefined ? {} : { cursor: value.cursor }),
        }),
      };
    }
    if (method === "GET" && turnId !== undefined && match[4] === undefined) {
      query();
      return { status: 200, value: service.store.getTurn(sessionId, turnId) };
    }
    if (method === "POST" && turnId !== undefined && match[4] === "cancel") {
      query();
      await body(request, []);
      return { status: 202, value: await service.cancel(sessionId, turnId) };
    }
  }
  throw new ServiceError("route_not_found", 404);
}

export async function serve(
  service: Service,
): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    void (async () => {
      try {
        const result = await route(service, request);
        response.statusCode = result.status;
        if ("value" in result) {
          response.setHeader("Content-Type", "application/json; charset=utf-8");
          response.end(JSON.stringify(result.value));
        } else response.end();
      } catch (error) {
        const failure = serviceError(error);
        console.error(JSON.stringify({ event: failure.code }));
        response.statusCode = failure.status;
        response.setHeader("Content-Type", "application/json; charset=utf-8");
        response.end(service.redactor.json({ error: diagnostic(error) }));
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", () => {
      reject(new ServiceError("listener_unavailable", 503));
    });
    server.listen(
      service.config.listen.port,
      service.config.listen.host,
      resolve,
    );
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new ServiceError("listener_unavailable", 503);
  let closing: Promise<void> | undefined;
  return {
    url: `http://${service.config.listen.host.includes(":") ? `[${service.config.listen.host}]` : service.config.listen.host}:${address.port}/v2`,
    close() {
      closing ??= (async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error === undefined) resolve();
            else reject(error);
          });
        });
        await service.close();
      })();
      return closing;
    },
  };
}

export async function start(config: Config) {
  const service = await Service.create(config);
  try {
    return await serve(service);
  } catch (error) {
    await service.close();
    throw error;
  }
}
