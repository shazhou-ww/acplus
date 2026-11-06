import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketTransport } from "@microsoft/agent-host-protocol/ws";
import {
  ActionType,
  AhpErrorCodes,
  MessageKind,
  TurnState,
} from "@microsoft/agent-host-protocol";
import {
  AhpdDriver,
  ahpdEnvironment,
  ahpdFactory,
  COPILOT_RESOURCE,
  type AhpdOptions,
} from "../src/ahpd.js";
import { Redactor } from "../src/common.js";
import { Service } from "../src/runtime.js";
import { serve } from "../src/server.js";
import { validator } from "../src/config.js";
import { ProcessOwner, Secrets } from "../src/processes.js";
import { copilotCliFactory, nativeCopilotLogin } from "../src/copilot-cli.js";
import {
  AdapterRegistry,
  type AuthenticationContext,
  type HostContext,
} from "../src/extensions.js";
import {
  config,
  eventually,
  initialChat,
  initialSession,
  ProtocolHost,
} from "./fixture.js";

const paths: string[] = [];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const path of paths.splice(0))
    await rm(path, { recursive: true, force: true });
});

function options(root: string): AhpdOptions {
  return {
    port: 19491,
    plugin: resolve(root, "agent-acp"),
    copilotCommand: process.execPath,
    copilotProfileDir: resolve(root, "copilot"),
    loginAccount: "fixture-user",
    trustedDirectories: [pathToFileURL(resolve(root, "work")).href],
    runtimeRevision: "8c6f4645b90a05d47e43359565cb5697b011a43d",
  };
}
async function setup(authTimeoutMs = 5000) {
  const input = config(["a"]);
  paths.push(input.dataDir);
  const host = input.hosts[0]!;
  host.adapter = "ahpd-test";
  host.options = { ...options(input.dataDir) };
  host.startup.args = [resolve("test", "ahpd-fixture-prefix.mjs")];
  const fixture = new ProtocolHost();
  fixture.root.agents[0]!.provider = "copilot";
  fixture.root.agents[0]!.protectedResources = [
    { resource: COPILOT_RESOURCE, required: true },
  ];
  for (const session of fixture.sessions.values()) session.provider = "copilot";
  for (const summary of fixture.summaries.values())
    summary.provider = "copilot";
  cleanups.push(() => fixture.close());
  const connect = vi
    .spyOn(WebSocketTransport, "connect")
    .mockImplementation(() =>
      Promise.resolve(fixture.transport() as WebSocketTransport),
    );
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const spawn = ProcessOwner.prototype.spawn;
  const launches = vi
    .spyOn(ProcessOwner.prototype, "spawn")
    .mockImplementation(function (this: ProcessOwner, value) {
      return spawn.call(this, {
        ...value,
        command: process.execPath,
        args: ["-e", "setInterval(()=>{},1000)"],
      });
    });
  const registry = new AdapterRegistry();
  registry.addHostAdapter({
    ...ahpdFactory,
    id: "ahpd-test",
    create: (context, config, options) =>
      new AhpdDriver(context, config, options, "linux"),
  });
  const service = await Service.create(input, { registry, authTimeoutMs });
  cleanups.push(() => service.close());
  return {
    input,
    host,
    service,
    fixture,
    connect,
    launches,
    originalSpawn: spawn,
    native: service.select("a").native,
  };
}

