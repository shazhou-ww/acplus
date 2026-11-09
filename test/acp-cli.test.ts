import {
  access,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type * as Os from "node:os";
import type * as LocalService from "../src/local-service.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";
import { ConfigurationError, ServiceError } from "../src/acp-common.js";
import { run } from "../src/cli.js";
import { Store } from "../src/acp-store.js";
import { fixtureConfig } from "./acp-fixture.js";

const mocks = vi.hoisted(() => ({
  home: vi.fn<() => string>(),
  close: vi.fn<() => Promise<void>>(),
  start:
    vi.fn<
      (config: unknown) => Promise<{ url: string; close(): Promise<void> }>
    >(),
  local: vi.fn(),
  question: vi.fn<(query: string) => Promise<string>>(),
  terminalClose: vi.fn<() => void>(),
}));
vi.mock("node:os", async (original) => {
  const actual = await original<typeof Os>();
  return { ...actual, homedir: mocks.home };
});
vi.mock("../src/acp-server.js", () => ({
  start: mocks.start,
  startManaged: mocks.start,
}));
vi.mock("../src/local-service.js", async (original) => {
  const actual = await original<typeof LocalService>();
  return { ...actual, localService: mocks.local };
});
vi.mock("node:readline/promises", () => ({
  createInterface: () => ({
    question: mocks.question,
    close: mocks.terminalClose,
  }),
}));
const roots: string[] = [];
beforeEach(() => {
  mocks.home.mockReturnValue(tmpdir());
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    Promise.resolve(
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
  mocks.close.mockResolvedValue();
  mocks.start.mockImplementation(() =>
    Promise.resolve({
      url: "http://127.0.0.1:1234/v2",
      close: mocks.close,
    }),
  );
  mocks.local.mockResolvedValue({
    dataDir: "local",
    url,
    token: "0".repeat(64),
  });
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  mocks.start.mockClear();
  mocks.close.mockReset();
  mocks.local.mockReset();
  mocks.question.mockReset();
  mocks.terminalClose.mockReset();
  process.exitCode = undefined;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function root() {
  const value = await mkdtemp(join(tmpdir(), "acplus-cli-"));
  roots.push(value);
  return value;
}
const url = "http://127.0.0.1:1234/v2";
const session = "12345678-1234-1234-1234-123456789abc";
const turn = "12345678-1234-1234-1234-123456789abd";

describe("acplus CLI", () => {
  it("sends an optional Session display name without treating it as an identifier", async () => {
    await run([
      "sessions",
      "create",
      "--agent",
      "copilot",
      "--working-directory",
      "D:\\project",
      "--name",
      "Project review",
      "--url",
      url,
      "--json",
    ]);
    expect(fetch).toHaveBeenLastCalledWith(
      `${url}/sessions`,
      expect.objectContaining({
        body: JSON.stringify({
          agentId: "copilot",
          workingDirectory: "D:\\project",
          name: "Project review",
        }),
      }),
    );
    await expect(
      run([
        "sessions",
        "create",
        "--agent",
        "copilot",
        "--working-directory",
        "D:\\project",
        "--name",
        " ",
        "--url",
        url,
      ]),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      run(["sessions", "get", "--session", "Project review", "--url", url]),
    ).rejects.toThrow("Session must be a UUID");
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("generates Turn IDs before dispatch and accepts direct text without contaminating JSON stdout", async () => {
    await run([
      "turns",
      "start",
      "--session",
      session,
      "--text",
      "--help",
      "--url",
      url,
      "--json",
    ]);
    const request = vi.mocked(fetch).mock.calls[0];
    const raw = request?.[1]?.body;
    if (typeof raw !== "string") throw new Error("Missing request body");
    const body: unknown = JSON.parse(raw);
    if (
      typeof body !== "object" ||
      body === null ||
      !("turnId" in body) ||
      typeof body.turnId !== "string"
    )
      throw new Error("Missing generated ID");
    expect(body).toHaveProperty("text", "--help");
    expect(body.turnId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(console.error).toHaveBeenCalledWith(
      JSON.stringify({
        event: "turn_submitting",
        sessionId: session,
        turnId: body.turnId,
      }),
    );
    expect(console.log).toHaveBeenCalledExactlyOnceWith("{}");
    expect(fetch).toHaveBeenCalledOnce();
    vi.mocked(fetch).mockRejectedValueOnce(new Error("lost response"));
    await expect(
      run([
        "turns",
        "start",
        "--session",
        session,
        "--text",
        "hello",
        "--url",
        url,
      ]),
    ).rejects.toThrow("lost response");
    expect(console.error).toHaveBeenLastCalledWith(
      expect.stringContaining("Keep these IDs"),
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("sends a positional message, waits for completion and prints only the answer", async () => {
    const current = {
      sessionId: session,
      turnId: turn,
      state: "complete",
      response: "Hello!",
      error: null,
    };
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ...current, state: "accepted" })),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(current)));
    await run([
      "sessions",
      "send",
      session,
      "hello",
      "--turn",
      turn,
      "--url",
      url,
    ]);
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      `${url}/sessions/${session}/turns`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ turnId: turn, text: "hello" }),
      }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      `${url}/sessions/${session}/turns/${turn}`,
      expect.objectContaining({ method: "GET" }),
    );
    expect(console.log).toHaveBeenCalledExactlyOnceWith("Hello!");
    vi.mocked(console.log).mockClear();
    vi.mocked(fetch).mockResolvedValueOnce(new Response("{}"));
    await run([
      "sessions",
      "send",
      session,
      "hello",
      "--url",
      url,
      "--no-wait",
      "--json",
    ]);
    expect(console.log).toHaveBeenCalledExactlyOnceWith("{}");
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("preserves terminal error and unknown outcomes, validates wait results and never resends", async () => {
    for (const state of ["error", "cancelled", "unknown", "complete"]) {
      vi.mocked(console.log).mockClear();
      const current = {
        sessionId: session,
        turnId: turn,
        state,
        response: "",
        error:
          state === "error"
            ? { code: "agent_auth_required", message: "login required" }
            : null,
      };
      vi.mocked(fetch)
        .mockResolvedValueOnce(new Response("{}"))
        .mockResolvedValueOnce(new Response(JSON.stringify(current)));
      process.exitCode = undefined;
      await run([
        "sessions",
        "send",
        "--session",
        session,
        "--text",
        "hello",
        "--turn",
        turn,
        "--url",
        url,
        "--json",
      ]);
      expect(console.log).toHaveBeenCalledExactlyOnceWith(
        JSON.stringify(current),
      );
      expect(process.exitCode).toBe(state === "complete" ? undefined : 1);
    }
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response("{}"))
      .mockResolvedValueOnce(new Response("{}"));
    await expect(
      run(["sessions", "send", session, "hello", "--turn", turn, "--url", url]),
    ).rejects.toMatchObject({ code: "invalid_turn_response" });
    expect(fetch).toHaveBeenCalledTimes(10);
  });

  it("bounds waiting without cancelling or silently resending an admitted Turn", async () => {
    vi.useFakeTimers();
    const running = {
      sessionId: session,
      turnId: turn,
      state: "running",
      response: "",
      error: null,
    };
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(running)));
    vi.mocked(fetch).mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify(running))),
    );
    const waiting = expect(
      run([
        "sessions",
        "send",
        session,
        "hello",
        "--turn",
        turn,
        "--timeout-ms",
        "100",
        "--url",
        url,
      ]),
    ).rejects.toMatchObject({ code: "turn_wait_timeout" });
    await vi.advanceTimersByTimeAsync(200);
    await waiting;
    expect(
      vi
        .mocked(fetch)
        .mock.calls.filter(([, options]) => options?.method === "POST"),
    ).toHaveLength(1);
    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(
          ([target]) =>
            typeof target === "string" && target.includes("/cancel"),
        ),
    ).toBe(false);
  });

  it("resolves unique remote Session prefixes across pages and rejects ambiguity", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [], nextCursor: "page2" })),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ items: [{ sessionId: session }], nextCursor: null }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            sessionId: session,
            agentId: "copilot",
            workingDirectory: "C:\\project",
          }),
        ),
      );
    await run([
      "sessions",
      "get",
      "--session",
      session.slice(0, 12),
      "--url",
      url,
    ]);
    expect(fetch).toHaveBeenLastCalledWith(
      `${url}/sessions/${session}`,
      expect.anything(),
    );
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          items: [{ sessionId: session }, { sessionId: turn }],
          nextCursor: null,
        }),
      ),
    );
    await expect(
      run(["sessions", "get", "--session", session.slice(0, 8), "--url", url]),
    ).rejects.toMatchObject({ code: "session_selector_ambiguous" });
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ items: [], nextCursor: null })),
    );
    await expect(
      run(["sessions", "get", "--session", "aaaaaaaa", "--url", url]),
    ).rejects.toMatchObject({ code: "session_not_found" });
    await expect(
      run(["sessions", "get", "--session", "short", "--url", url]),
    ).rejects.toThrow(ConfigurationError);
    vi.mocked(fetch).mockResolvedValueOnce(new Response("{}"));
    await expect(
      run(["sessions", "get", "--session", "aaaaaaaa", "--url", url]),
    ).rejects.toMatchObject({ code: "invalid_history_response" });
  });

  it("resolves local prefixes without a server and renders human records by default", async () => {
    vi.stubEnv("ACPLUS_URL", undefined);
    const directory = await root();
    const config = fixtureConfig(directory);
    const file = join(directory, "config.yaml");
    await writeFile(file, stringify(config));
    const store = new Store(join(config.dataDir, "sessions.sqlite"));
    const created = store.createSession("copilot", directory, "profile");
    store.close();
    await run([
      "sessions",
      "get",
      "--session",
      created.sessionId.slice(0, 12),
      "--config",
      file,
    ]);
    expect(console.log).toHaveBeenLastCalledWith(
      expect.stringContaining(`Session: ${created.sessionId}`),
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.local).not.toHaveBeenCalled();
    await run(["sessions", "list", "--config", file, "--json"]);
    expect(console.log).toHaveBeenLastCalledWith(
      expect.stringContaining('"items":['),
    );
  });

  it("deletes only after explicit confirmation and returns structured JSON when requested", async () => {
    await expect(
      run(["sessions", "delete", session, "--url", url]),
    ).rejects.toThrow("requires --yes");
    expect(fetch).not.toHaveBeenCalled();
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 204 }));
    await run(["sessions", "delete", session, "--yes", "--json", "--url", url]);
    expect(fetch).toHaveBeenLastCalledWith(
      `${url}/sessions/${session}`,
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(console.log).toHaveBeenLastCalledWith(
      JSON.stringify({ sessionId: session, deleted: true }),
    );
  });

  it("requires explicit interactive deletion consent and always closes the prompt", async () => {
    const input = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    const output = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });
    Object.defineProperty(process.stderr, "isTTY", {
      value: true,
      configurable: true,
    });
    try {
      mocks.question.mockResolvedValueOnce("no");
      await expect(
        run(["sessions", "delete", session, "--url", url]),
      ).rejects.toThrow("Deletion cancelled");
      expect(fetch).not.toHaveBeenCalled();
      expect(mocks.terminalClose).toHaveBeenCalledOnce();
      mocks.question.mockResolvedValueOnce("yes");
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(null, { status: 204 }),
      );
      await run(["sessions", "delete", session, "--url", url]);
      expect(console.log).toHaveBeenLastCalledWith(
        "Session and local history deleted.",
      );
      expect(mocks.terminalClose).toHaveBeenCalledTimes(2);
    } finally {
      if (input) Object.defineProperty(process.stdin, "isTTY", input);
      else Reflect.deleteProperty(process.stdin, "isTTY");
      if (output) Object.defineProperty(process.stderr, "isTTY", output);
      else Reflect.deleteProperty(process.stderr, "isTTY");
    }
  });

  it("honors the wait deadline during HTTP reads and preserves early transport failures", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response("{}"))
      .mockImplementationOnce(() => {
        clock.mockReturnValue(1101);
        return Promise.reject(new Error("read timed out"));
      });
    await expect(
      run([
        "sessions",
        "send",
        session,
        "hello",
        "--turn",
        turn,
        "--timeout-ms",
        "100",
        "--url",
        url,
      ]),
    ).rejects.toMatchObject({ code: "turn_wait_timeout" });
    expect(timeout).toHaveBeenNthCalledWith(2, 100);
    clock.mockReturnValue(2000);
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response("{}"))
      .mockRejectedValueOnce(new Error("connection lost"));
    await expect(
      run(["sessions", "send", session, "hello", "--turn", turn, "--url", url]),
    ).rejects.toThrow("connection lost");
    expect(
      vi
        .mocked(fetch)
        .mock.calls.filter(([, options]) => options?.method === "POST"),
    ).toHaveLength(2);
  });

  it("uses local auth service discovery but never invents an owner for health or auth input", async () => {
    vi.stubEnv("ACPLUS_URL", undefined);
    const directory = await root();
    const file = join(directory, "config.yaml");
    await writeFile(file, stringify(fixtureConfig(directory)));
    await run([
      "agents",
      "login",
      "--agent",
      "copilot",
      "--method",
      "native-login",
      "--config",
      file,
    ]);
    expect(mocks.local).toHaveBeenLastCalledWith(
      expect.anything(),
      file,
      30000,
      true,
    );
    await run(["agents", "auth", "--agent", "copilot", "--config", file]);
    expect(mocks.local).toHaveBeenLastCalledWith(
      expect.anything(),
      file,
      30000,
      true,
    );
    await run(["agents", "list", "--config", file]);
    await run(["health", "--config", file]);
    expect(mocks.local).toHaveBeenLastCalledWith(
      expect.anything(),
      file,
      30000,
      false,
    );
    const inputFile = join(directory, "input.json");
    await writeFile(inputFile, "{}");
    await run([
      "agents",
      "auth-input",
      "--agent",
      "copilot",
      "--input-file",
      inputFile,
      "--config",
      file,
    ]);
    expect(mocks.local).toHaveBeenLastCalledWith(
      expect.anything(),
      file,
      30000,
      false,
    );
  });

  it("provides focused subcommand help and rejects ambiguous input and boolean options", async () => {
    await run(["sessions", "send", "--help"]);
    expect(console.log).toHaveBeenLastCalledWith(
      expect.stringContaining('sessions send SESSION "MESSAGE"'),
    );
    expect(console.log).toHaveBeenLastCalledWith(
      expect.not.stringContaining("agents logout"),
    );
    await run(["sessions", "--help"]);
    await run(["turns", "get", "--help"]);
    expect(console.log).toHaveBeenLastCalledWith(
      expect.stringContaining("turns get --session SESSION --turn UUID"),
    );
    await expect(run(["unknown", "--help"])).rejects.toThrow(
      ConfigurationError,
    );
    for (const args of [
      ["sessions", "send", session],
      [
        "turns",
        "start",
        "--session",
        session,
        "--text",
        "x",
        "--text-file",
        "-",
      ],
      ["sessions", "send", session, "hello", "--json", "--json"],
      ["sessions", "send", session, "hello", "--no-wait", "true"],
      ["sessions", "send", session, "hello", "--timeout-ms", "0"],
    ])
      await expect(run([...args, "--url", url])).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("reports missing command arguments before accessing local configuration or starting a service", async () => {
    vi.stubEnv("ACPLUS_URL", undefined);
    for (const args of [
      ["turns", "get"],
      ["sessions", "send", "--text", "hello"],
      ["sessions", "delete", "--yes"],
      ["agents", "login"],
    ])
      await expect(
        run([...args, "--config", "nonexistent.yaml"]),
      ).rejects.toThrow("is required");
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.local).not.toHaveBeenCalled();
  });

  it("rejects idle grace on commands that cannot launch a service", async () => {
    for (const args of [
      ["sessions", "list"],
      ["sessions", "get", "--session", session],
      ["turns", "get", "--session", session, "--turn", turn],
      ["turns", "cancel", "--session", session, "--turn", turn],
      ["events", "list", "--session", session],
    ])
      await expect(run([...args, "--idle-grace-ms", "100"])).rejects.toThrow(
        ConfigurationError,
      );
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("routes local writes through discovered ownership without broadening URL-only commands", async () => {
    vi.stubEnv("ACPLUS_URL", undefined);
    const directory = await root();
    const file = join(directory, "config.yaml");
    await writeFile(file, stringify(fixtureConfig(directory)));
    await run([
      "sessions",
      "create",
      "--config",
      file,
      "--data-dir",
      join(directory, "override"),
      "--idle-grace-ms",
      "500",
      "--agent",
      "copilot",
      "--working-directory",
      directory,
    ]);
    expect(mocks.local).toHaveBeenLastCalledWith(
      expect.objectContaining({ dataDir: join(directory, "override") }),
      file,
      500,
      true,
    );
    const request = vi.mocked(fetch).mock.calls.at(-1);
    expect(request?.[0]).toBe(url + "/sessions");
    const headers = new Headers(request?.[1]?.headers);
    expect(headers.get("x-acplus-signature")).toMatch(/^[a-f0-9]{64}$/u);
    await run([
      "turns",
      "cancel",
      "--config",
      file,
      "--session",
      session,
      "--turn",
      turn,
    ]);
    expect(mocks.local).toHaveBeenLastCalledWith(
      expect.anything(),
      file,
      30000,
      false,
    );
    mocks.local.mockRejectedValueOnce(
      new ServiceError("local_work_owner_unavailable", 409),
    );
    await expect(
      run([
        "turns",
        "cancel",
        "--config",
        file,
        "--session",
        session,
        "--turn",
        turn,
      ]),
    ).rejects.toMatchObject({ code: "local_work_owner_unavailable" });
    await expect(
      run([
        "sessions",
        "create",
        "--config",
        file,
        "--idle-grace-ms",
        "0",
        "--agent",
        "copilot",
        "--working-directory",
        directory,
      ]),
    ).rejects.toMatchObject({ code: "invalid_input" });
    for (const args of [
      ["health"],
      ["agents", "list"],
      ["agents", "auth", "--agent", "copilot"],
    ])
      await expect(run(args)).rejects.toThrow(ConfigurationError);
    mocks.local.mockClear();
    vi.stubEnv("ACPLUS_URL", url);
    await run([
      "sessions",
      "create",
      "--config",
      "does-not-exist",
      "--agent",
      "copilot",
      "--working-directory",
      directory,
    ]);
    expect(mocks.local).not.toHaveBeenCalled();
  });
  it("starts a managed child on ephemeral loopback only and detaches its startup IPC", async () => {
    const directory = await root();
    const file = join(directory, "config.yaml");
    const config = fixtureConfig(directory);
    await writeFile(file, stringify(config));
    vi.spyOn(process, "once").mockImplementation(() => process);
    if (process.disconnect !== undefined)
      vi.spyOn(process, "disconnect").mockImplementation(() => {});
    await run([
      "_auto-serve",
      "--config",
      file,
      "--data-dir",
      join(directory, "override"),
      "--idle-grace-ms",
      "100",
    ]);
    expect(mocks.start).toHaveBeenLastCalledWith(
      expect.objectContaining({
        dataDir: join(directory, "override"),
        listen: { host: "127.0.0.1", port: 0 },
      }),
      100,
    );
    await expect(
      run(["serve", "--config", file, "--idle-grace-ms", "100"]),
    ).rejects.toThrow(ConfigurationError);
  });
  it("prints offline help and rejects unknown or malformed options", async () => {
    await run([]);
    await run(["--help"]);
    await run(["--version"]);
    await run(["-V"]);
    expect(console.log).toHaveBeenCalled();
    for (const args of [
      ["wrong"],
      ["sessions", "wrong"],
      ["health", "--url"],
      ["health", "--url", url, "--url", url],
      ["sessions", "get", "--url", url],
      ["health", "--unknown", "x"],
      ["health", "url", url],
      ["health", "--url", "--bad"],
      ["sessions", "get", "--url", url, "--agent", "unused"],
    ])
      await expect(run(args)).rejects.toThrow(ConfigurationError);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("validates explicit HTTP v2 URLs and environment fallback", async () => {
    for (const address of [
      "",
      "ftp://host/v2",
      "http://user:password@host/v2",
      "http://host/v1",
      url + "?key=secret",
      url + "#x",
    ])
      await expect(run(["health", "--url", address])).rejects.toThrow(
        ConfigurationError,
      );
    vi.stubEnv("ACPLUS_URL", url);
    await run(["health"]);
    expect(fetch).toHaveBeenCalledWith(url + "/health", expect.anything());
    vi.mocked(fetch).mockImplementationOnce(() =>
      Promise.resolve(new Response(null, { status: 204 })),
    );
    await run(["health", "--url", url + "/"]);
    vi.mocked(fetch).mockImplementationOnce(() =>
      Promise.resolve(new Response('{"error":"failed"}', { status: 409 })),
    );
    await expect(run(["health", "--url", url])).rejects.toThrow(ServiceError);
    vi.mocked(fetch).mockImplementationOnce(() =>
      Promise.resolve(new Response("not-json", { status: 200 })),
    );
    await expect(run(["health", "--url", url])).rejects.toMatchObject({
      code: "invalid_http_response",
    });
  });
  it("does not reuse the old command's environment variable", async () => {
    vi.stubEnv("ACPLUS_URL", undefined);
    vi.stubEnv("AHPLEX_URL", url);
    await expect(run(["health"])).rejects.toThrow(ConfigurationError);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("uses the exact Agent auth and catalogue routes", async () => {
    const directory = await root();
    const file = join(directory, "input.json");
    await writeFile(
      file,
      JSON.stringify({
        stepId: "step",
        values: { confirmPlaintextStorage: "yes" },
      }),
    );
    const commands = [
      { args: ["agents", "list"], path: "/agents", method: "GET" },
      {
        args: ["agents", "auth", "--agent", "copilot"],
        path: "/agents/copilot/auth",
        method: "GET",
      },
      {
        args: [
          "agents",
          "login",
          "--agent",
          "copilot",
          "--method",
          "native-login",
        ],
        path: "/agents/copilot/auth",
        method: "POST",
      },
      {
        args: [
          "agents",
          "auth-input",
          "--agent",
          "copilot",
          "--input-file",
          file,
        ],
        path: "/agents/copilot/auth/input",
        method: "POST",
      },
      {
        args: ["agents", "logout", "--agent", "copilot"],
        path: "/agents/copilot/auth/logout",
        method: "POST",
      },
    ];
    for (const command of commands) {
      await run([...command.args, "--url", url]);
      expect(fetch).toHaveBeenLastCalledWith(
        url + command.path,
        expect.objectContaining({ method: command.method }),
      );
    }
    await writeFile(file, "bad");
    await expect(
      run([
        "agents",
        "auth-input",
        "--agent",
        "copilot",
        "--input-file",
        file,
        "--url",
        url,
      ]),
    ).rejects.toThrow(ConfigurationError);
  });
  it("routes Sessions, Turns and filtered event pagination", async () => {
    const directory = await root();
    const prompt = join(directory, "prompt.txt");
    await writeFile(prompt, "OK");
    const commands = [
      {
        args: [
          "sessions",
          "list",
          "--agent",
          "copilot",
          "--limit",
          "1",
          "--cursor",
          "next",
        ],
        path: "/sessions?agentId=copilot&limit=1&cursor=next",
      },
      {
        args: [
          "sessions",
          "create",
          "--agent",
          "copilot",
          "--working-directory",
          directory,
        ],
        path: "/sessions",
      },
      {
        args: ["sessions", "get", "--session", session],
        path: `/sessions/${session}`,
      },
      {
        args: ["turns", "list", "--session", session],
        path: `/sessions/${session}/turns`,
      },
      {
        args: [
          "turns",
          "start",
          "--session",
          session,
          "--turn",
          turn,
          "--text-file",
          prompt,
        ],
        path: `/sessions/${session}/turns`,
      },
      {
        args: ["turns", "get", "--session", session, "--turn", turn],
        path: `/sessions/${session}/turns/${turn}`,
      },
      {
        args: ["turns", "cancel", "--session", session, "--turn", turn],
        path: `/sessions/${session}/turns/${turn}/cancel`,
      },
      {
        args: [
          "events",
          "list",
          "--session",
          session,
          "--turn",
          turn,
          "--after",
          "42",
          "--limit",
          "100",
        ],
        path: `/sessions/${session}/events?turnId=${turn}&after=42&limit=100`,
      },
      {
        args: ["events", "list", "--session", session],
        path: `/sessions/${session}/events`,
      },
    ];
    for (const command of commands) {
      await run([...command.args, "--url", url]);
      expect(fetch).toHaveBeenLastCalledWith(
        url + command.path,
        expect.anything(),
      );
    }
  });
  it("creates exclusive configuration without installing or launching", async () => {
    const directory = await root();
    const file = join(directory, "config.yaml");
    await run([
      "init",
      "--agent",
      "copilot",
      "--agent-command",
      process.execPath,
      "--config",
      file,
      "--data-dir",
      join(directory, "data"),
      "--profile",
      join(directory, "profile"),
      "--login-account",
      "wewei",
      "--port",
      "0",
    ]);
    const config: unknown = parse(await readFile(file, "utf8"));
    expect(await readFile(file, "utf8")).not.toContain("workspaces:");
    expect(config).toMatchObject({
      schemaVersion: 2,
      agents: [
        {
          id: "copilot",
          label: "copilot",
          authentication: { loginAccount: "wewei" },
        },
      ],
    });
    await expect(
      run([
        "init",
        "--agent",
        "copilot",
        "--agent-command",
        process.execPath,
        "--config",
        file,
      ]),
    ).rejects.toThrow(ConfigurationError);
    await expect(
      run([
        "init",
        "--agent",
        "copilot",
        "--agent-command",
        join(directory, "missing"),
        "--config",
        file,
      ]),
    ).rejects.toThrow(ConfigurationError);
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it("rejects the removed init workspace option instead of ignoring it", async () => {
    const directory = await root();
    const file = join(directory, "config.yaml");
    await expect(
      run([
        "init",
        "--agent",
        "copilot",
        "--agent-command",
        process.execPath,
        "--workspace",
        directory,
        "--config",
        file,
      ]),
    ).rejects.toThrow(ConfigurationError);
    await expect(access(file)).rejects.toMatchObject({ code: "ENOENT" });
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it("uses the supplied Agent ID and label rather than inferring them from the executable", async () => {
    const directory = await root();
    mocks.home.mockReturnValue(directory);
    await run([
      "init",
      "--agent",
      "review_agent-2",
      "--agent-command",
      process.execPath,
      "--json",
    ]);
    const file = join(directory, ".acplus", "acplus.yaml");
    const config: unknown = parse(await readFile(file, "utf8"));
    expect(config).toMatchObject({
      agents: [
        {
          id: "review_agent-2",
          label: "review_agent-2",
          command: process.execPath,
          profileDir: join(directory, ".acplus", "review_agent-2-profile"),
        },
      ],
    });
    expect(console.log).toHaveBeenLastCalledWith(
      JSON.stringify({ config: file }),
    );
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.local).not.toHaveBeenCalled();
  });
  it("rejects missing, invalid or repeated Agent IDs without creating configuration", async () => {
    const directory = await root();
    mocks.home.mockReturnValue(directory);
    const file = join(directory, "config.yaml");
    await expect(
      run(["init", "--agent-command", process.execPath, "--config", file]),
    ).rejects.toThrow("Required options: agent, agent-command");
    await expect(
      run([
        "init",
        "--agent",
        "copilot",
        "--agent",
        "other",
        "--agent-command",
        process.execPath,
        "--config",
        file,
      ]),
    ).rejects.toThrow(ConfigurationError);
    for (const id of [
      "",
      "../profile",
      "-invalid",
      "agent with spaces",
      "x".repeat(65),
    ])
      await expect(
        run([
          "init",
          "--agent",
          id,
          "--agent-command",
          process.execPath,
          "--config",
          file,
        ]),
      ).rejects.toThrow(ConfigurationError);
    await expect(access(file)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(directory, ".acplus"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it("initializes YAML under the user home and serves it without --config", async () => {
    const directory = await root();
    mocks.home.mockReturnValue(directory);
    const home = join(directory, ".acplus");
    const file = join(home, "acplus.yaml");
    await run([
      "init",
      "--agent",
      "copilot",
      "--agent-command",
      process.execPath,
    ]);
    const raw = await readFile(file, "utf8");
    expect(raw).toContain("schemaVersion: 2");
    expect(raw).not.toMatch(/^\{/u);
    const config: unknown = parse(raw);
    expect(config).toMatchObject({
      dataDir: join(home, "state"),
      agents: [{ profileDir: join(home, "copilot-profile") }],
    });
    await expect(access(join(home, "state"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(access(join(home, "copilot-profile"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    if (process.platform !== "win32") {
      expect((await stat(home)).mode & 0o777).toBe(0o700);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    }
    await expect(
      run(["init", "--agent", "copilot", "--agent-command", process.execPath]),
    ).rejects.toThrow(ConfigurationError);
    vi.spyOn(process, "once").mockImplementation(() => process);
    await run(["serve"]);
    expect(mocks.start).toHaveBeenCalledWith(config);
  });
  it("does not scan the working directory or create a home config while serving", async () => {
    const directory = await root();
    mocks.home.mockReturnValue(directory);
    await expect(run(["serve"])).rejects.toThrow(
      "Cannot read a valid YAML configuration",
    );
    expect(mocks.start).not.toHaveBeenCalled();
    await expect(access(join(directory, ".acplus"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const configFile = join(directory, "custom.yaml");
    const config = fixtureConfig(directory);
    await writeFile(configFile, stringify(config));
    vi.spyOn(process, "once").mockImplementation(() => process);
    await run(["serve", "--config", configFile]);
    expect(mocks.start).toHaveBeenCalledWith(config);
    await expect(access(join(directory, ".acplus"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      run([
        "init",
        "--agent",
        "copilot",
        "--agent-command",
        process.execPath,
        "--config",
        join(directory, "missing", "custom.yaml"),
      ]),
    ).rejects.toThrow(ConfigurationError);
  });
  it("keeps explicit data/profile overrides and reads YAML config from stdin", async () => {
    const directory = await root();
    mocks.home.mockReturnValue(directory);
    const dataDir = join(directory, "chosen-state");
    const profileDir = join(directory, "chosen-profile");
    await run([
      "init",
      "--agent",
      "copilot",
      "--agent-command",
      process.execPath,
      "--data-dir",
      dataDir,
      "--profile",
      profileDir,
    ]);
    const config: unknown = parse(
      await readFile(join(directory, ".acplus", "acplus.yaml"), "utf8"),
    );
    expect(config).toMatchObject({ dataDir, agents: [{ profileDir }] });
    vi.spyOn(process.stdin, Symbol.asyncIterator).mockImplementation(
      async function* () {
        yield await Promise.resolve(Buffer.from(stringify(config)));
        return undefined;
      },
    );
    vi.spyOn(process, "once").mockImplementation(() => process);
    await run(["serve", "--config", "-"]);
    expect(mocks.start).toHaveBeenCalledWith(config);
  });
  it("starts only the explicit service and handles its shutdown once", async () => {
    const directory = await root();
    const file = join(directory, "config.json");
    await writeFile(file, JSON.stringify(fixtureConfig(directory)));
    const callbacks: (() => void)[] = [];
    const original = process.once.bind(process);
    vi.spyOn(process, "once").mockImplementation((event, listener) => {
      if (event === "SIGINT" || event === "SIGTERM") {
        callbacks.push(() => {
          listener();
        });
        return process;
      }
      return original(event, listener);
    });
    await run([
      "serve",
      "--config",
      file,
      "--port",
      "0",
      "--listen-host",
      "127.0.0.1",
      "--data-dir",
      join(directory, "override"),
    ]);
    expect(mocks.start).toHaveBeenCalledWith(
      expect.objectContaining({ dataDir: join(directory, "override") }),
    );
    callbacks[0]?.();
    callbacks[1]?.();
    await Promise.resolve();
    expect(mocks.close).toHaveBeenCalledTimes(1);
    mocks.close.mockRejectedValueOnce(new ServiceError("cleanup_failed", 503));
    await run(["serve", "--config", file]);
    callbacks[2]?.();
    await Promise.resolve();
    expect(process.exitCode).toBe(1);
  });
  it("reads bounded stdin for prompts and rejects malformed streamed input", async () => {
    vi.spyOn(process.stdin, Symbol.asyncIterator).mockImplementation(
      async function* () {
        yield await Promise.resolve(Buffer.from("OK"));
        return undefined;
      },
    );
    await run([
      "turns",
      "start",
      "--session",
      session,
      "--turn",
      turn,
      "--text-file",
      "-",
      "--url",
      url,
    ]);
    expect(fetch).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        body: JSON.stringify({ turnId: turn, text: "OK" }),
      }),
    );
    vi.spyOn(process.stdin, Symbol.asyncIterator).mockImplementation(
      async function* () {
        yield await Promise.resolve(Buffer.alloc(1048577));
        return undefined;
      },
    );
    await expect(
      run([
        "turns",
        "start",
        "--session",
        session,
        "--turn",
        turn,
        "--text-file",
        "-",
        "--url",
        url,
      ]),
    ).rejects.toThrow(ConfigurationError);
    vi.spyOn(process.stdin, Symbol.asyncIterator).mockImplementation(
      async function* () {
        yield await Promise.resolve("not-buffer");
        return undefined;
      },
    );
    await expect(
      run([
        "turns",
        "start",
        "--session",
        session,
        "--turn",
        turn,
        "--text-file",
        "-",
        "--url",
        url,
      ]),
    ).rejects.toThrow(ConfigurationError);
  });
});
