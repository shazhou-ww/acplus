import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
  ActionType,
  MessageKind,
  ResponsePartKind,
  SessionLifecycle,
  SessionStatus,
  chatReducer,
  type ActionEnvelope,
  type ChatAction,
  type ChatState,
  type RootState,
  type SessionState,
  type SessionSummary,
  type Snapshot,
} from "@microsoft/agent-host-protocol";
import {
  InMemoryTransport,
  type AhpTransport,
} from "@microsoft/agent-host-protocol/client";
import { record, text } from "../src/common.js";
import { objectSchema, type Config, type HostConfig } from "../src/config.js";
import { AdapterRegistry, codec } from "../src/extensions.js";
import { Service } from "../src/runtime.js";
import { serve } from "../src/server.js";

export function config(hosts = ["a", "b"]): Config {
  return {
    schemaVersion: 1,
    instance: "test",
    dataDir: resolve(".test-state", randomUUID()),
    listen: { host: "127.0.0.1", port: 0 },
    hosts: hosts.map((id): HostConfig => ({
      id,
      label: id,
      adapter: "fixture",
      startup: { command: process.execPath, args: [], env: {} },
      lifecycle: {
        prepareOnStartup: false,
        onDemand: true,
        startupTimeoutMs: 2000,
      },
      options: {},
      authentication: [],
    })),
  };
}
export const initialSession = "ahp-session:/same";
export const initialChat = "ahp-chat:/same";

interface Peer {
  transport: AhpTransport;
  clientId: string;
}

export class ProtocolHost {
  root: RootState = {
    agents: [
      {
        provider: "test-provider",
        displayName: "Fixture",
        description: "",
        models: [],
        capabilities: { multipleChats: {} },
        protectedResources: [
          { resource: "https://api.github.com", required: true },
        ],
      },
    ],
  };
  sessions = new Map<string, SessionState>();
  chats = new Map<string, ChatState>();
  summaries = new Map<string, SessionSummary>();
  requests: { method: string; params: Record<string, unknown> }[] = [];
  starts = 0;
  stops = 0;
  connections = 0;
  connectDelay = 0;
  failStart = false;
  failStop = false;
  hiddenCreated = false;
  createdLifecycle = SessionLifecycle.Ready;
  omitSnapshot = false;
  invalidSnapshot = false;
  duplicateCursor = false;
  historyStuck = false;
  malformed:
    "catalogue" | "root" | "session" | "chat" | "turn" | "terminal" | undefined;
  holdDispatch = false;
  wrongEcho = false;
  noApplyDispatch = false;
  rejectDispatch: string | undefined;
  authenticationResult: unknown = {};
  readonly errors = new Map<string, number>();
  readonly held: (() => Promise<void>)[] = [];
  readonly peers = new Set<Peer>();
  private seq = 0;
  private readonly loops: Promise<void>[] = [];
  constructor() {
    this.addSession(initialSession, initialChat);
  }

  addSession(resource: string, chat = `ahp-chat:/${randomUUID()}`): void {
    this.addChat(chat);
    this.sessions.set(resource, {
      provider: "test-provider",
      title: "Context",
      status: SessionStatus.Idle,
      lifecycle: this.createdLifecycle,
      activeClients: [],
      chats: [
        {
          resource: chat,
          title: "Conversation",
          status: SessionStatus.Idle,
          modifiedAt: "2026-01-01",
        },
      ],
      defaultChat: chat,
    });
    if (!this.hiddenCreated)
      this.summaries.set(resource, {
        resource,
        title: "Context",
        provider: "test-provider",
        status: SessionStatus.Idle,
        createdAt: "2026-01-01",
        modifiedAt: "2026-01-01",
      });
  }

  addChat(resource: string): void {
    this.chats.set(resource, {
      resource,
      title: "Conversation",
      status: SessionStatus.Idle,
      modifiedAt: "2026-01-01",
      turns: [],
    });
  }

  state(resource = initialChat): ChatState {
    const state = this.chats.get(resource);
    if (state === undefined) throw new Error("Missing fixture chat");
    return state;
  }

  session(resource = initialSession): SessionState {
    const state = this.sessions.get(resource);
    if (state === undefined) throw new Error("Missing fixture session");
    return state;
  }

  transport(): AhpTransport {
    this.connections++;
    const [client, server] = InMemoryTransport.pair();
    const peer = { transport: server, clientId: "" };
    this.peers.add(peer);
    this.loops.push(this.loop(peer));
    return client;
  }

  private snapshot(resource: string): Snapshot {
    const state =
      resource === "ahp-root://"
        ? this.root
        : (this.sessions.get(resource) ?? this.chats.get(resource));
    if (state === undefined) throw new Error("Missing fixture state");
    return { resource, state, fromSeq: this.seq };
  }

