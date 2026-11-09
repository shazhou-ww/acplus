import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, openSync, closeSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { record, Redactor, ServiceError, text, uuid } from "./acp-common.js";
import type {
  AuthObservation,
  Coverage,
  ErrorInfo,
  Event,
  EventPage,
  Page,
  Session,
  Turn,
  TurnState,
} from "./acp-types.js";

const states: TurnState[] = [
  "accepted",
  "starting",
  "dispatching",
  "running",
  "cancelling",
  "complete",
  "cancelled",
  "error",
  "unknown",
];
const terminal = new Set<TurnState>([
  "complete",
  "cancelled",
  "error",
  "unknown",
]);
const transitions: Record<TurnState, TurnState[]> = {
  accepted: ["starting", "error", "cancelled"],
  starting: ["dispatching", "error", "cancelled"],
  dispatching: [
    "running",
    "cancelling",
    "complete",
    "cancelled",
    "error",
    "unknown",
  ],
  running: ["cancelling", "complete", "cancelled", "error", "unknown"],
  cancelling: ["complete", "cancelled", "error", "unknown"],
  complete: [],
  cancelled: [],
  error: [],
  unknown: [],
};

function corruption(): never {
  throw new ServiceError("storage_corrupt", 503);
}
function strings(value: Record<string, unknown>, keys: string[]): boolean {
  return keys.every((key) => typeof value[key] === "string");
}
function nullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}
function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function coverage(value: unknown): value is Coverage {
  return value === "complete" || value === "partial" || value === "unknown";
}
function errorInfo(value: unknown): value is ErrorInfo {
  return record(value) && strings(value, ["code", "message"]);
}
function identifier(value: unknown): boolean {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
      value,
    )
  );
}
function timestamps(value: Record<string, unknown>): boolean {
  return ["createdAt", "updatedAt", "observedAt"].every(
    (key) =>
      typeof value[key] === "string" && Number.isFinite(Date.parse(value[key])),
  );
}
function session(value: unknown): value is Session {
  return (
    record(value) &&
    (value.name === undefined ||
      (typeof value.name === "string" && value.name.trim() !== "")) &&
    strings(value, [
      "sessionId",
      "agentId",
      "workingDirectory",
      "profileIdentity",
      "createdAt",
      "updatedAt",
      "observedAt",
    ]) &&
    identifier(value.sessionId) &&
    timestamps(value) &&
    nullableString(value.backendSessionId) &&
    integer(value.lastSequence) &&
    coverage(value.coverage)
  );
}
function turn(value: unknown): value is Turn {
  return (
    record(value) &&
    strings(value, [
      "sessionId",
      "turnId",
      "text",
      "response",
      "createdAt",
      "updatedAt",
      "observedAt",
    ]) &&
    identifier(value.sessionId) &&
    identifier(value.turnId) &&
    timestamps(value) &&
    states.some((state) => state === value.state) &&
    nullableString(value.stopReason) &&
    (value.error === null || errorInfo(value.error)) &&
    integer(value.lastSequence) &&
    coverage(value.coverage)
  );
}
function event(value: unknown): value is Event {
  return (
    record(value) &&
    strings(value, ["sessionId", "type", "observedAt"]) &&
    identifier(value.sessionId) &&
    (value.turnId === null || identifier(value.turnId)) &&
    typeof value.observedAt === "string" &&
    Number.isFinite(Date.parse(value.observedAt)) &&
    nullableString(value.turnId) &&
    integer(value.sequence) &&
    value.sequence > 0 &&
    ["live", "replay", "session"].some((source) => source === value.source) &&
    Object.hasOwn(value, "payload")
  );
}
function auth(value: unknown): value is AuthObservation {
  return (
    record(value) &&
    strings(value, ["agentId", "profileIdentity"]) &&
    (value.generation === null || integer(value.generation)) &&
    ["authenticated", "required", "unknown"].some(
      (status) => status === value.lastKnownStatus,
    ) &&
    ["current", "stale", "unknown"].some(
      (freshness) => freshness === value.freshness,
    ) &&
    ["verifiedAt", "expiresAt", "invalidationReason", "evidence"].every((key) =>
      nullableString(value[key]),
    ) &&
    ["verifiedAt", "expiresAt"].every(
      (key) =>
        value[key] === null ||
        (typeof value[key] === "string" &&
          Number.isFinite(Date.parse(value[key]))),
    ) &&
    Array.isArray(value.methods) &&
    value.methods.every(
      (method: unknown) =>
        record(method) &&
        strings(method, ["id", "name"]) &&
        ["agent", "terminal", "native"].some((type) => type === method.type),
    )
  );
}
function limit(value: number): void {
  if (!integer(value) || value < 1 || value > 1000)
    throw new ServiceError(
      "invalid_input",
      400,
      "limit must be between 1 and 1000",
    );
}

