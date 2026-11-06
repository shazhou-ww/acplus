import { randomUUID } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import * as onboarding from "../src/init.js";
import { type InitOptions } from "../src/init.js";
import { ahpdFactory } from "../src/ahpd.js";
import { parseJson, validateConfig } from "../src/config.js";
import { ConfigurationError } from "../src/common.js";
import { ProcessOwner } from "../src/processes.js";

vi.mock("node:fs/promises", { spy: true });

const paths: string[] = [];
const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
afterEach(async () => {
  vi.mocked(stat).mockRestore();
  vi.mocked(access).mockRestore();
  vi.mocked(writeFile).mockRestore();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (ttyDescriptor)
    Object.defineProperty(process.stdout, "isTTY", ttyDescriptor);
  else Reflect.deleteProperty(process.stdout, "isTTY");
  for (const path of paths.splice(0))
    await rm(path, { recursive: true, force: true });
});

async function fixture(): Promise<
  InitOptions & { config: string; dataDir: string }
> {
  const root = resolve(".test-state", randomUUID());
  paths.push(root);
  const runtimeRoot = join(root, "runtime");
  for (const name of ["server", "sdk", "agent-acp"]) {
    const file = join(
      runtimeRoot,
      "node_modules",
      "@ahpd",
      name,
      "dist",
      name === "server" ? "main.js" : "index.js",
    );
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, "");
  }
  await writeFile(
    join(runtimeRoot, "node_modules", "@ahpd", "agent-acp", "package.json"),
    "{}",
  );
  const workspace = join(root, "trusted space #雪");
  await mkdir(workspace);
  return {
    runtimeRoot,
    workspace,
    copilotCommand: process.execPath,
    config: join(root, "ahplex.json"),
    dataDir: join(root, "state"),
  };
}

