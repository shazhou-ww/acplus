import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import type * as LocalService from "../src/local-service.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/cli-ai.js";
import { run as human } from "../src/cli.js";
import {
  aiArguments,
  aiHelp,
  aiMessage,
  aiResult,
} from "../src/cli-ai-contract.js";
import { ConfigurationError } from "../src/acp-common.js";

const mocks = vi.hoisted(() => ({ terminal: vi.fn(), local: vi.fn() }));
vi.mock("node:readline/promises", () => ({ createInterface: mocks.terminal }));
vi.mock("../src/local-service.js", async (original) => ({
  ...(await original<typeof LocalService>()),
  localService: mocks.local,
}));

const session = "12345678-1234-1234-1234-123456789abc";
const turn = "12345678-1234-1234-1234-123456789abd";
const url = "http://127.0.0.1:1234/v2";
const root = resolve(".cli-ai-tests", randomUUID());
const target = ["--session", session, "--turn", turn];
const ttyDescriptors = [process.stdin, process.stderr].map((stream) => ({
  stream,
  descriptor: Object.getOwnPropertyDescriptor(stream, "isTTY"),
}));
const remote = ["--url", url];
const submit = ["session-send", ...target, "--text", "Hello", ...remote];

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process.stdin, Symbol.asyncIterator).mockImplementation(() => {
    throw new Error("stdin must not be read");
  });
  vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    Promise.resolve(new Response("{}")),
  );
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const { stream, descriptor } of ttyDescriptors) {
    if (descriptor === undefined) Reflect.deleteProperty(stream, "isTTY");
    else Object.defineProperty(stream, "isTTY", descriptor);
  }
  mocks.terminal.mockClear();
  mocks.local.mockClear();
  process.exitCode = undefined;
  await rm(root, { recursive: true, force: true });
});

