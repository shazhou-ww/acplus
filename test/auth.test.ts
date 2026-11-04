import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionType } from "@microsoft/agent-host-protocol";
import { Authentication } from "../src/authentication.js";
import { deviceFactory } from "../src/auth-adapters.js";
import { objectSchema } from "../src/config.js";
import {
  AdapterRegistry,
  codec,
  type AuthenticationAdapter,
  type AuthenticationContext,
} from "../src/extensions.js";
import { ProcessOwner } from "../src/processes.js";
import { config, eventually, harness } from "./fixture.js";

type Harness = Awaited<ReturnType<typeof harness>>;
let app: Harness | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function authConfig(
  adapter = "ahp-token",
  options: Record<string, unknown> = {
    credential: { source: "env", name: "AHPLEX_FIXTURE_TOKEN" },
  },
) {
  const input = config(["a"]);
  const host = input.hosts[0];
  if (host === undefined) throw new Error();
  host.authentication.push({
    id: "login",
    provider: "test-provider",
    resource: "https://api.github.com",
    adapter,
    options,
  });
  return input;
}

function plugin(run: AuthenticationAdapter["run"]): AdapterRegistry {
  const registry = new AdapterRegistry();
  registry.addAuthenticationAdapter({
    id: "input-test",
    options: codec(objectSchema({})),
    create: () => ({ run }),
  });
  return registry;
}