  private async loop(peer: Peer): Promise<void> {
    for (;;) {
      const frame = await peer.transport.recv();
      if (frame === null) break;
      const raw: unknown =
        frame.kind === "parsed"
          ? frame.message
          : frame.kind === "text"
            ? JSON.parse(frame.text)
            : null;
      if (!record(raw) || typeof raw.method !== "string" || !record(raw.params))
        throw new Error("Invalid fixture request");
      const method = raw.method;
      const params = raw.params;
      this.requests.push({ method, params });
      if (method === "dispatchAction") {
        await this.dispatch(peer, params);
        continue;
      }
      if (typeof raw.id !== "number") continue;
      const id = raw.id;
      const channel = text(params.channel, "channel");
      const code = this.errors.get(method);
      if (code !== undefined) {
        await peer.transport.send({
          jsonrpc: "2.0",
          id,
          error: { code, message: "private raw diagnostic" },
        });
        continue;
      }
      let result: unknown;
      switch (method) {
        case "initialize":
          peer.clientId = text(params.clientId, "clientId");
          result = {
            protocolVersion: "1.0.0",
            serverSeq: this.seq,
            snapshots: [this.snapshot("ahp-root://")],
          };
          break;
        case "reconnect":
          peer.clientId = text(params.clientId, "clientId");
          result = {
            type: "snapshot",
            snapshots: [this.snapshot("ahp-root://")],
          };
          break;
        case "listSessions": {
          const items = [...this.summaries.values()];
          result =
            params.cursor === undefined
              ? {
                  items: items.slice(0, 1),
                  ...(items.length > 1 || this.duplicateCursor
                    ? { nextCursor: "next" }
                    : {}),
                }
              : {
                  items: items.slice(1),
                  ...(this.duplicateCursor ? { nextCursor: "next" } : {}),
                };
          if (this.malformed === "catalogue") result = { items: [{}] };
          break;
        }
        case "subscribe":
          if (
            channel !== "ahp-root://" &&
            !this.sessions.has(channel) &&
            !this.chats.has(channel)
          ) {
            await peer.transport.send({
              jsonrpc: "2.0",
              id,
              error: { code: -32008, message: "Not found" },
            });
            continue;
          }
          result = this.omitSnapshot
            ? {}
            : {
                snapshot: this.invalidSnapshot
                  ? this.snapshot("ahp-root://")
                  : this.snapshot(channel),
              };
          if (this.malformed === "root" && channel === "ahp-root://")
            result = {
              snapshot: {
                resource: channel,
                fromSeq: 0,
                state: { agents: [{}] },
              },
            };
          if (this.malformed === "session" && this.sessions.has(channel))
            result = {
              snapshot: {
                resource: channel,
                fromSeq: 0,
                state: { lifecycle: "ready", chats: [] },
              },
            };
          if (this.malformed === "chat" && this.sessions.has(channel))
            result = {
              snapshot: {
                ...this.snapshot(channel),
                state: { ...this.session(channel), chats: [{}] },
              },
            };
          if (
            (this.malformed === "turn" || this.malformed === "terminal") &&
            this.chats.has(channel)
          )
            result = {
              snapshot: {
                ...this.snapshot(channel),
                state: {
                  ...this.state(channel),
                  turns: [
                    {
                      id: "old",
                      responseParts: [],
                      ...(this.malformed === "terminal"
                        ? { state: "queued" }
                        : {}),
                    },
                  ],
                },
              },
            };
          break;
        case "createSession":
          this.addSession(channel);
          result = null;
          break;
        case "createChat": {
          const resource = text(params.chat, "chat");
          this.addChat(resource);
          this.session(channel).chats.push({
            resource,
            title: "New chat",
            status: SessionStatus.Idle,
            modifiedAt: "2026-01-01",
          });
          result = null;
          break;
        }
        case "fetchTurns":
          if (!this.historyStuck) delete this.state(channel).turnsNextCursor;
          result = {};
          break;
        case "authenticate":
          result = this.authenticationResult;
          break;
        case "ping":
          result = null;
          break;
        default:
          await peer.transport.send({
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: "Unknown" },
          });
          continue;
      }
      await peer.transport.send({ jsonrpc: "2.0", id, result });
    }
    this.peers.delete(peer);
  }

  private async dispatch(
    peer: Peer,
    params: Record<string, unknown>,
  ): Promise<void> {
    if (!record(params.action)) throw new Error("Invalid action");
    const channel = text(params.channel, "channel");
    const incoming = params.action;
    const turnId = text(incoming.turnId, "turnId");
    let action: ChatAction;
    if (incoming.type === "chat/turnStarted" && record(incoming.message)) {
      action = {
        type: ActionType.ChatTurnStarted,
        turnId,
        startedAt: text(incoming.startedAt, "startedAt"),
        message: {
          text: text(incoming.message.text, "text"),
          origin: { kind: MessageKind.User },
        },
      };
    } else action = { type: ActionType.ChatTurnCancelled, turnId, duration: 0 };
    if (typeof params.clientSeq !== "number")
      throw new Error("Missing client sequence");
    const envelope: ActionEnvelope = {
      channel,
      action,
      serverSeq: ++this.seq,
      origin: {
        clientId: peer.clientId,
        clientSeq: params.clientSeq + (this.wrongEcho ? 100 : 0),
      },
      ...(this.rejectDispatch === undefined
        ? {}
        : { rejectionReason: this.rejectDispatch }),
    };
    const send = async (): Promise<void> => {
      if (this.rejectDispatch === undefined && !this.noApplyDispatch)
        this.chats.set(channel, chatReducer(this.state(channel), action));
      await peer.transport.send({
        jsonrpc: "2.0",
        method: "action",
        params: envelope,
      });
    };
    if (this.holdDispatch) this.held.push(send);
    else await send();
  }

  async emit(action: ChatAction, channel = initialChat): Promise<void> {
    this.chats.set(channel, chatReducer(this.state(channel), action));
    for (const peer of this.peers)
      await peer.transport.send({
        jsonrpc: "2.0",
        method: "action",
        params: { channel, action, serverSeq: ++this.seq, origin: undefined },
      });
  }

  async complete(
    id: string,
    content = "Answer",
    channel = initialChat,
  ): Promise<void> {
    await this.emit(
      {
        type: ActionType.ChatResponsePart,
        turnId: id,
        part: { kind: ResponsePartKind.Markdown, id: "text", content },
      },
      channel,
    );
    await this.emit(
      { type: ActionType.ChatTurnComplete, turnId: id, duration: 0 },
      channel,
    );
  }

  async disconnect(): Promise<void> {
    await Promise.all(
      [...this.peers].map(async (peer) => {
        await peer.transport.close();
      }),
    );
  }
  async close(): Promise<void> {
    await this.disconnect();
    await Promise.all(this.loops);
  }
}