export class Store {
  private readonly db: DatabaseSync;
  private readonly redactor: Redactor;
  private closed = false;

  constructor(
    filePath: string,
    redactor = new Redactor(),
    private readonly readOnly = false,
  ) {
    this.redactor = redactor;
    let database: DatabaseSync | undefined;
    try {
      if (readOnly) {
        try {
          statSync(filePath);
        } catch (error) {
          throw new ServiceError(
            (error as NodeJS.ErrnoException).code === "ENOENT"
              ? "storage_missing"
              : "storage_failed",
            503,
          );
        }
      } else if (filePath !== ":memory:") {
        mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
        const fd = openSync(filePath, "a", 0o600);
        closeSync(fd);
        chmodSync(filePath, 0o600);
      }
      database = new DatabaseSync(filePath, { readOnly });
      this.db = database;
      this.db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
      const version = this.one("PRAGMA user_version")?.user_version;
      if ((readOnly && version !== 2) || (version !== 0 && version !== 2))
        throw new ServiceError("storage_schema_unsupported", 503);
      if (this.one("PRAGMA quick_check")?.quick_check !== "ok") corruption();
      this.snapshot(() => {
        if (version === 0) {
          if (
            this.one(
              "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
            )
          )
            corruption();
          this.db.exec(`
            CREATE TABLE sessions (
              ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
              session_id TEXT NOT NULL UNIQUE, agent_id TEXT NOT NULL,
              body TEXT NOT NULL
            );
            CREATE INDEX sessions_agent ON sessions(agent_id, ordinal);
            CREATE TABLE turns (
              ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
              session_id TEXT NOT NULL, turn_id TEXT NOT NULL,
              prompt_hash TEXT NOT NULL, body TEXT NOT NULL,
              UNIQUE(session_id, turn_id),
              FOREIGN KEY(session_id) REFERENCES sessions(session_id)
            );
            CREATE INDEX turns_session ON turns(session_id, ordinal);
            CREATE TABLE events (
              session_id TEXT NOT NULL, turn_id TEXT,
              sequence INTEGER NOT NULL CHECK(sequence > 0), body TEXT NOT NULL,
              PRIMARY KEY(session_id, sequence),
              FOREIGN KEY(session_id) REFERENCES sessions(session_id),
              FOREIGN KEY(session_id, turn_id) REFERENCES turns(session_id, turn_id)
            );
            CREATE INDEX events_turn ON events(session_id, turn_id, sequence);
            CREATE TABLE auth (
              agent_id TEXT NOT NULL, profile_identity TEXT NOT NULL, body TEXT NOT NULL,
              PRIMARY KEY(agent_id, profile_identity)
            );
            PRAGMA user_version=2;
          `);
        }
        if (this.one("PRAGMA foreign_key_check")) corruption();
        for (const row of this.all("SELECT session_id, body FROM sessions")) {
          const value = this.decode(row.body, session);
          if (value.sessionId !== row.session_id) corruption();
          const sequence = this.one(
            "SELECT COALESCE(MAX(sequence),0) AS sequence, COUNT(*) AS count FROM events WHERE session_id=?",
            value.sessionId,
          );
          if (
            sequence?.sequence !== value.lastSequence ||
            sequence.count !== value.lastSequence
          )
            corruption();
        }
        for (const row of this.all(
          "SELECT session_id, turn_id, prompt_hash, body FROM turns",
        )) {
          const value = this.decode(row.body, turn);
          if (
            value.sessionId !== row.session_id ||
            value.turnId !== row.turn_id
          )
            corruption();
          if (
            typeof row.prompt_hash !== "string" ||
            !/^[0-9a-f]{64}$/u.test(row.prompt_hash)
          )
            corruption();
          if (
            this.one(
              "SELECT COALESCE(MAX(sequence),0) AS sequence FROM events WHERE session_id=? AND turn_id=?",
              value.sessionId,
              value.turnId,
            )?.sequence !== value.lastSequence
          )
            corruption();
          if (!readOnly && !terminal.has(value.state))
            this.setState(
              value.sessionId,
              value.turnId,
              value.state === "accepted" || value.state === "starting"
                ? "error"
                : "unknown",
              {
                error: {
                  code:
                    value.state === "accepted" || value.state === "starting"
                      ? "dispatch_not_started"
                      : "turn_outcome_unknown",
                  message: "Service restarted before turn outcome was recorded",
                },
              },
            );
        }
        for (const row of this.all(
          "SELECT session_id, turn_id, sequence, body FROM events",
        )) {
          const value = this.decode(row.body, event);
          if (
            value.sessionId !== row.session_id ||
            value.turnId !== row.turn_id ||
            value.sequence !== row.sequence
          )
            corruption();
        }
        for (const row of this.all(
          "SELECT agent_id, profile_identity, body FROM auth",
        )) {
          const value = this.decode(row.body, auth);
          if (
            value.agentId !== row.agent_id ||
            value.profileIdentity !== row.profile_identity
          )
            corruption();
          if (!readOnly)
            this.saveAuth({
              ...value,
              freshness: "stale",
              invalidationReason: "service_restarted",
            });
        }
      });
    } catch (error) {
      database?.close();
      if (error instanceof ServiceError) throw error;
      throw new ServiceError("storage_failed", 503);
    }
  }

