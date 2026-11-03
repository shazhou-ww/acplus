import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeHost } from "@softov/ahpc/dist/src/ahp/fake.js";
import {
  liveHost,
  type LiveHostOptions,
} from "@softov/ahpc/dist/src/ahp/live.js";
import { serve } from "@softov/ahpc/dist/src/mcp/http.js";
import { TOOLS, type Tool } from "@softov/ahpc/dist/src/mcp/tools.js";
import { until } from "@softov/ahpc/dist/src/wait.js";
import { runAdapter } from "../src/adapter-worker.js";
import type * as NodeModule from "node:module";
import type * as WaitModule from "@softov/ahpc/dist/src/wait.js";

vi.mock("node:module", async (original) => ({
  ...(await original<typeof NodeModule>()),
  register: vi.fn(),
}));
vi.mock("@softov/ahpc/dist/src/ahp/live.js", () => ({ liveHost: vi.fn() }));
vi.mock("@softov/ahpc/dist/src/mcp/http.js", () => ({ serve: vi.fn() }));
vi.mock("@softov/ahpc/dist/src/wait.js", async (original) => ({
  ...(await original<typeof WaitModule>()),
  until: vi.fn(),
}));

const originalTools = TOOLS.map((tool) => ({ ...tool }));
const originalDisconnect = new Set(process.listeners("disconnect"));
let options: LiveHostOptions | undefined;
let host: ReturnType<typeof fakeHost> & { close(): Promise<void> };
let authenticate: ReturnType<
  typeof vi.fn<(resource: string, token: string) => Promise<void>>
>;

function tool(name: string): Tool {
  const found = TOOLS.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`Missing fixture tool ${name}`);
  return found;
}

beforeEach(() => {
  TOOLS.splice(
    0,
    TOOLS.length,
    ...originalTools.map((entry) => ({ ...entry })),
  );
  authenticate = vi
    .fn<(resource: string, token: string) => Promise<void>>()
    .mockResolvedValue(undefined);
  host = {
    ...fakeHost(),
    authenticate,
    close: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };
  vi.spyOn(host, "state").mockReturnValue("connected");
  vi.mocked(liveHost).mockImplementation(async (input) => {
    options = input;
    await input.onConnected?.(host);
    return host;
  });
  vi.mocked(serve).mockResolvedValue({
    host: "127.0.0.1",
    port: 43210,
    close: () => Promise.resolve(),
  });
  vi.mocked(until).mockResolvedValue({
    type: "snapshot",
    turns: [],
    status: 1,
    queued: [],
    draft: "",
  });
});

afterEach(() => {
  for (const listener of process.listeners("disconnect")) {
    if (!originalDisconnect.has(listener))
      process.removeListener("disconnect", listener);
  }
  vi.restoreAllMocks();
  options = undefined;
  TOOLS.splice(
    0,
    TOOLS.length,
    ...originalTools.map((entry) => ({ ...entry })),
  );
});

const config = {
  url: "ws://127.0.0.1:43211",
  instance: "test",
  connectionToken: "fixture-connection",
  apiToken: "fixture-adapter",
};

