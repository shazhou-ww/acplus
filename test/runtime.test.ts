import { createServer } from "node:http";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ActionType,
  SessionLifecycle,
  SessionStatus,
} from "@microsoft/agent-host-protocol";
import { objectSchema } from "../src/config.js";
import { AdapterRegistry, codec } from "../src/extensions.js";
import { Service, start } from "../src/runtime.js";
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
  vi.restoreAllMocks();
});

describe("failure isolation and lifecycle admission", () => {
  it("supports an empty service and retains one lock through listen and shutdown", async () => {
    const input = config([]);
    const running = await start(input);
    try {
      expect((await fetch(running.url + "/health")).status).toBe(204);
      await expect(start(input)).rejects.toMatchObject({
        code: "data_directory_locked",
      });
    } finally {
      await running.close();
      await running.close();
    }
    await expect(readFile(join(input.dataDir, "owner.lock"))).rejects.toThrow();
    await rm(input.dataDir, { recursive: true, force: true });
  });

  it("cleans resources on listener failure and partial driver creation", async () => {
    const listener = createServer();
    await new Promise<void>((resolve) =>
      listener.listen(0, "127.0.0.1", resolve),
    );
    const address = listener.address();
    if (address === null || typeof address === "string") throw new Error();
    const input = config([]);
    input.listen.port = address.port;
    await expect(start(input)).rejects.toThrow();
    await new Promise<void>((resolve) => {
      listener.close(() => {
        resolve();
      });
    });
    await expect(readFile(join(input.dataDir, "owner.lock"))).rejects.toThrow();
    await rm(input.dataDir, { recursive: true, force: true });
    const registry = new AdapterRegistry();
    registry.addHostAdapter({
      id: "fixture",
      options: codec(objectSchema({})),
      create() {
        throw new Error("create failure");
      },
    });
    const failing = config(["a"]);
    await expect(Service.create(failing, { registry })).rejects.toThrow(
      "create failure",
    );
    await rm(failing.dataDir, { recursive: true, force: true });
  });

  it("honors configured eager preparation and on-demand coalescing while stop freezes admission", async () => {
    const input = config(["a", "b"]);
    const a = input.hosts[0];
    if (a === undefined) throw new Error();
    a.lifecycle.prepareOnStartup = true;
    app = await harness(input);
    app.service.prepare();
    await eventually(() => app?.service.select("a").native.status === "ready");
    expect(app.host("b").starts).toBe(0);
    await Promise.all([
      app.service.select("b").native.ensure(),
      app.service.select("b").native.ensure(),
    ]);
    expect(app.host("b").starts).toBe(1);
    app.host().holdDispatch = true;
    const write = app.api("/hosts/a/turns", "POST", {
      chat: initialChat,
      turnId: "a",
      text: "hello",
    });
    await eventually(() => app?.host().held.length === 1);
    expect((await app.api("/hosts/a/stop", "POST")).status).toBe(409);
    await app.host().held.shift()?.();
    await write;
    await app.host().complete("a");
    const native = app.service.select("a").native;
    native.status = "stopping";
    expect((await app.api("/hosts/a/sessions")).body).toMatchObject({
      error: { code: "host_not_ready" },
    });
    expect(
      (await app.api(`/hosts/a/chats?session=${initialSession}`)).status,
    ).toBe(503);
    expect((await app.api("/hosts/a/start", "POST")).body).toMatchObject({
      error: { code: "host_stopping" },
    });
    expect((await app.api("/hosts/a/stop", "POST")).body).toMatchObject({
      error: { code: "host_stopping" },
    });
    expect(
      (
        await app.api("/hosts/a/sessions", "POST", {
          provider: "test-provider",
          workingDirectories: ["file:///D:/"],
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await app.api("/hosts/a/turns/cancel", "POST", {
          chat: initialChat,
          turnId: "a",
        })
      ).status,
    ).toBe(409);
    native.status = "ready";
  });

  it("keeps unavailable catalogue or background work from authorizing process stop", async () => {
    app = await harness();
    await app.ready();
    app.host().errors.set("listSessions", -32603);
    expect((await app.api("/hosts/a/stop", "POST")).body).toMatchObject({
      error: { code: "host_activity_unknown" },
    });
    app.host().errors.clear();
    app.host().session().status = SessionStatus.InProgress;
    expect((await app.api("/hosts/a/stop", "POST")).body).toMatchObject({
      error: { code: "host_busy" },
    });
    app.host().session().status = SessionStatus.Idle;
    app.host().state().status = SessionStatus.InProgress;
    expect((await app.api("/hosts/a/stop", "POST")).body).toMatchObject({
      error: { code: "host_busy" },
    });
    app.host().state().status = SessionStatus.Idle;
    app.host().connectDelay = 100;
    await app.host().disconnect();
    await eventually(() => app?.service.select("a").native.status !== "ready");
    expect((await app.api("/hosts/a/stop", "POST")).body).toMatchObject({
      error: { code: "host_activity_unknown" },
    });
    await eventually(() => app?.service.select("a").native.status === "ready");
  });

  it("surfaces upstream rejection versus ambiguous creation and never substitutes another resource", async () => {
    app = await harness();
    await app.ready();
    app.host().errors.set("createSession", -32007);
    expect(
      (
        await app.api("/hosts/a/sessions", "POST", {
          provider: "test-provider",
          workingDirectories: ["file:///D:/"],
        })
      ).body,
    ).toMatchObject({ error: { code: "upstream_auth_required" } });
    app.host().errors.clear();
    expect(
      (
        await app.api("/hosts/a/sessions", "POST", {
          provider: "missing",
          workingDirectories: ["file:///D:/"],
        })
      ).status,
    ).toBe(404);
    app.host().errors.set("createChat", -32011);
    expect(
      (await app.api("/hosts/a/chats", "POST", { session: initialSession }))
        .status,
    ).toBe(502);
    app.host().errors.clear();
    const original = app.host().addSession.bind(app.host());
    vi.spyOn(app.host(), "addSession").mockImplementation((resource) => {
      original(resource);
      const state = app?.host().session(resource);
      if (state !== undefined) state.lifecycle = SessionLifecycle.Failed;
    });
    expect(
      (
        await app.api("/hosts/a/sessions", "POST", {
          provider: "test-provider",
          workingDirectories: ["file:///D:/"],
        })
      ).body,
    ).toMatchObject({ error: { code: "session_creation_failed" } });
    vi.restoreAllMocks();
    const createChat = app.host().addChat.bind(app.host());
    vi.spyOn(app.host(), "addChat").mockImplementation((resource) => {
      createChat(resource);
      app?.host().chats.delete(resource);
    });
    expect(
      (await app.api("/hosts/a/chats", "POST", { session: initialSession }))
        .body,
    ).toMatchObject({ error: { code: "creation_outcome_unknown" } });
  });

  it("supports independent idle chats while another chat has an active turn", async () => {
    app = await harness();
    const second = resource(
      (await app.api("/hosts/a/chats", "POST", { session: initialSession }))
        .body,
    );
    const start = (chat: string, turnId: string) =>
      app?.api("/hosts/a/turns", "POST", { chat, turnId, text: "hi" });
    expect(await start(initialChat, "one")).toMatchObject({ status: 202 });
    expect(await start(second, "two")).toMatchObject({ status: 202 });
    await app
      .host()
      .emit({ type: ActionType.ChatTurnCancelled, turnId: "one", duration: 0 });
    expect(app.host().state(second).activeTurn?.id).toBe("two");
  });

  it("resolves exact older turns and refuses a non-advancing history window", async () => {
    app = await harness();
    await app.ready();
    app.host().state().turnsNextCursor = "older";
    app.host().historyStuck = true;
    const response = await app.api(
      `/hosts/a/turns?chat=${initialChat}&turnId=old`,
    );
    expect(response.status).toBe(503);
  });

  it("reports failed cleanup and prevents unsafe process reuse", async () => {
    app = await harness();
    await app.ready();
    app.host().failStop = true;
    expect((await app.api("/hosts/a/stop", "POST")).status).toBe(202);
    await eventually(() => app?.service.select("a").native.status === "failed");
    expect((await app.api("/hosts/a/start", "POST")).body).toMatchObject({
      error: { code: "cleanup_failed_lock_retained" },
    });
    app.host().failStop = false;
  });

  it("separates provider discovery from authenticated catalogue access and unknown turn state", async () => {
    app = await harness();
    app.host().errors.set("listSessions", -32007);
    await app.api("/hosts/a/start", "POST");
    await eventually(() => app?.service.select("a").native.status === "ready");
    expect((await app.api("/hosts")).body).toMatchObject([
      { hostId: "a", status: "ready" },
      { hostId: "b", status: "idle" },
    ]);
    expect((await app.api("/hosts/a/sessions")).body).toMatchObject({
      error: { code: "upstream_auth_required" },
    });
    app.host().omitSnapshot = true;
    expect(
      (await app.api(`/hosts/a/turns?chat=${initialChat}&turnId=x`)).status,
    ).toBe(503);
  });

  it("fails unsupported protocol negotiation explicitly and sanitizes SDK connection diagnostics", async () => {
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    app = await harness();
    app.host().errors.set("initialize", -32005);
    await app.api("/hosts/a/start", "POST");
    await eventually(() => app?.service.select("a").native.status === "failed");
    expect(app.service.select("a").native.error?.code).toBe(
      "host_protocol_unsupported",
    );
    expect(JSON.stringify(warnings.mock.calls)).not.toContain(
      "private raw diagnostic",
    );
  });
});
