import { afterEach, describe, expect, it, vi } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import type { Adapter } from "../src/adapter.js";
import { HubError } from "../src/common.js";
import { TaskManager } from "../src/tasks.js";

class Fixture implements Adapter {
  readonly turns = new Map<string, Record<string, unknown>[]>();
  readonly active = new Map<string, string>();
  readonly calls: string[] = [];
  visible = false;
  unavailable = false;
  auth = true;
  sequence = 0;

  async call(name: string, input: Record<string, unknown>): Promise<unknown> {
    await Promise.resolve();
    this.calls.push(name);
    if (this.unavailable) throw new HubError("adapter_unavailable", 503);
    if (!this.auth) throw new HubError("auth_required", 401);
    if (name === "list_agents") return [{ provider: "test" }];
    if (name === "new_session") return { session: `test:/${++this.sequence}` };
    if (name === "list_sessions") {
      return this.visible
        ? { sessions: [{ session: "test:/1", provider: "test", status: 1 }] }
        : [];
    }
    const session = String(input.session);
    if (name === "hub_start_turn") {
      if (this.active.has(session)) throw new Error("overlapping turns");
      this.active.set(session, String(input.turnId));
      return { id: input.turnId };
    }
    if (name === "hub_cancel_turn") {
      this.complete(session, "cancelled");
      return { requested: true };
    }
    if (name === "session_history")
      return { turns: this.turns.get(session) ?? [] };
    throw new Error(`Unexpected tool: ${name}`);
  }

  complete(session: string, state = "complete"): void {
    const id = this.active.get(session);
    if (id === undefined) throw new Error("No running fixture turn");
    this.turns.set(session, [
      ...(this.turns.get(session) ?? []),
      {
        id,
        state,
        text: `result:${id}`,
        tools: [],
      },
    ]);
    this.active.delete(session);
  }
}

const managers: TaskManager[] = [];
afterEach(async () => {
  await Promise.all(managers.map((manager) => manager.close()));
  managers.length = 0;
});

async function setup(
  capacity = 100,
): Promise<{ fixture: Fixture; manager: TaskManager; sessionId: string }> {
  const fixture = new Fixture();
  const manager = new TaskManager(fixture, 1, capacity);
  managers.push(manager);
  const session = await manager.createSession({
    provider: "test",
    workingDirectory: "C:\\a b#c",
  });
  return { fixture, manager, sessionId: session.sessionId };
}

async function running(fixture: Fixture, sessionId: string): Promise<void> {
  for (let n = 0; n < 100 && !fixture.active.has(sessionId); n++)
    await delay(1);
  expect(fixture.active.has(sessionId)).toBe(true);
}