describe("host-scoped upstream authentication", () => {
  it("does not start on GET, only advertises bindings, and verifies token on the actual service connection", async () => {
    vi.stubEnv("AHPLEX_FIXTURE_TOKEN", "test-token-never-returned");
    app = await harness(authConfig());
    expect((await app.api("/hosts/a/auth")).body).toEqual({ status: "idle" });
    expect(app.host().starts).toBe(0);
    expect((await app.api("/hosts")).body).toEqual([
      {
        hostId: "a",
        status: "idle",
        authMethods: [
          {
            methodId: "login",
            provider: "test-provider",
            resource: "https://api.github.com",
          },
        ],
      },
    ]);
    expect(
      (await app.api("/hosts/a/auth", "POST", { methodId: "missing" })).status,
    ).toBe(404);
    expect(
      (await app.api("/hosts/a/auth", "POST", { methodId: "login" })).status,
    ).toBe(202);
    await eventually(
      () => app?.service.select("a").auth.get().status === "succeeded",
    );
    const request = app
      .host()
      .requests.find((item) => item.method === "authenticate");
    expect(request?.params).toEqual({
      channel: "ahp-root://",
      resource: "https://api.github.com",
      token: "test-token-never-returned",
    });
    expect(app.host().connections).toBe(1);
    expect((await app.api("/hosts/a/auth")).body).toEqual({
      status: "succeeded",
      methodId: "login",
    });
    app.host().connectDelay = 100;
    await app.host().disconnect();
    await eventually(
      () => app?.service.select("a").auth.get().status === "idle",
    );
    await eventually(() => app?.service.select("a").native.status === "ready");
    expect(
      app.host().requests.filter((item) => item.method === "authenticate"),
    ).toHaveLength(1);
  });

  it("rejects concurrent attempts and stale/extra input without logging values", async () => {
    const registry = plugin(async (context, signal) => {
      const input = await context.requestInput(
        { kind: "input", fields: ["token", "state"] },
        signal,
      );
      if (input.values.state !== "expected")
        throw new Error("sensitive failed callback");
      await context.submitCredential(
        { token: input.values.token ?? "" },
        signal,
      );
    });
    app = await harness(authConfig("input-test", {}), { registry });
    await app.api("/hosts/a/auth", "POST", { methodId: "login" });
    await eventually(
      () => app?.service.select("a").auth.get().status === "action_required",
    );
    const status = app.service.select("a").auth.get();
    if (status.status !== "action_required" || status.step?.kind !== "input")
      throw new Error();
    expect(
      (await app.api("/hosts/a/auth", "POST", { methodId: "login" })).body,
    ).toMatchObject({ error: { code: "auth_in_progress" } });
    expect((await app.api("/hosts/a/stop", "POST")).body).toMatchObject({
      error: { code: "host_busy" },
    });
    for (const data of [
      { stepId: "stale", values: { token: "secret", state: "expected" } },
      { stepId: status.step.stepId, values: { token: "secret" } },
      {
        stepId: status.step.stepId,
        values: { token: "secret", state: "expected", extra: "x" },
      },
    ])
      expect((await app.api("/hosts/a/auth/input", "POST", data)).status).toBe(
        409,
      );
    expect(
      (
        await app.api("/hosts/a/auth/input", "POST", {
          stepId: status.step.stepId,
          values: { token: "secret", state: "expected" },
        })
      ).status,
    ).toBe(202);
    await eventually(
      () => app?.service.select("a").auth.get().status === "succeeded",
    );
    expect(app.service.redactor.clean("the secret")).toBe("the [redacted]");
    await app.api("/hosts/a/auth", "POST", { methodId: "login" });
    await eventually(
      () => app?.service.select("a").auth.get().status === "action_required",
    );
    expect(
      (
        await app.api("/hosts/a/auth/input", "POST", {
          stepId: status.step.stepId,
          values: { token: "secret", state: "expected" },
        })
      ).status,
    ).toBe(409);
  });

  it("expires input attempts, ignores late completion, and cancels on shutdown", async () => {
    let context: AuthenticationContext | undefined;
    let resumed = false;
    const registry = plugin(async (value, signal) => {
      context = value;
      await value.requestInput({ kind: "input", fields: ["token"] }, signal);
      resumed = true;
    });
    app = await harness(authConfig("input-test", {}), {
      registry,
      authTimeoutMs: 60,
    });
    await app.api("/hosts/a/auth", "POST", { methodId: "login" });
    await eventually(
      () => app?.service.select("a").auth.get().status === "expired",
    );
    expect(resumed).toBe(false);
    expect(() =>
      context?.publishStep({ kind: "link", url: "https://example.com" }),
    ).toThrow();
    await app.api("/hosts/a/auth", "POST", { methodId: "login" });
    await eventually(
      () => app?.service.select("a").auth.get().status === "action_required",
    );
    await app.service.select("a").auth.close();
    expect(app.service.select("a").auth.get().status).toBe("failed");
  });

  it("fails rejected tokens, absent provisioning, and unadvertised targets without leaking diagnostics", async () => {
    app = await harness(authConfig());
    await app.api("/hosts/a/auth", "POST", { methodId: "login" });
    await eventually(
      () => app?.service.select("a").auth.get().status === "failed",
    );
    expect((await app.api("/hosts/a/auth")).body).toMatchObject({
      error: { code: "credential_unavailable" },
    });
    vi.stubEnv("AHPLEX_FIXTURE_TOKEN", "provided-token");
    app.host().errors.set("authenticate", -32007);
    await app.api("/hosts/a/auth", "POST", { methodId: "login" });
    await eventually(
      () => app?.service.select("a").auth.get().status === "failed",
    );
    expect((await app.api("/hosts/a/auth")).body).toMatchObject({
      error: { code: "upstream_auth_required" },
    });
    app.host().root.agents = [];
    await app.api("/hosts/a/auth", "POST", { methodId: "login" });
    await eventually(
      () => app?.service.select("a").auth.get().status === "failed",
    );
    expect((await app.api("/hosts/a/auth")).body).toMatchObject({
      error: { code: "auth_target_not_advertised" },
    });
  });

  it("does not accept an adapter's return or an unknown verification as authentication", async () => {
    app = await harness(authConfig("input-test", {}), {
      registry: plugin(async () => {
        await Promise.resolve();
      }),
    });
    await app.api("/hosts/a/auth", "POST", { methodId: "login" });
    await eventually(
      () => app?.service.select("a").auth.get().status === "failed",
    );
    expect((await app.api("/hosts/a/auth")).body).toMatchObject({
      error: { code: "auth_verification_unsupported" },
    });
  });

  it("rejects invalid input steps and invalid credential expiry, and clears known expiry", async () => {
    let mode = "invalid";
    const registry = plugin(async (context, signal) => {
      if (mode === "invalid")
        await context.requestInput({ kind: "input", fields: [] }, signal);
      else
        await context.submitCredential(
          {
            token: "tok",
            expiresAt:
              mode === "expired"
                ? "invalid"
                : new Date(Date.now() + 40).toISOString(),
          },
          signal,
        );
    });
    app = await harness(authConfig("input-test", {}), { registry });
    for (const next of ["invalid", "expired", "valid"]) {
      mode = next;
      await app.api("/hosts/a/auth", "POST", { methodId: "login" });
      await eventually(() =>
        ["failed", "succeeded"].includes(
          app?.service.select("a").auth.get().status ?? "",
        ),
      );
      expect(app.service.select("a").auth.get().status).toBe(
        next === "valid" ? "succeeded" : "failed",
      );
    }
    await eventually(
      () => app?.service.select("a").auth.get().status === "idle",
    );
  });

  it("never revives a connection-bound attempt after reconnect", async () => {
    app = await harness(authConfig("input-test", {}), {
      registry: plugin(async (context, signal) => {
        await context.requestInput({ kind: "input", fields: ["code"] }, signal);
      }),
    });
    await app.api("/hosts/a/auth", "POST", { methodId: "login" });
    await eventually(
      () => app?.service.select("a").auth.get().status === "action_required",
    );
    await app.host().disconnect();
    await eventually(
      () => app?.service.select("a").auth.get().status === "failed",
    );
  });

  it("validates malformed input bodies and keeps authentication out of execution", async () => {
    app = await harness(authConfig());
    expect(
      (
        await app.api("/hosts/a/auth/input", "POST", {
          stepId: "x",
          values: { x: 1 },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await app.api("/hosts/a/auth/input", "POST", {
          stepId: "x",
          values: {},
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await app.api("/hosts/a/auth/input", "POST", {
          stepId: "x",
          values: { x: "s" },
        })
      ).status,
    ).toBe(409);
    await app.ready();
    expect(
      app
        .host()
        .requests.some(
          (request) => request.params.action === ActionType.ChatTurnStarted,
        ),
    ).toBe(false);
    expect(Authentication).toBeDefined();
  });

  it("invalidates successful auth on an upstream challenge, including known token expiry", async () => {
    vi.stubEnv("AHPLEX_FIXTURE_TOKEN", "provided-token");
    app = await harness(authConfig());
    await app.api("/hosts/a/auth", "POST", { methodId: "login" });
    await eventually(
      () => app?.service.select("a").auth.get().status === "succeeded",
    );
    for (const peer of app.host().peers)
      await peer.transport.send({
        jsonrpc: "2.0",
        method: "auth/required",
        params: {
          channel: "ahp-root://",
          resource: { resource: "https://api.github.com" },
          reason: "expired",
        },
      });
    await eventually(
      () => app?.service.select("a").auth.get().status === "idle",
    );
    expect(
      app
        .host()
        .requests.filter((request) => request.method === "authenticate"),
    ).toHaveLength(1);
  });

  it("enforces generation checks, invalid link/input steps, and verified host-side login", async () => {
    let mode = "link";
    const registry = plugin(async (context, signal) => {
      if (mode === "link")
        context.publishStep({ kind: "link", url: "file:///unsafe" });
      else if (mode === "duplicate")
        await context.requestInput(
          { kind: "input", fields: ["same", "same"] },
          signal,
        );
      else if (mode === "empty")
        await context.submitCredential({ token: "" }, signal);
      else if (mode === "verify") await context.verifyAuthentication(signal);
    });
    app = await harness(authConfig("input-test", {}), { registry });
    for (const next of ["link", "duplicate", "empty"]) {
      mode = next;
      await app.api("/hosts/a/auth", "POST", { methodId: "login" });
      await eventually(
        () => app?.service.select("a").auth.get().status === "failed",
      );
    }
    expect(() => app?.service.select("a").native.connection(999)).toThrow(
      "auth connection changed",
    );
    vi.spyOn(
      app.service.select("a").native.driver,
      "verifyAuthentication",
    ).mockResolvedValue({ status: "required" });
    mode = "verify";
    await app.api("/hosts/a/auth", "POST", { methodId: "login" });
    await eventually(
      () => app?.service.select("a").auth.get().status === "failed",
    );
    expect((await app.api("/hosts/a/auth")).body).toMatchObject({
      error: { code: "upstream_auth_required" },
    });
  });

  it("supports verified transport login without preparing a provider and rejects provider tokens for transport", async () => {
    const input = authConfig("input-test", {});
    const binding = input.hosts[0]?.authentication[0];
    if (binding === undefined) throw new Error();
    binding.provider = "$host";
    let submit = true;
    app = await harness(input, {
      registry: plugin(async (context, signal) => {
        if (submit) await context.submitCredential({ token: "token" }, signal);
        else await context.verifyAuthentication(signal);
      }),
    });

    await app.api("/hosts/a/auth", "POST", { methodId: "login" });
    await eventually(
      () => app?.service.select("a").auth.get().status === "failed",
    );
    expect((await app.api("/hosts/a/auth")).body).toMatchObject({
      error: { code: "auth_target_unsupported" },
    });
    expect(app.host().starts).toBe(0);
    submit = false;
    vi.spyOn(
      app.service.select("a").native.driver,
      "verifyAuthentication",
    ).mockResolvedValue({ status: "authenticated" });
    await app.api("/hosts/a/auth", "POST", { methodId: "login" });
    await eventually(
      () => app?.service.select("a").auth.get().status === "succeeded",
    );
  });
  it("reports credential expiry and retains attempt admission on cleanup failure", async () => {
    let expired = true;
    app = await harness(authConfig("input-test", {}), {
      registry: plugin(async (context, signal) => {
        await context.submitCredential(
          {
            token: "explicit-token",
            ...(expired
              ? { expiresAt: new Date(Date.now() - 1000).toISOString() }
              : {}),
          },
          signal,
        );
      }),
    });
    await app.api("/hosts/a/auth", "POST", { methodId: "login" });
    await eventually(
      () => app?.service.select("a").auth.get().status === "expired",
    );
    expired = false;
    vi.spyOn(ProcessOwner.prototype, "close").mockRejectedValueOnce(
      new Error("cleanup"),
    );
    await app.api("/hosts/a/auth", "POST", { methodId: "login" });
    await eventually(
      () => app?.service.select("a").auth.get().status === "failed",
    );
    expect((await app.api("/hosts/a/auth")).body).toMatchObject({
      error: { code: "auth_cleanup_failed" },
    });
    expect(
      (await app.api("/hosts/a/auth", "POST", { methodId: "login" })).status,
    ).toBe(409);
  });
});

it.each([
  [{ authenticated: true }, "succeeded"],
  [{ authenticated: false }, "failed"],
  [{ authenticated: "true" }, "failed"],
  [{ unsupported: true }, "failed"],
  [null, "failed"],
])(
  "requires a protocol-defined positive authentication result",
  async (result, expected) => {
    vi.stubEnv("AHPLEX_FIXTURE_TOKEN", "test-token");
    app = await harness(authConfig());
    app.host().authenticationResult = result;
    await app.api("/hosts/a/auth", "POST", { methodId: "login" });
    await eventually(() =>
      ["failed", "succeeded"].includes(
        app?.service.select("a").auth.get().status ?? "",
      ),
    );
    expect(app.service.select("a").auth.get().status).toBe(expected);
  },
);

describe("configured GitHub device authorization", () => {
  const options = { clientId: "deployment-client", scopes: ["read:user"] };
  function context(): AuthenticationContext {
    return {
      target: {
        hostId: "a",
        provider: "test-provider",
        resource: "https://api.github.com",
      },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      secrets: { resolve: () => Promise.reject(new Error("not used")) },
      processes: new ProcessOwner(),
      logger: { event: () => {} },
      publishStep: vi.fn(),
      requestInput: () => Promise.reject(new Error("not used")),
      submitCredential: vi.fn<AuthenticationContext["submitCredential"]>(() =>
        Promise.resolve({ status: "authenticated" }),
      ),
      verifyAuthentication: () => Promise.resolve({ status: "authenticated" }),
    };
  }
  function mockOAuth(
    token: unknown,
    device: unknown = {
      device_code: "private-device",
      user_code: "USER-CODE",
      verification_uri: "https://github.com/login/device",
      interval: 1,
      expires_in: 60,
    },
  ) {
    return vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json(device))
      .mockResolvedValueOnce(Response.json(token));
  }
  it("uses only the configured OAuth app and submits the result through its bound context", async () => {
    const ctx = context();
    const fetch = mockOAuth({
      access_token: "explicit-token",
      token_type: "bearer",
      scope: "read:user",
      expires_in: 3600,
    });
    await deviceFactory.create(options).run(ctx, new AbortController().signal);
    const published = vi.spyOn(ctx, "publishStep");
    expect(published).toHaveBeenCalledWith({
      kind: "link",
      url: "https://github.com/login/device",
      userCode: "USER-CODE",
    });
    const submitted = vi.spyOn(ctx, "submitCredential");
    expect(submitted).toHaveBeenCalledWith(
      expect.objectContaining({
        token: "explicit-token",
        scopes: ["read:user"],
      }),
      expect.any(AbortSignal),
    );
    const body = fetch.mock.calls[0]?.[1]?.body;
    expect(body instanceof URLSearchParams ? body.toString() : "").toContain(
      "client_id=deployment-client",
    );
  });
  it.each([
    [{ error: "access_denied" }, "auth_authorization_denied"],
    [{ error: "expired_token" }, "auth_expired"],
    [{ access_token: "", token_type: "bearer" }, "auth_invalid_response"],
    [
      { access_token: "token", token_type: "bearer", scope: "" },
      "auth_scope_missing",
    ],
    [
      { access_token: "token", token_type: "bearer", expires_in: -1 },
      "auth_invalid_response",
    ],
  ])(
    "rejects OAuth errors and missing granted scope",
    async (response, code) => {
      mockOAuth(response);
      await expect(
        deviceFactory
          .create(options)
          .run(context(), new AbortController().signal),
      ).rejects.toMatchObject({ code });
    },
  );
  it("rejects untrusted verification destinations, invalid payloads, and target mismatch", async () => {
    const ctx = context();
    ctx.target.resource = "https://other.invalid";
    await expect(
      deviceFactory.create(options).run(ctx, new AbortController().signal),
    ).rejects.toMatchObject({ code: "auth_target_unsupported" });
    mockOAuth({}, {});
    await expect(
      deviceFactory
        .create(options)
        .run(context(), new AbortController().signal),
    ).rejects.toMatchObject({ code: "auth_invalid_response" });
    vi.restoreAllMocks();
    mockOAuth(
      {},
      {
        device_code: "device",
        user_code: "user",
        verification_uri: "https://evil.invalid",
        interval: 1,
        expires_in: 60,
      },
    );
    await expect(
      deviceFactory
        .create(options)
        .run(context(), new AbortController().signal),
    ).rejects.toMatchObject({ code: "auth_invalid_response" });
  });
  it("honors abort and finite device deadlines", async () => {
    mockOAuth(
      {},
      {
        device_code: "device",
        user_code: "user",
        verification_uri: "https://github.com/login/device",
        interval: 1,
        expires_in: 0.02,
      },
    );
    await expect(
      deviceFactory
        .create(options)
        .run(context(), new AbortController().signal),
    ).rejects.toMatchObject({ code: "auth_expired" });
    vi.restoreAllMocks();
    mockOAuth({});
    const controller = new AbortController();
    const running = deviceFactory
      .create(options)
      .run(context(), controller.signal);
    controller.abort();
    await expect(running).rejects.toThrow();
  });

  it("honors authorization_pending/slow_down and rejects failed authorization-server HTTP responses", async () => {
    const fetch = mockOAuth({ error: "authorization_pending" });
    fetch.mockResolvedValueOnce(Response.json({ error: "slow_down" }));
    fetch.mockResolvedValueOnce(
      Response.json({
        access_token: "token",
        token_type: "bearer",
        scope: "read:user",
      }),
    );
    await deviceFactory
      .create(options)
      .run(context(), new AbortController().signal);
    expect(fetch).toHaveBeenCalledTimes(4);
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 500 }),
    );
    await expect(
      deviceFactory
        .create(options)
        .run(context(), new AbortController().signal),
    ).rejects.toMatchObject({ code: "auth_server_unavailable" });
  }, 15_000);
});