  private safe<T>(operation: () => T): T {
    try {
      if (this.closed) throw new ServiceError("storage_failed", 503);
      return operation();
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      throw new ServiceError("storage_failed", 503);
    }
  }
  private transaction<T>(operation: () => T): T {
    if (this.readOnly) throw new ServiceError("storage_read_only", 503);
    return this.snapshot(operation);
  }
  snapshot<T>(operation: () => T): T {
    return this.safe(() => {
      this.db.exec(this.readOnly ? "BEGIN" : "BEGIN IMMEDIATE");
      try {
        const result = operation();
        this.db.exec("COMMIT");
        return result;
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    });
  }
  private one(sql: string, ...values: SQLInputValue[]) {
    return this.safe(() => this.db.prepare(sql).get(...values));
  }
  private all(sql: string, ...values: SQLInputValue[]) {
    return this.safe(() => this.db.prepare(sql).all(...values));
  }
  private run(sql: string, ...values: SQLInputValue[]): void {
    this.safe(() => {
      this.db.prepare(sql).run(...values);
    });
  }
  private decode<T>(body: unknown, guard: (value: unknown) => value is T): T {
    if (typeof body !== "string") corruption();
    let value: unknown;
    try {
      value = JSON.parse(body);
    } catch {
      corruption();
    }
    if (!guard(value)) corruption();
    return value;
  }
  close(): void {
    if (!this.closed) {
      this.safe(() => {
        this.db.close();
      });
      this.closed = true;
    }
  }
  createSession(
    agentId: string,
    workingDirectory: string,
    profileIdentity: string,
    name?: string,
  ): Session {
    text(agentId, "agentId");
    text(workingDirectory, "workingDirectory");
    text(profileIdentity, "profileIdentity");
    if (name !== undefined) text(name, "name");
    return this.transaction(() => {
      const now = new Date().toISOString();
      const value: Session = {
        sessionId: randomUUID(),
        ...(name === undefined ? {} : { name: this.redactor.clean(name) }),
        agentId,
        workingDirectory,
        profileIdentity,
        backendSessionId: null,
        createdAt: now,
        updatedAt: now,
        observedAt: now,
        lastSequence: 0,
        coverage: "partial",
      };
      this.run(
        "INSERT INTO sessions(session_id, agent_id, body) VALUES (?, ?, ?)",
        value.sessionId,
        agentId,
        JSON.stringify(value),
      );
      return this.getSession(value.sessionId);
    });
  }
  getSession(sessionId: string): Session {
    uuid(sessionId, "sessionId");
    const row = this.one(
      "SELECT body FROM sessions WHERE session_id=?",
      sessionId,
    );
    if (!row) throw new ServiceError("session_not_found", 404);
    const value = this.decode(row.body, session);
    if (value.sessionId !== sessionId) corruption();
    return value;
  }
  deleteSession(sessionId: string): void {
    this.transaction(() => {
      this.getSession(sessionId);
      const turns = this.all(
        "SELECT body FROM turns WHERE session_id=?",
        sessionId,
      ).map((row) => this.decode(row.body, turn));
      if (turns.some((value) => value.state === "unknown"))
        throw new ServiceError("turn_outcome_unknown", 409);
      if (turns.some((value) => !terminal.has(value.state)))
        throw new ServiceError("session_busy", 409);
      this.run("DELETE FROM events WHERE session_id=?", sessionId);
      this.run("DELETE FROM turns WHERE session_id=?", sessionId);
      this.run("DELETE FROM sessions WHERE session_id=?", sessionId);
    });
  }
  private cursor(value: string | undefined, scope: string): number {
    if (value === undefined) return 0;
    try {
      const parsed: unknown = JSON.parse(
        Buffer.from(value, "base64url").toString("utf8"),
      );
      if (
        !record(parsed) ||
        parsed.scope !== scope ||
        !integer(parsed.key) ||
        Buffer.from(JSON.stringify(parsed)).toString("base64url") !== value
      )
        throw new Error();
      return parsed.key;
    } catch {
      throw new ServiceError("invalid_cursor", 400);
    }
  }
  private page<T>(
    rows: Record<string, unknown>[],
    count: number,
    scope: string,
    guard: (value: unknown) => value is T,
  ): Page<T> {
    const selected = rows.slice(0, count);
    const last = selected.at(-1);
    return {
      items: selected.map((row) => this.decode(row.body, guard)),
      nextCursor:
        rows.length > count && last
          ? Buffer.from(JSON.stringify({ scope, key: last.ordinal })).toString(
              "base64url",
            )
          : null,
    };
  }
  listSessions(options: {
    agentId?: string;
    cursor?: string;
    limit: number;
  }): Page<Session> {
    limit(options.limit);
    if (options.agentId !== undefined) text(options.agentId, "agentId");
    const scope = JSON.stringify(["sessions", options.agentId ?? null]);
    const after = this.cursor(options.cursor, scope);
    const rows =
      options.agentId === undefined
        ? this.all(
            "SELECT ordinal, body FROM sessions WHERE ordinal>? ORDER BY ordinal LIMIT ?",
            after,
            options.limit + 1,
          )
        : this.all(
            "SELECT ordinal, body FROM sessions WHERE agent_id=? AND ordinal>? ORDER BY ordinal LIMIT ?",
            options.agentId,
            after,
            options.limit + 1,
          );
    return this.page(rows, options.limit, scope, session);
  }
  bindSession(sessionId: string, backendSessionId: string): void {
    text(backendSessionId, "backendSessionId");
    this.transaction(() => {
      const value = this.getSession(sessionId);
      if (
        value.backendSessionId !== null &&
        value.backendSessionId !== backendSessionId
      )
        throw new ServiceError("session_already_bound", 409);
      this.saveSession({
        ...value,
        backendSessionId,
        updatedAt: new Date().toISOString(),
      });
    });
  }
  private saveSession(value: Session): void {
    this.run(
      "UPDATE sessions SET body=? WHERE session_id=?",
      JSON.stringify(value),
      value.sessionId,
    );
  }
  private saveTurn(value: Turn): void {
    this.run(
      "UPDATE turns SET body=? WHERE session_id=? AND turn_id=?",
      this.serializeTurn(value),
      value.sessionId,
      value.turnId,
    );
  }
  private serializeTurn(value: Turn): string {
    // Identity, state and timestamps are protocol metadata, not secret-bearing content.
    return JSON.stringify({
      ...value,
      text: this.redactor.clean(value.text),
      response: this.redactor.clean(value.response),
      stopReason:
        value.stopReason === null
          ? null
          : this.redactor.clean(value.stopReason),
      error:
        value.error === null
          ? null
          : {
              code: this.redactor.clean(value.error.code),
              message: this.redactor.clean(value.error.message),
            },
    });
  }
  findTurn(sessionId: string, turnId: string): Turn | null {
    this.getSession(sessionId);
    uuid(turnId, "turnId");
    const row = this.one(
      "SELECT body FROM turns WHERE session_id=? AND turn_id=?",
      sessionId,
      turnId,
    );
    if (!row) return null;
    const value = this.decode(row.body, turn);
    if (value.sessionId !== sessionId || value.turnId !== turnId) corruption();
    return value;
  }
  getTurn(sessionId: string, turnId: string): Turn {
    const value = this.findTurn(sessionId, turnId);
    if (!value) throw new ServiceError("turn_not_found", 404);
    return value;
  }
  admitTurn(
    sessionId: string,
    turnId: string,
    prompt: string,
  ): { turn: Turn; created: boolean } {
    text(prompt, "text");
    return this.transaction(() => {
      const existing = this.findTurn(sessionId, turnId);
      const hash = createHash("sha256")
        .update(JSON.stringify(prompt))
        .digest("hex");
      if (existing) {
        if (
          this.one(
            "SELECT prompt_hash FROM turns WHERE session_id=? AND turn_id=?",
            sessionId,
            turnId,
          )?.prompt_hash !== hash
        )
          throw new ServiceError("turn_id_conflict", 409);
        return { turn: existing, created: false };
      }
      const prior = this.all(
        "SELECT body FROM turns WHERE session_id=?",
        sessionId,
      ).map((row) => this.decode(row.body, turn));
      if (prior.some((value) => value.state === "unknown"))
        throw new ServiceError("turn_outcome_unknown", 409);
      if (prior.some((value) => !terminal.has(value.state)))
        throw new ServiceError("session_busy", 409);
      const now = new Date().toISOString();
      const value: Turn = {
        sessionId,
        turnId,
        text: this.redactor.clean(prompt),
        state: "accepted",
        response: "",
        stopReason: null,
        error: null,
        createdAt: now,
        updatedAt: now,
        observedAt: now,
        lastSequence: 0,
        coverage: "partial",
      };
      this.run(
        "INSERT INTO turns(session_id,turn_id,prompt_hash,body) VALUES(?,?,?,?)",
        sessionId,
        turnId,
        hash,
        this.serializeTurn(value),
      );
      this.insertEvent(
        sessionId,
        turnId,
        "user_message",
        { content: { type: "text", text: prompt } },
        "live",
      );
      return { turn: this.getTurn(sessionId, turnId), created: true };
    });
  }
  setTurnState(
    sessionId: string,
    turnId: string,
    state: TurnState,
    options: { stopReason?: string; error?: ErrorInfo; response?: string } = {},
  ): Turn {
    return this.transaction(() =>
      this.setState(sessionId, turnId, state, options),
    );
  }
  private setState(
    sessionId: string,
    turnId: string,
    state: TurnState,
    options: { stopReason?: string; error?: ErrorInfo; response?: string },
  ): Turn {
    const value = this.getTurn(sessionId, turnId);
    if (
      !states.includes(state) ||
      (state !== value.state && !transitions[value.state].includes(state))
    )
      throw new ServiceError("invalid_turn_state", 409);
    if (
      (options.error !== undefined && !errorInfo(options.error)) ||
      (options.stopReason !== undefined &&
        typeof options.stopReason !== "string") ||
      (options.response !== undefined && typeof options.response !== "string")
    )
      throw new ServiceError("invalid_input", 400);
    if (terminal.has(value.state)) {
      if (Object.keys(options).length !== 0)
        throw new ServiceError("invalid_turn_state", 409);
      return value;
    }
    const updated: Turn = {
      ...value,
      state,
      stopReason:
        options.stopReason === undefined
          ? value.stopReason
          : this.redactor.clean(options.stopReason),
      error:
        options.error === undefined
          ? value.error
          : {
              code: this.redactor.clean(options.error.code),
              message: this.redactor.clean(options.error.message),
            },
      coverage:
        state === "complete"
          ? "complete"
          : state === "unknown"
            ? "unknown"
            : "partial",
    };
    // Response is derived exclusively from committed agent text chunks, never a summary.
    this.saveTurn(updated);
    this.insertEvent(
      sessionId,
      turnId,
      "turn_state",
      { state, stopReason: updated.stopReason, error: updated.error },
      "live",
    );
    return this.getTurn(sessionId, turnId);
  }
  appendEvent(
    sessionId: string,
    turnId: string | null,
    type: string,
    payload: unknown,
    source: "live" | "replay" | "session" = "live",
  ): Event {
    text(type, "type");
    if (
      !["live", "replay", "session"].includes(source) ||
      (source === "replay" && turnId !== null)
    )
      throw new ServiceError("invalid_input", 400);
    return this.transaction(() =>
      this.insertEvent(sessionId, turnId, type, payload, source),
    );
  }
  private insertEvent(
    sessionId: string,
    turnId: string | null,
    type: string,
    payload: unknown,
    source: "live" | "replay" | "session",
  ): Event {
    const owner = this.getSession(sessionId);
    const target = turnId === null ? null : this.getTurn(sessionId, turnId);
    if (target && terminal.has(target.state) && type !== "turn_state")
      throw new ServiceError("invalid_turn_state", 409);
    const now = new Date().toISOString();
    const sequence = owner.lastSequence + 1;
    if (!integer(sequence)) corruption();
    const cleanPayload: unknown = JSON.parse(this.redactor.json({ payload }));
    if (!record(cleanPayload)) corruption();
    const serialized = JSON.stringify({
      sessionId,
      turnId,
      sequence,
      type,
      payload: cleanPayload.payload,
      source,
      observedAt: now,
    });
    const value = this.decode(serialized, event);
    this.run(
      "INSERT INTO events(session_id,turn_id,sequence,body) VALUES(?,?,?,?)",
      sessionId,
      turnId,
      sequence,
      serialized,
    );
    if (target) {
      if (
        type === "agent_message_chunk" &&
        source === "live" &&
        record(value.payload) &&
        record(value.payload.content) &&
        value.payload.content.type === "text" &&
        typeof value.payload.content.text === "string"
      )
        target.response += value.payload.content.text;
      this.saveTurn({
        ...target,
        lastSequence: sequence,
        updatedAt: now,
        observedAt: now,
      });
    }
    const turns = this.all(
      "SELECT body FROM turns WHERE session_id=?",
      sessionId,
    ).map((row) => this.decode(row.body, turn));
    const hasReplay =
      this.one(
        "SELECT 1 FROM events WHERE session_id=? AND json_extract(body,'$.source')='replay' LIMIT 1",
        sessionId,
      ) !== undefined;
    this.saveSession({
      ...owner,
      lastSequence: sequence,
      updatedAt: now,
      observedAt: now,
      coverage: turns.some((item) => item.coverage === "unknown")
        ? "unknown"
        : !hasReplay &&
            turns.length > 0 &&
            turns.every((item) => item.coverage === "complete")
          ? "complete"
          : "partial",
    });
    return value;
  }
  listTurns(
    sessionId: string,
    options: { cursor?: string; limit: number },
  ): Page<Turn> {
    this.getSession(sessionId);
    limit(options.limit);
    const scope = JSON.stringify(["turns", sessionId]);
    const after = this.cursor(options.cursor, scope);
    return this.page(
      this.all(
        "SELECT ordinal,body FROM turns WHERE session_id=? AND ordinal>? ORDER BY ordinal LIMIT ?",
        sessionId,
        after,
        options.limit + 1,
      ),
      options.limit,
      scope,
      turn,
    );
  }
  listEvents(
    sessionId: string,
    options: { turnId?: string; after?: number; limit: number },
  ): EventPage {
    const owner = this.getSession(sessionId);
    limit(options.limit);
    const after = options.after ?? 0;
    if (!integer(after)) throw new ServiceError("invalid_input", 400);
    const target =
      options.turnId === undefined
        ? null
        : this.getTurn(sessionId, options.turnId);
    const rows =
      options.turnId === undefined
        ? this.all(
            "SELECT body FROM events WHERE session_id=? AND sequence>? ORDER BY sequence LIMIT ?",
            sessionId,
            after,
            options.limit + 1,
          )
        : this.all(
            "SELECT body FROM events WHERE session_id=? AND turn_id=? AND sequence>? ORDER BY sequence LIMIT ?",
            sessionId,
            options.turnId,
            after,
            options.limit + 1,
          );
    const items = rows
      .slice(0, options.limit)
      .map((row) => this.decode(row.body, event));
    return {
      items,
      nextAfter:
        rows.length > options.limit ? (items.at(-1)?.sequence ?? null) : null,
      lastSequence: target?.lastSequence ?? owner.lastSequence,
      coverage: target?.coverage ?? owner.coverage,
      observedAt: target?.observedAt ?? owner.observedAt,
    };
  }
  getAuth(agentId: string, profileIdentity: string): AuthObservation {
    text(agentId, "agentId");
    text(profileIdentity, "profileIdentity");
    return this.transaction(() => {
      const row = this.one(
        "SELECT body FROM auth WHERE agent_id=? AND profile_identity=?",
        agentId,
        profileIdentity,
      );
      if (!row) {
        const changed = this.one(
          "SELECT agent_id FROM auth WHERE agent_id=?",
          agentId,
        );
        const value: AuthObservation = {
          agentId,
          profileIdentity,
          generation: null,
          lastKnownStatus: "unknown",
          verifiedAt: null,
          expiresAt: null,
          freshness: changed ? "stale" : "unknown",
          invalidationReason: changed ? "profile_changed" : null,
          evidence: null,
          methods: [],
        };
        if (changed) {
          this.run(
            "UPDATE auth SET body=json_set(body,'$.freshness','stale','$.invalidationReason','profile_changed') WHERE agent_id=?",
            agentId,
          );
          this.saveAuth(value);
        }
        return value;
      }
      const value = this.decode(row.body, auth);
      if (
        value.expiresAt !== null &&
        Date.parse(value.expiresAt) <= Date.now() &&
        value.freshness === "current"
      ) {
        value.freshness = "stale";
        value.invalidationReason = "credential_expired";
        this.saveAuth(value);
      }
      return value;
    });
  }
  setAuth(value: AuthObservation): void {
    if (!auth(value)) throw new ServiceError("invalid_input", 400);
    text(value.agentId, "agentId");
    text(value.profileIdentity, "profileIdentity");
    this.transaction(() => {
      this.run(
        "UPDATE auth SET body=json_set(body,'$.freshness','stale','$.invalidationReason','profile_changed') WHERE agent_id=? AND profile_identity<>?",
        value.agentId,
        value.profileIdentity,
      );
      this.saveAuth(value);
    });
  }
  private saveAuth(value: AuthObservation): void {
    // Only the observation contract is persisted, not raw authentication output.
    const clean: AuthObservation = {
      agentId: value.agentId,
      profileIdentity: value.profileIdentity,
      generation: value.generation,
      lastKnownStatus: value.lastKnownStatus,
      verifiedAt: value.verifiedAt,
      expiresAt: value.expiresAt,
      freshness: value.freshness,
      invalidationReason:
        value.invalidationReason === null
          ? null
          : this.redactor.clean(value.invalidationReason),
      evidence:
        value.evidence === null ? null : this.redactor.clean(value.evidence),
      methods: value.methods.map(({ id, name, type }) => ({
        id,
        name: this.redactor.clean(name),
        type,
      })),
    };
    this.run(
      "INSERT INTO auth(agent_id,profile_identity,body) VALUES(?,?,?) ON CONFLICT(agent_id,profile_identity) DO UPDATE SET body=excluded.body",
      value.agentId,
      value.profileIdentity,
      JSON.stringify(clean),
    );
  }
  invalidateAuth(agentId: string, reason: string): void {
    text(agentId, "agentId");
    text(reason, "reason");
    this.transaction(() => {
      for (const row of this.all(
        "SELECT body FROM auth WHERE agent_id=?",
        agentId,
      ))
        this.saveAuth({
          ...this.decode(row.body, auth),
          freshness: "stale",
          invalidationReason: this.redactor.clean(reason),
        });
    });
  }
}
