import { afterEach, describe, expect, it } from "vitest";
import {
  ActionType,
  ChatInteractivity,
  ChatOriginKind,
  ResponsePartKind,
  SessionLifecycle,
  SessionStatus,
  ToolCallStatus,
} from "@microsoft/agent-host-protocol";
import {
  config,
  eventually,
  harness,
  initialChat,
  initialSession,
  resource,
} from "./fixture.js";

type Harness = Awaited<ReturnType<typeof harness>>;
let app: Harness | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});
const turn = (id: string, chat = initialChat) => ({
  chat,
  turnId: id,
  text: "Hello",
});
const query = (id: string, chat = initialChat) =>
  `/hosts/a/turns?${new URLSearchParams({ chat, turnId: id }).toString()}`;

describe("fourteen HTTP operations over official SDK transport", () => {
  it("keeps GET passive, isolates failed hosts, coalesces startup and stops owned hosts", async () => {
    app = await harness();
    expect(await app.api("/health")).toMatchObject({
      status: 204,
      body: undefined,
    });
    expect((await app.api("/hosts")).body).toEqual([
      { hostId: "a", status: "idle" },
      { hostId: "b", status: "idle" },
    ]);
    expect((await app.api("/hosts/a/sessions")).status).toBe(503);
    expect(app.host().starts).toBe(0);
    app.host("b").failStart = true;
    await app.api("/hosts/b/start", "POST");
    await Promise.all(
      Array.from({ length: 10 }, async () => {
        await app?.api("/hosts/a/start", "POST");
      }),
    );
    await eventually(() => app?.service.select("a").native.status === "ready");
    expect(app.host().starts).toBe(1);
    expect((await app.api("/hosts")).body).toMatchObject([
      { hostId: "a", status: "ready", providers: ["test-provider"] },
      { hostId: "b", status: "failed" },
    ]);
    expect((await app.api("/hosts/a/stop", "POST")).status).toBe(202);
    await eventually(() => app?.service.select("a").native.status === "idle");
    expect((await app.api("/hosts/a/stop", "POST")).status).toBe(202);
    expect(app.host().stops).toBe(1);
    expect((await app.api("/hosts/a/sessions")).status).toBe(503);
  });

  it("preserves native identities, pagination, empty creation and ordinary chats", async () => {
    app = await harness();
    const host = app.host();
    host.addSession("ahp-session:/second");
    host.hiddenCreated = true;
    const created = await app.api("/hosts/a/sessions", "POST", {
      provider: "test-provider",
      workingDirectories: ["file:///D:/a%20b"],
    });
    expect(created.status).toBe(201);
    const session = resource(created.body);
    const sessions = await app.api("/hosts/a/sessions");
    expect(sessions.body).toEqual(
      expect.arrayContaining([
        { resource: session, title: "Context", provider: "test-provider" },
        {
          resource: "ahp-session:/second",
          title: "Context",
          provider: "test-provider",
        },
      ]),
    );
    const chat = resource(
      (await app.api("/hosts/a/chats", "POST", { session })).body,
    );
    const catalogue = await app.api(
      `/hosts/a/chats?${new URLSearchParams({ session }).toString()}`,
    );
    expect(JSON.stringify(catalogue.body)).toContain(
      JSON.stringify({ resource: chat, title: "New chat" }),
    );
    expect(
      host.requests.find((item) => item.method === "createChat")?.params,
    ).toEqual({ channel: session, chat });
    expect(
      host.requests.find((item) => item.method === "createSession")?.params,
    ).toEqual({
      channel: session,
      provider: "test-provider",
      workingDirectories: ["file:///D:/a%20b"],
    });
    await app.ready("b");
    expect((await app.api("/hosts/b/sessions")).body).toEqual([
      { resource: initialSession, title: "Context", provider: "test-provider" },
    ]);
  });

  it("projects origin and interactivity independently of defaultChat and blocks unsupported creation", async () => {
    app = await harness();
    await app.ready();
    const host = app.host();
    const state = host.session();
    delete state.defaultChat;
    state.chats = [
      { ...host.state(), origin: { kind: ChatOriginKind.User } },
      {
        ...host.state(),
        resource: "ahp-chat:/fork",
        origin: { kind: ChatOriginKind.Fork, chat: initialChat, turnId: "old" },
      },
      {
        ...host.state(),
        resource: "ahp-chat:/side",
        origin: {
          kind: ChatOriginKind.SideChat,
          chat: initialChat,
          turnId: "old",
          selection: { text: "private" },
        },
      },
      {
        ...host.state(),
        resource: "ahp-chat:/tool",
        interactivity: ChatInteractivity.ReadOnly,
        origin: {
          kind: ChatOriginKind.Tool,
          chat: initialChat,
          toolCallId: "tool",
        },
      },
    ];
    const response = await app.api(
      `/hosts/a/chats?${new URLSearchParams({ session: initialSession }).toString()}`,
    );
    expect(JSON.stringify(response.body)).not.toContain("private");
    expect(response.body).not.toHaveProperty("defaultChat");
    const agent = host.root.agents[0];
    if (agent === undefined) throw new Error();
    delete agent.capabilities;
    expect(
      (await app.api("/hosts/a/chats", "POST", { session: initialSession }))
        .body,
    ).toMatchObject({ error: { code: "capability_unsupported" } });
    host.state().interactivity = ChatInteractivity.ReadOnly;
    expect(
      (await app.api("/hosts/a/turns", "POST", turn("no"))).body,
    ).toMatchObject({ error: { code: "chat_not_interactive" } });
  });

  it("rejects concurrent admissions, observes exact turns, surfaces blocks and cancels only requested ID", async () => {
    app = await harness();
    await app.ready();
    const host = app.host();
    host.holdDispatch = true;
    const first = app.api("/hosts/a/turns", "POST", turn("one"));
    await eventually(() => host.held.length === 1);
    expect(
      (await app.api("/hosts/a/turns", "POST", turn("two"))).body,
    ).toMatchObject({ error: { code: "chat_busy" } });
    await host.held.shift()?.();
    host.holdDispatch = false;
    expect(await first).toMatchObject({ status: 202, body: undefined });
    expect((await app.api(query("one"))).body).toEqual({ state: "running" });
    host.state().status = SessionStatus.InputNeeded;
    expect((await app.api(query("one"))).body).toEqual({
      state: "running",
      inputRequired: true,
    });
    host.state().status = SessionStatus.InProgress;
    expect(
      (await app.api("/hosts/a/turns", "POST", turn("one"))).body,
    ).toMatchObject({ error: { code: "turn_exists" } });
    expect(
      (await app.api("/hosts/a/turns", "POST", turn("two"))).body,
    ).toMatchObject({ error: { code: "chat_busy" } });
    await host.emit({
      type: ActionType.ChatInputRequested,
      request: { id: "question" },
    });
    expect((await app.api(query("one"))).body).toEqual({
      state: "running",
      inputRequired: true,
    });
    expect((await app.api("/hosts/a/stop", "POST")).body).toMatchObject({
      error: { code: "host_busy" },
    });
    expect(
      (
        await app.api("/hosts/a/turns/cancel", "POST", {
          chat: initialChat,
          turnId: "other",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await app.api("/hosts/a/turns/cancel", "POST", {
          chat: initialChat,
          turnId: "one",
        })
      ).status,
    ).toBe(202);
    expect((await app.api(query("one"))).body).toEqual({ state: "cancelled" });
    expect((await app.api("/hosts/a/turns", "POST", turn("two"))).status).toBe(
      202,
    );
    expect(
      (
        await app.api("/hosts/a/turns/cancel", "POST", {
          chat: initialChat,
          turnId: "one",
        })
      ).status,
    ).toBe(202);
    expect(host.state().activeTurn?.id).toBe("two");
    await host.complete("two", "Hello");
    expect((await app.api(query("two"))).body).toEqual({
      state: "complete",
      text: "Hello",
    });
  });

  it("retains uncertain dispatch and never mistakes a wrong echo for acceptance", async () => {
    app = await harness();
    await app.ready();
    const host = app.host();
    host.wrongEcho = true;
    host.noApplyDispatch = true;
    expect(
      (await app.api("/hosts/a/turns", "POST", turn("uncertain"))).body,
    ).toMatchObject({ error: { code: "turn_outcome_unknown" } });
    expect((await app.api(query("uncertain"))).body).toMatchObject({
      error: { code: "turn_state_unavailable" },
    });
    expect(
      (await app.api("/hosts/a/turns", "POST", turn("later"))).status,
    ).toBe(503);
    expect((await app.api("/hosts/a/stop", "POST")).body).toMatchObject({
      error: { code: "host_activity_unknown" },
    });
    expect(
      host.requests.filter((item) => item.method === "dispatchAction"),
    ).toHaveLength(1);
  });

  it("reconciles an unacknowledged turn by native state and honors host rejections", async () => {
    app = await harness();
    await app.ready();
    const host = app.host();
    host.wrongEcho = true;
    expect((await app.api("/hosts/a/turns", "POST", turn("a"))).status).toBe(
      502,
    );
    expect((await app.api(query("a"))).body).toEqual({ state: "running" });
    host.wrongEcho = false;
    await host.complete("a");
    host.rejectDispatch = "Chat busy";
    expect(
      (await app.api("/hosts/a/turns", "POST", turn("b"))).body,
    ).toMatchObject({ error: { code: "chat_busy" } });
    host.rejectDispatch = "No permission";
    expect(
      (await app.api("/hosts/a/turns", "POST", turn("b"))).body,
    ).toMatchObject({ error: { code: "turn_rejected" } });
    host.rejectDispatch = undefined;
    expect((await app.api("/hosts/a/turns", "POST", turn("b"))).status).toBe(
      202,
    );
  });

  it("uses error state and markdown only; tool approval blocks are explicit", async () => {
    app = await harness();
    await app.ready();
    await app.api("/hosts/a/turns", "POST", turn("one"));
    app
      .host()
      .state()
      .activeTurn?.responseParts.push({
        kind: ResponsePartKind.ToolCall,
        toolCall: {
          toolCallId: "tool",
          toolName: "private",
          displayName: "Tool",
          status: ToolCallStatus.PendingConfirmation,
          invocationMessage: "secret command",
        },
      });
    expect((await app.api(query("one"))).body).toEqual({
      state: "running",
      inputRequired: true,
    });
    await app.host().emit({
      type: ActionType.ChatError,
      turnId: "one",
      duration: 0,
      part: {
        kind: ResponsePartKind.Error,
        error: { errorType: "error", message: "private details" },
      },
    });
    expect((await app.api(query("one"))).body).toEqual({
      state: "error",
      error: {
        code: "upstream_turn_error",
        message: "The host reported a turn error",
      },
    });
  });

  it("returns uncertainty for incomplete or inaccessible history; pagination cannot loop", async () => {
    app = await harness();
    await app.ready();
    app.host().state().turnsNextCursor = "older";
    app.host().errors.set("fetchTurns", -32601);
    expect((await app.api(query("old"))).body).toMatchObject({
      error: { code: "turn_state_unavailable" },
    });
    app.host().errors.delete("fetchTurns");
    expect((await app.api(query("old"))).status).toBe(404);
    app.host().duplicateCursor = true;
    expect((await app.api("/hosts/a/sessions")).body).toMatchObject({
      error: { code: "incomplete_host_catalogue" },
    });
  });

  it("reconnects without starting another process or exposing stale observations", async () => {
    app = await harness();
    await app.ready();
    await app.api("/hosts/a/turns", "POST", turn("one"));
    app.host().connectDelay = 100;
    await app.host().disconnect();
    await eventually(() => app?.service.select("a").native.status !== "ready");
    expect((await app.api(query("one"))).status).toBe(503);
    await eventually(() => app?.service.select("a").native.status === "ready");
    expect(app.host().starts).toBe(1);
    expect(app.host().connections).toBe(2);
    expect((await app.api(query("one"))).body).toEqual({ state: "running" });
    expect(
      app.host().requests.filter((item) => item.method === "dispatchAction"),
    ).toHaveLength(1);
  });

  it("validates inputs and has no old, gateway, or arbitrary-command API", async () => {
    app = await harness();
    for (const path of ["/tasks", "/hosts/a", "/services", "/hosts/a/tools"])
      expect((await app.api(path)).status).toBe(404);
    expect((await app.api("/hosts/unknown/start", "POST")).status).toBe(404);
    for (const value of [
      {},
      { provider: "test-provider", workingDirectories: [] },
      { provider: "test-provider", workingDirectories: ["D:\\work"] },
      { provider: "test-provider", workingDirectories: ["file:relative"] },
      {
        provider: "test-provider",
        workingDirectories: ["file:///D:/work#fragment"],
      },
      {
        provider: "test-provider",
        workingDirectories: ["file:///D:/work"],
        extra: true,
      },
    ])
      expect((await app.api("/hosts/a/sessions", "POST", value)).status).toBe(
        400,
      );
    expect((await app.api("/hosts/a/chats?session=x&session=y")).status).toBe(
      400,
    );
    expect((await app.api("/hosts/a/chats", "DELETE")).status).toBe(404);
    const response = await fetch(app.url + "/health", {
      headers: { origin: "https://external.example" },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(app.host().starts).toBe(0);
    const invalidRequests = [
      { headers: {}, body: "{}" },
      { headers: { "content-type": "application/json" }, body: "{" },
      {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "x".repeat(1_048_577) }),
      },
    ];
    for (const options of invalidRequests) {
      const response = await fetch(app.url + "/hosts/a/turns", {
        method: "POST",
        ...options,
      });
      expect(response.status).toBe(400);
    }
    expect((await app.api("/hosts/%ZZ/start", "POST")).status).toBe(400);
  });

  it("does not turn malformed native state into success-shaped observations", async () => {
    app = await harness();
    await app.ready();
    app.host().malformed = "catalogue";
    expect((await app.api("/hosts/a/sessions")).body).toMatchObject({
      error: { code: "invalid_host_catalogue" },
    });
    for (const kind of ["session", "chat"] as const) {
      app.host().malformed = kind;
      expect(
        (await app.api(`/hosts/a/chats?session=${initialSession}`)).status,
      ).toBe(502);
    }
    for (const kind of ["turn", "terminal"] as const) {
      app.host().malformed = kind;
      expect((await app.api(query("old"))).body).toMatchObject({
        error: { code: "turn_state_unavailable" },
      });
    }
    app.host().malformed = "root";
    expect((await app.api("/hosts")).body).toMatchObject([
      { hostId: "a", status: "failed" },
      { hostId: "b", status: "idle" },
    ]);
    app.host().malformed = undefined;
    expect((await app.api(query("id", "ahp-chat:/missing"))).status).toBe(404);
  });

  it("fails explicit startup requirements and missing/corrupt host snapshots safely", async () => {
    const input = config();
    const a = input.hosts[0];
    if (a === undefined) throw new Error();
    a.lifecycle.onDemand = false;
    app = await harness(input);
    expect(
      (
        await app.api("/hosts/a/sessions", "POST", {
          provider: "test-provider",
          workingDirectories: ["file:///D:/"],
        })
      ).status,
    ).toBe(503);
    await app.ready();
    app.host().omitSnapshot = true;
    expect(
      (await app.api(`/hosts/a/chats?session=${initialSession}`)).status,
    ).toBe(503);
    app.host().omitSnapshot = false;
    app.host().invalidSnapshot = true;
    expect(
      (await app.api(`/hosts/a/chats?session=${initialSession}`)).status,
    ).toBe(503);
    app.host().invalidSnapshot = false;
    app.host().session().lifecycle = SessionLifecycle.Creating;
    expect(
      (await app.api(`/hosts/a/chats?session=${initialSession}`)).status,
    ).toBe(200);
    app.host().session().lifecycle = SessionLifecycle.Failed;
    expect(
      (await app.api(`/hosts/a/chats?session=${initialSession}`)).status,
    ).toBe(503);
  });
});
