import { EventEmitter } from "node:events";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Redactor } from "../src/acp-common.js";
import type { AgentConfig, AuthStep } from "../src/acp-types.js";

const fake = vi.hoisted(() => ({
  spawn: vi.fn(),
  execFile: vi.fn(),
}));
vi.mock("node:child_process", () => fake);
import {
  AgentProcess,
  CopilotLoginParser,
  agentEnvironment,
  copilotLogin,
  waitFor,
} from "../src/acp-login.js";

const platform = process.platform;
beforeEach(() => {
  Object.defineProperty(process, "platform", {
    value: "win32",
    configurable: true,
  });
});
const directory = join(process.cwd(), "test", "acp-login-profile");
function config(): AgentConfig {
  return {
    id: "copilot",
    label: "Copilot",
    command: "/private/copilot's executable",
    args: ["--acp"],
    env: {},
    profileDir: directory,
    mcpServers: [],
    startupTimeoutMs: 1000,
    idleTimeoutMs: 0,
    permission: "deny",
    authentication: { type: "copilot", loginAccount: "expected-user" },
  };
}

function child() {
  const result = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 123456,
  });
  fake.spawn.mockReturnValue(result);
  fake.execFile.mockImplementation(
    (
      _command: string,
      _args: string[],
      _options: unknown,
      callback: (error: unknown) => void,
    ) => {
      result.emit("exit", 0);
      result.emit("close", 0);
      callback(null);
    },
  );
  return result;
}

afterEach(async () => {
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
  });
  vi.restoreAllMocks();
  fake.spawn.mockReset();
  fake.execFile.mockReset();
  await rm(directory, { recursive: true, force: true });
  delete process.env.ACP_TEST_SECRET;
});

