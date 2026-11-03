import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { start } from "../src/runtime.js";

const state = vi.hoisted(() => ({
  directory: "",
  root: "",
  registry: "",
  released: false,
  failStop: false,
  failAdapter: false,
  identity: "test",
  health: undefined as (() => Promise<Record<string, unknown>>) | undefined,
  processes: [] as {
    args: string[];
    exit: () => void;
    stop: () => Promise<void>;
  }[],
}));

vi.mock("../src/processes.js", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    instanceDirectory: (root: string) => {
      state.root = root;
      return Promise.resolve({
        directory: state.directory,
        release: () => {
          state.released = true;
          return Promise.resolve();
        },
      });
    },
    isolatedEnvironment: () => ({}),
    nativeCode: () => Promise.resolve("fixture-executable"),
    endpointFromRegistry: () => Promise.resolve(state.registry),
    waitReady: async (_child: unknown, probe: () => Promise<boolean>) => {
      await Promise.resolve();
      if (!(await probe())) throw new Error("not_ready");
    },
    OwnedProcess: class {
      readonly child = Object.assign(new EventEmitter(), {
        send: () => {
          queueMicrotask(() => {
            this.child.emit("message", { type: "ready", port: 43210 });
          });
        },
      });
      readonly stop = vi.fn(() => {
        if (state.failStop) throw new Error("fixture cleanup failure");
        return Promise.resolve();
      });
      constructor(
        _executable: string,
        args: string[],
        _env: unknown,
        exit: () => void,
      ) {
        state.processes.push({ args, exit, stop: this.stop });
      }
    },
  };
});

vi.mock("../src/adapter.js", () => ({
  HttpAdapter: class {
    async call(): Promise<unknown> {
      await Promise.resolve();
      if (state.failAdapter) throw new Error("fixture adapter failure");
      return {
        status: "ready",
        authentication: "required",
        instance: state.identity,
      };
    }
  },
}));

vi.mock("../src/server.js", () => ({
  serveHub: (
    _manager: unknown,
    options: { health: () => Promise<Record<string, unknown>> },
  ) => {
    state.health = options.health;
    return Promise.resolve({
      url: "http://127.0.0.1:4280",
      close: () => Promise.resolve(),
    });
  },
}));

beforeEach(async () => {
  state.directory = await mkdtemp(join(tmpdir(), "ahplex-runtime-test-"));
  state.registry = join(state.directory, "registry-fixture.json");
  await writeFile(
    state.registry,
    JSON.stringify({
      schemaVersion: 2,
      type: "standalone",
      instanceId: "native-test-instance",
      endpoint: { type: "tcp", host: "127.0.0.1", port: 43211 },
    }),
  );
  state.processes.length = 0;
  state.released = false;
  state.failStop = false;
  state.failAdapter = false;
  state.identity = "test";
  state.health = undefined;
});

afterEach(async () => {
  await rm(state.directory, { recursive: true, force: true });
});

describe("runtime orchestration (mock subprocess integration, not real Host acceptance)", () => {
  it("uses explicit independent Host flags, per-run registry, identity, and removes its token", async () => {
    const running = await start({
      instance: "test",
      dataDir: state.directory,
      port: 0,
    });
    expect(state.processes).toHaveLength(2);
    const args = state.processes[0]?.args ?? [];
    expect(args).toContain("--new-instance");
    expect(args).toContain("--foreground");
    expect(args).not.toContain("--replace");
    const registryArg = args[args.indexOf("--user-data-dir") + 1];
    expect(registryArg).toContain(join("runs", ""));
    expect(
      await readFile(join(state.directory, "connection-token"), "utf8"),
    ).toHaveLength(64);
    expect(await state.health?.()).toMatchObject({
      instance: "test",
      host: { owned: true, instanceId: "native-test-instance" },
    });
    await running.close();
    await running.close();
    expect(state.released).toBe(true);
    await expect(
      readFile(join(state.directory, "connection-token")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("connects only to the explicitly configured existing Host and never owns it", async () => {
    const running = await start({
      instance: "test",
      hostUrl: "ws://127.0.0.1:43211",
      hostToken: "fixture",
    });
    expect(state.processes).toHaveLength(1);
    expect(state.root).toBe(join(homedir(), ".ahplex"));
    expect(await state.health?.()).toMatchObject({ host: { owned: false } });
    await running.close();
  });

  it("rejects incomplete credentials and remote URLs before starting anything", async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(
      start({ instance: "test", signal: abort.signal }),
    ).rejects.toThrow("startup_cancelled");
    await expect(
      start({ instance: "test", authToken: "fixture" }),
    ).rejects.toThrow("auth_resource_and_token_required_together");
    await expect(
      start({ instance: "test", hostUrl: "ws://example.com:1234" }),
    ).rejects.toThrow("explicit_loopback_endpoint_required");
    expect(state.processes).toHaveLength(0);
  });

  it("rejects unexpected native registry contracts and cleans up startup failures", async () => {
    await writeFile(
      state.registry,
      JSON.stringify({
        schemaVersion: 1,
        endpoint: { type: "tcp", host: "127.0.0.1", port: 43211 },
      }),
    );
    await expect(start({ instance: "test" })).rejects.toThrow(
      "unsupported_host_registry",
    );
    expect(state.released).toBe(true);
    expect(state.processes).toHaveLength(1);
  });

  it("fails closed on adapter identity mismatch", async () => {
    state.identity = "different-instance";
    await expect(
      start({ instance: "test", hostUrl: "ws://127.0.0.1:43211" }),
    ).rejects.toThrow("adapter_identity_mismatch");
    expect(state.released).toBe(true);
  });

  it("marks health unavailable and stops owned processes after unexpected exit", async () => {
    const running = await start({ instance: "test" });
    state.processes[0]?.exit();
    expect(await state.health?.()).toMatchObject({
      status: "unavailable",
      error: "child_exited",
    });
    await running.close();
  });

  it("reports lost adapter connectivity rather than stale health", async () => {
    const running = await start({
      instance: "test",
      hostUrl: "ws://127.0.0.1:43211",
    });
    state.failAdapter = true;
    expect(await state.health?.()).toMatchObject({
      status: "unavailable",
      error: "adapter_unavailable",
    });
    await running.close();
  });

  it("retains the lock when owned process cleanup fails", async () => {
    const running = await start({ instance: "test" });
    state.failStop = true;
    await expect(running.close()).rejects.toThrow(
      "cleanup_failed_lock_retained",
    );
    expect(state.released).toBe(false);
  });
});
