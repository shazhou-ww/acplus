import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  ActionType,
  AhpErrorCodes,
  MessageKind,
  chatReducer,
  SessionLifecycle,
  SessionStatus,
  ChatInteractivity,
  ChatOriginKind,
  ResponsePartKind,
  type ActiveTurn,
  type AgentInfo,
  type ChatAction,
  type ChatState,
  type ChatSummary,
  type RootState,
  type SessionState,
  type SessionSummary,
  type Snapshot,
  type StateAction,
  type Turn,
} from "@microsoft/agent-host-protocol";
import {
  AhpStateMirror,
  RpcError,
} from "@microsoft/agent-host-protocol/client";
import type {
  MultiHostClient,
  HostClientHandle,
} from "@microsoft/agent-host-protocol/hosts";
import {
  bounded,
  diagnostic,
  record,
  ServiceError,
  upstream,
} from "./common.js";
import type { HostConfig } from "./config.js";
import type { HostDriver } from "./extensions.js";
import type { ProcessOwner } from "./processes.js";
import { safeTransport } from "./transport.js";

const ROOT = "ahp-root://";
const INPUT_NEEDED_FLAG = SessionStatus.InputNeeded & ~SessionStatus.InProgress;

export interface SessionView {
  resource: string;
  title: string;
  provider: string;
}
export interface TurnView {
  state: "running" | "complete" | "cancelled" | "error";
  text?: string;
  inputRequired?: true;
  error?: { code: string; message: string };
}
export type HostStatus = "idle" | "starting" | "ready" | "stopping" | "failed";

export class NativeHost {
  status: HostStatus = "idle";
  error: { code: string; message: string } | undefined;
  private readonly mirror = new AhpStateMirror();
  private generation: number | undefined;
  private preparation: Promise<void> | undefined;
  private stopping: Promise<void> | undefined;
  private startupAbort: AbortController | undefined;
  private readonly admissions = new Set<string>();
  private writes = 0;
  private readonly uncertain = new Map<string, string>();
  private readonly created = new Set<string>();
  private closed = false;
  private readonly events;
  private readonly watching: Promise<void>;
  private readonly notifications;
  private readonly watchingNotifications: Promise<void>;
  private readonly watchAbort = new AbortController();
  onConnectionChange: () => void = () => {};
  onAuthenticationRequired: (resource: string) => void = () => {};
  authActive: () => boolean = () => false;

  constructor(
    readonly config: HostConfig,
    readonly driver: HostDriver,
    private readonly processes: ProcessOwner,
    private readonly multi: MultiHostClient,
    private readonly requestTimeoutMs = 30_000,
  ) {
    this.events = multi.hostEvents();
    this.notifications = multi.events();
    this.watching = this.watch();
    this.watchingNotifications = this.watchNotifications();
  }

  private async watchNotifications(): Promise<void> {
    while (!this.watchAbort.signal.aborted) {
      let next;
      try {
        next = await bounded(this.notifications.next(), this.watchAbort.signal);
      } catch {
        break;
      }
      if (next.done === true) break;
      if (
        next.value.hostId === this.config.id &&
        next.value.event.type === "authRequired"
      )
        this.onAuthenticationRequired(
          next.value.event.params.resource.resource,
        );
      if (
        next.value.hostId === this.config.id &&
        next.value.event.type === "sessionRemoved"
      )
        this.created.delete(next.value.event.params.session);
    }
  }

  private async watch(): Promise<void> {
    while (!this.watchAbort.signal.aborted) {
      let next;
      try {
        next = await bounded(this.events.next(), this.watchAbort.signal);
      } catch {
        break;
      }
      if (next.done === true) break;
      const event = next.value;
      if (
        event.hostId !== this.config.id ||
        this.closed ||
        this.status === "stopping"
      )
        continue;
      if (event.type === "connected") {
        this.onConnectionChange();
        if (this.preparation !== undefined) continue;
        try {
          await this.synchronize();
        } catch (error) {
          this.error = diagnostic(error);
          this.status = "failed";
        }
      } else if (
        event.type === "stateChanged" &&
        event.state.status !== "connected"
      ) {
        this.generation = undefined;
        this.onConnectionChange();
        if (this.status === "ready") {
          this.status = "failed";
          this.error = diagnostic(
            new ServiceError("host_connection_lost", 503),
          );
        }
      }
    }
  }