describe("ahpc worker integration with explicit test HostConnection", () => {
  it("forwards creation and execution without an ahplex provider credential gate", async () => {
    await runAdapter(config);
    expect(liveHost).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: "ahplex-test" }),
    );
    expect(serve).toHaveBeenCalledWith(
      host,
      expect.objectContaining({ name: "ahplex" }),
    );
    expect(await tool("hub_status").run(host, {})).toMatchObject({
      authentication: "backend",
      instance: "test",
    });
    const create = vi.spyOn(host, "createSession").mockResolvedValue("test:/1");
    await expect(
      tool("new_session").run(host, {
        provider: "test",
        workingDirectory: process.cwd(),
      }),
    ).resolves.toMatchObject({ session: "test:/1" });
    expect(create).toHaveBeenCalled();
    await expect(
      tool("hub_start_turn").run(host, {
        session: "test:/1",
        text: "a",
        turnId: "one",
      }),
    ).resolves.toEqual({ id: "one" });
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("authenticates only the supplied resource and starts the caller's exact turn ID", async () => {
    await runAdapter({
      ...config,
      authResource: "https://resource.example",
      authToken: "fixture-provider",
    });
    expect(authenticate).toHaveBeenCalledWith(
      "https://resource.example",
      "fixture-provider",
    );
    const say = vi.spyOn(host, "say").mockImplementation(() => {});
    expect(
      await tool("hub_start_turn").run(host, {
        session: "test:/1",
        text: "a",
        turnId: "one",
      }),
    ).toEqual({ id: "one" });
    expect(say).toHaveBeenCalledWith("test:/1", "a", undefined, "one");
    const cancel = vi.spyOn(host, "stopTurn").mockImplementation(() => {});
    await tool("hub_cancel_turn").run(host, {
      session: "test:/1",
      turnId: "one",
    });
    expect(cancel).toHaveBeenCalledWith("test:/1", "one");
    options?.onAuthRequired?.([]);
    expect(await tool("hub_status").run(host, {})).toMatchObject({
      authentication: "required",
    });
    options?.onAuthRequired?.([], "expired");
    await options?.onConnected?.(host);
    expect(authenticate).toHaveBeenCalledOnce();
  });

  it("refuses busy, silent, refused and offline sessions without sending another turn", async () => {
    await runAdapter({
      ...config,
      authResource: "https://resource.example",
      authToken: "fixture-provider",
    });
    const input = { session: "test:/1", text: "a", turnId: "one" };
    vi.mocked(until).mockResolvedValue(undefined);
    await expect(tool("hub_start_turn").run(host, input)).rejects.toThrow(
      "session_unavailable",
    );
    vi.mocked(until).mockResolvedValue({
      type: "snapshot",
      turns: [],
      status: 8,
      queued: [],
      draft: "",
      active: {
        id: "other",
        role: "agent",
        state: "running",
        at: "",
        parts: [],
      },
    });
    await expect(tool("hub_start_turn").run(host, input)).rejects.toThrow(
      "session_busy",
    );
    vi.mocked(until).mockResolvedValue({
      type: "snapshot",
      turns: [],
      status: 1,
      queued: [],
      draft: "",
    });
    options?.onRefusal?.("test:/1", "fixture refusal");
    await expect(tool("hub_start_turn").run(host, input)).rejects.toThrow(
      "session_refused",
    );
    await expect(tool("session_history").run(host, input)).rejects.toThrow(
      "session_refused",
    );
    vi.spyOn(host, "state").mockReturnValue("offline");
    await expect(tool("hub_start_turn").run(host, input)).rejects.toThrow(
      "host_unavailable",
    );
    expect(await tool("hub_status").run(host, {})).toMatchObject({
      status: "unavailable",
    });
  });

  it("does not claim authentication succeeded after credential refusal", async () => {
    if (host.authenticate === undefined)
      throw new Error("Missing fixture authenticate");
    vi.spyOn(host, "authenticate").mockRejectedValue(
      new Error("fixture refusal"),
    );
    await runAdapter({
      ...config,
      authResource: "https://resource.example",
      authToken: "fixture-provider",
    });
    expect(await tool("hub_status").run(host, {})).toMatchObject({
      authentication: "required",
    });
  });

  it("reports native backend auth requirements without leaking backend error text", async () => {
    await runAdapter(config);
    vi.spyOn(host, "createSession").mockRejectedValue(
      Object.assign(new Error("backend secret must not escape"), {
        code: -32007,
        data: { resources: [{ resource: "https://resource.example" }] },
      }),
    );
    await expect(
      tool("new_session").run(host, { provider: "test" }),
    ).rejects.toThrow("backend_authentication_required");
    expect(await tool("hub_status").run(host, {})).toMatchObject({
      authentication: "required",
    });
    expect(await tool("hub_status").run(host, {})).toHaveProperty(
      "action",
      expect.stringContaining("native authorization"),
    );
    options?.onRefusal?.("test:/auth", "Backend token refused (-32007)");
    await expect(
      tool("session_history").run(host, { session: "test:/auth" }),
    ).rejects.toThrow("backend_authentication_required");
    vi.spyOn(host, "createSession").mockResolvedValue("test:/recovered");
    await expect(
      tool("new_session").run(host, { provider: "test" }),
    ).resolves.toEqual({ session: "test:/recovered" });
  });

  it("normalizes unexpected backend failures and checks connectivity for cancellation", async () => {
    await runAdapter(config);
    vi.spyOn(host, "createSession").mockRejectedValue(
      new Error("provider secret"),
    );
    await expect(
      tool("new_session").run(host, { provider: "test" }),
    ).rejects.toThrow("backend_request_failed");
    vi.spyOn(host, "createSession").mockRejectedValue(
      Object.assign(new Error("unsupported secret text"), { code: -32601 }),
    );
    await expect(
      tool("new_session").run(host, { provider: "test" }),
    ).rejects.toThrow("backend_capability_unsupported");
    vi.spyOn(host, "state").mockReturnValue("offline");
    await expect(
      tool("hub_cancel_turn").run(host, {
        session: "test:/1",
        turnId: "one",
      }),
    ).rejects.toThrow("host_unavailable");
    await expect(tool("list_agents").run(host, {})).rejects.toThrow(
      "host_unavailable",
    );
  });

  it("does not require the optional upstream credential-delivery capability", async () => {
    delete host.authenticate;
    await runAdapter({
      ...config,
      authResource: "https://resource.example",
      authToken: "fixture",
    });
    expect(await tool("hub_status").run(host, {})).toMatchObject({
      authentication: "required",
    });
    const say = vi.spyOn(host, "say").mockImplementation(() => {});
    await tool("hub_start_turn").run(host, {
      session: "test:/1",
      text: "hello",
      turnId: "one",
    });
    expect(say).toHaveBeenCalled();
  });
});