describe("AI audience contract", () => {
  it("shows all commands/options and recovery in compact complete offline help", async () => {
    await run(["--help"]);
    const help = vi.mocked(console.log).mock.calls[0]?.[0] as string;
    expect(Buffer.byteLength(`${help}\n`)).toBeLessThanOrEqual(8192);
    for (const command of [
      "init",
      "health",
      "agent-list",
      "agent-auth",
      "agent-login",
      "agent-auth-input",
      "agent-logout",
      "session-list",
      "session-create",
      "session-get",
      "session-send",
      "session-delete",
      "turn-list",
      "turn-start",
      "turn-get",
      "turn-cancel",
      "event-list",
    ])
      expect(help).toContain(`acplus-ai ${command}`);
    for (const option of [
      "agent",
      "agent-command",
      "config",
      "profile",
      "login-account",
      "data-dir",
      "port",
      "url",
      "json",
      "confirm-storage",
      "method",
      "wait-ms",
      "idle-grace-ms",
      "input-file",
      "limit",
      "cursor",
      "working-directory",
      "name",
      "session",
      "turn",
      "text",
      "text-file",
      "yes",
      "after",
    ])
      expect(help).toContain(`--${option}`);
    for (const semantic of [
      "unknown",
      "Lost write",
      "NOT execution",
      "Exit 0",
      "2:",
      "action_required",
      "JSON Lines",
      "100..86400000",
      "full lowercase UUID",
    ])
      expect(help).toContain(semantic);
    expect(help).not.toContain("_auto-serve");
    expect(help).not.toMatch(/acplus (agents|sessions|turns|events|serve)/u);
    expect(fetch).not.toHaveBeenCalled();
    expect(aiHelp(["turn-get"])).toContain(
      "turn-get --session UUID --turn UUID",
    );
    expect(aiHelp(["turn-get"])).not.toContain("session-create");
    expect(() => aiHelp(["unknown"])).toThrow("Unknown command");
    await expect(run(["unknown", "--help"])).rejects.toThrow("Unknown command");
    await run([]);
    await run(["-V"]);
    expect(console.log).toHaveBeenLastCalledWith(
      expect.stringMatching(/^acplus-ai \S+ \(HTTP \/v2, ACP v1\)$/u),
    );
  });

  it.each([true, false])(
    "never prompts or reads stdin with TTY=%s",
    async (tty) => {
      for (const { stream } of ttyDescriptors)
        Object.defineProperty(stream, "isTTY", {
          configurable: true,
          value: tty,
        });
      for (const args of [
        ["session-delete", "--session", session, ...remote],
        ["session-send", ...target, "--text-file", "-", ...remote],
        [
          "agent-auth-input",
          "--agent",
          "copilot",
          "--input-file",
          "-",
          ...remote,
        ],
        ["health", "--config", "-"],
        [
          "init",
          "--agent",
          "copilot",
          "--agent-command",
          process.execPath,
          "--config",
          "-",
        ],
      ])
        await expect(run(args)).rejects.toBeInstanceOf(ConfigurationError);
      expect(mocks.terminal).not.toHaveBeenCalled();
      expect(process.stdin[Symbol.asyncIterator]).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(mocks.local).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["sessions", "list"],
    ["serve"],
    ["_auto-serve"],
    ["session-get", "--session", "12345678"],
    ["turn-get", "--session", session, "--turn", "bad"],
    ["session-send", "--session", session, "--text", "hello"],
    ["session-send", ...target, "--text", "hello", "--text-file", "file"],
    ["session-send", ...target],
    ["session-send", ...target, "--text", "hello", "--no-wait"],
    ["session-send", ...target, "--text", "hello", "--timeout-ms", "100"],
    ["turn-start", ...target, "--text", "hello", "--wait-ms", "100"],
    ["session-send", ...target, "--text", "hello", "--wait-ms", "99"],
    [
      "session-send",
      ...target,
      "--text",
      "hello",
      "--wait-ms",
      "100",
      "--wait-ms",
      "200",
    ],
    ["session-delete", session, "--yes"],
    ["health", "--url"],
    ["health", "--json", "--json"],
    ["health", "--unknown", "value"],
  ])("rejects invalid invocation before effects: %j", async (...args) => {
    await expect(run([...args, ...remote])).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.local).not.toHaveBeenCalled();
  });

  it("defaults to one admission, keeps caller's IDs/text and emits exact JSON receipt", async () => {
    const admission = { sessionId: session, turnId: turn, state: "accepted" };
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(admission)));
    await run(submit);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      `${url}/sessions/${session}/turns`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ turnId: turn, text: "Hello" }),
      }),
    );
    expect(console.log).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify(admission),
    );
    expect(console.error).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({
        event: "turn_submitting",
        sessionId: session,
        turnId: turn,
      }),
    );
    expect(mocks.terminal).not.toHaveBeenCalled();
  });

  it("does not mistake message flags for CLI flags/help", async () => {
    for (const message of ["--json", "--help", "--wait-ms"]) {
      vi.mocked(fetch).mockImplementation(() =>
        Promise.resolve(new Response("{}")),
      );
      await run(["turn-start", ...target, "--text", message, ...remote]);
      expect(fetch).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({
          body: JSON.stringify({ turnId: turn, text: message }),
        }),
      );
      expect(console.log).toHaveBeenLastCalledWith("{}");
    }
  });

  it("reads explicit files, rejects malformed auth input, and prints JSON null acknowledgements", async () => {
    await mkdir(root, { recursive: true });
    const file = join(root, "input.json");
    await writeFile(
      file,
      JSON.stringify({ stepId: "step", values: { answer: "yes" } }),
    );
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 202 }));
    await run([
      "agent-auth-input",
      "--agent",
      "copilot",
      "--input-file",
      file,
      ...remote,
    ]);
    expect(console.log).toHaveBeenLastCalledWith("null");
    await writeFile(file, "bad json");
    await expect(
      run([
        "agent-auth-input",
        "--agent",
        "copilot",
        "--input-file",
        file,
        ...remote,
      ]),
    ).rejects.toThrow("Expected JSON auth input");
    await run(["turn-start", ...target, "--text-file", file, ...remote]);
    expect(fetch).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        body: JSON.stringify({ turnId: turn, text: "bad json" }),
      }),
    );
    await run(["session-delete", "--session", session, "--yes", ...remote]);
    expect(console.log).toHaveBeenLastCalledWith(
      JSON.stringify({ sessionId: session, deleted: true }),
    );
  });

  it.each(["complete", "cancelled", "error", "unknown"])(
    "explicit bounded wait returns %s with execution exit semantics",
    async (state) => {
      const result = {
        sessionId: session,
        turnId: turn,
        state,
        response: "answer",
      };
      vi.mocked(fetch)
        .mockResolvedValueOnce(new Response("{}"))
        .mockResolvedValueOnce(new Response(JSON.stringify(result)));
      await run([...submit, "--wait-ms", "100"]);
      expect(console.log).toHaveBeenLastCalledWith(JSON.stringify(result));
      expect(process.exitCode).toBe(state === "complete" ? undefined : 1);
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );

  it("wait timeout preserves receipt, does not cancel/retry and names AI recovery", async () => {
    vi.useFakeTimers();
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response("{}"))
      .mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              sessionId: session,
              turnId: turn,
              state: "running",
              response: "",
            }),
          ),
        ),
      );
    const pending = expect(
      run([...submit, "--wait-ms", "100"]),
    ).rejects.toMatchObject({
      code: "turn_wait_timeout",
      message: expect.stringContaining("acplus-ai turn-get") as unknown,
    });
    await vi.runAllTimersAsync();
    await pending;
    expect(console.log).not.toHaveBeenCalled();
    expect(
      vi
        .mocked(fetch)
        .mock.calls.filter(([, options]) => options?.method === "POST"),
    ).toHaveLength(1);
  });

  it("keeps error/unknown observations successful and preserves model content verbatim", async () => {
    const result = {
      sessionId: session,
      turnId: turn,
      state: "unknown",
      response: "acplus agents auth is quoted content",
    };
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(result)));
    await run(["turn-get", ...target, ...remote]);
    expect(console.log).toHaveBeenCalledExactlyOnceWith(JSON.stringify(result));
    expect(process.exitCode).toBeUndefined();
    const error = { code: "unsupported", message: "Use agents auth." };
    expect(
      aiResult({ flow: { error }, items: [{ error }], payload: { error } }),
    ).toEqual({
      flow: { error: { ...error, message: "Use acplus-ai agent-auth." } },
      items: [{ error: { ...error, message: "Use acplus-ai agent-auth." } }],
      payload: { error },
    });
  });

  it("does not retry a lost write or fall back from explicit URL", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("network lost"));
    await expect(run(submit)).rejects.toThrow("network lost");
    expect(fetch).toHaveBeenCalledOnce();
    expect(mocks.local).not.toHaveBeenCalled();
    expect(console.log).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledOnce();
  });

  it("returns pending login immediately and uses AI-only error guidance", async () => {
    const flow = {
      operationId: "flow",
      status: "pending",
      expiresAt: "2030-01-01",
    };
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(flow)));
    await run(["agent-login", "--agent", "copilot", ...remote]);
    expect(fetch).toHaveBeenCalledOnce();
    expect(console.log).toHaveBeenLastCalledWith(JSON.stringify(flow));
    vi.mocked(fetch).mockResolvedValueOnce(new Response("{}"));
    await expect(
      run(["agent-login", "--agent", "copilot", ...remote]),
    ).rejects.toMatchObject({
      code: "invalid_auth_response",
      message: expect.stringContaining("acplus-ai agent-auth") as unknown,
    });
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            code: "unsupported",
            message: "Use acplus agents auth or agents login.",
          },
        }),
        { status: 409 },
      ),
    );
    await expect(
      run(["agent-auth", "--agent", "copilot", ...remote]),
    ).rejects.toMatchObject({
      code: "unsupported",
      status: 409,
      message: "Use acplus-ai agent-auth or acplus-ai agent-login.",
    });
  });

  it("bounds login waiting and never collects storage consent implicitly", async () => {
    const flow = {
      operationId: "flow",
      status: "action_required",
      expiresAt: "2030-01-01",
      step: {
        kind: "input",
        stepId: "consent",
        fields: ["confirmPlaintextStorage"],
      },
    };
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(flow)));
    await run([
      "agent-login",
      "--agent",
      "copilot",
      "--wait-ms",
      "100",
      ...remote,
    ]);
    expect(fetch).toHaveBeenCalledOnce();
    expect(console.log).toHaveBeenLastCalledWith(JSON.stringify(flow));
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ agentId: "copilot", flow })),
    );
    await run(["agent-auth", "--agent", "copilot", ...remote]);
    expect(fetch).toHaveBeenCalledTimes(2);
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ agentId: "copilot", flow })),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            agentId: "copilot",
            flow: { ...flow, status: "pending" },
          }),
        ),
      );
    await run([
      "agent-auth",
      "--agent",
      "copilot",
      "--confirm-storage",
      "no",
      ...remote,
    ]);
    expect(fetch).toHaveBeenNthCalledWith(
      4,
      `${url}/agents/copilot/auth/input`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          stepId: "consent",
          values: { confirmPlaintextStorage: "no" },
        }),
      }),
    );
  });

  it("shares remote capability/results with the compatible Human JSON path", async () => {
    for (const [ai, grouped] of [
      [["agent-list"], ["agents", "list"]],
      [
        ["session-list", "--limit", "1", "--cursor", "opaque"],
        ["sessions", "list", "--limit", "1", "--cursor", "opaque"],
      ],
      [
        ["session-create", "--agent", "copilot", "--working-directory", "."],
        [
          "sessions",
          "create",
          "--agent",
          "copilot",
          "--working-directory",
          ".",
        ],
      ],
      [
        ["event-list", ...target, "--after", "1", "--limit", "2"],
        ["events", "list", ...target, "--after", "1", "--limit", "2"],
      ],
      [
        ["turn-cancel", ...target],
        ["turns", "cancel", ...target],
      ],
      [
        ["agent-logout", "--agent", "copilot"],
        ["agents", "logout", "--agent", "copilot"],
      ],
    ]) {
      vi.mocked(fetch).mockImplementation(() =>
        Promise.resolve(new Response("{}")),
      );
      await run([...(ai ?? []), ...remote]);
      const call = vi.mocked(fetch).mock.lastCall;
      await human([...(grouped ?? []), ...remote, "--json"]);
      expect(vi.mocked(fetch).mock.lastCall?.[0]).toEqual(call?.[0]);
      expect(vi.mocked(fetch).mock.lastCall?.[1]).toMatchObject({
        method: call?.[1]?.method,
        ...(call?.[1]?.body === undefined ? {} : { body: call[1].body }),
      });
      expect(console.log).toHaveBeenLastCalledWith("{}");
    }
    expect(aiArguments(["health", "--json"])).toEqual(["health", "--json"]);
    expect(
      aiMessage(
        'Supply exactly one message: --text TEXT, --text-file FILE|-, or sessions send SESSION "MESSAGE"',
      ),
    ).toBe("Supply exactly one message: --text TEXT or --text-file FILE");
  });
});