  async view() {
    let status = this.status;
    let error = this.error;
    let providers: string[] | undefined;
    if (status === "ready") {
      try {
        providers = (await this.root(this.connection())).agents.map(
          (agent) => agent.provider,
        );
      } catch (failure) {
        status = "failed";
        error = diagnostic(failure);
      }
    }
    return {
      hostId: this.config.id,
      status,
      ...(providers === undefined ? {} : { providers }),
      ...(this.config.authentication.length === 0
        ? {}
        : {
            authMethods: this.config.authentication.map(
              ({ id, provider, resource }) => ({
                methodId: id,
                provider,
                resource,
              }),
            ),
          }),
      ...(error === undefined ? {} : { error }),
    };
  }

  start(): void {
    if (this.closed) throw new ServiceError("service_stopping", 503);
    if (this.status === "stopping")
      throw new ServiceError("host_stopping", 409);
    if (
      this.error?.code === "cleanup_failed_lock_retained" ||
      this.error?.code === "owned_cleanup_failed"
    )
      throw new ServiceError("cleanup_failed_lock_retained", 503);
    if (this.preparation !== undefined || this.status === "ready") return;
    this.status = "starting";
    this.error = undefined;
    this.startupAbort = new AbortController();
    const signal = AbortSignal.any([
      this.startupAbort.signal,
      AbortSignal.timeout(this.config.lifecycle.startupTimeoutMs),
    ]);
    this.preparation = this.prepare(signal)
      .catch((error: unknown) => {
        this.status = "failed";
        this.error = diagnostic(error);
        throw upstream(error, "host_start_failed");
      })
      .finally(() => {
        this.preparation = undefined;
      });
    void this.preparation.catch(() => {});
  }

  private async prepare(signal: AbortSignal): Promise<void> {
    try {
      const existing = this.multi.host(this.config.id);
      if (existing === undefined) {
        await bounded(this.driver.start(signal), signal);
        await this.multi.addHost({
          id: this.config.id,
          label: this.config.label,
          clientConfig: { requestTimeoutMs: this.requestTimeoutMs },
          transportFactory: async (_id, connectSignal) => {
            try {
              return safeTransport(
                await this.driver.openTransport(connectSignal),
              );
            } catch {
              throw new ServiceError("host_transport_unavailable", 503);
            }
          },
        });
      } else {
        this.processes.check();
        await this.multi.reconnectHost(this.config.id);
      }
      while (this.multi.host(this.config.id)?.state.status !== "connected") {
        signal.throwIfAborted();
        this.processes.check();
        const failure = this.multi.host(this.config.id)?.lastError;
        if (
          failure instanceof RpcError &&
          failure.code === AhpErrorCodes.UnsupportedProtocolVersion
        )
          throw new ServiceError("host_protocol_unsupported", 503);
        await delay(10, undefined, { signal });
      }
      await bounded(this.synchronize(), signal);
    } catch (error) {
      if (this.multi.host(this.config.id) !== undefined)
        await this.multi.removeHost(this.config.id);
      try {
        await this.driver.stop(new AbortController().signal);
        await this.processes.stop();
      } catch {
        throw new ServiceError("cleanup_failed_lock_retained", 503);
      }
      throw error;
    }
  }

  private async synchronize(): Promise<void> {
    const handle = this.multi.client(this.config.id);
    if (handle === undefined) throw new ServiceError("host_not_ready", 503);
    const snapshot = await this.snapshot(handle, ROOT);
    requireRoot(snapshot);
    handle.checkAlive();
    if (this.closed || this.status === "stopping") return;
    this.mirror.applySnapshot(snapshot);
    this.generation = handle.generation;
    this.status = "ready";
    this.error = undefined;
  }

  connection(generation?: number): HostClientHandle {
    if (this.closed) throw new ServiceError("service_stopping", 503);
    if (this.status === "stopping")
      throw new ServiceError("host_stopping", 409);
    const handle = this.multi.client(this.config.id);
    if (
      this.status !== "ready" ||
      handle === undefined ||
      handle.generation !== this.generation
    )
      throw new ServiceError("host_not_ready", 503);
    if (generation !== undefined && generation !== handle.generation)
      throw new ServiceError("auth_connection_changed", 409);
    this.processes.check();
    return handle;
  }

  async ensure(): Promise<HostClientHandle> {
    if (this.status !== "ready") {
      if (!this.config.lifecycle.onDemand) return this.connection();
      this.start();
      await this.preparation;
    }
    return this.connection();
  }

  private readConnection(): HostClientHandle {
    if (this.status !== "ready") throw new ServiceError("host_not_ready", 503);
    return this.connection();
  }

