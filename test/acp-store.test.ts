import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { Redactor, ServiceError } from "../src/acp-common.js";
import { Store } from "../src/acp-store.js";
import type { AuthObservation, TurnState } from "../src/acp-types.js";

const directories: string[] = [];
const stores: Store[] = [];
function fixture() {
  const directory = resolve(".acp-store-tests", randomUUID());
  mkdirSync(directory, { recursive: true });
  directories.push(directory);
  const file = resolve(directory, "store.sqlite");
  return { directory, file };
}
function open(file = ":memory:", redactor?: Redactor) {
  const store = new Store(file, redactor);
  stores.push(store);
  return store;
}
function owner(store: Store, agent = "agent") {
  return store.createSession(agent, resolve("."), "profile");
}
function admitted(store: Store, sessionId: string) {
  return store.admitTurn(sessionId, randomUUID(), "hello").turn;
}
function start(store: Store, sessionId: string, turnId: string) {
  store.setTurnState(sessionId, turnId, "starting");
  store.setTurnState(sessionId, turnId, "dispatching");
  store.setTurnState(sessionId, turnId, "running");
}
function observation(
  overrides: Partial<AuthObservation> = {},
): AuthObservation {
  return {
    agentId: "agent",
    profileIdentity: "profile",
    generation: 1,
    lastKnownStatus: "authenticated",
    verifiedAt: new Date().toISOString(),
    expiresAt: null,
    freshness: "current",
    invalidationReason: null,
    evidence: "authenticate_succeeded",
    methods: [{ id: "login", name: "Login", type: "agent" }],
    ...overrides,
  };
}
function failure(operation: () => unknown, code: string, status: number) {
  expect(operation).toThrowError(expect.objectContaining({ code, status }));
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
  rmSync(resolve(".acp-store-tests"), { recursive: true, force: true });
});

