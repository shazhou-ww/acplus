import {
  execFile,
  execFileSync,
  spawn,
  type ChildProcess,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { main } from "../src/cli.js";
import { humanOutput } from "../src/cli-output.js";
import { config, eventually } from "./fixture.js";

const directory = resolve(".test-state", randomUUID());
const children = new Set<ChildProcess>();
const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
beforeAll(async () => {
  await mkdir(directory, { recursive: true });
  execFileSync(
    process.execPath,
    [
      join("node_modules", "typescript", "bin", "tsc"),
      "-p",
      "tsconfig.build.json",
    ],
    { stdio: "pipe" },
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (ttyDescriptor)
    Object.defineProperty(process.stdout, "isTTY", ttyDescriptor);
  else Reflect.deleteProperty(process.stdout, "isTTY");
});
afterAll(async () => {
  for (const child of children) child.kill();
  await rm(directory, { recursive: true, force: true });
});

describe("thin client CLI", () => {
  it("has help/version and rejects unknown/repeated options, commands and implicit targets", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await main(["--help"]);
    expect(String(stdout.mock.calls[0]?.[0])).toContain(
      "turns start|get|cancel",
    );
    await main(["--version"]);
    const manifest: unknown = JSON.parse(
      await readFile("package.json", "utf8"),
    );
    if (!manifest || typeof manifest !== "object" || !("version" in manifest))
      throw new Error("Invalid package manifest");
    expect(stdout).toHaveBeenLastCalledWith(`${String(manifest.version)}\n`);
    vi.stubEnv("AHPLEX_URL", "");
    for (const args of [
      ["validate"],
      ["tasks", "list"],
      ["health"],
      ["health", "--bogus"],
      ["hosts", "start", "--host", "a", "--host", "b"],
      ["health", "--url", "http://localhost"],
      ["health", "--url", "ftp://localhost/v1"],
      ["health", "--url", "http://user:pass@localhost/v1"],
      ["health", "--host", "a"],
      ["hosts", "start", "--url", "http://localhost/v1"],
      ["serve", "--config", "x", "--port", "-1"],
      ["serve", "--config", "x", "--port", "1.5"],
      ["serve", "--config", "x", "--host", "a"],
      ["serve", "--config", "x", "--json"],
    ])
      await expect(main(args)).rejects.toThrow();
  });

  it("maps all client commands exactly and preserves URIs without automatic retry", async () => {
    vi.stubEnv("AHPLEX_URL", "http://example.test/v1");
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() =>
        Promise.resolve(new Response(null, { status: 202 })),
      );
    const text = join(directory, "prompt.txt");
    const input = join(directory, "input.json");
    await writeFile(text, "UTF-8 prompt 你好");
    await writeFile(input, JSON.stringify({ token: "sensitive" }));
    const cases = [
      ["health"],
      ["hosts", "list"],
      ["hosts", "start", "--host", "a"],
      ["hosts", "stop", "--host", "a"],
      ["sessions", "list", "--host", "a"],
      [
        "sessions",
        "create",
        "--host",
        "a",
        "--provider",
        "p",
        "--working-directory",
        "file:///D:/a%20b",
      ],
      ["chats", "list", "--host", "a", "--session", "ahp-session:/a?b#c"],
      ["chats", "create", "--host", "a", "--session", "ahp-session:/a"],
      [
        "turns",
        "start",
        "--host",
        "a",
        "--chat",
        "ahp-chat:/a",
        "--turn",
        "caller-id",
        "--text-file",
        text,
      ],
      [
        "turns",
        "get",
        "--host",
        "a",
        "--chat",
        "ahp-chat:/a",
        "--turn",
        "caller-id",
      ],
      [
        "turns",
        "cancel",
        "--host",
        "a",
        "--chat",
        "ahp-chat:/a",
        "--turn",
        "caller-id",
      ],
      ["auth", "begin", "--host", "a", "--method", "login"],
      ["auth", "get", "--host", "a"],
      [
        "auth",
        "input",
        "--host",
        "a",
        "--step",
        "current",
        "--input-file",
        input,
      ],
    ];
    for (const args of cases) await main([...args, "--json"]);
    expect(fetch).toHaveBeenCalledTimes(14);
    expect(stdout).not.toHaveBeenCalled();
    const url = fetch.mock.calls[6]?.[0];
    expect(url instanceof URL ? url.href : "").toContain(
      "session=ahp-session%3A%2Fa%3Fb%23c",
    );
    expect(fetch.mock.calls[8]?.[1]?.body).toBe(
      JSON.stringify({
        chat: "ahp-chat:/a",
        turnId: "caller-id",
        text: "UTF-8 prompt 你好",
      }),
    );
    await main(["hosts", "start", "--host", "a"]);
    expect(stdout).toHaveBeenLastCalledWith("Accepted; poll for progress.\n");
    fetch.mockResolvedValueOnce(Response.json({ state: "error" }));
    await main([
      "turns",
      "get",
      "--host",
      "a",
      "--chat",
      "ahp-chat:/a",
      "--turn",
      "id",
      "--json",
    ]);
    expect(stdout).toHaveBeenLastCalledWith('{"state":"error"}\n');
    fetch.mockResolvedValueOnce(
      Response.json(
        { error: { code: "chat_busy", message: "busy" } },
        { status: 409 },
      ),
    );
    await expect(main(["hosts", "list"])).rejects.toThrow("chat_busy");
    fetch.mockResolvedValueOnce(
      new Response("gateway unavailable", { status: 502 }),
    );
    await expect(main(["health"])).rejects.toThrow("HTTP 502");
    fetch.mockRejectedValueOnce(new Error("network"));
    await expect(main(["health"])).rejects.toThrow("network");
  });

  it("rejects malformed or unavailable input files without posting secret values", async () => {
    vi.stubEnv("AHPLEX_URL", "http://example.test/v1");
    const file = join(directory, "invalid.json");
    await writeFile(file, '{"token":2}');
    await expect(
      main([
        "auth",
        "input",
        "--host",
        "a",
        "--step",
        "x",
        "--input-file",
        file,
      ]),
    ).rejects.toThrow("JSON string map");
    await expect(
      main([
        "turns",
        "start",
        "--host",
        "a",
        "--chat",
        "ahp-chat:/a",
        "--turn",
        "x",
        "--text-file",
        file + ".missing",
      ]),
    ).rejects.toThrow("input file");
  });

  it("runs serve in process with explicit settings and cleans up on signals", async () => {
    const input = config([]);
    input.dataDir = join(directory, "in-process");
    const file = join(directory, "serve.json");
    await writeFile(file, JSON.stringify(input));
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await main([
      "serve",
      "--config",
      file,
      "--port",
      "0",
      "--listen-host",
      "127.0.0.1",
      "--instance",
      "direct",
      "--data-dir",
      input.dataDir,
    ]);
    expect(stdout).toHaveBeenCalledWith(
      expect.stringContaining("ahplex direct listening"),
    );
    const url = /listening at (\S+)/u.exec(
      String(stdout.mock.calls[0]?.[0]),
    )?.[1];
    if (url === undefined) throw new Error("Missing URL");
    expect((await fetch(url + "/health")).status).toBe(204);
    process.emit("SIGTERM");
    await eventually(() => process.listenerCount("SIGINT") === 0);
  });
});