  private async snapshot(
    handle: HostClientHandle,
    resource: string,
  ): Promise<Snapshot> {
    handle.checkAlive();
    const { result, subscription } = await handle
      .rawClient()
      .subscribe(resource);
    await subscription.close();
    handle.checkAlive();
    const snapshot = result.snapshot;
    if (!record(result) || !record(snapshot) || snapshot.resource !== resource)
      throw new ServiceError("state_snapshot_unavailable", 503);
    return snapshot;
  }

  async root(handle: HostClientHandle): Promise<RootState> {
    const snapshot = await this.snapshot(handle, ROOT);
    requireRoot(snapshot);
    this.mirror.applySnapshot(snapshot);
    return this.mirror.root;
  }

  private async catalogue(handle: HostClientHandle): Promise<SessionSummary[]> {
    const sessions = new Map<string, SessionSummary>();
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const result = await handle.request("listSessions", {
        channel: ROOT,
        ...(cursor === undefined ? {} : { cursor }),
      });
      handle.checkAlive();
      if (!Array.isArray(result.items))
        throw new ServiceError("invalid_host_catalogue", 502);
      for (const summary of result.items) {
        if (
          !record(summary) ||
          typeof summary.resource !== "string" ||
          !URL.canParse(summary.resource) ||
          typeof summary.title !== "string" ||
          typeof summary.provider !== "string"
        )
          throw new ServiceError("invalid_host_catalogue", 502);
        sessions.set(summary.resource, summary);
      }
      cursor = result.nextCursor;
      if (cursor !== undefined) {
        if (seen.has(cursor))
          throw new ServiceError("incomplete_host_catalogue", 503);
        seen.add(cursor);
      }
    } while (cursor !== undefined);
    return [...sessions.values()];
  }

  private async session(
    handle: HostClientHandle,
    resource: string,
  ): Promise<SessionState> {
    const snapshot = await this.snapshot(handle, resource);
    if (
      !("lifecycle" in snapshot.state) ||
      !("chats" in snapshot.state) ||
      !Array.isArray(snapshot.state.chats) ||
      typeof snapshot.state.title !== "string" ||
      typeof snapshot.state.provider !== "string" ||
      ![
        SessionLifecycle.Creating,
        SessionLifecycle.Ready,
        SessionLifecycle.Failed,
      ].includes(snapshot.state.lifecycle)
    )
      throw new ServiceError("invalid_session_state", 502);
    this.mirror.applySnapshot(snapshot);
    return snapshot.state;
  }

  private async chat(
    handle: HostClientHandle,
    resource: string,
  ): Promise<ChatState> {
    const snapshot = await this.snapshot(handle, resource);
    if (
      !("turns" in snapshot.state) ||
      !Array.isArray(snapshot.state.turns) ||
      snapshot.state.resource !== resource
    )
      throw new ServiceError("invalid_chat_state", 502);
    return snapshot.state;
  }

  async listSessions(handle = this.readConnection()): Promise<SessionView[]> {
    try {
      const result = new Map(
        (await this.catalogue(handle)).map((item) => [
          item.resource,
          {
            resource: item.resource,
            title: item.title,
            provider: item.provider,
          },
        ]),
      );
      for (const resource of this.created) {
        if (result.has(resource)) {
          this.created.delete(resource);
          continue;
        }
        const state = await this.session(handle, resource);
        result.set(resource, {
          resource,
          title: state.title,
          provider: state.provider,
        });
      }
      handle.checkAlive();
      return [...result.values()];
    } catch (error) {
      throw upstream(error);
    }
  }

  async createSession(
    provider: string,
    workingDirectories: string[],
  ): Promise<{ resource: string }> {
    return this.write(async (handle) => {
      this.provider(await this.root(handle), provider);
      const resource = `ahp-session:/${randomUUID()}`;
      let accepted = false;
      try {
        await handle.request("createSession", {
          channel: resource,
          provider,
          workingDirectories,
        });
        accepted = true;
        const state = await this.session(handle, resource);
        if (state.lifecycle === SessionLifecycle.Failed)
          throw new ServiceError("session_creation_failed", 502);
        if (state.provider !== provider)
          throw new ServiceError("creation_outcome_unknown", 502);
        // VS Code allocates provisional sessions/chats before materializing the
        // provider on first send. "creating" is not a missing resource or a turn.
        if (state.defaultChat !== undefined) {
          if (!state.chats.some((chat) => chat.resource === state.defaultChat))
            throw new ServiceError("creation_outcome_unknown", 502);
          await this.chat(handle, state.defaultChat);
        }
        this.created.add(resource);
        return { resource };
      } catch (error) {
        if (
          (!accepted && error instanceof RpcError) ||
          (error instanceof ServiceError &&
            error.code === "session_creation_failed")
        )
          throw upstream(error);
        throw new ServiceError("creation_outcome_unknown", 502);
      }
    });
  }

  async listChats(resource: string, handle = this.readConnection()) {
    try {
      const state = await this.session(handle, resource);
      if (state.lifecycle === SessionLifecycle.Failed)
        throw new ServiceError("session_not_ready", 503);
      return {
        ...(state.defaultChat === undefined
          ? {}
          : { defaultChat: state.defaultChat }),
        chats: state.chats.map(chatView),
      };
    } catch (error) {
      throw upstream(error);
    }
  }

  async createChat(session: string): Promise<{ resource: string }> {
    return this.write(async (handle) => {
      const state = await this.session(handle, session);
      const agent = this.provider(await this.root(handle), state.provider);
      if (agent.capabilities?.multipleChats === undefined)
        throw new ServiceError("capability_unsupported", 409);
      const resource = `ahp-chat:/${randomUUID()}`;
      let accepted = false;
      try {
        await handle.request("createChat", {
          channel: session,
          chat: resource,
        });
        accepted = true;
        await this.chat(handle, resource);
        const confirmed = await this.session(handle, session);
        if (!confirmed.chats.some((chat) => chat.resource === resource))
          throw new ServiceError("creation_outcome_unknown", 502);
        return { resource };
      } catch (error) {
        if (!accepted && error instanceof RpcError) throw upstream(error);
        throw new ServiceError("creation_outcome_unknown", 502);
      }
    });
  }

  private provider(root: RootState, id: string): AgentInfo {
    const agent = root.agents.find((agent) => agent.provider === id);
    if (agent === undefined) throw new ServiceError("provider_not_found", 404);
    return agent;
  }

  private async write<T>(
    operation: (handle: HostClientHandle) => Promise<T>,
  ): Promise<T> {
    if (this.status === "stopping")
      throw new ServiceError("host_stopping", 409);
    if (this.closed) throw new ServiceError("service_stopping", 503);
    this.writes++;
    try {
      return await operation(await this.ensure());
    } catch (error) {
      throw upstream(error);
    } finally {
      this.writes--;
    }
  }

  private async findTurn(
    handle: HostClientHandle,
    resource: string,
    id: string,
  ): Promise<{
    chat: ChatState;
    turn: ActiveTurn | Turn | undefined;
  }> {
    let state = await this.chat(handle, resource);
    const cursors = new Set<string>();
    for (;;) {
      const found =
        state.activeTurn?.id === id
          ? state.activeTurn
          : state.turns.find((turn) => turn.id === id);
      if (found !== undefined) {
        if (this.uncertain.get(resource) === id)
          this.uncertain.delete(resource);
        return { chat: state, turn: found };
      }
      if (state.turnsNextCursor === undefined) break;
      const cursor = state.turnsNextCursor;
      if (cursors.has(cursor))
        throw new ServiceError("turn_state_unavailable", 503);
      cursors.add(cursor);
      try {
        await handle.request("fetchTurns", { channel: resource, cursor });
        state = await this.chat(handle, resource);
      } catch {
        throw new ServiceError("turn_state_unavailable", 503);
      }
    }
    if (this.uncertain.get(resource) === id)
      throw new ServiceError("turn_state_unavailable", 503);
    return { chat: state, turn: undefined };
  }

  async getTurn(resource: string, id: string): Promise<TurnView> {
    try {
      const handle = this.connection();
      const { chat, turn } = await this.findTurn(handle, resource, id);
      if (turn === undefined) throw new ServiceError("turn_not_found", 404);
      return turnView(
        turn,
        chat.activeTurn?.id === id,
        (chat.status & INPUT_NEEDED_FLAG) !== 0,
      );
    } catch (error) {
      const safe = upstream(error);
      if (safe.status === 404) throw safe;
      throw new ServiceError("turn_state_unavailable", 503);
    }
  }

  async startTurn(resource: string, id: string, text: string): Promise<void> {
    if (this.admissions.has(resource)) throw new ServiceError("chat_busy", 409);
    this.admissions.add(resource);
    try {
      await this.write(async (handle) => {
        const unknown = this.uncertain.get(resource);
        if (unknown !== undefined)
          await this.findTurn(handle, resource, unknown);
        const { chat, turn } = await this.findTurn(handle, resource, id);
        if (turn !== undefined) throw new ServiceError("turn_exists", 409);
        if (
          chat.interactivity !== undefined &&
          chat.interactivity !== ChatInteractivity.Full
        )
          throw new ServiceError("chat_not_interactive", 409);
        if (
          chat.activeTurn !== undefined ||
          (chat.queuedMessages?.length ?? 0) > 0
        )
          throw new ServiceError("chat_busy", 409);
        this.uncertain.set(resource, id);
        await this.dispatch(handle, chat, {
          type: ActionType.ChatTurnStarted,
          turnId: id,
          startedAt: new Date().toISOString(),
          message: { text, origin: { kind: MessageKind.User } },
        });
        this.uncertain.delete(resource);
      });
    } finally {
      this.admissions.delete(resource);
    }
  }

  async cancelTurn(resource: string, id: string): Promise<void> {
    // Cancellation never prepares a stopped host or selects a replacement turn.
    const handle = this.connection();
    if (this.admissions.has(resource)) throw new ServiceError("chat_busy", 409);
    this.admissions.add(resource);
    this.writes++;
    try {
      const unknown = this.uncertain.get(resource);
      if (unknown !== undefined && unknown !== id)
        await this.findTurn(handle, resource, unknown);
      const { chat, turn } = await this.findTurn(handle, resource, id);
      if (turn === undefined) throw new ServiceError("turn_not_found", 404);
      if (chat.activeTurn?.id !== id) return;
      this.uncertain.set(resource, id);
      await this.dispatch(handle, chat, {
        type: ActionType.ChatTurnCancelled,
        turnId: id,
        duration: 0,
      });
      this.uncertain.delete(resource);
    } catch (error) {
      throw upstream(error, "turn_state_unavailable");
    } finally {
      this.admissions.delete(resource);
      this.writes--;
    }
  }

  private async dispatch(
    handle: HostClientHandle,
    state: ChatState,
    action: Extract<
      ChatAction,
      { type: ActionType.ChatTurnStarted | ActionType.ChatTurnCancelled }
    >,
  ): Promise<void> {
    const client = handle.rawClient();
    const events = client.events();
    const clientId = this.multi.host(this.config.id)?.clientId;
    try {
      handle.checkAlive();
      const dispatched = handle.dispatch(state.resource, action);
      const receive = async (): Promise<void> => {
        for await (const { channel, event } of events) {
          handle.checkAlive();
          if (channel !== state.resource || event.type !== "action") continue;
          const envelope = event.params;
          if (
            envelope.origin?.clientId === clientId &&
            envelope.origin?.clientSeq === dispatched.clientSeq
          ) {
            if (
              envelope.action.type !== action.type ||
              !("turnId" in envelope.action) ||
              envelope.action.turnId !== action.turnId
            )
              throw new ServiceError("turn_outcome_unknown", 502);
            if (envelope.rejectionReason !== undefined) {
              this.uncertain.delete(state.resource);
              throw new ServiceError(
                /busy|in.progress/iu.test(envelope.rejectionReason)
                  ? "chat_busy"
                  : "turn_rejected",
                409,
              );
            }
            if (isChatAction(envelope.action))
              state = chatReducer(state, envelope.action);
            return;
          }
          if (
            envelope.rejectionReason === undefined &&
            isChatAction(envelope.action)
          )
            state = chatReducer(state, envelope.action);
        }
        throw new ServiceError("turn_outcome_unknown", 502);
      };
      await bounded(receive(), AbortSignal.timeout(this.requestTimeoutMs));
      handle.checkAlive();
    } catch (error) {
      if (error instanceof ServiceError && error.status === 409) throw error;
      throw new ServiceError("turn_outcome_unknown", 502);
    } finally {
      await events.return?.();
    }
  }

  async stop(): Promise<void> {
    if (this.status === "idle") return;
    if (this.status === "stopping")
      throw new ServiceError("host_stopping", 409);
    if (this.authActive() || this.writes > 0 || this.preparation !== undefined)
      throw new ServiceError("host_busy", 409);
    let handle: HostClientHandle;
    try {
      handle = this.connection();
    } catch {
      throw new ServiceError("host_activity_unknown", 409);
    }
    this.status = "stopping";
    try {
      for (const [resource, id] of this.uncertain)
        await this.findTurn(handle, resource, id);
      for (const session of await this.listSessions(handle)) {
        const catalogue = await this.session(handle, session.resource);
        if ((catalogue.status & SessionStatus.InProgress) !== 0)
          throw new ServiceError("host_busy", 409);
        for (const item of catalogue.chats) {
          const chat = await this.chat(handle, item.resource);
          if (
            chat.activeTurn !== undefined ||
            (chat.backgroundWork?.length ?? 0) > 0 ||
            (chat.queuedMessages?.length ?? 0) > 0 ||
            (chat.status & 8) !== 0
          )
            throw new ServiceError("host_busy", 409);
        }
      }
      handle.checkAlive();
    } catch (error) {
      this.status = "ready";
      if (error instanceof ServiceError && error.code === "host_busy")
        throw error;
      throw new ServiceError("host_activity_unknown", 409);
    }
    this.stopping = this.cleanup()
      .then(
        () => {
          this.status = "idle";
          this.error = undefined;
        },
        () => {
          this.status = "failed";
          this.error = diagnostic(
            new ServiceError("owned_cleanup_failed", 503),
          );
        },
      )
      .finally(() => {
        this.stopping = undefined;
      });
  }

  private async cleanup(): Promise<void> {
    if (this.multi.host(this.config.id) !== undefined)
      await this.multi.removeHost(this.config.id);
    await this.driver.stop(new AbortController().signal);
    await this.processes.stop();
    this.created.clear();
    this.generation = undefined;
    this.onConnectionChange();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.startupAbort?.abort();
    await this.preparation?.catch(() => {});
    await this.stopping;
    await this.cleanup();
    this.watchAbort.abort();
    await this.events.return?.();
    await this.notifications.return?.();
    await this.watching;
    await this.watchingNotifications;
    await this.driver.dispose();
    await this.processes.close();
  }
}

