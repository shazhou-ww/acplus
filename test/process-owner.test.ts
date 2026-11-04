import { ChildProcess } from "node:child_process";
import type * as ChildProcessModule from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OwnedProcess, ProcessOwner } from "../src/processes.js";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  execFile:
    vi.fn<
      (
        command: string,
        args: string[],
        options: { timeout: number },
        callback: (error: Error | null) => void,
      ) => void
    >(),
}));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof ChildProcessModule>();
  return { ...actual, spawn: mocks.spawn, execFile: mocks.execFile };
});
vi.mock("node:timers/promises", () => ({
  setTimeout: () => Promise.resolve(),
}));
const platform = Object.getOwnPropertyDescriptor(process, "platform");
afterEach(() => {
  if (platform !== undefined)
    Object.defineProperty(process, "platform", platform);
  vi.restoreAllMocks();
  mocks.spawn.mockReset();
  mocks.execFile.mockReset();
});

function child(platform: string): {
  owned: OwnedProcess;
  process: ChildProcess;
} {
  Object.defineProperty(process, "platform", { value: platform });
  const fake = new ChildProcess();
  Object.defineProperty(fake, "pid", { value: 12345 });
  mocks.spawn.mockReturnValue(fake);
  return {
    owned: new OwnedProcess({
      command: "trusted",
      args: [],
      env: {},
      signal: new AbortController().signal,
    }),
    process: fake,
  };
}

describe("portable owned process tree cleanup", () => {
  it("uses a specific Windows PID tree, a finite kill deadline, and no shell", async () => {
    const handle = child("win32");
    mocks.execFile.mockImplementation((_command, _args, _options, callback) => {
      handle.process.emit("exit", 0, null);
      callback(null);
    });
    await handle.owned.stop();
    expect(mocks.execFile).toHaveBeenCalledWith(
      "taskkill.exe",
      ["/PID", "12345", "/T", "/F"],
      { windowsHide: true, timeout: 10_000 },
      expect.any(Function),
    );
    expect(mocks.spawn.mock.calls[0]?.[2]).toMatchObject({ shell: false });
  });

  it("retains Windows cleanup failures but tolerates a concurrently exited child", async () => {
    const failed = child("win32");
    mocks.execFile.mockImplementation((_command, _args, _options, callback) => {
      callback(new Error("failure"));
    });
    await expect(failed.owned.stop()).rejects.toMatchObject({
      code: "owned_cleanup_failed",
    });
    failed.process.emit("exit", 0, null);
    const exited = child("win32");
    mocks.execFile.mockImplementation((_command, _args, _options, callback) => {
      exited.process.emit("exit", 0, null);
      callback(new Error("already exited"));
    });
    await exited.owned.stop();
  });

  it("terminates only the owned POSIX process group and escalates after the grace period", async () => {
    const handle = child("linux");
    const kill = vi
      .spyOn(process, "kill")
      .mockImplementation((_pid, signal) => {
        if (signal === "SIGKILL") handle.process.emit("exit", 0, null);
        return true;
      });
    await handle.owned.stop();
    expect(kill.mock.calls).toEqual([
      [-12345, "SIGTERM"],
      [-12345, "SIGKILL"],
    ]);
  });

  it("does not escalate a POSIX child that already stopped", async () => {
    const handle = child("linux");
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      handle.process.emit("exit", 0, null);
      return true;
    });
    await handle.owned.stop();
    expect(kill).toHaveBeenCalledOnce();
  });

  it("retains failed owned handles and rejects further spawning after close", async () => {
    const handle = child("win32");
    const owner = new ProcessOwner();
    owner.spawn({
      command: "trusted",
      args: [],
      env: {},
      signal: new AbortController().signal,
    });
    mocks.execFile.mockImplementation((_command, _args, _options, callback) => {
      callback(new Error("failure"));
    });
    await expect(owner.close()).rejects.toMatchObject({
      code: "owned_cleanup_failed",
    });
    expect(() =>
      owner.spawn({
        command: "trusted",
        args: [],
        env: {},
        signal: new AbortController().signal,
      }),
    ).toThrow("owner closed");
    handle.process.emit("exit", 0, null);
  });
});