describe("owned AHPD adapter", () => {
  it("keeps the documented example aligned with the adapter and public configuration schema", async () => {
    const example: unknown = JSON.parse(
      await readFile(resolve("docs", "ahpd.example.json"), "utf8"),
    );
    const schema: Record<string, unknown> = JSON.parse(
      await readFile(resolve("docs", "host-config.schema.json"), "utf8"),
    ) as Record<string, unknown>;
    const validate = validator.compile(schema);
    expect(validate(example), JSON.stringify(validate.errors)).toBe(true);
    expect(
      validate({
        schemaVersion: 1,
        instance: "example",
        dataDir: "data",
        listen: { host: "127.0.0.1", port: 0 },
        hosts: [
          {
            ...config(["a"]).hosts[0],
            adapter: "ahpd",
            options: {
              ...options(resolve(".test-state")),
              runtimeRevision: "main",
            },
          },
        ],
      }),
    ).toBe(false);
  });
  it("uses explicit isolation, stable paths and exact trust, coalesces startup and restores original native resources", async () => {
    vi.stubEnv("GH_TOKEN", "ambient-never-inherit");
    vi.stubEnv("GITHUB_TOKEN", "ambient-never-inherit");
    vi.stubEnv("COPILOT_GITHUB_TOKEN", "ambient-never-inherit");
    const app = await setup();
    app.native.config.startup.env.PATH = process.env.PATH ?? "";
    expect(app.native.status).toBe("idle");
    await Promise.all(Array.from({ length: 5 }, () => app.native.ensure()));
    expect(app.launches).toHaveBeenCalledTimes(1);
    const start = app.launches.mock.calls[0]![0];
    expect(start.env).toMatchObject({
      COPILOT_HOME: app.host.options.copilotProfileDir,
      COPILOT_AUTO_UPDATE: "false",
      DBUS_SESSION_BUS_ADDRESS: "disabled:",
    });
    expect(start.env.GH_TOKEN).toBeUndefined();
    expect(start.env.GITHUB_TOKEN).toBeUndefined();
    expect(start.env.COPILOT_GITHUB_TOKEN).toBeUndefined();
    const root = join(app.input.dataDir, "hosts", "a");
    const runtime = JSON.parse(
      await readFile(join(root, "config", "ahpd", "config.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(runtime).toMatchObject({
      sessions: "file",
      paths: options(app.input.dataDir).trustedDirectories.map((uri) =>
        fileURLToPath(uri, { windows: false }),
      ),
      port: 19491,
      updateCheck: false,
    });
    expect(
      await readFile(
        join(root, "config", "ahpd", "agents", "copilot.json"),
        "utf8",
      ),
    ).toContain('"hostTools":false');
    expect(
      app.fixture.requests.find((r) => r.method === "dispatchAction")?.params
        .action,
    ).toEqual({
      type: "root/configChanged",
      config: {
        workspaceTrust: {
          enabled: true,
          trustedUris: options(app.input.dataDir).trustedDirectories,
        },
      },
    });
    expect(await app.native.listSessions()).toContainEqual(
      expect.objectContaining({ resource: initialSession }),
    );
    await app.native.startTurn(initialChat, "stable-turn", "original message");
    await app.fixture.complete("stable-turn", "actual agent answer");
    expect(await app.native.getTurn(initialChat, "stable-turn")).toMatchObject({
      state: TurnState.Complete,
      text: "actual agent answer",
    });
    const writes = app.fixture.requests.filter(
      (r) => r.method === "dispatchAction" && r.params.channel === initialChat,
    ).length;
    app.connect.mockRejectedValue(new Error("network disconnected"));
    await app.fixture.disconnect();
    await eventually(() => app.native.status !== "ready");
    app.connect.mockImplementation(() =>
      Promise.resolve(app.fixture.transport() as WebSocketTransport),
    );
    app.native.start();
    await app.native.ensure();
    expect(app.launches).toHaveBeenCalledTimes(1);
    expect(await app.native.getTurn(initialChat, "stable-turn")).toMatchObject({
      state: "complete",
    });
    expect(
      app.fixture.requests.filter(
        (r) =>
          r.method === "dispatchAction" && r.params.channel === initialChat,
      ),
    ).toHaveLength(writes);
    await app.native.stop();
    await eventually(() => app.native.status === "idle");
    expect(await readdir(root)).not.toContain("connection-token");
    await app.native.ensure();
    expect(app.launches).toHaveBeenCalledTimes(2);
    expect(await app.native.getTurn(initialChat, "stable-turn")).toMatchObject({
      state: "complete",
    });
  });

  it("retries transport until protocol connects but cleans timeout/cancellation and rejects trust blocks", async () => {
    const app = await setup();
    app.connect.mockRejectedValueOnce(new Error("listener not bound"));
    await app.native.ensure();
    expect(app.connect.mock.calls.length).toBeGreaterThanOrEqual(2);
    await app.native.stop();
    await eventually(() => app.native.status === "idle");
    app.fixture.rejectDispatch = "permission denied";
    await expect(app.native.ensure()).rejects.toMatchObject({
      code: "workspace_trust_rejected",
    });
    expect(app.native.status).toBe("failed");
    expect(await readdir(join(app.input.dataDir, "hosts", "a"))).not.toContain(
      "connection-token",
    );
    app.fixture.rejectDispatch = undefined;
    app.host.lifecycle.startupTimeoutMs = 50;
    app.native.config.lifecycle.startupTimeoutMs = 50;
    app.connect.mockRejectedValue(new Error("not listening"));
    await expect(app.native.ensure()).rejects.toThrow();
    expect(app.native.status).toBe("failed");
  });

  it("rejects unsafe configuration and shared profiles before launching anything", async () => {
    const input = config(["a", "b"]);
    paths.push(input.dataDir);
    const host = input.hosts[0]!;
    const valid = options(input.dataDir);
    for (const changed of [
      { port: 0 },
      { runtimeRevision: "main" },
      { trustedDirectories: ["https://untrusted"] },
    ])
      expect(() =>
        ahpdFactory.options.parse({ ...valid, ...changed }),
      ).toThrow();
    for (const changed of [
      { plugin: "package-specifier" },
      { copilotCommand: "copilot.cmd" },
      { copilotProfileDir: "ambient" },
      { trustedDirectories: ["file:///work?q=x"] },
    ])
      expect(() =>
        ahpdFactory.validate?.(host, { ...valid, ...changed }),
      ).toThrow();
    host.startup.args = ["--port=1"];
    expect(() => ahpdFactory.validate?.(host, valid)).toThrow();
    host.startup.args = [];
    host.startup.env.GH_TOKEN = "unsafe";
    expect(() => ahpdFactory.validate?.(host, valid)).toThrow();
    host.startup.env = {};
    host.authentication = [
      {
        id: "wrong",
        provider: "copilot",
        resource: "https://api.github.com",
        adapter: "ahp-token",
        options: {},
      },
    ];
    expect(() => ahpdFactory.validate?.(host, valid)).toThrow();
    for (const item of input.hosts) {
      item.adapter = "ahpd";
      item.options = { ...valid };
    }
    await expect(Service.create(input)).rejects.toThrow(
      "profiles must not be shared",
    );
  });

  it("never starts via openTransport, treats ready/reuse as unknown and handles absent native auth support", async () => {
    const directory = resolve(".test-state", randomUUID());
    paths.push(directory);
    const owner = new ProcessOwner();
    cleanups.push(() => owner.close());
    const context: HostContext = {
      hostId: "a",
      dataDir: directory,
      processes: owner,
      secrets: new Secrets(new Redactor()),
      logger: { event() {} },
      connection() {
        throw new Error("not connected");
      },
    };
    const driver = ahpdFactory.create(
      context,
      config(["a"]).hosts[0]!,
      options(directory),
    );
    const unsupported = new AhpdDriver(
      context,
      config(["a"]).hosts[0]!,
      options(directory),
      "win32",
    );
    await expect(
      unsupported.start(AbortSignal.timeout(100)),
    ).rejects.toMatchObject({ code: "host_platform_unsupported" });
    await expect(
      driver.openTransport(AbortSignal.timeout(100)),
    ).rejects.toMatchObject({ code: "host_not_started" });
    await expect(
      driver.verifyAuthentication(
        { hostId: "a", provider: "$host", resource: "https://api.github.com" },
        AbortSignal.timeout(100),
      ),
    ).rejects.toMatchObject({ code: "auth_target_unsupported" });
    await driver.dispose();
    const auth = authContext(owner);
    await expect(
      driver.authenticateNative?.(
        { ...auth, target: { ...auth.target, provider: "wrong" } },
        "reuse",
        AbortSignal.timeout(100),
      ),
    ).rejects.toMatchObject({ code: "auth_target_unsupported" });
    await expect(
      driver.authenticateNative?.(auth, "reuse", AbortSignal.timeout(100)),
    ).rejects.toThrow("not connected");
    const adapter = copilotCliFactory.create({ mode: "reuse" });
    await expect(
      adapter.run(auth, AbortSignal.timeout(100)),
    ).rejects.toMatchObject({ code: "auth_target_unsupported" });
  });

  it("native reuse is explicit but cannot falsely mark provider authenticated", async () => {
    const app = await setup();
    app.native.config.authentication.push({
      id: "reuse",
      provider: "copilot",
      resource: COPILOT_RESOURCE,
      adapter: "copilot-cli",
      options: { mode: "reuse" },
    });

    app.service.select("a").auth.begin("reuse");
    await eventually(
      () => app.service.select("a").auth.get().status === "failed",
    );
    expect(app.service.select("a").auth.get()).toMatchObject({
      status: "failed",
      error: { code: "auth_verification_unsupported" },
    });
    expect(
      app.fixture.requests.some(
        (r) =>
          r.method === "authenticate" ||
          (r.method === "dispatchAction" && r.params.channel !== "ahp-root://"),
      ),
    ).toBe(false);
  });

  it("verifies only an advertised current-generation native account state without a billable probe", async () => {
    const app = await setup();
    await app.native.ensure();
    const target = {
      hostId: "a",
      provider: "copilot",
      resource: COPILOT_RESOURCE,
      generation: app.native.connection().generation,
    };
    const verify = () =>
      app.native.driver.verifyAuthentication(target, AbortSignal.timeout(1000));
    expect(await verify()).toMatchObject({ status: "unknown" });
    const raw = app.native.connection().rawClient();
    const subscribe = raw.subscribe.bind(raw);
    const delayed = vi
      .spyOn(raw, "subscribe")
      .mockImplementationOnce(async (resource, options) => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return subscribe(resource, options);
      });
    await expect(
      app.native.driver.verifyAuthentication(target, AbortSignal.timeout(5)),
    ).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 50));
    delayed.mockRestore();
    app.fixture.root.config = {
      schema: { type: "object", properties: {} },
      values: {
        "ahpd.copilotAccount": { status: "signedIn", observedAt: Date.now() },
      },
    };
    expect(await verify()).toEqual({ status: "authenticated" });
    app.fixture.root.config = {
      schema: { type: "object", properties: {} },
      values: {
        "ahpd.copilotAccount": { status: "signedOut", observedAt: Date.now() },
      },
    };
    expect(await verify()).toEqual({ status: "required" });
    for (const account of [
      { status: "unavailable" },
      { status: "signedIn" },
      { status: "signedIn", observedAt: Date.now() + 60000 },
    ]) {
      app.fixture.root.config = {
        schema: { type: "object", properties: {} },
        values: { "ahpd.copilotAccount": account },
      };
      expect(await verify()).toEqual({ status: "unknown" });
    }
    await expect(
      app.native.driver.verifyAuthentication(
        { ...target, resource: "https://api.github.com" },
        AbortSignal.timeout(1000),
      ),
    ).rejects.toMatchObject({ code: "auth_target_unsupported" });
    await expect(
      app.native.driver.verifyAuthentication(
        { ...target, generation: target.generation + 100 },
        AbortSignal.timeout(1000),
      ),
    ).rejects.toMatchObject({ code: "auth_connection_changed" });
    app.fixture.root.agents[0]!.protectedResources = [];
    await expect(verify()).rejects.toMatchObject({
      code: "auth_target_not_advertised",
    });
    app.fixture.root.agents[0]!.protectedResources = [
      { resource: COPILOT_RESOURCE, required: true },
    ];
    app.fixture.omitSnapshot = true;
    await expect(verify()).rejects.toMatchObject({
      code: "auth_invalid_response",
    });
    expect(app.fixture.requests.some((r) => r.method === "authenticate")).toBe(
      false,
    );
  });

  it("requires a caller-admitted Copilot Turn with native complete and agent markdown; history, user-only, cancellation and auth challenges do not authenticate", async () => {
    const app = await setup();
    app.native.config.authentication.push({
      id: "reuse",
      provider: "copilot",
      resource: COPILOT_RESOURCE,
      adapter: "copilot-cli",
      options: { mode: "reuse" },
    });
    await app.native.ensure();
    const target = {
      hostId: "a",
      provider: "copilot",
      resource: COPILOT_RESOURCE,
      generation: app.native.connection().generation,
    };
    const verify = () =>
      app.native.driver.verifyAuthentication(target, AbortSignal.timeout(1000));
    await app.native.listChats(initialSession);
    app.native.driver.observeExecution?.({
      phase: "submitted",
      generation: target.generation + 100,
      provider: "copilot",
      chat: initialChat,
      turnId: "wrong-generation",
    });
    app.native.driver.observeExecution?.({
      phase: "submitted",
      generation: target.generation,
      provider: "other-provider",
      chat: initialChat,
      turnId: "other",
    });
    await app.fixture.emit({
      type: ActionType.ChatTurnStarted,
      turnId: "historical",
      startedAt: new Date().toISOString(),
      message: { text: "old user prompt", origin: { kind: MessageKind.User } },
    });
    await app.fixture.complete("historical", "old agent markdown");
    await app.native.getTurn(initialChat, "historical");
    expect(await verify()).toMatchObject({ status: "unknown" });
    await app.native.startTurn(initialChat, "empty", "user prompt");
    await app.fixture.emit({
      type: ActionType.ChatTurnComplete,
      turnId: "empty",
      duration: 0,
    });
    await app.native.getTurn(initialChat, "empty");
    expect(await verify()).toMatchObject({ status: "unknown" });
    await app.native.startTurn(initialChat, "cancelled", "user prompt");
    await app.native.cancelTurn(initialChat, "cancelled");
    await app.native.getTurn(initialChat, "cancelled");
    expect(await verify()).toMatchObject({ status: "unknown" });
    await app.native.startTurn(
      initialChat,
      "actual",
      "caller explicitly requests a normal Turn",
    );
    expect(await verify()).toMatchObject({ status: "unknown" });
    await app.fixture.complete("actual", "genuine agent markdown");
    await app.native.getTurn(initialChat, "actual");
    expect(await verify()).toEqual({ status: "authenticated" });
    app.service.select("a").auth.begin("reuse");
    await eventually(
      () => app.service.select("a").auth.get().status === "succeeded",
    );
    app.fixture.errors.set("subscribe", AhpErrorCodes.AuthRequired);
    app.service.select("a").auth.begin("reuse");
    await eventually(
      () => app.service.select("a").auth.get().status === "failed",
    );
    app.fixture.errors.delete("subscribe");
    expect(await verify()).toMatchObject({ status: "unknown" });
    await app.native.getTurn(initialChat, "actual");
    expect(await verify()).toMatchObject({ status: "unknown" });
  });

  it.each([
    [
      "--no-cwd serves only what --path names",
      "host_configuration_paths_required",
    ],
    ["listen EADDRINUSE private-directory", "host_port_in_use"],
    ["ERR_MODULE_NOT_FOUND private-module", "host_runtime_module_unavailable"],
  ])(
    "classifies startup failure without forwarding raw output: %s",
    async (message, code) => {
      const app = await setup();
      app.connect.mockRejectedValue(new Error("not yet listening"));
      app.launches.mockImplementation(function (this: ProcessOwner, value) {
        return app.originalSpawn.call(this, {
          ...value,
          command: process.execPath,
          args: [
            "-e",
            `process.stderr.write(${JSON.stringify(message)}); setTimeout(()=>process.exit(2),50)`,
          ],
        });
      });
      await expect(app.native.ensure()).rejects.toMatchObject({ code });
      expect(JSON.stringify(await app.native.view())).not.toContain("private-");
    },
  );
  it.each([
    ["prompt", "fixture-user", "succeeded"],
    ["prompt", "other-user", "failed"],
    ["prompt-no-receipt", "fixture-user", "failed"],
    ["premature-receipt", "fixture-user", "failed"],
    ["partial-receipt", "fixture-user", "failed"],
    ["receipt-failure", "fixture-user", "failed"],
  ])(
    "requires the complete native receipt, expected account and successful exit: %s/%s",
    async (scenario, account, expected) => {
      const app = await setup();
      app.native.config.options.loginAccount = account;
      app.native.config.authentication.push({
        id: "login",
        provider: "copilot",
        resource: COPILOT_RESOURCE,
        adapter: "copilot-cli",
        options: { mode: "login" },
      });
      app.launches.mockImplementation(function (this: ProcessOwner, value) {
        return app.originalSpawn.call(this, {
          ...value,
          command: process.execPath,
          args:
            value.command === "/usr/bin/script"
              ? [resolve("test", "copilot-login-fixture.mjs")]
              : ["-e", "setInterval(()=>{},1000)"],
          env: { ...value.env, LOGIN_SCENARIO: scenario },
        });
      });
      const auth = app.service.select("a").auth;
      auth.begin("login");
      await eventually(() => {
        const status = auth.get();
        return (
          status.status === "action_required" && status.step?.kind === "input"
        );
      });
      const current = auth.get();
      if (
        current.status !== "action_required" ||
        current.step?.kind !== "input"
      )
        throw new Error("expected input");
      auth.input(current.step.stepId, { confirmPlaintextStorage: "yes" });
      await eventually(() => auth.get().status === expected);
      expect(
        app.fixture.requests.some(
          (r) =>
            r.method === "authenticate" ||
            (r.method === "dispatchAction" &&
              r.params.channel !== "ahp-root://"),
        ),
      ).toBe(false);
    },
  );

  it("does not let a native receipt survive a target auth challenge during storage confirmation", async () => {
    const app = await setup();
    app.native.config.authentication.push({
      id: "login",
      provider: "copilot",
      resource: COPILOT_RESOURCE,
      adapter: "copilot-cli",
      options: { mode: "login" },
    });
    app.launches.mockImplementation(function (this: ProcessOwner, value) {
      return app.originalSpawn.call(this, {
        ...value,
        command: process.execPath,
        args:
          value.command === "/usr/bin/script"
            ? [resolve("test", "copilot-login-fixture.mjs")]
            : ["-e", "setInterval(()=>{},1000)"],
        env: { ...value.env, LOGIN_SCENARIO: "prompt" },
      });
    });
    const auth = app.service.select("a").auth;
    auth.begin("login");
    await eventually(() => {
      const status = auth.get();
      return (
        status.status === "action_required" && status.step?.kind === "input"
      );
    });
    const current = auth.get();
    if (current.status !== "action_required" || current.step?.kind !== "input")
      throw new Error("expected input");
    app.fixture.errors.set("subscribe", AhpErrorCodes.AuthRequired);
    await expect(app.native.root(app.native.connection())).rejects.toThrow();
    app.fixture.errors.delete("subscribe");
    auth.input(current.step.stepId, { confirmPlaintextStorage: "yes" });
    await eventually(() => auth.get().status === "failed");
    expect(auth.get()).toMatchObject({
      status: "failed",
      error: { code: "upstream_auth_required" },
    });
    const handle = app.native.connection();
    expect(
      await app.native.driver.verifyAuthentication(
        {
          hostId: "a",
          provider: "copilot",
          resource: COPILOT_RESOURCE,
          generation: handle.generation,
        },
        AbortSignal.timeout(1000),
      ),
    ).toMatchObject({ status: "unknown" });
  });

  it("cancels native storage interaction on reconnect without carrying a receipt into the new generation", async () => {
    const app = await setup();
    app.native.config.authentication.push(
      {
        id: "login",
        provider: "copilot",
        resource: COPILOT_RESOURCE,
        adapter: "copilot-cli",
        options: { mode: "login" },
      },
      {
        id: "reuse",
        provider: "copilot",
        resource: COPILOT_RESOURCE,
        adapter: "copilot-cli",
        options: { mode: "reuse" },
      },
    );
    app.launches.mockImplementation(function (this: ProcessOwner, value) {
      return app.originalSpawn.call(this, {
        ...value,
        command: process.execPath,
        args:
          value.command === "/usr/bin/script"
            ? [resolve("test", "copilot-login-fixture.mjs")]
            : ["-e", "setInterval(()=>{},1000)"],
        env: { ...value.env, LOGIN_SCENARIO: "prompt" },
      });
    });
    const auth = app.service.select("a").auth;
    auth.begin("login");
    await eventually(() => {
      const status = auth.get();
      return (
        status.status === "action_required" && status.step?.kind === "input"
      );
    });
    app.connect.mockRejectedValue(new Error("network disconnected"));
    await app.fixture.disconnect();
    await eventually(() => auth.get().status === "failed");
    expect(auth.get()).toMatchObject({
      status: "failed",
      error: { code: "auth_connection_changed" },
    });
    app.connect.mockImplementation(() =>
      Promise.resolve(app.fixture.transport() as WebSocketTransport),
    );
    await app.native.ensure();
    await eventually(() => {
      try {
        auth.begin("reuse");
        return true;
      } catch {
        return false;
      }
    });
    await eventually(() => auth.get().status === "failed");
    expect(auth.get()).toMatchObject({
      status: "failed",
      error: { code: "auth_verification_unsupported" },
    });
  });

  it("binds live native challenges to the host profile and reaps a timed-out authentication attempt", async () => {
    const app = await setup(1000);
    app.native.config.authentication.push({
      id: "login",
      provider: "copilot",
      resource: COPILOT_RESOURCE,
      adapter: "copilot-cli",
      options: { mode: "login" },
    });
    app.launches.mockImplementation(function (this: ProcessOwner, value) {
      return app.originalSpawn.call(this, {
        ...value,
        command: process.execPath,
        args:
          value.command === "/usr/bin/script"
            ? [resolve("test", "copilot-login-fixture.mjs")]
            : ["-e", "setInterval(()=>{},1000)"],
        env: { ...value.env, LOGIN_SCENARIO: "wait" },
      });
    });
    const auth = app.service.select("a").auth;
    auth.begin("login");
    await eventually(() => auth.get().status === "action_required");
    expect(auth.get()).toMatchObject({
      status: "action_required",
      step: {
        kind: "link",
        url: "https://github.com/login/device",
        userCode: "ABCD-EF12",
      },
    });
    await expect(app.native.stop()).rejects.toMatchObject({
      code: "host_busy",
    });
    await eventually(() => auth.get().status === "expired");
    await app.service.close();
    expect(auth.get()).toMatchObject({
      status: "expired",
      error: { code: "auth_expired" },
    });
    expect(app.launches.mock.calls[1]![0].env.COPILOT_HOME).toBe(
      app.host.options.copilotProfileDir,
    );
    expect(app.fixture.requests.some((r) => r.method === "authenticate")).toBe(
      false,
    );
  });

  it("preserves HTTP Turn identity, busy admission, explicit cancellation and follow-up over the same SDK connection", async () => {
    const app = await setup();
    const http = await serve(app.service);
    cleanups.push(() => http.close());
    const api = async (path: string, method = "GET", data?: unknown) =>
      fetch(`${http.url}${path}`, {
        method,
        ...(data === undefined
          ? {}
          : {
              headers: { "content-type": "application/json" },
              body: JSON.stringify(data),
            }),
      });
    expect((await api("/hosts/a/start", "POST")).status).toBe(202);
    await eventually(() => app.native.status === "ready");
    const session = await api("/hosts/a/sessions");
    expect(session.status).toBe(200);
    expect(await session.json()).toContainEqual({
      resource: initialSession,
      title: "Context",
      provider: "copilot",
    });
    const turn = {
      chat: initialChat,
      turnId: "http-exact",
      text: "caller prompt",
    };
    expect((await api("/hosts/a/turns", "POST", turn)).status).toBe(202);
    expect(
      (await api("/hosts/a/turns", "POST", { ...turn, turnId: "busy" })).status,
    ).toBe(409);
    expect(
      (
        await api("/hosts/a/turns/cancel", "POST", {
          chat: initialChat,
          turnId: "http-exact",
        })
      ).status,
    ).toBe(202);
    expect(
      await (
        await api(
          `/hosts/a/turns?chat=${encodeURIComponent(initialChat)}&turnId=http-exact`,
        )
      ).json(),
    ).toMatchObject({ state: "cancelled" });
    expect(
      (
        await api("/hosts/a/turns", "POST", {
          ...turn,
          turnId: "http-followup",
        })
      ).status,
    ).toBe(202);
    await app.fixture.complete("http-followup", "real fixture markdown");
    expect(
      await (
        await api(
          `/hosts/a/turns?chat=${encodeURIComponent(initialChat)}&turnId=http-followup`,
        )
      ).json(),
    ).toMatchObject({ state: "complete", text: "real fixture markdown" });
    expect(app.launches).toHaveBeenCalledTimes(1);
  });
});

