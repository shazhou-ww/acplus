import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { start } from "../src/runtime.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

vi.mock("../src/runtime.js", () => ({ start: vi.fn() }));
const originalInt = new Set(process.listeners("SIGINT"));
const originalTerm = new Set(process.listeners("SIGTERM"));

afterEach(() => {
  for (const [signal, original] of [
    ["SIGINT", originalInt],
    ["SIGTERM", originalTerm],
  ] as const) {
    for (const listener of process.listeners(signal)) {
      if (!original.has(listener)) process.removeListener(signal, listener);
    }
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
});

describe("CLI", () => {
  it("provides help without starting a Host", async () => {
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await main(["--help"]);
    expect(output).toHaveBeenCalledWith(
      expect.stringContaining("ahplex --instance"),
    );
    expect(start).not.toHaveBeenCalled();
  });

  it("rejects missing instance and invalid ports", async () => {
    await expect(main([])).rejects.toThrow("instance_required");
    await expect(main(["--instance", "test", "--port=-1"])).rejects.toThrow(
      "invalid_port",
    );
  });

  it("starts with explicit options and handles graceful shutdown", async () => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const close = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    vi.mocked(start).mockResolvedValue({
      url: "http://127.0.0.1:4280",
      directory: "test",
      close,
    });

    await main([
      "--instance",
      "test",
      "--port",
      "0",
      "--host-url",
      "ws://127.0.0.1:43211",
      "--data-dir",
      "test",
      "--code-path",
      "fixture",
    ]);
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        instance: "test",
        port: 0,
        hostUrl: "ws://127.0.0.1:43211",
        codePath: "fixture",
      }),
    );
    const stop = process
      .listeners("SIGTERM")
      .find((listener) => !originalTerm.has(listener));
    if (stop === undefined) throw new Error("Missing shutdown handler");
    stop("SIGTERM");
    await Promise.resolve();
    expect(close).toHaveBeenCalledOnce();
  });

  it("loads an explicitly named configuration without selecting a service", async () => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const root = await mkdtemp(join(process.cwd(), ".test-cli-"));
    try {
      const path = join(root, "services.json");
      const config = {
        version: 1,
        services: [
          {
            id: "external",
            kind: "ahp-websocket",
            lifecycle: "attached",
            startupTimeoutMs: 100,
            endpoint: { url: "ws://localhost:4321/" },
          },
        ],
      };
      await writeFile(path, JSON.stringify(config));
      vi.mocked(start).mockResolvedValue({
        url: "http://127.0.0.1:4280",
        directory: root,
        close: () => Promise.resolve(),
      });
      await main(["--instance", "test", "--config", path]);
      expect(start).toHaveBeenCalledWith(expect.objectContaining({ config }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("passes only explicit credential variables and surfaces shutdown failure", async () => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const error = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    for (const key of [
      "HOST_TOKEN",
      "API_TOKEN",
      "AUTH_RESOURCE",
      "AUTH_TOKEN",
    ]) {
      vi.stubEnv(`AHPLEX_${key}`, `fixture-${key}`);
    }
    vi.mocked(start).mockResolvedValue({
      url: "http://127.0.0.1:4280",
      directory: "test",
      close: () => Promise.reject(new Error("fixture")),
    });

    await main(["--instance", "test"]);
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        port: 4280,
        hostToken: "fixture-HOST_TOKEN",
        apiToken: "fixture-API_TOKEN",
        authResource: "fixture-AUTH_RESOURCE",
        authToken: "fixture-AUTH_TOKEN",
      }),
    );
    const stop = process
      .listeners("SIGINT")
      .find((listener) => !originalInt.has(listener));
    if (stop === undefined) throw new Error("Missing handler");
    stop("SIGINT");
    await Promise.resolve();
    expect(error).toHaveBeenCalledWith("ahplex: cleanup_failed\n");
    expect(process.exitCode).toBe(1);
  });

  it("handles Ctrl+C during startup and removes its signal handlers on failure", async () => {
    vi.mocked(start).mockImplementation(
      (options) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener(
            "abort",
            () => {
              reject(new Error("startup_cancelled"));
            },
            { once: true },
          );
        }),
    );
    const starting = main(["--instance", "test"]);
    const stop = process
      .listeners("SIGINT")
      .find((listener) => !originalInt.has(listener));
    if (stop === undefined) throw new Error("Missing startup handler");
    stop("SIGINT");
    await expect(starting).rejects.toThrow("startup_cancelled");
    expect(process.listeners("SIGINT")).not.toContain(stop);
  });
});