function isChatAction(action: StateAction): action is ChatAction {
  return action.type.startsWith("chat/");
}

function requireRoot(snapshot: Snapshot): RootState {
  const state = snapshot.state;
  if (
    !("agents" in state) ||
    !Array.isArray(state.agents) ||
    state.agents.some(
      (agent) => !record(agent) || typeof agent.provider !== "string",
    )
  )
    throw new ServiceError("invalid_host_state", 502);
  return state;
}

function chatView(chat: ChatSummary) {
  if (
    !record(chat) ||
    typeof chat.resource !== "string" ||
    !URL.canParse(chat.resource) ||
    typeof chat.title !== "string"
  )
    throw new ServiceError("invalid_chat_state", 502);
  const origin = chat.origin;
  return {
    resource: chat.resource,
    title: chat.title,
    ...(chat.interactivity === undefined
      ? {}
      : { interactivity: chat.interactivity }),
    ...(origin === undefined
      ? {}
      : {
          origin:
            origin.kind === ChatOriginKind.User
              ? { kind: origin.kind }
              : origin.kind === ChatOriginKind.Tool
                ? {
                    kind: origin.kind,
                    chat: origin.chat,
                    toolCallId: origin.toolCallId,
                  }
                : {
                    kind: origin.kind,
                    chat: origin.chat,
                    turnId: origin.turnId,
                  },
        }),
  };
}