describe("offline Linux onboarding", () => {
  it("writes the exact validated owned-host config with private exclusive creation and no runtime effects", async () => {
    const options = await fixture();
    const fetch = vi.spyOn(globalThis, "fetch");
    const spawn = vi.spyOn(ProcessOwner.prototype, "spawn");
    vi.stubEnv("AHPLEX_URL", "");
    vi.stubEnv("COPILOT_HOME", "never-discover-this");
    const result = await onboarding.initialize(options, "linux");
    expect(result).toEqual({ config: options.config, host: "ahpd" });
    const config = validateConfig(
      parseJson(await readFile(options.config, "utf8")),
    );
    expect(config).toEqual({
      schemaVersion: 1,
      instance: "local",
      dataDir: options.dataDir,
      listen: { host: "127.0.0.1", port: 4280 },
      hosts: [
        {
          id: "ahpd",
          label: "Owned AHPD / Copilot",
          adapter: "ahpd",
          startup: {
            command: process.execPath,
            args: [
              join(
                options.runtimeRoot,
                "node_modules",
                "@ahpd",
                "server",
                "dist",
                "main.js",
              ),
            ],
            env: {},
            cwd: options.workspace,
          },
          lifecycle: {
            prepareOnStartup: false,
            onDemand: true,
            startupTimeoutMs: 60000,
          },
          options: {
            port: 19491,
            plugin: join(
              options.runtimeRoot,
              "node_modules",
              "@ahpd",
              "agent-acp",
            ),
            copilotCommand: process.execPath,
            copilotProfileDir: join(options.dataDir, "copilot-profile"),
            trustedDirectories: [pathToFileURL(options.workspace).href],
            runtimeRevision: "1d52d06c65ec1006d548bad7c477e032b9dc6782",
          },
          authentication: [
            {
              id: "native-login",
              provider: "copilot",
              resource: "https://api.github.com/repos",
              adapter: "copilot-cli",
              options: { mode: "login" },
            },
            {
              id: "reuse-native-login",
              provider: "copilot",
              resource: "https://api.github.com/repos",
              adapter: "copilot-cli",
              options: { mode: "reuse" },
            },
          ],
        },
      ],
    });
    const host = config.hosts[0]!;
    expect(() =>
      ahpdFactory.validate?.(host, ahpdFactory.options.parse(host.options)),
    ).not.toThrow();
    if (process.platform !== "win32")
      expect((await stat(options.config)).mode & 0o777).toBe(0o600);
    await expect(stat(options.dataDir)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    const original = await readFile(options.config, "utf8");
    await expect(onboarding.initialize(options, "linux")).rejects.toThrow(
      "exclusively",
    );
    expect(await readFile(options.config, "utf8")).toBe(original);
  });

  it("resolves invocation-relative paths, honors explicit isolation and never inspects the chosen profile", async () => {
    const options = await fixture();
    const relative = (path: string): string =>
      join(".", path.slice(process.cwd().length + 1));
    const profile = join(dirname(options.config), "authorized-profile");
    await writeFile(profile, "not read, copied, validated or changed");
    await onboarding.initialize(
      {
        ...options,
        runtimeRoot: relative(options.runtimeRoot),
        workspace: relative(options.workspace),
        config: relative(options.config),
        dataDir: relative(options.dataDir),
        copilotProfile: relative(profile),
        loginAccount: "chosen-user",
        nodeCommand: process.execPath,
        port: "0",
        daemonPort: "21001",
        instance: "isolated",
      },
      "linux",
    );
    const config = validateConfig(
      parseJson(await readFile(options.config, "utf8")),
    );
    expect(config.instance).toBe("isolated");
    expect(config.listen.port).toBe(0);
    expect(config.dataDir).toBe(options.dataDir);
    expect(config.hosts[0]?.options).toMatchObject({
      copilotProfileDir: profile,
      loginAccount: "chosen-user",
      port: 21001,
    });
    expect(await readFile(profile, "utf8")).toBe(
      "not read, copied, validated or changed",
    );
  });

  it("has local defaults for output and data without discovering a runtime or workspace", async () => {
    const options = await fixture();
    const cwd = vi
      .spyOn(process, "cwd")
      .mockReturnValue(dirname(options.config));
    await onboarding.initialize(
      {
        runtimeRoot: options.runtimeRoot,
        workspace: options.workspace,
        copilotCommand: options.copilotCommand,
      },
      "linux",
    );
    cwd.mockRestore();
    const config = validateConfig(
      parseJson(await readFile(options.config, "utf8")),
    );
    expect(config.dataDir).toBe(join(dirname(options.config), ".ahplex"));
  });

  it("rejects platforms, malformed inputs and missing runtime layouts before creating anything", async () => {
    const options = await fixture();
    for (const platform of ["win32", "darwin"] as const)
      await expect(onboarding.initialize(options, platform)).rejects.toThrow(
        "Linux-only",
      );
    if (process.platform !== "linux")
      await expect(onboarding.initialize(options)).rejects.toThrow(
        "Linux-only",
      );
    for (const override of [
      { config: "-" },
      { dataDir: " " },
      { workspace: "a\0b" },
      { runtimeRoot: "" },
      { copilotProfile: "" },
      { nodeCommand: "" },
      { port: "-1" },
      { port: "1.5" },
      { port: "65536" },
      { daemonPort: "0" },
      { daemonPort: "no" },
      { port: "19491" },
      { instance: "bad id" },
      { loginAccount: "bad login" },
      { workspace: options.config },
      { workspace: process.execPath },
      { nodeCommand: options.config },
      { copilotCommand: options.workspace },
      { copilotCommand: "copilot.cmd" },
      { nodeCommand: "node.bat" },
      { runtimeRoot: options.workspace },
    ])
      await expect(
        onboarding.initialize({ ...options, ...override }, "linux"),
      ).rejects.toThrow();
    for (const name of [
      join("sdk", "dist", "index.js"),
      join("agent-acp", "dist", "index.js"),
      join("agent-acp", "package.json"),
      join("server", "dist", "main.js"),
    ]) {
      const file = join(options.runtimeRoot, "node_modules", "@ahpd", name);
      await rm(file);
      await expect(onboarding.initialize(options, "linux")).rejects.toThrow(
        "--runtime-root",
      );
      await writeFile(file, "");
    }
    await expect(
      onboarding.initialize(
        { ...options, config: join(options.config, "missing-parent.json") },
        "linux",
      ),
    ).rejects.toThrow("parent must exist");
    await expect(stat(options.config)).rejects.toThrow();
  });

  it.skipIf(process.platform === "win32")(
    "refuses existing and dangling file symlinks, and non-executable commands",
    async () => {
      const options = await fixture();
      const target = join(dirname(options.config), "target");
      await writeFile(target, "untouched");
      await symlink(target, options.config);
      await expect(onboarding.initialize(options, "linux")).rejects.toThrow(
        "exclusively",
      );
      expect(await readFile(target, "utf8")).toBe("untouched");
      await rm(target);
      await expect(onboarding.initialize(options, "linux")).rejects.toThrow(
        "exclusively",
      );
      await expect(stat(target)).rejects.toThrow();
      await rm(options.config);
      await writeFile(target, "not executable");
      await chmod(target, 0o600);
      await expect(
        onboarding.initialize({ ...options, copilotCommand: target }, "linux"),
      ).rejects.toThrow("executable unavailable");
    },
  );

  it("reports expected filesystem input errors with the field, errno and original cause", async () => {
    const options = await fixture();
    for (const code of ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"]) {
      const error = Object.assign(new Error("filesystem input failure"), {
        code,
      });
      const message: unknown = expect.stringContaining(`--workspace: ${code}:`);
      vi.mocked(stat).mockRejectedValueOnce(error);
      await expect(
        onboarding.initialize(options, "linux"),
      ).rejects.toMatchObject({
        name: "Error",
        message,
        cause: error,
      });
    }
    const denied = Object.assign(new Error("execute denied"), {
      code: "EACCES",
    });
    const message: unknown = expect.stringContaining("--node-command: EACCES:");
    vi.mocked(access).mockRejectedValueOnce(denied);
    await expect(onboarding.initialize(options, "linux")).rejects.toMatchObject(
      {
        message,
        cause: denied,
      },
    );
    for (const code of [
      "ENOENT",
      "ENOTDIR",
      "EACCES",
      "EPERM",
      "ELOOP",
      "EEXIST",
      "EISDIR",
      "EROFS",
    ]) {
      const error = Object.assign(new Error("output input failure"), { code });
      const message: unknown = expect.stringContaining(`--config: ${code}:`);
      vi.mocked(writeFile).mockRejectedValueOnce(error);
      await expect(
        onboarding.initialize(options, "linux"),
      ).rejects.toMatchObject({
        message,
        cause: error,
      });
    }
    await expect(stat(options.config)).rejects.toThrow();
    await expect(
      onboarding.initialize(
        { ...options, workspace: process.execPath },
        "linux",
      ),
    ).rejects.toThrow(
      "--workspace: required directory unavailable (wrong file kind)",
    );
  });

  it("propagates unexpected filesystem and programming failures without changing their identity", async () => {
    const options = await fixture();
    for (const error of [
      Object.assign(new Error("device I/O"), { code: "EIO" }),
      Object.assign(new Error("disk full"), { code: "ENOSPC" }),
      new TypeError("programming error"),
      { code: 123 },
      null,
    ]) {
      for (const operation of [stat, access, writeFile]) {
        vi.mocked(operation).mockRejectedValueOnce(error);
        await expect(onboarding.initialize(options, "linux")).rejects.toBe(
          error,
        );
      }
    }
    await expect(stat(options.config)).rejects.toThrow();
  });

  it("retains a partial exclusively created output after an unexpected write failure and refuses retry overwrite", async () => {
    const options = await fixture();
    const error = Object.assign(new Error("disk full after opening"), {
      code: "ENOSPC",
    });
    const { writeFile: original } = await vi.importActual<{
      writeFile: typeof writeFile;
    }>("node:fs/promises");
    vi.mocked(writeFile).mockImplementationOnce(async (file) => {
      await original(file, "partial output", { flag: "wx", mode: 0o600 });
      throw error;
    });
    await expect(onboarding.initialize(options, "linux")).rejects.toBe(error);
    expect(await readFile(options.config, "utf8")).toBe("partial output");
    await expect(onboarding.initialize(options, "linux")).rejects.toThrow(
      ConfigurationError,
    );
    await expect(onboarding.initialize(options, "linux")).rejects.toThrow(
      "--config: EEXIST:",
    );
    expect(await readFile(options.config, "utf8")).toBe("partial output");
  });

  it("routes contextual help and rejects missing, unknown, repeated and wrong-command arguments without HTTP", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const fetch = vi.spyOn(globalThis, "fetch");
    const initialize = vi.spyOn(onboarding, "initialize");
    for (const args of [
      ["init", "--help"],
      ["init", "-h"],
      ["--help"],
      ["serve", "--help"],
    ])
      await main(args);
    expect(stdout.mock.calls[0]?.[0]).toContain("Usage: ahplex init");
    expect(stdout.mock.calls[2]?.[0]).toContain("ahplex init");
    expect(stdout).toHaveBeenLastCalledWith(
      expect.stringContaining("Usage: ahplex serve --config"),
    );
    expect(initialize).not.toHaveBeenCalled();
    for (const args of [
      ["init"],
      ["init", "--runtime-root", "x"],
      ["init", "--workspace"],
      ["init", "--no-such-option"],
      ["init", "--runtime-root", "a", "--runtime-root", "b"],
      ["init", "--help", "-h"],
      ["init", "--json", "--json"],
      ["init", "extra"],
      ["init", "extra", "--help"],
      ["init", "--help", "--url", "http://example.test/v1"],
      ["init", "--runtime-root="],
      ["init", "--url", "http://example.test/v1"],
      ["init", "--host", "a"],
      ["init", "--listen-host", "0.0.0.0"],
      ["serve", "--runtime-root", "a"],
      ["health", "--workspace", "x"],
    ])
      await expect(main(args)).rejects.toThrow();
    expect(initialize).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("emits only a result object for automation and explicit JSON, with honest TTY next steps", async () => {
    const options = await fixture();
    const initialize = onboarding.initialize;
    vi.spyOn(onboarding, "initialize").mockImplementation((input) =>
      initialize(input, "linux"),
    );
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const fetch = vi.spyOn(globalThis, "fetch");
    vi.stubEnv("AHPLEX_URL", "");
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: false,
    });
    const cwd = vi
      .spyOn(process, "cwd")
      .mockReturnValue(dirname(options.config));
    await main([
      "init",
      "--runtime-root",
      options.runtimeRoot,
      "--copilot-command",
      process.execPath,
      "--workspace",
      options.workspace,
    ]);
    cwd.mockRestore();
    expect(stdout).toHaveBeenLastCalledWith(
      `${JSON.stringify({ config: options.config, host: "ahpd" })}\n`,
    );
    for (const [name, tty, json] of [
      ["redirected", false, false],
      ["json", true, true],
      ["tty", true, false],
    ] as const) {
      Object.defineProperty(process.stdout, "isTTY", {
        configurable: true,
        value: tty,
      });
      const file = join(dirname(options.config), `${name}.json`);
      await main([
        "init",
        "--runtime-root",
        options.runtimeRoot,
        "--copilot-command",
        process.execPath,
        "--workspace",
        options.workspace,
        "--config",
        file,
        "--data-dir",
        options.dataDir,
        "--node-command",
        process.execPath,
        "--copilot-profile",
        join(options.dataDir, "explicit"),
        "--login-account",
        "chosen-user",
        "--instance",
        "test",
        "--port",
        "4291",
        "--daemon-port",
        "19492",
        ...(json ? ["--json"] : []),
      ]);
      if (tty && !json) {
        expect(stdout).toHaveBeenLastCalledWith(
          expect.stringContaining("authentication remains unverified"),
        );
        expect(stdout).toHaveBeenLastCalledWith(
          expect.stringContaining("Next: ahplex serve --config"),
        );
      } else
        expect(stdout).toHaveBeenLastCalledWith(
          `${JSON.stringify({ config: file, host: "ahpd" })}\n`,
        );
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(await readdir(dirname(options.config))).not.toContain("state");
  });
});
