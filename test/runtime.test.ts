import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { start } from "../src/runtime.js";
import { validateConfig, type HubConfig } from "../src/config.js";
import type * as Processes from "../src/processes.js";

const state = vi.hoisted(() => ({
  root: "",
  failStop: false,
  failAdapter: false,
  adapterFailed: false,
  unavailable: false,
  mismatch: false,
  invalidRegistry: false,
  registryMissing: false,
  detail: "",
  processes: [] as {
    executable: string;
    args: string[];
    env: NodeJS.ProcessEnv;
    cwd?: string;
    exit: () => void;
    stop: () => Promise<void>;
    message?: Record<string, unknown>;
    check: () => void;
  }[],
  clients: new Map<string, string>(),
  turns: new Map<string, unknown>(),
}));

vi.mock("../src/processes.js", async (original) => {
  const actual = await original<typeof Processes>();
  const { EventEmitter: Emitter } = await import("node:events");
  return {
    ...actual,
    nativeCode: () => Promise.resolve("fixture-executable"),
    endpointFromRegistry: async (directory: string) => {
      if (state.registryMissing) return undefined;
      const path = join(directory, "entry.json");
      await writeFile(
        path,
        JSON.stringify({
          schemaVersion: state.invalidRegistry ? 1 : 2,
          type: "standalone",
          instanceId: "native-test-instance",
          endpoint: { type: "tcp", host: "127.0.0.1", port: 43211 },
        }),
      );
      return path;
    },
    waitReady: async (
      child: { check(): void },
      probe: () => Promise<boolean>,
    ) => {
      await Promise.resolve();
      child.check();
      if (!(await probe())) throw new Error("not_ready");
    },
    OwnedProcess: class {
      readonly child = Object.assign(new Emitter(), {
        send: (message: Record<string, unknown>) => {
          this.record.message = message;
          const port = 45000 + state.processes.indexOf(this.record);
          state.clients.set(
            `http://127.0.0.1:${port}`,
            String(message.instance),
          );
          queueMicrotask(() =>
            this.child.emit(
              "message",
              state.adapterFailed
                ? { type: "failed" }
                : { type: "ready", port },
            ),
          );
        },
      });
      readonly stop = vi.fn(() => {
        if (state.failStop)
          return Promise.reject(new Error("fixture cleanup failure"));
        return Promise.resolve();
      });
      readonly check = vi.fn();
      readonly record: (typeof state.processes)[number];
      constructor(
        executable: string,
        args: string[],
        env: NodeJS.ProcessEnv,
        exit: () => void,
        _ipc: boolean,
        cwd?: string,
      ) {
        this.record = {
          executable,
          args,
          env,
          exit,
          stop: this.stop,
          check: this.check,
          ...(cwd === undefined ? {} : { cwd }),
        };
        state.processes.push(this.record);
      }
    },
  };
});

vi.mock("../src/adapter.js", () => ({
  HttpAdapter: class {
    constructor(private readonly base: string) {}
    async call(
      name: string,
      input: Record<string, unknown> = {},
    ): Promise<unknown> {
      await Promise.resolve();
      if (state.failAdapter) throw new Error("fixture adapter failure");
      const instance = state.clients.get(this.base);
      if (name === "list_agents") return [{ provider: instance }];
      if (name === "new_session") return { session: "same:/session" };
      if (name === "list_sessions") return [];
      if (name === "hub_start_turn") {
        state.turns.set(String(instance), input.turnId);
        return { id: input.turnId };
      }
      if (name === "session_history")
        return {
          turns: [
            {
              id: state.turns.get(String(instance)),
              state: "complete",
              text: instance,
            },
          ],
        };
      return {
        status: state.unavailable ? "unavailable" : "ready",
        authentication: "backend",
        instance: state.mismatch ? "different" : instance,
        detail: state.detail,
      };
    }
  },
}));

