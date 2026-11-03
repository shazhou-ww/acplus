import { ChildProcess, execFile, spawn } from "node:child_process";
import { access, open, readdir } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  endpointFromRegistry,
  instanceDirectory,
  nativeCode,
  OwnedProcess,
} from "../src/processes.js";

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof ChildProcesses>();
  return { ...actual, spawn: vi.fn(), execFile: vi.fn() };
});
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof FileSystem>();
  return {
    ...actual,
    access: vi.fn(),
    open: vi.fn(),
    readdir: vi.fn(),
    mkdir: vi.fn(),
  };
});
vi.mock("node:timers/promises", () => ({
  setTimeout: () => Promise.resolve(),
}));
import type * as ChildProcesses from "node:child_process";
import type * as FileSystem from "node:fs/promises";

const platform = process.platform;
let child: ChildProcess;

beforeEach(() => {
  vi.resetAllMocks();
  child = new ChildProcess();
  Object.defineProperty(child, "pid", { value: 12345 });
  vi.mocked(spawn).mockReturnValue(child);
  vi.mocked(access).mockResolvedValue(undefined);
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: platform });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("process boundaries with synthetic child handles (never OS PIDs)", () => {
  it("passes the exact executable, argument array, environment and cwd without a shell", async () => {
    const args = [
      "space argument",
      "$(not a shell)",
      '{"providerOption":true}',
    ];
    const env = { HOME: "intended-context" };
    const owned = new OwnedProcess(
      "exact-executable",
      args,
      env,
      () => {},
      false,
      "intended-directory",
    );
    expect(spawn).toHaveBeenCalledWith("exact-executable", args, {
      env,
      cwd: "intended-directory",
      windowsHide: true,
      detached: platform !== "win32",
      stdio: "ignore",
    });
    child.emit("exit", 0);
    await owned.stop();
  });
  it("finds the native executable and skips missing PATH entries", async () => {
    vi.stubEnv("PATH", `first${delimiter}second`);
    vi.mocked(access).mockRejectedValueOnce(
      Object.assign(new Error("missing"), { code: "ENOENT" }),
    );
    expect(await nativeCode()).toBe(
      join("second", platform === "win32" ? "code-tunnel.exe" : "code"),
    );
  });

  it("surfaces PATH permission errors and missing executable", async () => {
    vi.stubEnv("PATH", "");
    vi.mocked(access).mockRejectedValue(
      Object.assign(new Error("missing"), { code: "ENOENT" }),
    );
    await expect(nativeCode()).rejects.toThrow("vscode_executable_not_found");
    vi.mocked(access).mockRejectedValue(new Error("permission denied"));
    await expect(nativeCode()).rejects.toThrow("permission denied");
    vi.stubEnv("PATH", undefined);
    await expect(nativeCode()).rejects.toThrow("permission denied");
  });

  it("propagates lock and registry filesystem errors", async () => {
    vi.mocked(open).mockRejectedValue(new Error("lock denied"));
    await expect(instanceDirectory("root", "test")).rejects.toThrow(
      "lock denied",
    );
    vi.mocked(readdir).mockRejectedValue(new Error("registry denied"));
    await expect(endpointFromRegistry("root")).rejects.toThrow(
      "registry denied",
    );
  });

  it("uses a detached POSIX group and escalates only its owned group", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    vi.stubEnv("PATH", "");
    expect(await nativeCode()).toBe("code");
    const kill = vi
      .spyOn(process, "kill")
      .mockImplementation((_pid, signal) => {
        if (signal === "SIGKILL") child.emit("exit", null, "SIGKILL");
        return true;
      });
    const owned = new OwnedProcess("fixture", [], {});
    await owned.stop();
    expect(kill.mock.calls).toEqual([
      [-12345, "SIGTERM"],
      [-12345, "SIGKILL"],
    ]);
    expect(vi.mocked(spawn).mock.calls[0]?.[2]).toMatchObject({
      detached: true,
    });
  });

  it("does not escalate after graceful POSIX exit", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      child.emit("exit", 0);
      return true;
    });
    const owned = new OwnedProcess("fixture", [], {});
    await owned.stop();
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it("retains a Windows cleanup failure for all callers instead of hanging or claiming success", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    vi.mocked(execFile).mockImplementation((...args) => {
      const callback = args[args.length - 1];
      if (typeof callback === "function")
        callback(
          Object.assign(new Error("denied"), { cmd: "fixture" }),
          "",
          "",
        );
      return child;
    });
    const owned = new OwnedProcess("fixture", [], {}, () => {}, true);
    const first = owned.stop();
    expect(owned.stop()).toBe(first);
    await expect(first).rejects.toThrow("child_cleanup_failed");
    await expect(owned.stop()).rejects.toThrow("child_cleanup_failed");
    expect(vi.mocked(execFile).mock.calls[0]?.[1]).toEqual([
      "/PID",
      "12345",
      "/T",
      "/F",
    ]);
  });

  it("tolerates the exact owned PID exiting during Windows termination", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    vi.mocked(execFile).mockImplementation((...args) => {
      child.emit("exit", 0);
      const callback = args[args.length - 1];
      if (typeof callback === "function")
        callback(
          Object.assign(new Error("already exited"), { cmd: "fixture" }),
          "",
          "",
        );
      return child;
    });
    const owned = new OwnedProcess("fixture", [], {});
    await owned.stop();
  });

  it("deduplicates child error and exit notifications", async () => {
    const exit = vi.fn();
    const owned = new OwnedProcess("fixture", [], {}, exit);
    child.emit("error", new Error("spawn failed"));
    child.emit("exit", 1);
    expect(exit).toHaveBeenCalledOnce();
    expect(() => {
      owned.check();
    }).toThrow("child_exited");
    await owned.stop();
  });
});