describe("correlated tasks", () => {
  it("retains empty created sessions and separates existence from activity", async () => {
    const { fixture, manager, sessionId } = await setup();
    expect(await manager.agents()).toEqual([{ provider: "test" }]);
    expect(await manager.listSessions()).toEqual([
      { sessionId, provider: "test", hostVisible: false, running: false },
    ]);
    const task = manager.submit(sessionId, "first");
    await running(fixture, sessionId);
    expect((await manager.listSessions())[0]?.running).toBe(true);
    fixture.complete(sessionId);
    expect((await manager.wait(task.taskId, 1000)).task.status).toBe(
      "completed",
    );
    fixture.visible = true;
    expect((await manager.listSessions())[0]?.hostVisible).toBe(true);
  });

  it("serializes a session, runs other sessions concurrently and waits only for the specified task", async () => {
    const { fixture, manager, sessionId } = await setup();
    const other = await manager.createSession({
      provider: "test",
      workingDirectory: "C:\\other",
    });
    const a = manager.submit(sessionId, "a");
    const b = manager.submit(sessionId, "b");
    const c = manager.submit(other.sessionId, "c");
    await running(fixture, sessionId);
    await running(fixture, other.sessionId);
    expect(manager.get(b.taskId).status).toBe("queued");
    fixture.complete(other.sessionId);
    expect((await manager.wait(c.taskId, 1000)).task.result?.id).toBe(c.turnId);
    expect((await manager.wait(b.taskId, 5)).timedOut).toBe(true);
    fixture.complete(sessionId);
    expect((await manager.wait(a.taskId, 1000)).task.status).toBe("completed");
    await running(fixture, sessionId);
    fixture.complete(sessionId);
    const waits = await Promise.all([
      manager.wait(b.taskId, 1000),
      manager.wait(b.taskId, 1000),
    ]);
    expect(waits.every((result) => result.task.result?.id === b.turnId)).toBe(
      true,
    );
  });

  it("does not mistake idle or unrelated completed turns for success or cancel on timeout", async () => {
    const { fixture, manager, sessionId } = await setup();
    const task = manager.submit(sessionId, "a");
    await running(fixture, sessionId);
    fixture.turns.set(sessionId, [
      { id: "another-turn", state: "complete", text: "not ours" },
    ]);
    expect((await manager.wait(task.taskId, 5)).timedOut).toBe(true);
    expect(manager.get(task.taskId).status).toBe("running");
    expect(fixture.calls).not.toContain("hub_cancel_turn");
    fixture.complete(sessionId);
    expect((await manager.wait(task.taskId, 1000)).task.result?.id).toBe(
      task.turnId,
    );
  });

  it.each(["failed", "cancelled"])(
    "preserves terminal %s results",
    async (state) => {
      const { fixture, manager, sessionId } = await setup();
      const task = manager.submit(sessionId, "a");
      await running(fixture, sessionId);
      fixture.complete(sessionId, state);
      expect((await manager.wait(task.taskId, 1000)).task.status).toBe(state);
    },
  );

  it("cancels queued tasks without touching the Host and confirms running cancellation from history", async () => {
    const { fixture, manager, sessionId } = await setup();
    const a = manager.submit(sessionId, "a");
    const b = manager.submit(sessionId, "b");
    await running(fixture, sessionId);
    expect(manager.cancel(b.taskId).status).toBe("cancelled");
    expect(manager.cancel(a.taskId).cancelRequested).toBe(true);
    expect((await manager.wait(a.taskId, 1000)).task.status).toBe("cancelled");
    expect(
      fixture.calls.filter((name) => name === "hub_start_turn"),
    ).toHaveLength(1);
    expect(manager.cancel(b.taskId).status).toBe("cancelled");
  });

  it("reports missing authentication, transport failure, capacity and unknown resources", async () => {
    const { fixture, manager, sessionId } = await setup(1);
    fixture.auth = false;
    await expect(
      manager.createSession({ provider: "test", workingDirectory: "C:\\a" }),
    ).rejects.toMatchObject({ code: "auth_required" });
    const task = manager.submit(sessionId, "a");
    expect((await manager.wait(task.taskId, 1000)).task.error).toBe(
      "auth_required",
    );
    expect(() => manager.submit(sessionId, "b")).toThrow("task_capacity");
    expect(() => manager.submit("missing", "a")).toThrow("session_not_found");
    expect(() => manager.get("missing")).toThrow("task_not_found");
    fixture.auth = true;
    fixture.unavailable = true;
    await expect(manager.agents()).rejects.toThrow("adapter_unavailable");
  });

  it("fails unfinished tasks explicitly on process exit and rejects new work", async () => {
    const { fixture, manager, sessionId } = await setup();
    const task = manager.submit(sessionId, "a");
    await running(fixture, sessionId);
    manager.failAll("child_exited_outcome_unknown");
    expect((await manager.wait(task.taskId, 1000)).task.error).toBe(
      "child_exited_outcome_unknown",
    );
    expect(() => manager.submit(sessionId, "b")).toThrow("service_unavailable");
  });

  it("aborts a disconnected waiter without cancelling work", async () => {
    const { manager, sessionId } = await setup();
    const task = manager.submit(sessionId, "a");
    const abort = new AbortController();
    const waiter = manager.wait(task.taskId, 1000, abort.signal);
    abort.abort();
    expect((await waiter).timedOut).toBe(true);
    expect(manager.get(task.taskId).cancelRequested).toBeUndefined();
  });

  it.each(["invalid-history", "invalid-state", "error-part", "running"])(
    "validates the exact matching turn's result (%s)",
    async (mode) => {
      const { fixture, manager, sessionId } = await setup();
      const original = fixture.call.bind(fixture);
      let id = "";
      vi.spyOn(fixture, "call").mockImplementation((name, input) => {
        if (name === "session_history")
          return Promise.resolve({
            turns:
              mode === "invalid-history"
                ? {}
                : [
                    {
                      id,
                      state:
                        mode === "invalid-state"
                          ? "unknown"
                          : mode === "running"
                            ? "running"
                            : "complete",
                      ...(mode === "error-part"
                        ? { error: "fixture error" }
                        : {}),
                    },
                  ],
          });
        return original(name, input);
      });
      const task = manager.submit(sessionId, "a");
      id = task.turnId;
      const result = await manager.wait(
        task.taskId,
        mode === "running" ? 5 : 1000,
      );
      if (mode === "running") expect(result.timedOut).toBe(true);
      else
        expect(result.task.error).toBe(
          mode === "invalid-history"
            ? "invalid_history"
            : mode === "invalid-state"
              ? "invalid_turn_state"
              : "turn_failed",
        );
    },
  );

  it("rejects malformed catalogues and accepts unwrapped catalogues with activity bits", async () => {
    const { fixture, manager } = await setup();
    const call = vi.spyOn(fixture, "call");
    call.mockResolvedValueOnce({ sessions: {} });
    await expect(manager.listSessions()).rejects.toThrow(
      "invalid_session_catalogue",
    );
    call.mockResolvedValueOnce([
      { session: "test:/1", provider: "test", status: 8 },
    ]);
    expect((await manager.listSessions())[0]?.running).toBe(true);
    call.mockResolvedValueOnce([]);
    expect((await manager.listSessions())[0]?.running).toBe(false);
    call.mockResolvedValueOnce([{ session: "test:/1", provider: "test" }]);
    expect((await manager.listSessions())[0]?.running).toBe(false);
    const aborted = new AbortController();
    aborted.abort();
    const task = manager.submit("test:/1", "a");
    expect(
      (await manager.wait(task.taskId, 1000, aborted.signal)).timedOut,
    ).toBe(true);
  });

  it("does not overwrite a shutdown failure with a late in-flight history response", async () => {
    const { fixture, manager, sessionId } = await setup();
    const original = fixture.call.bind(fixture);
    let resolveHistory!: (value: unknown) => void;
    const history = new Promise<unknown>((resolve) => {
      resolveHistory = resolve;
    });
    vi.spyOn(fixture, "call").mockImplementation((name, input) =>
      name === "session_history" ? history : original(name, input),
    );
    const task = manager.submit(sessionId, "a");
    await running(fixture, sessionId);
    manager.failAll("child_exited_outcome_unknown");
    resolveHistory({
      turns: [{ id: task.turnId, state: "complete", text: "late" }],
    });
    await manager.close();
    expect(manager.get(task.taskId)).toMatchObject({
      status: "failed",
      error: "child_exited_outcome_unknown",
    });
    expect(manager.get(task.taskId).result).toBeUndefined();
  });
});