let running: Awaited<ReturnType<typeof start>> | undefined;
beforeEach(async () => {
  state.root = await mkdtemp(join(process.cwd(), ".test-runtime-"));
  state.processes.length = 0;
  state.clients.clear();
  state.turns.clear();
  state.detail = "";
  for (const key of [
    "failStop",
    "failAdapter",
    "adapterFailed",
    "unavailable",
    "mismatch",
    "invalidRegistry",
    "registryMissing",
  ] as const)
    state[key] = false;
});
afterEach(async () => {
  state.failStop = false;
  await running?.close().catch(() => {});
  running = undefined;
  vi.unstubAllEnvs();
  await rm(state.root, { recursive: true, force: true });
});

function config(): HubConfig {
  return validateConfig({
    version: 1,
    services: ["one", "two"].map((id, index) => ({
      id,
      kind: "ahp-websocket",
      lifecycle: "attached",
      startupTimeoutMs: 100,
      endpoint: { url: `ws://127.0.0.1:${43211 + index}` },
    })),
  });
}
async function setup(
  input: Partial<Parameters<typeof start>[0]> = {},
): Promise<string> {
  running = await start({
    instance: "test",
    dataDir: state.root,
    port: 0,
    ...input,
  });
  return running.url;
}

describe("lazy runtime orchestration with mock bridge subprocesses", () => {
  it("starts no service for hub health/catalogue, deduplicates concurrent selection, isolates IDs", async () => {
    const url = await setup({ config: config() });
    expect(await (await fetch(`${url}/health`)).json()).toMatchObject({
      status: "listening",
    });
    expect(await (await fetch(`${url}/services`)).json()).toEqual({
      services: ["one", "two"],
    });
    expect(state.processes).toHaveLength(0);
    expect((await fetch(`${url}/agents`)).status).toBe(400);
    expect((await fetch(`${url}/services/missing/agents`)).status).toBe(404);
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => fetch(`${url}/services/one/agents`)),
    );
    expect(state.processes).toHaveLength(1);
    for (const response of responses)
      expect(await response.json()).toEqual({ agents: [{ provider: "one" }] });
    expect(await (await fetch(`${url}/services/two/agents`)).json()).toEqual({
      agents: [{ provider: "two" }],
    });
    expect(state.processes).toHaveLength(2);
    expect(state.processes[0]?.message?.instance).toBe("one");
    expect(state.processes[1]?.message?.instance).toBe("two");
    const post = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "one",
        workingDirectory: process.cwd(),
      }),
    };
    expect((await fetch(`${url}/services/one/sessions`, post)).status).toBe(
      201,
    );
    const wrong = await fetch(
      `${url}/services/two/sessions/same%3A%2Fsession/tasks`,
      { ...post, body: JSON.stringify({ text: "hello" }) },
    );
    expect(wrong.status).toBe(404);
    expect((await fetch(`${url}/services/two/sessions`, post)).status).toBe(
      201,
    );
    for (const id of ["one", "two"]) {
      const submitted = await fetch(
        `${url}/services/${id}/sessions/same%3A%2Fsession/tasks`,
        {
          ...post,
          body: JSON.stringify({ text: "harmless fixture question" }),
        },
      );
      expect(submitted.status).toBe(202);
      const task = (await submitted.json()) as {
        taskId: string;
        turnId: string;
      };
      const waited = await fetch(
        `${url}/services/${id}/tasks/${task.taskId}/wait`,
      );
      expect(await waited.json()).toMatchObject({
        task: {
          status: "completed",
          turnId: task.turnId,
          result: { id: task.turnId, text: id },
        },
      });
      expect(
        (
          await fetch(
            `${url}/services/${id === "one" ? "two" : "one"}/tasks/${task.taskId}`,
          )
        ).status,
      ).toBe(404);
    }
    await running?.close();
    expect(
      state.processes.every(
        (child) => vi.mocked(child.stop).mock.calls.length === 1,
      ),
    ).toBe(true);
  });

  it("uses explicit legacy flags with persistent profile, inherited identity and fresh private registry", async () => {
    vi.stubEnv("HOME", "intended-home");
    vi.stubEnv("VSCODE_CLI_DATA_DIR", "intended-cli-context");
    vi.stubEnv("GITHUB_TOKEN", "unrelated-secret");
    const url = await setup({ codePath: "exact-executable" });
    expect((await fetch(`${url}/services/test/health`)).status).toBe(200);
    const child = state.processes[0];
    expect(child?.executable).toBe("exact-executable");
    expect(child?.args).toContain("--new-instance");
    expect(child?.args).toContain("--foreground");
    expect(child?.args).not.toContain("--replace");
    expect(child?.env.HOME).toBe("intended-home");
    expect(child?.env.VSCODE_CLI_DATA_DIR).toBe("intended-cli-context");
    expect(child?.args).not.toContain("--cli-data-dir");
    expect(child?.env.GITHUB_TOKEN).toBeUndefined();
    expect(child?.cwd).toBe(process.cwd());
    const dir = join(state.root, "test", "services", "test");
    expect(await readFile(join(dir, "connection-token"), "utf8")).toHaveLength(
      64,
    );
    expect(
      await (await fetch(`${url}/services/test/health`)).json(),
    ).toMatchObject({
      host: { owned: true, instanceId: "native-test-instance" },
    });
    const marker = join(dir, "profile", "identity-marker");
    await writeFile(marker, "preserve");
    await running?.close();
    await running?.close();
    expect(await readFile(marker, "utf8")).toBe("preserve");
    await expect(readFile(join(dir, "connection-token"))).rejects.toMatchObject(
      { code: "ENOENT" },
    );
  });

  it("expands exact launch arguments/environment without a shell or forwarding ambient credentials", async () => {
    vi.stubEnv("NATIVE_SERVICE_CONTEXT", "explicit-context");
    vi.stubEnv("NATIVE_SERVICE_TOKEN", "fixture-native-secret");
    state.detail = "fixture-native-secret";
    const service = config().services[0];
    if (service === undefined) throw new Error("missing fixture");
    service.lifecycle = "owned";
    service.endpoint = { registry: true };
    service.launch = {
      executable: "fixture-path",
      args: ["space argument", "$(not a shell)", "{connectionTokenFile}"],
      cwd: state.root,
      environment: {
        mode: "isolated",
        inherit: ["NATIVE_SERVICE_CONTEXT", "NATIVE_SERVICE_TOKEN"],
        values: { PROFILE: "{profileDirectory}", EMPTY: "" },
      },
    };
    const url = await setup({ config: { version: 1, services: [service] } });
    expect((await fetch(`${url}/services/one/health`)).status).toBe(200);
    const child = state.processes[0];
    expect(child?.args.slice(0, 2)).toEqual([
      "space argument",
      "$(not a shell)",
    ]);
    expect(child?.env.NATIVE_SERVICE_CONTEXT).toBe("explicit-context");
    expect(child?.env.NATIVE_SERVICE_TOKEN).toBe("fixture-native-secret");
    expect(child?.env.PROFILE).toBe(child?.env.HOME);
    expect(child?.env.EMPTY).toBe("");
    expect(child?.cwd).toBe(state.root);
    expect(child?.env.HOME).toContain(join("services", "one", "profile"));
    expect(
      await (await fetch(`${url}/services/one/health`)).json(),
    ).toHaveProperty("detail", "[redacted]");
  });

  it("attaches only to an explicit endpoint and never launches or owns that Host", async () => {
    const url = await setup({
      hostUrl: "ws://127.0.0.1:43211",
      hostToken: "fixture",
    });
    expect((await fetch(`${url}/services/test/health`)).status).toBe(200);
    expect(state.processes).toHaveLength(1);
    expect(state.processes[0]?.message?.connectionToken).toBe("fixture");
    expect(
      await (await fetch(`${url}/services/test/health`)).json(),
    ).toMatchObject({ host: { owned: false } });
  });

  it.each([
    "invalidRegistry",
    "registryMissing",
    "adapterFailed",
    "mismatch",
    "unavailable",
  ] as const)(
    "does not report service readiness when %s and cleans failed starts",
    async (key) => {
      state[key] = true;
      const url = await setup();
      expect(
        (await fetch(`${url}/services/test/health`)).status,
      ).toBeGreaterThanOrEqual(500);
      const count = state.processes.length;
      expect(
        (await fetch(`${url}/services/test/health`)).status,
      ).toBeGreaterThanOrEqual(500);
      expect(state.processes).toHaveLength(count);
      expect(
        state.processes.every(
          (child) => vi.mocked(child.stop).mock.calls.length === 1,
        ),
      ).toBe(true);
    },
  );

  it("observes process exit and adapter loss without stale readiness", async () => {
    const url = await setup();
    await fetch(`${url}/services/test/health`);
    state.processes[0]?.exit();
    expect(
      await (await fetch(`${url}/services/test/health`)).json(),
    ).toMatchObject({
      status: "unavailable",
      error: "child_exited",
    });
    await running?.close();
    running = undefined;
    const second = await setup({ config: config() });
    await fetch(`${second}/services/one/health`);
    state.failAdapter = true;
    expect(
      await (await fetch(`${second}/services/one/health`)).json(),
    ).toMatchObject({
      status: "unavailable",
      error: "adapter_unavailable",
    });
  });

  it("requires explicit connection-token and environment references", async () => {
    const input = config();
    input.services[0]!.endpoint = {
      url: "ws://127.0.0.1:43211",
      tokenEnv: "MISSING_AHPLEX_TEST_TOKEN",
    };
    const url = await setup({ config: input });
    const response = await fetch(`${url}/services/one/health`);
    expect(await response.json()).toMatchObject({
      error: { code: "connection_token_environment_missing" },
    });
    expect(state.processes).toHaveLength(0);
  });

  it("resolves only the selected attachment's explicit transport token reference", async () => {
    vi.stubEnv("AHPLEX_TEST_TRANSPORT_TOKEN", "fixture-transport-secret");
    state.detail = "fixture-transport-secret";
    const input = config();
    input.services[0]!.endpoint = {
      url: "ws://127.0.0.1:43211",
      tokenEnv: "AHPLEX_TEST_TRANSPORT_TOKEN",
    };
    const url = await setup({ config: input });
    const response = await fetch(`${url}/services/one/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toHaveProperty("detail", "[redacted]");
    expect(state.processes[0]?.message?.connectionToken).toBe(
      "fixture-transport-secret",
    );
  });

  it("cleans failed startup when an explicitly inherited context variable is missing", async () => {
    const service = config().services[0]!;
    service.lifecycle = "owned";
    service.endpoint = { registry: true };
    service.launch = {
      executable: "fixture",
      args: [],
      cwd: state.root,
      environment: {
        mode: "inherited",
        inherit: ["MISSING_AHPLEX_TEST_ENVIRONMENT"],
        values: {},
      },
    };
    const url = await setup({ config: { version: 1, services: [service] } });
    expect(
      await (await fetch(`${url}/services/one/health`)).json(),
    ).toMatchObject({
      error: { code: "configured_environment_variable_missing" },
    });
    expect(state.processes).toHaveLength(0);
    await expect(
      readFile(join(state.root, "test", "services", "one", "owner.lock")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains ownership locks if cleanup fails", async () => {
    const url = await setup();
    await fetch(`${url}/services/test/health`);
    state.failStop = true;
    await expect(running?.close()).rejects.toThrow(
      "cleanup_failed_lock_retained",
    );
    expect(await readFile(join(state.root, "test", "owner.lock"), "utf8")).toBe(
      String(process.pid),
    );
    // The test owns this socket, but production must retain locks on failure.
    state.failStop = false;
  });

  it("rejects cancellation, conflicting options and invalid legacy configuration", async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(
      start({ instance: "test", signal: abort.signal }),
    ).rejects.toThrow("startup_cancelled");
    await expect(
      start({ instance: "test", authToken: "fixture" }),
    ).rejects.toThrow("auth_resource_and_token_required_together");
    await expect(
      start({ instance: "test", config: config(), codePath: "x" }),
    ).rejects.toThrow("configuration_legacy_options_conflict");
    const url = await setup({ hostUrl: "ws://example.com:1234" });
    expect((await fetch(`${url}/services/test/health`)).status).toBe(400);
    expect(state.processes).toHaveLength(0);
  });

  it("releases the hub lock on HTTP listener startup failure", async () => {
    const first = await setup();
    await expect(
      start({
        instance: "other",
        dataDir: state.root,
        port: Number(new URL(first).port),
      }),
    ).rejects.toThrow();
    await expect(
      readFile(join(state.root, "other", "owner.lock")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