function authContext(processes: ProcessOwner): AuthenticationContext {
  return {
    target: {
      hostId: "a",
      provider: "copilot",
      resource: COPILOT_RESOURCE,
      generation: 1,
    },
    expiresAt: new Date(Date.now() + 5000).toISOString(),
    processes,
    secrets: { resolve: () => Promise.reject(new Error("never read tokens")) },
    logger: { event() {} },
    publishStep() {},
    requestInput: () =>
      Promise.resolve({
        stepId: "choice",
        values: { confirmPlaintextStorage: "yes" },
      }),
    submitCredential: () => Promise.reject(new Error("never copy tokens")),
    verifyAuthentication: () => Promise.resolve({ status: "unknown" }),
  };
}

describe("native Copilot terminal bridge (synthetic child, no credentials)", () => {
  function login(
    scenario: string,
    answer = "yes",
    signal = AbortSignal.timeout(4000),
  ) {
    const owner = new ProcessOwner();
    cleanups.push(() => owner.close());
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const spawn = owner.spawn;
    const calls = vi.spyOn(owner, "spawn").mockImplementation((value) =>
      spawn.call(owner, {
        ...value,
        command: process.execPath,
        args: [resolve("test", "copilot-login-fixture.mjs")],
        env: { ...value.env, LOGIN_SCENARIO: scenario },
      }),
    );
    const context = authContext(owner);
    const publish = vi.spyOn(context, "publishStep");
    const input = vi.spyOn(context, "requestInput").mockResolvedValue({
      stepId: "choice",
      values: { confirmPlaintextStorage: answer },
    });
    const work = nativeCopilotLogin(
      context,
      "/explicit/copilot's cli",
      ahpdEnvironment(resolve(".test-state"), "/explicit/profile"),
      signal,
      "linux",
    );
    return { work, calls, publish, input };
  }
  it("publishes chunked device challenge and obtains explicit yes before writing stdin, without recording output", async () => {
    const run = login("prompt");
    expect(await run.work).toEqual({
      authenticated: true,
      account: "fixture-user",
    });
    expect(run.publish).toHaveBeenCalledWith({
      kind: "link",
      url: "https://github.com/login/device",
      userCode: "ABCD-EF12",
    });
    expect(run.input).toHaveBeenCalledWith(
      { kind: "input", fields: ["confirmPlaintextStorage"] },
      expect.any(AbortSignal),
    );
    expect(run.calls.mock.calls[0]![0]).toMatchObject({
      command: "/usr/bin/script",
      input: "pipe",
    });
    expect(run.calls.mock.calls[0]![0].args).toContain("/dev/null");
    expect(run.calls.mock.calls[0]![0].args.join(" ")).toContain("'\\''");
  });
  it("does not auto-confirm plaintext, never forwards raw failure, caps output, cancels and times out", async () => {
    for (const [scenario, answer, expected] of [
      ["prompt", "no", "auth_storage_declined"],
      ["failure", "yes", "auth_cli_failed"],
      ["overflow", "yes", "auth_cli_invalid_response"],
    ]) {
      const run = login(scenario!, answer);
      await expect(run.work).rejects.toMatchObject({ code: expected });
      expect(JSON.stringify(run.publish.mock.calls)).not.toContain("gh_fake");
    }
    const abort = new AbortController();
    const run = login("wait", "yes", abort.signal);
    await eventually(() => run.publish.mock.calls.length === 1);
    abort.abort();
    await expect(run.work).rejects.toThrow();
    const timed = login("wait", "yes", AbortSignal.timeout(80));
    await expect(timed.work).rejects.toThrow();
    const zero = login("success");
    expect(await zero.work).toEqual({ authenticated: false });
    expect(zero.publish).not.toHaveBeenCalled();
  });
  it("reports unsupported terminal platforms and missing script explicitly", async () => {
    const owner = new ProcessOwner();
    cleanups.push(() => owner.close());
    const context = authContext(owner);
    await expect(
      nativeCopilotLogin(
        context,
        "copilot",
        {},
        AbortSignal.timeout(100),
        "win32",
      ),
    ).rejects.toMatchObject({ code: "auth_native_pty_unsupported" });
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const spawn = owner.spawn;
    vi.spyOn(owner, "spawn").mockImplementation((value) =>
      spawn.call(owner, { ...value, command: resolve("missing-script.exe") }),
    );
    await expect(
      nativeCopilotLogin(
        context,
        "copilot",
        {},
        AbortSignal.timeout(1000),
        "linux",
      ),
    ).rejects.toMatchObject({ code: "auth_cli_unavailable" });
    await mkdir(resolve(".test-state"), { recursive: true });
  });
});
