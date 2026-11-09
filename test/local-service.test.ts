import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canonicalDataDir,
  localService,
  publishOwner,
  readOwner,
  proof,
  startupTimeoutMs,
} from "../src/local-service.js";
import { fixtureConfig } from "./acp-fixture.js";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  exec: vi.fn<
    (
      command: string,
      args: readonly string[] | null | undefined,
      options: ChildProcess.ExecFileOptions | null | undefined,
    ) => void
  >(),
}));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof ChildProcess>();
  const { promisify } = await import("node:util");
  const execute = promisify(actual.execFile);
  const execFile = Object.assign(
    (...args: Parameters<typeof actual.execFile>) => actual.execFile(...args),
    {
      [promisify.custom]: (...args: Parameters<typeof execute>) => {
        mocks.exec(...args);
        return execute(...args);
      },
    },
  );
  return { ...actual, spawn: mocks.spawn, execFile };
});
const roots: string[] = [];
async function fixture() {
  const directory = resolve(".local-discovery-tests", randomUUID());
  await mkdir(directory, { recursive: true });
  roots.push(directory);
  const config = fixtureConfig(directory);
  config.dataDir = await canonicalDataDir(config.dataDir);
  return config;
}
afterEach(async () => {
  vi.restoreAllMocks();
  mocks.spawn.mockReset();
  mocks.exec.mockClear();
  await Promise.all(
    roots
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("local startup failure boundaries", () => {
  it("starts a detached native child with private IPC, then returns only proved readiness", async () => {
    const config = await fixture();
    const child = Object.assign(new EventEmitter(), {
      unref: vi.fn(),
      channel: { unref: vi.fn() },
    });
    let release: (() => Promise<void>) | undefined;
    mocks.spawn.mockImplementation(() => {
      void publishOwner(config.dataDir, "http://127.0.0.1:3210/v2").then(
        (lease) => {
          release = () => lease.release();
        },
      );
      return child;
    });
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
      const challenge =
        new Headers(init?.headers).get("x-acplus-challenge") ?? "";
      return readOwner(config.dataDir).then(
        (owner) =>
          new Response(
            JSON.stringify({
              dataDir: config.dataDir,
              proof: proof(owner!.token, challenge),
            }),
          ),
      );
    });
    const owner = await localService(config, "config.yaml", 1000, true);
    expect(owner.url).toBe("http://127.0.0.1:3210/v2");
    expect(mocks.spawn).toHaveBeenCalledWith(
      process.execPath,
      expect.arrayContaining([
        "_auto-serve",
        "--config",
        "config.yaml",
        "--data-dir",
        config.dataDir,
      ]),
      {
        detached: true,
        windowsHide: true,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
    );
    expect(child.unref).toHaveBeenCalled();
    expect(child.channel.unref).toHaveBeenCalled();
    child.emit("message", {});
    child.emit("message", { error: 7 });
    await release?.();
    if (process.platform === "win32") {
      expect(
        mocks.exec.mock.calls.some(([name]) => name === "whoami.exe"),
      ).toBe(true);
      expect(
        mocks.exec.mock.calls.some(
          ([name, args]) => name === "icacls.exe" && args?.includes("/grant:r"),
        ),
      ).toBe(true);
      expect(
        mocks.exec.mock.calls.some(
          ([name, args]) => name === "icacls.exe" && args?.length === 1,
        ),
      ).toBe(true);
      for (const [, , options] of mocks.exec.mock.calls)
        expect(options).toEqual({ windowsHide: true });
    }
  });

  it("rejects child startup errors or early exit rather than looping or claiming success", async () => {
    for (const [event, value, code] of [
      ["error", new Error("spawn"), "local_service_spawn_failed"],
      [
        "message",
        { error: "credential_unavailable" },
        "credential_unavailable",
      ],
      ["exit", 1, "local_service_exited_before_ready"],
    ] as const) {
      const config = await fixture();
      mocks.spawn.mockClear();
      mocks.spawn.mockImplementation(() => {
        const child = Object.assign(new EventEmitter(), {
          unref() {},
          channel: undefined,
        });
        queueMicrotask(() => {
          child.emit(event, value);
        });
        return child;
      });
      await expect(
        localService(config, "config.yaml", 1000, true),
      ).rejects.toMatchObject({ code });
      expect(mocks.spawn).toHaveBeenCalledTimes(1);
    }
  });

  it("does not trust a port listener, forged proof, failed health or mismatched data directory", async () => {
    const config = await fixture();
    const lease = await publishOwner(
      config.dataDir,
      "http://127.0.0.1:3210/v2",
    );
    for (const response of [
      new Response("{}", { status: 503 }),
      new Response("not JSON"),
      new Response(
        JSON.stringify({ dataDir: config.dataDir, proof: "0".repeat(64) }),
      ),
      new Response(
        JSON.stringify({ dataDir: "elsewhere", proof: "0".repeat(64) }),
      ),
    ]) {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response);
      await expect(
        localService(config, "ignored", 1000, false),
      ).rejects.toMatchObject({ code: "local_work_owner_unavailable" });
    }
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
      new Error("connection refused"),
    );
    await expect(
      localService(config, "ignored", 1000, false),
    ).rejects.toMatchObject({ code: "local_work_owner_unavailable" });
    expect(mocks.spawn).not.toHaveBeenCalled();
    await lease.release();
  });

  it("waits boundedly for an existing writer without stealing a stale lease", async () => {
    const config = await fixture();
    const path = join(config.dataDir, "owner.lock");
    await writeFile(path, "existing");
    const now = Date.now();
    let calls = 0;
    vi.spyOn(Date, "now").mockImplementation(() => {
      calls += 1;
      return calls <= 2 ? now : now + startupTimeoutMs + 1;
    });
    await expect(
      localService(config, "ignored", 1000, true),
    ).rejects.toMatchObject({ code: "local_service_start_timeout" });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("can retry a losing startup after the real lease disappears, without treating contention as fatal", async () => {
    const config = await fixture();
    const now = Date.now();
    let calls = 0;
    vi.spyOn(Date, "now").mockImplementation(() => {
      calls += 1;
      return calls <= 2 ? now : now + startupTimeoutMs + 1;
    });
    mocks.spawn.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), {
        unref() {},
        channel: undefined,
      });
      queueMicrotask(() => {
        child.emit("message", { error: "data_directory_locked" });
        child.emit("exit", 1);
      });
      return child;
    });
    await expect(
      localService(config, "ignored", 1000, true),
    ).rejects.toMatchObject({ code: "local_service_start_timeout" });
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });
});
