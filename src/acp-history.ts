import { ServiceError, text, uuid } from "./acp-common.js";
import type { Store } from "./acp-store.js";
import type { Session } from "./acp-types.js";

export function integer(
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

export function publicSession(session: Session) {
  return {
    sessionId: session.sessionId,
    ...(session.name === undefined ? {} : { name: session.name }),
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

export function history(
  store: Store,
  url: URL,
  select: (id: string) => unknown,
): unknown {
  const query = (...names: string[]) => {
    const result: Record<string, string> = {};
    for (const name of url.searchParams.keys()) {
      if (!names.includes(name) || url.searchParams.getAll(name).length !== 1)
        throw new ServiceError("invalid_input", 400);
      result[name] = text(url.searchParams.get(name), name);
    }
    return result;
  };
  if (url.pathname === "/v2/sessions") {
    const value = query("agentId", "cursor", "limit");
    if (value.agentId !== undefined) select(value.agentId);
    const result = store.listSessions({
      limit: integer(value.limit, 100, 1, 1000),
      ...(value.agentId === undefined ? {} : { agentId: value.agentId }),
      ...(value.cursor === undefined ? {} : { cursor: value.cursor }),
    });
    return { ...result, items: result.items.map(publicSession) };
  }
  const match =
    /^\/v2\/sessions\/([^/]+)(?:\/(events|turns)(?:\/([^/]+))?)?$/u.exec(
      url.pathname,
    );
  if (match === null) throw new ServiceError("route_not_found", 404);
  const sessionId = uuid(match[1], "sessionId");
  const operation = match[2];
  const turnId = match[3] === undefined ? undefined : uuid(match[3], "turnId");
  if (operation === undefined) {
    query();
    return publicSession(store.getSession(sessionId));
  }
  if (operation === "events" && turnId === undefined) {
    const value = query("turnId", "after", "limit");
    return store.listEvents(sessionId, {
      limit: integer(value.limit, 100, 1, 1000),
      after: integer(value.after, 0, 0, Number.MAX_SAFE_INTEGER),
      ...(value.turnId === undefined
        ? {}
        : { turnId: uuid(value.turnId, "turnId") }),
    });
  }
  if (operation === "turns") {
    if (turnId !== undefined) {
      query();
      return store.getTurn(sessionId, turnId);
    }
    const value = query("cursor", "limit");
    return store.listTurns(sessionId, {
      limit: integer(value.limit, 100, 1, 1000),
      ...(value.cursor === undefined ? {} : { cursor: value.cursor }),
    });
  }
  throw new ServiceError("route_not_found", 404);
}