describe("direct ACP persistence", () => {
  it("deletes only one Session and its local history, refusing active or unknown work", () => {
    const store = open();
    const first = owner(store);
    const keep = owner(store);
    store.setAuth(observation());
    const active = admitted(store, first.sessionId);
    failure(
      () => {
        store.deleteSession(first.sessionId);
      },
      "session_busy",
      409,
    );
    expect(store.getTurn(first.sessionId, active.turnId).state).toBe(
      "accepted",
    );
    start(store, first.sessionId, active.turnId);
    store.setTurnState(first.sessionId, active.turnId, "unknown");
    failure(
      () => {
        store.deleteSession(first.sessionId);
      },
      "turn_outcome_unknown",
      409,
    );
    const empty = owner(store);
    store.deleteSession(empty.sessionId);
    failure(() => store.getSession(empty.sessionId), "session_not_found", 404);
    const completed = admitted(store, keep.sessionId);
    start(store, keep.sessionId, completed.turnId);
    store.appendEvent(keep.sessionId, completed.turnId, "agent_message_chunk", {
      content: { type: "text", text: "hello" },
    });
    store.setTurnState(keep.sessionId, completed.turnId, "complete");
    store.deleteSession(keep.sessionId);
    failure(() => store.getSession(keep.sessionId), "session_not_found", 404);
    failure(
      () => store.getTurn(keep.sessionId, completed.turnId),
      "session_not_found",
      404,
    );
    expect(
      store.listSessions({ limit: 100 }).items.map((item) => item.sessionId),
    ).toEqual([first.sessionId]);
    expect(store.getAuth("agent", "profile").lastKnownStatus).toBe(
      "authenticated",
    );
    failure(
      () => {
        store.deleteSession(keep.sessionId);
      },
      "session_not_found",
      404,
    );
  });
  it("redacts short environment values without corrupting durable protocol metadata", () => {
    const { file } = fixture();
    const redactor = new Redactor();
    let store = open(file, redactor);
    const session = store.createSession(
      "agent-1",
      resolve("workspace-1"),
      "profile-1",
    );
    redactor.add("1");
    redactor.add("agent");
    store.bindSession(session.sessionId, "backend-1");
    const firstId = "11111111-1111-4111-8111-111111111111";
    store.admitTurn(session.sessionId, firstId, "prompt 1");
    start(store, session.sessionId, firstId);
    store.appendEvent(session.sessionId, firstId, "agent_message_chunk", {
      content: { type: "text", text: "response 1" },
    });
    store.setTurnState(session.sessionId, firstId, "complete");
    store.setAuth(
      observation({
        agentId: "agent-1",
        profileIdentity: "profile-1",
        methods: [{ id: "agent-1", name: "agent 1", type: "agent" }],
      }),
    );
    expect(store.getSession(session.sessionId)).toMatchObject({
      agentId: "agent-1",
      backendSessionId: "backend-1",
      workingDirectory: resolve("workspace-1"),
      profileIdentity: "profile-1",
    });
    expect(store.getTurn(session.sessionId, firstId)).toMatchObject({
      turnId: firstId,
      text: "prompt [redacted]",
      response: "response [redacted]",
      state: "complete",
      coverage: "complete",
    });
    expect(store.getAuth("agent-1", "profile-1").methods).toEqual([
      { id: "agent-1", name: "[redacted] [redacted]", type: "agent" },
    ]);
    store.close();
    store = open(file, redactor);
    expect(store.getTurn(session.sessionId, firstId).state).toBe("complete");
    const secondId = randomUUID();
    store.admitTurn(session.sessionId, secondId, "prompt 1");
    store.setTurnState(session.sessionId, secondId, "starting");
    store.setTurnState(session.sessionId, secondId, "error", {
      error: {
        code: "session_resume_unsupported",
        message: "session resume unsupported 1",
      },
    });
    expect(store.getTurn(session.sessionId, secondId)).toMatchObject({
      state: "error",
      error: {
        code: "session_resume_unsupported",
        message: "session resume unsupported [redacted]",
      },
    });
    expect(
      store
        .listEvents(session.sessionId, { turnId: firstId, limit: 100 })
        .items.find((event) => event.type === "agent_message_chunk"),
    ).toMatchObject({
      sessionId: session.sessionId,
      turnId: firstId,
      source: "live",
      payload: { content: { type: "text", text: "response [redacted]" } },
    });
    store.close();
    expect(
      open(file, redactor).getTurn(session.sessionId, secondId).state,
    ).toBe("error");
  });

  it("persists sessions, typed events, text response and completion in order", () => {
    const { file } = fixture();
    const store = open(file);
    const session = owner(store);
    store.bindSession(session.sessionId, "backend");
    store.bindSession(session.sessionId, "backend");
    failure(
      () => {
        store.bindSession(session.sessionId, "other");
      },
      "session_already_bound",
      409,
    );
    const turn = admitted(store, session.sessionId);
    start(store, session.sessionId, turn.turnId);
    store.appendEvent(session.sessionId, turn.turnId, "tool_call_update", {
      toolCallId: "tool",
      status: "completed",
      content: [
        { type: "content", content: { type: "text", text: "not response" } },
      ],
    });
    store.appendEvent(session.sessionId, turn.turnId, "agent_thought_chunk", {
      content: { type: "text", text: "not response" },
    });
    store.appendEvent(session.sessionId, turn.turnId, "agent_message_chunk", {
      content: { type: "image", data: "not text" },
    });
    store.appendEvent(session.sessionId, turn.turnId, "agent_message_chunk", {
      content: { type: "text", text: "first" },
    });
    store.appendEvent(session.sessionId, turn.turnId, "agent_message_chunk", {
      content: { type: "text", text: " second" },
    });
    const complete = store.setTurnState(
      session.sessionId,
      turn.turnId,
      "complete",
      { stopReason: "end_turn", response: "ignored summary" },
    );
    expect(complete).toMatchObject({
      state: "complete",
      response: "first second",
      coverage: "complete",
      stopReason: "end_turn",
    });
    const before = store.listEvents(session.sessionId, { limit: 100 });
    expect(before.items.at(-1)?.payload).toMatchObject({ state: "complete" });
    expect(
      before.items.find((event) => event.type === "tool_call_update")?.payload,
    ).toMatchObject({ content: [{ type: "content" }] });
    store.close();
    store.close();
    const reopened = open(file);
    expect(reopened.getSession(session.sessionId).backendSessionId).toBe(
      "backend",
    );
    expect(reopened.getTurn(session.sessionId, turn.turnId)).toEqual(complete);
    expect(reopened.listEvents(session.sessionId, { limit: 100 })).toEqual(
      before,
    );
    if (process.platform !== "win32")
      expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("distinguishes original lone-surrogate prompts for exact turn deduplication", () => {
    const { file } = fixture();
    const store = open(file);
    const session = owner(store);
    const id = randomUUID();
    const original = "\ud800";
    const different = "\ud801";
    const first = store.admitTurn(session.sessionId, id, original);
    expect(store.admitTurn(session.sessionId, id, original)).toEqual({
      turn: first.turn,
      created: false,
    });
    failure(
      () => store.admitTurn(session.sessionId, id, different),
      "turn_id_conflict",
      409,
    );
    expect(
      store.listEvents(session.sessionId, { limit: 100 }).items,
    ).toHaveLength(1);
    store.setTurnState(session.sessionId, id, "error");
    store.close();
    const reopened = open(file);
    expect(reopened.admitTurn(session.sessionId, id, original).created).toBe(
      false,
    );
    failure(
      () => reopened.admitTurn(session.sessionId, id, different),
      "turn_id_conflict",
      409,
    );
    expect(reopened.getTurn(session.sessionId, id).text).toBe(original);
    expect(reopened.getTurn(session.sessionId, id)).not.toHaveProperty(
      "prompt_hash",
    );
  });

  it("hashes original prompts before redaction and atomically deduplicates admission", () => {
    const redactor = new Redactor();
    redactor.add("secret-a");
    redactor.add("secret-b");
    const { file } = fixture();
    let store = open(file, redactor);
    const session = owner(store);
    const id = randomUUID();
    const first = store.admitTurn(session.sessionId, id, "use secret-a");
    expect(first.created).toBe(true);
    expect(first.turn.text).toBe("use [redacted]");
    expect(store.admitTurn(session.sessionId, id, "use secret-a")).toEqual({
      turn: first.turn,
      created: false,
    });
    failure(
      () => store.admitTurn(session.sessionId, id, "use secret-b"),
      "turn_id_conflict",
      409,
    );
    failure(
      () => store.admitTurn(session.sessionId, randomUUID(), "new"),
      "session_busy",
      409,
    );
    expect(
      store.listEvents(session.sessionId, { limit: 100 }).items,
    ).toHaveLength(1);
    store.setTurnState(session.sessionId, id, "error", {
      error: { code: "secret-a", message: "failure secret-b" },
      stopReason: "secret-a",
    });
    store.setAuth({
      ...observation({
        evidence: "secret-a",
        methods: [{ id: "login", name: "secret-b", type: "native" }],
      }),
      token: "DO_NOT_PERSIST",
    } as AuthObservation);
    store.close();
    expect(readFileSync(file).includes(Buffer.from("secret-a"))).toBe(false);
    expect(readFileSync(file).includes(Buffer.from("secret-b"))).toBe(false);
    expect(readFileSync(file).includes(Buffer.from("DO_NOT_PERSIST"))).toBe(
      false,
    );
    store = open(file, redactor);
    expect(store.admitTurn(session.sessionId, id, "use secret-a").created).toBe(
      false,
    );
    expect(store.getTurn(session.sessionId, id).error).toEqual({
      code: "[redacted]",
      message: "failure [redacted]",
    });
    expect(store.getAuth("agent", "profile").methods[0]?.name).toBe(
      "[redacted]",
    );
  });

  it.each<TurnState>([
    "accepted",
    "starting",
    "dispatching",
    "running",
    "cancelling",
  ])("recovers %s without redispatch or replay", (state) => {
    const { file } = fixture();
    const store = open(file);
    const session = owner(store);
    const turn = admitted(store, session.sessionId);
    if (state !== "accepted")
      store.setTurnState(session.sessionId, turn.turnId, "starting");
    if (["dispatching", "running", "cancelling"].includes(state))
      store.setTurnState(session.sessionId, turn.turnId, "dispatching");
    if (["running", "cancelling"].includes(state))
      store.setTurnState(session.sessionId, turn.turnId, "running");
    if (state === "cancelling")
      store.setTurnState(session.sessionId, turn.turnId, "cancelling");
    store.close();
    const recovered = open(file);
    const neverDispatched = state === "accepted" || state === "starting";
    expect(recovered.getTurn(session.sessionId, turn.turnId)).toMatchObject({
      state: neverDispatched ? "error" : "unknown",
      coverage: neverDispatched ? "partial" : "unknown",
      error: {
        code: neverDispatched ? "dispatch_not_started" : "turn_outcome_unknown",
      },
    });
    expect(
      recovered.admitTurn(session.sessionId, turn.turnId, "hello").created,
    ).toBe(false);
    expect(
      recovered
        .listEvents(session.sessionId, { limit: 100 })
        .items.every((event) => event.source === "live"),
    ).toBe(true);
    if (!neverDispatched)
      failure(
        () => admitted(recovered, session.sessionId),
        "turn_outcome_unknown",
        409,
      );
    else expect(admitted(recovered, session.sessionId).state).toBe("accepted");
  });

  it("persists confirmed local cancellation before dispatch without making crash recovery safe", () => {
    const { file } = fixture();
    const store = open(file);
    const session = owner(store);
    const first = admitted(store, session.sessionId);
    store.setTurnState(session.sessionId, first.turnId, "starting");
    store.setTurnState(session.sessionId, first.turnId, "dispatching");
    const cancelled = store.setTurnState(
      session.sessionId,
      first.turnId,
      "cancelled",
      { stopReason: "cancelled" },
    );
    expect(cancelled).toMatchObject({
      state: "cancelled",
      stopReason: "cancelled",
      error: null,
      response: "",
      coverage: "partial",
    });
    expect(
      store
        .listEvents(session.sessionId, { turnId: first.turnId, limit: 100 })
        .items.at(-1)?.payload,
    ).toEqual({ state: "cancelled", stopReason: "cancelled", error: null });
    expect(store.admitTurn(session.sessionId, first.turnId, "hello")).toEqual({
      turn: cancelled,
      created: false,
    });
    const second = admitted(store, session.sessionId);
    store.setTurnState(session.sessionId, second.turnId, "starting");
    store.setTurnState(session.sessionId, second.turnId, "dispatching");
    store.close();
    const reopened = open(file);
    expect(reopened.getTurn(session.sessionId, first.turnId)).toEqual(
      cancelled,
    );
    expect(reopened.getTurn(session.sessionId, second.turnId)).toMatchObject({
      state: "unknown",
      coverage: "unknown",
      error: { code: "turn_outcome_unknown" },
    });
  });

  it("enforces state transitions and terminal immutability", () => {
    const store = open();
    const session = owner(store);
    const turn = admitted(store, session.sessionId);
    failure(
      () => store.setTurnState(session.sessionId, turn.turnId, "complete"),
      "invalid_turn_state",
      409,
    );
    failure(
      () =>
        store.setTurnState(session.sessionId, turn.turnId, "fake" as TurnState),
      "invalid_turn_state",
      409,
    );
    failure(
      () =>
        store.setTurnState(session.sessionId, turn.turnId, "starting", {
          error: {} as never,
        }),
      "invalid_input",
      400,
    );
    failure(
      () =>
        store.setTurnState(session.sessionId, turn.turnId, "starting", {
          stopReason: 1 as never,
        }),
      "invalid_input",
      400,
    );
    failure(
      () =>
        store.setTurnState(session.sessionId, turn.turnId, "starting", {
          response: 1 as never,
        }),
      "invalid_input",
      400,
    );
    start(store, session.sessionId, turn.turnId);
    store.setTurnState(session.sessionId, turn.turnId, "cancelling");
    const cancelled = store.setTurnState(
      session.sessionId,
      turn.turnId,
      "cancelled",
    );
    expect(cancelled.coverage).toBe("partial");
    expect(
      store.setTurnState(session.sessionId, turn.turnId, "cancelled"),
    ).toEqual(cancelled);
    failure(
      () =>
        store.setTurnState(session.sessionId, turn.turnId, "cancelled", {
          response: "changed",
        }),
      "invalid_turn_state",
      409,
    );
    failure(
      () => store.setTurnState(session.sessionId, turn.turnId, "running"),
      "invalid_turn_state",
      409,
    );
    failure(
      () =>
        store.appendEvent(
          session.sessionId,
          turn.turnId,
          "agent_message_chunk",
          { content: { type: "text", text: "late" } },
        ),
      "invalid_turn_state",
      409,
    );
    expect(admitted(store, session.sessionId).state).toBe("accepted");
  });

  it.each([1, 100, 1000])(
    "filters interleaved events before limit %i and preserves original sequences",
    (size) => {
      const store = open();
      const session = owner(store);
      const first = admitted(store, session.sessionId);
      const expected: number[] = [1];
      for (let index = 0; index < 1003; index++) {
        store.appendEvent(
          session.sessionId,
          null,
          "history",
          { index },
          "replay",
        );
        expected.push(
          store.appendEvent(
            session.sessionId,
            first.turnId,
            "tool_call_update",
            { toolCallId: "x", index },
          ).sequence,
        );
      }
      const all: number[] = [];
      let after = 0;
      let more = true;
      while (more) {
        const page = store.listEvents(session.sessionId, {
          turnId: first.turnId,
          after,
          limit: size,
        });
        all.push(...page.items.map((event) => event.sequence));
        expect(page.items.every((event) => event.turnId === first.turnId)).toBe(
          true,
        );
        expect(page.coverage).toBe("partial");
        more = page.nextAfter !== null;
        if (page.nextAfter !== null) {
          expect(page.nextAfter).toBeGreaterThan(after);
          after = page.nextAfter;
        }
      }
      expect(all).toEqual(expected);
      expect(
        store.listEvents(session.sessionId, {
          turnId: first.turnId,
          after: expected.at(-1)!,
          limit: size,
        }).items,
      ).toEqual([]);
      store.setTurnState(session.sessionId, first.turnId, "error");
      const second = admitted(store, session.sessionId);
      expect(
        store
          .listEvents(session.sessionId, { turnId: second.turnId, limit: size })
          .items.map((event) => event.type),
      ).toEqual(["user_message"]);
      const other = owner(store);
      const foreign = admitted(store, other.sessionId);
      failure(
        () =>
          store.listEvents(session.sessionId, {
            turnId: foreign.turnId,
            limit: size,
          }),
        "turn_not_found",
        404,
      );
      failure(
        () =>
          store.listEvents(session.sessionId, {
            turnId: randomUUID(),
            limit: size,
          }),
        "turn_not_found",
        404,
      );
    },
  );

  it("returns empty known turn filters and explicit replay provenance", () => {
    const { file } = fixture();
    const store = open(file);
    const session = owner(store);
    const turn = admitted(store, session.sessionId);
    const db = new DatabaseSync(file);
    db.prepare("DELETE FROM events WHERE session_id=?").run(session.sessionId);
    db.close();
    expect(
      store.listEvents(session.sessionId, { turnId: turn.turnId, limit: 1 })
        .items,
    ).toEqual([]);
    const replay = store.appendEvent(
      session.sessionId,
      null,
      "agent_message_chunk",
      { content: { type: "text", text: "history" } },
      "replay",
    );
    expect(replay).toMatchObject({ turnId: null, source: "replay" });
    expect(store.getTurn(session.sessionId, turn.turnId).response).toBe("");
    expect(
      store.listEvents(session.sessionId, { turnId: turn.turnId, limit: 1 })
        .items,
    ).toEqual([]);
    failure(
      () =>
        store.appendEvent(
          session.sessionId,
          turn.turnId,
          "history",
          {},
          "replay",
        ),
      "invalid_input",
      400,
    );
    failure(
      () =>
        store.appendEvent(
          session.sessionId,
          null,
          "history",
          {},
          "wrong" as never,
        ),
      "invalid_input",
      400,
    );
    failure(
      () => store.appendEvent(session.sessionId, randomUUID(), "history", {}),
      "turn_not_found",
      404,
    );
    failure(
      () => store.appendEvent(session.sessionId, null, "bad", undefined),
      "storage_corrupt",
      503,
    );
  });

  it("uses scoped stable keyset cursors, not mutable offsets", () => {
    const store = open();
    const first = owner(store, "a");
    owner(store, "b");
    const second = owner(store, "a");
    const page = store.listSessions({ agentId: "a", limit: 1 });
    expect(page.items[0]?.sessionId).toBe(first.sessionId);
    expect(page.nextCursor).not.toBeNull();
    const third = owner(store, "a");
    const following = store.listSessions({
      agentId: "a",
      cursor: page.nextCursor!,
      limit: 100,
    });
    expect(following.items.map((session) => session.sessionId)).toEqual([
      second.sessionId,
      third.sessionId,
    ]);
    expect(store.listSessions({ limit: 100 }).items).toHaveLength(4);
    failure(
      () =>
        store.listSessions({
          agentId: "b",
          cursor: page.nextCursor!,
          limit: 1,
        }),
      "invalid_cursor",
      400,
    );
    failure(
      () => store.listSessions({ cursor: "1", limit: 1 }),
      "invalid_cursor",
      400,
    );
    failure(
      () =>
        store.listSessions({
          cursor: Buffer.from('{"scope":"sessions","key":-1}').toString(
            "base64url",
          ),
          limit: 1,
        }),
      "invalid_cursor",
      400,
    );
    const turn = admitted(store, first.sessionId);
    store.setTurnState(first.sessionId, turn.turnId, "error");
    const next = admitted(store, first.sessionId);
    const turns = store.listTurns(first.sessionId, { limit: 1 });
    expect(
      store.listTurns(first.sessionId, { cursor: turns.nextCursor!, limit: 1 })
        .items[0]?.turnId,
    ).toBe(next.turnId);
    failure(
      () =>
        store.listTurns(second.sessionId, {
          cursor: turns.nextCursor!,
          limit: 1,
        }),
      "invalid_cursor",
      400,
    );
  });

  it("keeps auth evidence separate, expires it and invalidates profile changes and restarts", () => {
    const { file } = fixture();
    const store = open(file);
    expect(store.getAuth("agent", "profile")).toMatchObject({
      freshness: "unknown",
      lastKnownStatus: "unknown",
    });
    store.setAuth(observation());
    expect(store.getAuth("agent", "profile").freshness).toBe("current");
    expect(store.getAuth("agent", "new-profile")).toMatchObject({
      freshness: "stale",
      lastKnownStatus: "unknown",
      invalidationReason: "profile_changed",
      evidence: null,
    });
    store.setAuth(observation({ profileIdentity: "new-profile" }));
    expect(store.getAuth("agent", "profile").invalidationReason).toBe(
      "profile_changed",
    );
    store.invalidateAuth("agent", "runtime_disconnected");
    expect(store.getAuth("agent", "new-profile")).toMatchObject({
      freshness: "stale",
      invalidationReason: "runtime_disconnected",
    });
    store.setAuth(
      observation({ expiresAt: new Date(Date.now() - 1000).toISOString() }),
    );
    expect(store.getAuth("agent", "profile")).toMatchObject({
      freshness: "stale",
      invalidationReason: "credential_expired",
      lastKnownStatus: "authenticated",
    });
    store.setAuth(
      observation({ expiresAt: new Date(Date.now() + 60_000).toISOString() }),
    );
    expect(store.getAuth("agent", "profile").freshness).toBe("current");
    store.close();
    expect(open(file).getAuth("agent", "profile")).toMatchObject({
      freshness: "stale",
      invalidationReason: "service_restarted",
      lastKnownStatus: "authenticated",
    });
    failure(
      () => {
        store.setAuth(observation({ generation: -1 }));
      },
      "invalid_input",
      400,
    );
    const validation = open();
    failure(
      () => {
        validation.setAuth(observation({ expiresAt: "nonsense" }));
      },
      "invalid_input",
      400,
    );
    failure(
      () => {
        validation.setAuth(
          observation({
            methods: [{ id: "x", name: "x", type: "wrong" as never }],
          }),
        );
      },
      "invalid_input",
      400,
    );
  });

  it("validates identifiers, limits and exclusive safe integer event positions", () => {
    const store = open();
    const session = owner(store);
    failure(() => store.getSession("invalid"), "invalid_input", 400);
    failure(() => store.getSession(randomUUID()), "session_not_found", 404);
    failure(
      () => store.findTurn(session.sessionId, "invalid"),
      "invalid_input",
      400,
    );
    expect(store.findTurn(session.sessionId, randomUUID())).toBeNull();
    failure(
      () => store.getTurn(session.sessionId, randomUUID()),
      "turn_not_found",
      404,
    );
    failure(
      () => store.createSession("", ".", "profile"),
      "invalid_input",
      400,
    );
    failure(
      () => store.admitTurn(session.sessionId, randomUUID(), ""),
      "invalid_input",
      400,
    );
    failure(
      () => store.listSessions({ agentId: "", limit: 1 }),
      "invalid_input",
      400,
    );
    for (const invalid of [0, -1, 1001, 1.5, NaN, Infinity]) {
      failure(
        () => store.listSessions({ limit: invalid }),
        "invalid_input",
        400,
      );
      failure(
        () => store.listTurns(session.sessionId, { limit: invalid }),
        "invalid_input",
        400,
      );
      failure(
        () => store.listEvents(session.sessionId, { limit: invalid }),
        "invalid_input",
        400,
      );
    }
    for (const after of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
      failure(
        () => store.listEvents(session.sessionId, { after, limit: 1 }),
        "invalid_input",
        400,
      );
    expect(
      store.listEvents(session.sessionId, {
        after: Number.MAX_SAFE_INTEGER,
        limit: 1,
      }).items,
    ).toEqual([]);
  });

  it("enforces composite foreign keys and rolls back failed event admissions", () => {
    const { file } = fixture();
    const store = open(file);
    const session = owner(store);
    const other = owner(store);
    const foreign = admitted(store, other.sessionId);
    const db = new DatabaseSync(file);
    db.exec("PRAGMA foreign_keys=ON");
    expect(() =>
      db
        .prepare(
          "INSERT INTO events(session_id,turn_id,sequence,body) VALUES(?,?,?,?)",
        )
        .run(session.sessionId, foreign.turnId, 1, "{}"),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          "INSERT INTO turns(session_id,turn_id,prompt_hash,body) VALUES(?,?,?,?)",
        )
        .run(randomUUID(), randomUUID(), "hash", "{}"),
    ).toThrow();
    db.exec(
      "CREATE TRIGGER fail_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'cannot persist'); END",
    );
    const id = randomUUID();
    failure(
      () => store.admitTurn(session.sessionId, id, "prompt"),
      "storage_failed",
      503,
    );
    expect(store.findTurn(session.sessionId, id)).toBeNull();
    expect(store.getSession(session.sessionId).lastSequence).toBe(0);
    db.exec("DROP TRIGGER fail_event");
    expect(store.admitTurn(session.sessionId, id, "prompt").created).toBe(true);
    db.close();
    store.close();
    failure(() => store.getSession(session.sessionId), "storage_failed", 503);
  });

  it("marks exact prompt hash databases as version 2 and rejects development version 1 without migration", () => {
    const { file } = fixture();
    const store = open(file);
    const session = owner(store);
    const turn = admitted(store, session.sessionId);
    store.setTurnState(session.sessionId, turn.turnId, "error");
    store.close();
    const db = new DatabaseSync(file);
    expect(db.prepare("PRAGMA user_version").get()).toMatchObject({
      user_version: 2,
    });
    db.exec("PRAGMA user_version=1");
    const before = readFileSync(file);
    db.close();
    failure(() => open(file), "storage_schema_unsupported", 503);
    expect(readFileSync(file)).toEqual(before);
    const unchanged = new DatabaseSync(file);
    expect(unchanged.prepare("PRAGMA user_version").get()).toMatchObject({
      user_version: 1,
    });
    expect(
      unchanged.prepare("SELECT COUNT(*) AS count FROM turns").get(),
    ).toMatchObject({ count: 1 });
    unchanged.close();
  });

  it("reports open, incompatible schema and database corruption explicitly", () => {
    const { file, directory } = fixture();
    failure(() => open(directory), "storage_failed", 503);
    writeFileSync(file, "not SQLite");
    failure(() => open(file), "storage_failed", 503);
    rmSync(file);
    let db = new DatabaseSync(file);
    db.exec("PRAGMA user_version=99");
    db.close();
    failure(() => open(file), "storage_schema_unsupported", 503);
    rmSync(file);
    db = new DatabaseSync(file);
    db.exec("CREATE TABLE unrelated(value)");
    db.close();
    failure(() => open(file), "storage_corrupt", 503);
    rmSync(file);
    const store = open(file);
    owner(store);
    store.close();
    db = new DatabaseSync(file);
    db.prepare("UPDATE sessions SET body=?").run("{");
    db.close();
    failure(() => open(file), "storage_corrupt", 503);
    expect(new ServiceError("storage_failed", 503)).toBeInstanceOf(Error);
  });

  it.each(["sessions", "turns", "events", "auth"])(
    "does not silently replace corrupt %s records",
    (table) => {
      const { file } = fixture();
      const store = open(file);
      const session = owner(store);
      const turn = admitted(store, session.sessionId);
      store.setTurnState(session.sessionId, turn.turnId, "error");
      store.setAuth(observation());
      store.close();
      const db = new DatabaseSync(file);
      db.exec(`UPDATE ${table} SET body='{}'`);
      db.close();
      failure(() => open(file), "storage_corrupt", 503);
    },
  );

  it.each(["sequence", "prompt_hash", "foreign_key", "identity"])(
    "rejects persisted %s integrity violations",
    (kind) => {
      const { file } = fixture();
      const store = open(file);
      const session = owner(store);
      const turn = admitted(store, session.sessionId);
      store.setTurnState(session.sessionId, turn.turnId, "error");
      store.close();
      const db = new DatabaseSync(file);
      if (kind === "sequence")
        db.exec("UPDATE sessions SET body=json_set(body,'$.lastSequence',99)");
      if (kind === "prompt_hash")
        db.exec("UPDATE turns SET prompt_hash='invalid'");
      if (kind === "foreign_key") {
        db.exec("PRAGMA foreign_keys=OFF");
        db.prepare("UPDATE turns SET session_id=?").run(randomUUID());
      }
      if (kind === "identity")
        db.prepare("UPDATE events SET body=json_set(body,'$.turnId',?)").run(
          randomUUID(),
        );
      db.close();
      failure(() => open(file), "storage_corrupt", 503);
    },
  );
});