export async function harness(
  input = config(),
  options: {
    registry?: AdapterRegistry;
    requestTimeoutMs?: number;
    authTimeoutMs?: number;
  } = {},
) {
  const registry = options.registry ?? new AdapterRegistry();
  const hosts = new Map(
    input.hosts.map((host) => [host.id, new ProtocolHost()]),
  );
  registry.addHostAdapter({
    id: "fixture",
    options: codec(objectSchema({})),
    create(context) {
      const fixture = hosts.get(context.hostId);
      if (fixture === undefined) throw new Error("Missing host");
      return {
        async start() {
          fixture.starts++;
          if (fixture.failStart) throw new Error("fixture startup failed");
          await Promise.resolve();
        },
        async openTransport() {
          if (fixture.connectDelay > 0)
            await new Promise((resolve) =>
              setTimeout(resolve, fixture.connectDelay),
            );
          return fixture.transport();
        },
        async stop() {
          fixture.stops++;
          if (fixture.failStop) throw new Error("fixture cleanup failed");
          await fixture.disconnect();
        },
        verifyAuthentication() {
          return Promise.resolve({ status: "unknown" });
        },
        dispose() {
          return fixture.close();
        },
      };
    },
  });
  const service = await Service.create(input, {
    ...options,
    registry,
    requestTimeoutMs: options.requestTimeoutMs ?? 150,
  });
  const http = await serve(service);
  return {
    service,
    url: http.url,
    host(id = "a") {
      const host = hosts.get(id);
      if (host === undefined) throw new Error("Missing fixture");
      return host;
    },
    async api(path: string, method = "GET", data?: unknown) {
      const response = await fetch(http.url + path, {
        method,
        ...(data === undefined
          ? {}
          : {
              body: JSON.stringify(data),
              headers: { "content-type": "application/json" },
            }),
      });
      const raw = await response.text();
      const body: unknown = raw === "" ? undefined : JSON.parse(raw);
      return { status: response.status, body, headers: response.headers };
    },
    async ready(id = "a") {
      await this.api(`/hosts/${id}/start`, "POST");
      await eventually(() => service.select(id).native.status === "ready");
    },
    async close() {
      await http.close();
      await rm(input.dataDir, { recursive: true, force: true });
    },
  };
}

export async function eventually(
  predicate: () => boolean,
  timeout = 3000,
): Promise<void> {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("Condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export function resource(value: unknown): string {
  if (!record(value)) throw new Error("Expected resource");
  return text(value.resource, "resource");
}