describe(
  "isolated environment and native Copilot login",
  { timeout: 10_000 },
  () => {
    it("isolates profiles and resolves only explicit referenced secrets", async () => {
      await mkdir(directory, { recursive: true });
      const secret = join(directory, "credential");
      await writeFile(secret, "file-secret\n");
      process.env.ACP_TEST_SECRET = "environment-secret";
      const agent = config();
      agent.env = {
        EXPLICIT: "literal",
        SECRET: { source: "env", name: "ACP_TEST_SECRET" },
        FILE: { source: "file", path: secret },
        HOME: "unsafe",
        COPILOT_HOME: "unsafe",
        DBUS_SESSION_BUS_ADDRESS: "unsafe",
        NO_LOAD: "1",
        GITHUB_TOKEN: "literal-token",
      };
      agent.mcpServers = [
        {
          name: "stdio",
          command: "mcp",
          args: [],
          env: [
            { name: "API_KEY", value: "mcp-secret" },
            { name: "NO_LOAD", value: "1" },
          ],
        },
        {
          name: "http",
          type: "http",
          url: "https://example.test",
          headers: [{ name: "Authorization", value: "Bearer mcp-token" }],
        },
      ];
      const redactor = new Redactor();
      const env = await agentEnvironment(agent, redactor);
      expect(env.SECRET).toBe("environment-secret");
      expect(env.FILE).toBe("file-secret");
      expect(env.HOME).toBe(directory);
      expect(env.COPILOT_HOME).toBe(directory);
      expect(env.DBUS_SESSION_BUS_ADDRESS).toBe("disabled:");
      expect(env.GITHUB_TOKEN).toBe("literal-token");
      expect(env.ACP_TEST_SECRET).toBeUndefined();
      expect(redactor.clean("environment-secret file-secret")).toBe(
        "[redacted] [redacted]",
      );
      expect(redactor.clean("literal-token mcp-secret mcp-token")).toBe(
        "[redacted] [redacted] [redacted]",
      );
      expect(
        redactor.clean(
          JSON.stringify({
            id: "12345678-1234-4123-8123-123456789012",
            observedAt: "2026-11-09T01:02:03Z",
          }),
        ),
      ).toBe(
        JSON.stringify({
          id: "12345678-1234-4123-8123-123456789012",
          observedAt: "2026-11-09T01:02:03Z",
        }),
      );
    });

    it.each([
      { source: "env" as const, name: "ACP_TEST_MISSING" },
      { source: "file" as const, path: join(directory, "missing") },
    ])(
      "reports unavailable secret without revealing details",
      async (reference) => {
        const agent = config();
        agent.env.SECRET = reference;
        await expect(
          agentEnvironment(agent, new Redactor()),
        ).rejects.toMatchObject({ code: "credential_unavailable" });
      },
    );

    it("fences waits with abort signals, including already-aborted signals", async () => {
      const controller = new AbortController();
      const wait = waitFor(new Promise(() => {}), controller.signal);
      controller.abort(new Error("aborted"));
      await expect(wait).rejects.toThrow("aborted");
      await expect(
        waitFor(Promise.resolve("ignored"), controller.signal),
      ).rejects.toThrow("aborted");
      expect(
        await waitFor(Promise.resolve("ready"), new AbortController().signal),
      ).toBe("ready");
      await expect(
        waitFor(
          Promise.reject(new Error("failed")),
          new AbortController().signal,
        ),
      ).rejects.toThrow("failed");
    });

    it("parses split ANSI device challenges and exact successful account receipts", () => {
      const steps: AuthStep[] = [];
      const input = vi.fn();
      const parser = new CopilotLoginParser((step) => {
        steps.push(step);
      }, input);
      parser.accept("\u001b[32mABCD-");
      parser.accept("1234\u001b[0m https://github.com/login/device\n");
      parser.accept(
        "System keychain unavailable. Store token in plaintext config file? (y/N)",
      );
      expect(input).toHaveBeenCalledOnce();
      parser.accept("\nSigned in successfully as expected-user.\n");
      expect(() => {
        parser.verify("expected-user");
      }).toThrow();
      parser.confirm();
      parser.accept("\n✓ Signed in successfully as expected-user.\n");
      parser.verify("expected-user");
      expect(steps).toEqual([
        {
          kind: "link",
          url: "https://github.com/login/device",
          userCode: "ABCD-1234",
        },
      ]);
      expect(() => {
        parser.verify("different");
      }).toThrow();
    });

    it("rejects deceptive links, receipts without a challenge, and unbounded output", () => {
      const parser = new CopilotLoginParser(vi.fn(), vi.fn());
      parser.accept(
        "ABCD-1234 https://github.com/login/device.evil\nSigned in successfully as expected-user.\n",
      );
      expect(() => {
        parser.verify("expected-user");
      }).toThrow();
      expect(() => {
        parser.accept("x".repeat(33_000));
      }).toThrow("auth cli invalid response");
      const missing = new CopilotLoginParser(vi.fn(), vi.fn());
      missing.accept("Signed in successfully as expected-user.\n");
      expect(() => {
        missing.verify("expected-user");
      }).toThrow();
    });

    it("runs a dedicated PTY with explicit yes and requires exit-zero account evidence", async () => {
      const subprocess = child();
      subprocess.stdin.on("data", () => {
        subprocess.stdout.write("\nSigned in successfully as expected-user.\n");
        subprocess.emit("exit", 0);
        subprocess.emit("close", 0);
      });
      const steps = vi.fn();
      const input = vi.fn(() =>
        Promise.resolve({ confirmPlaintextStorage: "yes" }),
      );
      const result = copilotLogin(
        config(),
        { COPILOT_HOME: directory },
        steps,
        input,
        new AbortController().signal,
        "linux",
      );
      subprocess.stdout.write(
        "ABCD-1234 https://github.com/login/device\nSystem keychain unavailable. Store token in plaintext config file? (y/N)",
      );
      await result;
      expect(steps).toHaveBeenCalledWith({
        kind: "input",
        stepId: "plaintext-storage",
        fields: ["confirmPlaintextStorage"],
      });
      expect(input).toHaveBeenCalledOnce();
      expect(fake.spawn).toHaveBeenCalledWith(
        "/usr/bin/script",
        [
          "--quiet",
          "--return",
          "--flush",
          "--command",
          "'/private/copilot'\\''s executable' login --device-code",
          "/dev/null",
        ],
        expect.objectContaining({
          shell: false,
          env: { COPILOT_HOME: directory, TERM: "dumb" },
        }),
      );
    });

    it("supports real keychain storage without requiring plaintext consent", async () => {
      const subprocess = child();
      const input = vi.fn();
      const result = copilotLogin(
        config(),
        {},
        vi.fn(),
        input,
        new AbortController().signal,
        "linux",
      );
      subprocess.stdout.write(
        "ABCD-1234 https://github.com/login/device\nSigned in successfully as expected-user.\n",
      );
      subprocess.emit("exit", 0);
      subprocess.emit("close", 0);
      await result;
      expect(input).not.toHaveBeenCalled();
    });

    it.each([
      "decline",
      "input-error",
      "bad-account",
      "exit-failure",
      "spawn-failure",
      "oversized",
      "abort",
      "no-receipt",
    ])(
      "fails native %s explicitly and cleans the owned process",
      async (mode) => {
        const subprocess = child();
        const controller = new AbortController();
        const input = vi.fn(() => {
          if (mode === "input-error")
            return Promise.reject(new Error("PRIVATE"));
          return Promise.resolve({ confirmPlaintextStorage: "no" });
        });
        const result = copilotLogin(
          config(),
          {},
          vi.fn(),
          input,
          controller.signal,
          "linux",
        );
        if (mode === "decline" || mode === "input-error")
          subprocess.stdout.write(
            "ABCD-1234 https://github.com/login/device\nSystem keychain unavailable. Store token in plaintext config file? (y/N)",
          );
        else if (mode === "abort") controller.abort();
        else if (mode === "spawn-failure")
          subprocess.emit("error", new Error("PRIVATE"));
        else if (mode === "oversized")
          subprocess.stdout.write("x".repeat(33_000));
        else {
          if (mode !== "no-receipt")
            subprocess.stdout.write(
              "ABCD-1234 https://github.com/login/device\nSigned in successfully as other-user.\n",
            );
          subprocess.emit("exit", mode === "exit-failure" ? 1 : 0);
          subprocess.emit("close", mode === "exit-failure" ? 1 : 0);
        }
        await expect(result).rejects.toBeDefined();
        expect(subprocess.stdout.destroyed).toBe(true);
      },
    );

    it("rejects unsupported platforms and already-aborted authentication without spawning", async () => {
      await expect(
        copilotLogin(
          config(),
          {},
          vi.fn(),
          vi.fn(),
          new AbortController().signal,
          "win32",
        ),
      ).rejects.toMatchObject({ code: "auth_native_pty_unsupported" });
      const controller = new AbortController();
      controller.abort();
      await expect(
        copilotLogin(
          config(),
          {},
          vi.fn(),
          vi.fn(),
          controller.signal,
          "linux",
        ),
      ).rejects.toBeDefined();
      expect(fake.spawn).not.toHaveBeenCalled();
    });

    it("kills only the owned Windows PID tree and coalesces shutdown", async () => {
      Object.defineProperty(process, "platform", {
        value: "win32",
        configurable: true,
      });
      child();
      const owned = new AgentProcess("agent", ["argument"], {});
      const stop = owned.stop();
      expect(owned.stop()).toBe(stop);
      await stop;
      expect(fake.execFile).toHaveBeenCalledWith(
        "taskkill.exe",
        ["/PID", "123456", "/T", "/F"],
        expect.objectContaining({ timeout: 3000 }),
        expect.any(Function),
      );
    });

    it("reports Windows cleanup failures without killing by name", async () => {
      Object.defineProperty(process, "platform", {
        value: "win32",
        configurable: true,
      });
      child();
      fake.execFile.mockImplementation(
        (
          _command: unknown,
          _args: unknown,
          _options: unknown,
          callback: (error: unknown) => void,
        ) => {
          callback(new Error("PRIVATE"));
        },
      );
      await expect(
        new AgentProcess("agent", [], {}).stop(),
      ).rejects.toMatchObject({ code: "owned_cleanup_failed" });
    });

    it("terminates the owned POSIX group and ignores ESRCH only", async () => {
      Object.defineProperty(process, "platform", {
        value: "linux",
        configurable: true,
      });
      const subprocess = child();
      const kill = vi.spyOn(process, "kill").mockImplementation(() => {
        subprocess.emit("exit", 0);
        return true;
      });
      await new AgentProcess("agent", [], {}).stop();
      expect(kill).toHaveBeenCalledWith(-123456, "SIGTERM");
      expect(kill).toHaveBeenCalledWith(-123456, "SIGKILL");
      kill.mockImplementation(() => {
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      });
      const ended = child();
      const owned = new AgentProcess("agent", [], {});
      ended.emit("exit", 0);
      await owned.stop();
      kill.mockImplementation(() => {
        throw new Error("PRIVATE");
      });
      await expect(
        new AgentProcess("agent", [], {}).stop(),
      ).rejects.toMatchObject({ code: "owned_cleanup_failed" });
    });

    it("handles spawn errors without assuming a PID exists", async () => {
      const subprocess = child();
      Object.assign(subprocess, { pid: undefined });
      const owned = new AgentProcess("agent", [], {});
      subprocess.emit("error", new Error("PRIVATE"));
      await owned.stop();
      expect(fake.execFile).not.toHaveBeenCalled();
    });
  },
);
