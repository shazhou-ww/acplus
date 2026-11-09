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
import { history, publicSession } from "./acp-history.js";
import type { Config } from "./acp-types.js";
import {
  canonicalDataDir,
  proof,
  publishOwner,
  verifies,
} from "./local-service.js";

async function body(
  request: IncomingMessage,
  keys: string[],
  optional: string[] = [],
) {
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
    Object.keys(value).some(
      (key) => !keys.includes(key) && !optional.includes(key),
    ) ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    throw new ServiceError(
      "invalid_input",
      400,
      "Unexpected or missing fields",
    );
  return value;
}

async function route(service: Service, request: IncomingMessage) {
  service.assertReady();
  const url = new URL(request.url ?? "", "http://acplus.invalid");
  const method = request.method ?? "";
  if (method === "GET" && url.pathname.startsWith("/v2/sessions"))
    return {
      status: 200,
      value: history(service.store, url, (id) => service.select(id)),
    };
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
      const value = await body(request, [], ["methodId"]);
      return {
        status: 202,
        value: service.beginAuth(
          agentId,
          Object.hasOwn(value, "methodId")
            ? text(value.methodId, "methodId")
            : undefined,
        ),
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
      const value = await body(
        request,
        ["agentId", "workingDirectory"],
        ["name"],
      );
      return {
        status: 201,
        value: publicSession(
          await service.createSession(
            text(value.agentId, "agentId"),
            text(value.workingDirectory, "workingDirectory"),
            Object.hasOwn(value, "name") ? text(value.name, "name") : undefined,
          ),
        ),
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
  if (method === "DELETE" && operation === undefined) {
    query();
    service.deleteSession(sessionId);
    return { status: 204 };
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
  idleGraceMs?: number,
): Promise<{ url: string; close(): Promise<void> }> {
  let stopping = false;
  let activeRequests = 0;
  let lastActivity = Date.now();
  const identity: { token?: string } = {};
  const nonces = new Map<string, number>();
  const dataDir = await canonicalDataDir(service.config.dataDir);
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    activeRequests += 1;
    const state = {
      finished: false,
      operationFinished: false,
      responseFinished: false,
    };
    const finish = () => {
      state.responseFinished = true;
      if (state.finished || !state.operationFinished) return;
      state.finished = true;
      activeRequests -= 1;
      lastActivity = Date.now();
    };
    response.once("finish", finish);
    response.once("close", finish);
    void (async () => {
      try {
        if (stopping) throw new ServiceError("service_stopping", 503);
        if (request.url === "/v2/local-owner") {
          const challenge = request.headers["x-acplus-challenge"];
          if (
            identity.token === undefined ||
            typeof challenge !== "string" ||
            !/^[a-f0-9]{64}$/u.test(challenge)
          )
            throw new ServiceError("local_owner_unauthorized", 403);
          response.setHeader("Content-Type", "application/json");
          response.end(
            JSON.stringify({
              dataDir,
              proof: proof(identity.token, challenge),
            }),
          );
          return;
        }
        // Managed services are private to clients holding their discovery token.
        if (
          idleGraceMs !== undefined ||
          request.headers["x-acplus-signature"] !== undefined
        ) {
          const nonce = request.headers["x-acplus-nonce"];
          const signature = request.headers["x-acplus-signature"];
          for (const [key, expires] of nonces)
            if (expires < Date.now()) nonces.delete(key);
          const timestamp =
            typeof nonce === "string" ? Number(nonce.split(".")[0]) : NaN;
          if (
            identity.token === undefined ||
            typeof nonce !== "string" ||
            !/^\d+\.[a-f0-9]{32}$/u.test(nonce) ||
            Math.abs(Date.now() - timestamp) > 30000 ||
            nonces.has(nonce) ||
            typeof signature !== "string" ||
            !verifies(
              signature,
              proof(
                identity.token,
                `${request.method ?? ""}:${request.url ?? ""}:${nonce}`,
              ),
            )
          )
            throw new ServiceError("local_owner_unauthorized", 403);
          nonces.set(nonce, timestamp + 30000);
        }
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
      } finally {
        state.operationFinished = true;
        if (state.responseFinished) finish();
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
  let discovery;
  try {
    discovery = await publishOwner(
      dataDir,
      `http://${service.config.listen.host.includes(":") ? "[::1]" : "127.0.0.1"}:${address.port}/v2`,
    );
  } catch (error) {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    throw error;
  }
  identity.token = discovery.value.token;
  lastActivity = Date.now();
  service.beforeRelease = () => discovery.release();
  let closing: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const result = {
    url: `http://${service.config.listen.host.includes(":") ? `[${service.config.listen.host}]` : service.config.listen.host}:${address.port}/v2`,
    close() {
      closing ??= (async () => {
        stopping = true;
        clearInterval(timer);
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
  if (idleGraceMs !== undefined) {
    timer = setInterval(
      () => {
        if (activeRequests > 0 || service.hasWork) {
          lastActivity = Date.now();
          return;
        }
        if (Date.now() - lastActivity >= idleGraceMs) {
          stopping = true;
          void result.close().catch((error: unknown) => {
            console.error(JSON.stringify({ event: serviceError(error).code }));
            process.exitCode = 1;
          });
        }
      },
      Math.min(100, idleGraceMs),
    );
  }
  return result;
}

async function startService(config: Config, idleGraceMs?: number) {
  const service = await Service.create(config);
  try {
    return await serve(service, idleGraceMs);
  } catch (error) {
    await service.close();
    throw error;
  }
}

export function start(config: Config) {
  return startService(config);
}

export function startManaged(config: Config, idleGraceMs: number) {
  return startService(config, idleGraceMs);
}
