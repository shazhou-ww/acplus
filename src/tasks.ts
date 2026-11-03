import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Adapter } from "./adapter.js";
import {
  directoryUri,
  HubError,
  object,
  publicError,
  string,
} from "./common.js";

export type TaskStatus =
  "queued" | "running" | "completed" | "failed" | "cancelled";

export interface Task {
  taskId: string;
  sessionId: string;
  turnId: string;
  status: TaskStatus;
  createdAt: string;
  finishedAt?: string;
  result?: Record<string, unknown>;
  error?: string;
  cancelRequested?: boolean;
}

interface Session {
  sessionId: string;
  provider: string;
  hostVisible: boolean;
  running: boolean;
}

export function terminal(task: Task): boolean {
  return ["completed", "failed", "cancelled"].includes(task.status);
}

export class TaskManager {
  private readonly sessions = new Map<string, Session>();
  private readonly tasks = new Map<string, Task>();
  private readonly workers = new Map<string, Promise<void>>();
  private readonly listeners = new Set<() => void>();
  private readonly abort = new AbortController();
  private stopped = false;

  constructor(
    private readonly adapter: Adapter,
    private readonly pollMs = 100,
    private readonly capacity = 10_000,
  ) {}

  agents(): Promise<unknown> {
    return this.adapter.call("list_agents", {});
  }

  async createSession(input: Record<string, unknown>): Promise<Session> {
    this.available();
    const provider = string(input.provider);
    const workingDirectory = string(input.workingDirectory);
    directoryUri(workingDirectory);
    const created = object(
      await this.adapter.call("new_session", {
        provider,
        workingDirectory,
        config: { isolation: "folder" },
      }),
    );
    const session: Session = {
      sessionId: string(created.session),
      provider,
      hostVisible: false,
      running: false,
    };
    this.sessions.set(session.sessionId, session);
    return { ...session };
  }

  async listSessions(): Promise<Session[]> {
    const response = await this.adapter.call("list_sessions", {});
    const rows = Array.isArray(response) ? response : object(response).sessions;
    if (!Array.isArray(rows)) throw new HubError("invalid_session_catalogue");
    const visible = new Set<string>();
    for (const raw of rows) {
      const row = object(raw);
      const sessionId = string(row.session);
      visible.add(sessionId);
      this.sessions.set(sessionId, {
        sessionId,
        provider: string(row.provider),
        hostVisible: true,
        running: typeof row.status === "number" && (row.status & 8) !== 0,
      });
    }
    return [...this.sessions.values()].map((session) => ({
      ...session,
      hostVisible: visible.has(session.sessionId),
      running:
        (visible.has(session.sessionId) && session.running) ||
        [...this.tasks.values()].some(
          (task) =>
            task.sessionId === session.sessionId && task.status === "running",
        ),
    }));
  }

  submit(sessionId: string, text: string): Task {
    this.available();
    string(text);
    if (!this.sessions.has(sessionId)) {
      throw new HubError("session_not_found_list_or_create_first", 404);
    }
    if (this.tasks.size >= this.capacity)
      throw new HubError("task_capacity", 503);
    const task: Task = {
      taskId: randomUUID(),
      sessionId,
      turnId: randomUUID(),
      status: "queued",
      createdAt: new Date().toISOString(),
    };
    this.tasks.set(task.taskId, task);
    const previous = this.workers.get(sessionId) ?? Promise.resolve();
    const worker = previous.then(async () => {
      if (terminal(task)) return;
      try {
        task.status = "running";
        this.notify();
        await this.adapter.call("hub_start_turn", {
          session: sessionId,
          text: string(text),
          turnId: task.turnId,
        });
        while (!terminal(task)) {
          const history = object(
            await this.adapter.call("session_history", { session: sessionId }),
          );
          if (terminal(task)) break;
          if (!Array.isArray(history.turns)) {
            throw new HubError("invalid_history");
          }
          const match = history.turns
            .map(object)
            .find((turn) => turn.id === task.turnId);
          if (match !== undefined && match.state !== "running") {
            task.result = match;
            if (match.state === "cancelled") this.finish(task, "cancelled");
            else if (match.state === "failed" || match.error !== undefined) {
              this.finish(task, "failed", "turn_failed");
            } else if (match.state === "complete") {
              this.finish(task, "completed");
            } else throw new HubError("invalid_turn_state");
            break;
          }
          if (task.cancelRequested === true) {
            await this.adapter.call("hub_cancel_turn", {
              session: sessionId,
              turnId: task.turnId,
            });
          }
          await delay(this.pollMs, undefined, { signal: this.abort.signal });
        }
      } catch (error) {
        if (!terminal(task))
          this.finish(task, "failed", publicError(error).code);
      }
    });
    this.workers.set(sessionId, worker);
    void worker.then(() => {
      if (this.workers.get(sessionId) === worker)
        this.workers.delete(sessionId);
    });
    return { ...task };
  }

  get(taskId: string): Task {
    const task = this.tasks.get(taskId);
    if (task === undefined) throw new HubError("task_not_found", 404);
    return structuredClone(task);
  }

  cancel(taskId: string): Task {
    const snapshot = this.get(taskId);
    const task = this.tasks.get(snapshot.taskId)!;
    if (terminal(task)) return snapshot;
    if (task.status === "queued") this.finish(task, "cancelled");
    else {
      task.cancelRequested = true;
      this.notify();
    }
    return this.get(taskId);
  }

  async wait(
    taskId: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ task: Task; timedOut: boolean }> {
    const initial = this.get(taskId);
    if (terminal(initial)) return { task: initial, timedOut: false };
    await new Promise<void>((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        this.listeners.delete(changed);
        signal?.removeEventListener("abort", finish);
        resolve();
      };
      const changed = (): void => {
        if (terminal(this.get(taskId))) finish();
      };
      const timer = setTimeout(finish, timeoutMs);
      this.listeners.add(changed);
      signal?.addEventListener("abort", finish, { once: true });
      if (signal?.aborted === true) finish();
      changed();
    });
    const task = this.get(taskId);
    return { task, timedOut: !terminal(task) };
  }

  failAll(code: string): void {
    this.stopped = true;
    for (const task of this.tasks.values()) {
      if (!terminal(task)) this.finish(task, "failed", code);
    }
    this.abort.abort();
  }

  async close(): Promise<void> {
    this.failAll("service_stopped_outcome_unknown");
    await Promise.all(this.workers.values());
  }

  private available(): void {
    if (this.stopped) throw new HubError("service_unavailable", 503);
  }

  private finish(task: Task, status: TaskStatus, error?: string): void {
    task.status = status;
    task.finishedAt = new Date().toISOString();
    if (error !== undefined) task.error = error;
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
