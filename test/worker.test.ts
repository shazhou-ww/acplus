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
  it("reports missing credentials explicitly and refuses creation or execution", async () => {
    await runAdapter(config);
    expect(await tool("hub_status").run(host, {})).toMatchObject({
      authentication: "required",
      instance: "test",
    });
    await expect(
      tool("new_session").run(host, { provider: "test" }),
    ).rejects.toThrow("auth_required");
    await expect(
      tool("hub_start_turn").run(host, {
        session: "test:/1",
        text: "a",
        turnId: "one",
      }),
    ).rejects.toThrow("auth_required");
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
      "session_unavailable",
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
});