describe("built CLI process", () => {
  it("prints the most relevant help for invalid commands and missing arguments", async () => {
    for (const [args, usage] of [
      [["turns", "get", "--host", "a"], "Usage: ahplex turns get"],
      [["hosts", "wrong"], "ahplex hosts start"],
      [["serve", "--port", "bad"], "Usage: ahplex serve"],
      [["health", "--unknown"], "Usage: ahplex health"],
      [["init"], "Usage: ahplex init"],
      [["init", "--unknown"], "Usage: ahplex init"],
      [["init", "--workspace", "a", "--workspace", "b"], "Usage: ahplex init"],
      [["init", "--url", "http://localhost/v1"], "Usage: ahplex init"],
    ] as const) {
      const expectedHelp: unknown = expect.stringContaining(usage);
      await expect(
        promisify(execFile)(process.execPath, [
          join("dist", "cli.js"),
          ...args,
        ]),
      ).rejects.toMatchObject({
        code: 2,
        stderr: expectedHelp,
      });
    }
    const fetch = vi.spyOn(globalThis, "fetch");
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    for (const args of [
      [],
      ["hosts"],
      ["auth", "--help"],
      ["turns", "get", "-h"],
    ])
      await main(args);
    expect(fetch).not.toHaveBeenCalled();
    expect(stdout).toHaveBeenLastCalledWith(
      expect.stringContaining("Usage: ahplex turns get"),
    );
  }, 15_000);
  it("validates before listening and uses exit code 2 for CLI/config errors", async () => {
    await expect(
      promisify(execFile)(process.execPath, [
        join("dist", "cli.js"),
        "validate",
      ]),
    ).rejects.toMatchObject({ code: 2 });
    await expect(
      promisify(execFile)(process.execPath, [
        join("dist", "cli.js"),
        "serve",
        "--config",
        "missing.json",
      ]),
    ).rejects.toMatchObject({ code: 2 });
  });

  describe("TTY presentation and machine output", () => {
    it("formats lists, native identities and authentication actions without JSON noise", () => {
      expect(
        humanOutput("hosts list", [
          {
            hostId: "vscode",
            status: "idle",
            authMethods: [{ methodId: "login" }],
          },
        ]),
      ).toContain("AUTH METHODS");
      expect(humanOutput("sessions list", [])).toBe("No entries.\n");
      expect(
        humanOutput("sessions list", [
          {
            resource: "ahp-session:/a",
            provider: "copilotcli",
            title: "Test\nsession",
          },
        ]),
      ).toContain("Test session");
      expect(
        humanOutput("sessions create", { resource: "ahp-session:/a" }),
      ).toBe("Session created: ahp-session:/a\n");
      expect(humanOutput("chats create", { resource: "ahp-chat:/a" })).toBe(
        "Chat created: ahp-chat:/a\n",
      );
      expect(
        humanOutput("chats list", {
          defaultChat: "ahp-chat:/a",
          chats: [
            {
              resource: "ahp-chat:/a",
              title: "Main",
              origin: { kind: "user" },
            },
          ],
        }),
      ).toContain("yes");
      expect(
        humanOutput("auth get", {
          status: "action_required",
          methodId: "login",
          step: {
            kind: "link",
            url: "https://github.com/login/device",
            userCode: "ABCD-1234",
          },
        }),
      ).toContain("Verification code: ABCD-1234");
      expect(
        humanOutput("auth get", {
          status: "action_required",
          step: { kind: "input", stepId: "step", fields: ["token"] },
        }),
      ).toContain("Required fields: token");
      expect(
        humanOutput("auth get", {
          status: "failed",
          error: { code: "auth_failed", message: "Rejected" },
        }),
      ).toContain("auth_failed: Rejected");
      expect(
        humanOutput("turns get", {
          state: "running",
          inputRequired: true,
          error: { code: "blocked" },
          text: "\u001b[31mAnswer\u001b[0m",
        }),
      ).toContain("\nAnswer\n");
      expect(
        humanOutput("turns get", { state: "running", inputRequired: true }),
      ).toContain("Waiting for user input");
      expect(() => humanOutput("hosts list", {})).toThrow(
        "invalid cli response",
      );
      expect(() => humanOutput("chats list", { chats: [null] })).toThrow();
      expect(() => humanOutput("auth get", null)).toThrow();
      expect(() => humanOutput("unknown", {})).toThrow();
    });

    it("uses human output only in a TTY and preserves explicit JSON and redirected output", async () => {
      vi.stubEnv("AHPLEX_URL", "http://example.test/v1");
      const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      Object.defineProperty(process.stdout, "isTTY", {
        configurable: true,
        get: () => true,
      });
      const tty = vi
        .spyOn(process.stdout, "isTTY", "get")
        .mockReturnValue(true);
      const body = [
        { hostId: "vscode", status: "ready", providers: ["copilotcli"] },
      ];
      vi.spyOn(globalThis, "fetch").mockImplementation(() =>
        Promise.resolve(Response.json(body)),
      );
      await main(["hosts", "list"]);
      expect(stdout).toHaveBeenLastCalledWith(
        expect.stringContaining("PROVIDERS"),
      );
      await main(["hosts", "list", "--json"]);
      expect(stdout).toHaveBeenLastCalledWith(JSON.stringify(body) + "\n");
      tty.mockReturnValue(false);
      await main(["hosts", "list"]);
      expect(stdout).toHaveBeenLastCalledWith(JSON.stringify(body) + "\n");
    });
  });

  it("serves one stdin document through EOF with explicit overrides, then responds to client CLI", async () => {
    const input = config([]);
    input.dataDir = join(directory, "source-root");
    const effective = join(directory, "override-root");
    const child = spawn(
      process.execPath,
      [
        join("dist", "cli.js"),
        "serve",
        "--config",
        "-",
        "--listen-host",
        "127.0.0.1",
        "--port",
        "0",
        "--instance",
        "overridden",
        "--data-dir",
        effective,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    children.add(child);
    let output = "";
    let errors = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errors += chunk.toString();
    });
    child.stdin.end(JSON.stringify(input));
    await eventually(() => {
      if (errors !== "") throw new Error(errors);
      return output.includes("listening at");
    }, 10_000);
    expect(output).toContain("ahplex overridden");
    const url = /listening at (\S+)/u.exec(output)?.[1];
    if (url === undefined) throw new Error("No service URL");
    const health = await promisify(execFile)(process.execPath, [
      join("dist", "cli.js"),
      "health",
      "--url",
      url,
      "--json",
    ]);
    expect(health.stdout).toBe("");
    const list = await promisify(execFile)(process.execPath, [
      join("dist", "cli.js"),
      "hosts",
      "list",
      "--url",
      url,
      "--json",
    ]);
    expect(list.stdout).toBe("[]\n");
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
    children.delete(child);
  }, 15_000);
});
