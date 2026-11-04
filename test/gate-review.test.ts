import { afterEach, describe, expect, it, vi } from "vitest";
import type { AhpTransport } from "@microsoft/agent-host-protocol/client";
import { record } from "../src/common.js";
import { config, eventually, harness } from "./fixture.js";

type Harness = Awaited<ReturnType<typeof harness>>;
let app: Harness | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function loginConfig() {
  const input = config(["a"]);
  const host = input.hosts[0];
  if (host === undefined) throw new Error("Missing host");
  host.authentication.push({
    id: "login",
    provider: "test-provider",
    resource: "https://api.github.com",
    adapter: "ahp-token",
    options: {
      credential: { source: "env", name: "AHPLEX_GATE_FIXTURE_TOKEN" },
    },
  });
  return input;
}

function rejectAuthentication(transport: AhpTransport): AhpTransport {
  let authenticateId: unknown;
  return {
    async send(message) {
      const request: unknown =
        typeof message === "string" ? JSON.parse(message) : message;
      if (record(request) && request.method === "authenticate")
        authenticateId = request.id;
      await transport.send(message);
    },
    async recv() {
      const frame = await transport.recv();
      if (frame === null) return null;
      const message: unknown =
        frame.kind === "parsed"
          ? frame.message
          : frame.kind === "text"
            ? JSON.parse(frame.text)
            : JSON.parse(Buffer.from(frame.data).toString("utf8"));
      if (
        authenticateId !== undefined &&
        record(message) &&
        message.id === authenticateId &&
        Object.hasOwn(message, "result")
      )
        return {
          kind: "text",
          text: JSON.stringify({
            ...message,
            result: { authenticated: false },
          }),
        };
      return frame;
    },
    close: () => transport.close(),
  };
}

describe("coordinating-agent acceptance regressions", () => {
  it("does not interpret an explicit authenticated=false result as login success", async () => {
    vi.stubEnv("AHPLEX_GATE_FIXTURE_TOKEN", "gate-fixture-only");
    app = await harness(loginConfig());
    const original = app.host().transport.bind(app.host());
    vi.spyOn(app.host(), "transport").mockImplementation(() =>
      rejectAuthentication(original()),
    );
    expect(
      (await app.api("/hosts/a/auth", "POST", { methodId: "login" })).status,
    ).toBe(202);
    await eventually(() => {
      const status = app?.service.select("a").auth.get().status;
      return status === "succeeded" || status === "failed";
    });
    expect((await app.api("/hosts/a/auth")).body).toMatchObject({
      status: "failed",
      methodId: "login",
      error: { code: "upstream_auth_required" },
    });
  });

  it("can authenticate a connected host whose session catalogue requires login", async () => {
    vi.stubEnv("AHPLEX_GATE_FIXTURE_TOKEN", "gate-fixture-only");
    app = await harness(loginConfig());
    app.host().errors.set("listSessions", -32007);
    expect((await app.api("/hosts/a/start", "POST")).status).toBe(202);
    await eventually(() => {
      const status = app?.service.select("a").native.status;
      return status === "ready" || status === "failed";
    });
    expect(app.service.select("a").native.status).toBe("ready");
    expect((await app.api("/hosts/a/sessions")).body).toMatchObject({
      error: { code: "upstream_auth_required" },
    });
    expect(
      (await app.api("/hosts/a/auth", "POST", { methodId: "login" })).status,
    ).toBe(202);
    await eventually(
      () => app?.service.select("a").auth.get().status === "succeeded",
    );
    expect(app.host().connections).toBe(1);
    expect(
      app
        .host()
        .requests.filter((request) => request.method === "authenticate"),
    ).toHaveLength(1);
  });
});