function turnView(
  turn: ActiveTurn | Turn,
  active: boolean,
  blocked: boolean,
): TurnView {
  if (!active && !("state" in turn))
    throw new ServiceError("turn_state_unavailable", 503);
  if (
    "state" in turn &&
    !["complete", "cancelled", "error"].includes(turn.state)
  )
    throw new ServiceError("turn_state_unavailable", 503);
  const text = turn.responseParts
    .filter((part) => part.kind === ResponsePartKind.Markdown)
    .map((part) => part.content)
    .join("");
  const error = turn.responseParts.find(
    (part) => part.kind === ResponsePartKind.Error,
  );
  return {
    state: active ? "running" : "state" in turn ? turn.state : "running",
    ...(text === "" ? {} : { text }),
    ...(active &&
    (blocked ||
      turn.responseParts.some(
        (part) =>
          (part.kind === ResponsePartKind.InputRequest &&
            part.response === undefined) ||
          (part.kind === ResponsePartKind.ToolCall &&
            [
              "pending-confirmation",
              "pending-result-confirmation",
              "auth-required",
            ].includes(part.toolCall.status)),
      ))
      ? { inputRequired: true }
      : {}),
    ...(error === undefined
      ? {}
      : {
          error: {
            code: "upstream_turn_error",
            message: "The host reported a turn error",
          },
        }),
  };
}
