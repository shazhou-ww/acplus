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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";
import { ConfigurationError, ServiceError } from "../src/acp-common.js";
import { run } from "../src/cli.js";
import { fixtureConfig } from "./acp-fixture.js";

const mocks = vi.hoisted(() => ({
  home: vi.fn<() => string>(),
  close: vi.fn<() => Promise<void>>(),
  start:
    vi.fn<
      (config: unknown) => Promise<{ url: string; close(): Promise<void> }>
    >(),
}));
vi.mock("node:os", async (original) => {
  const actual = await original<typeof Os>();
  return { ...actual, homedir: mocks.home };
});
vi.mock("../src/acp-server.js", () => ({ start: mocks.start }));
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
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  mocks.start.mockClear();
  mocks.close.mockReset();
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
      "--agent-command",
      process.execPath,
      "--workspace",
      directory,
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
    expect(config).toMatchObject({
      schemaVersion: 2,
      agents: [{ authentication: { loginAccount: "wewei" } }],
    });
    await expect(
      run([
        "init",
        "--agent-command",
        process.execPath,
        "--workspace",
        directory,
        "--config",
        file,
      ]),
    ).rejects.toThrow(ConfigurationError);
    await expect(
      run([
        "init",
        "--agent-command",
        join(directory, "missing"),
        "--workspace",
        directory,
        "--config",
        file,
      ]),
    ).rejects.toThrow(ConfigurationError);
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it("initializes YAML under the user home and serves it without --config", async () => {
    const directory = await root();
    mocks.home.mockReturnValue(directory);
    const home = join(directory, ".acplus");
    const file = join(home, "acplus.yaml");
    await run([
      "init",
      "--agent-command",
      process.execPath,
      "--workspace",
      directory,
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
      run([
        "init",
        "--agent-command",
        process.execPath,
        "--workspace",
        directory,
      ]),
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
        "--agent-command",
        process.execPath,
        "--workspace",
        directory,
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
      "--agent-command",
      process.execPath,
      "--workspace",
      directory,
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
