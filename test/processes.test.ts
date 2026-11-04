import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Redactor } from "../src/common.js";
import {
  isolatedEnvironment,
  OwnedProcess,
  ProcessOwner,
  Secrets,
} from "../src/processes.js";
import { Service } from "../src/runtime.js";
import { registryEndpoint, vscodeFactory } from "../src/vscode.js";
import { config, eventually } from "./fixture.js";

const directories: string[] = [];
const owned: ProcessOwner[] = [];
afterEach(async () => {
  for (const owner of owned.splice(0)) await owner.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function root(): Promise<string> {
  const path = resolve(".test-state", randomUUID());
  directories.push(path);
  await mkdir(path, { recursive: true });
  return path;
}

describe("owned subprocess and WebSocket boundaries", () => {
  it("uses native argument construction, short explicit CLI data, private schema-2 registry and allowlisted environment", async () => {
    const input = config(["a", "b"]);
    input.dataDir = await root();
    for (const host of input.hosts) {
      host.adapter = "vscode";
      host.startup.command = "code-tunnel.exe";
      host.lifecycle.startupTimeoutMs = 10_000;
      host.startup.cwd = input.dataDir;
      host.startup.env.EXPLICIT_LITERAL = "value";
      host.startup.env.EXPLICIT_SECRET = {
        source: "env",
        name: "AHPLEX_SYNTHETIC_SECRET",
      };
    }
    vi.stubEnv("AHPLEX_SYNTHETIC_SECRET", "synthetic-token");
    vi.stubEnv("SHOULD_NOT_REACH_CHILD", "private-ambient");
    // Called with the original owner below, preserving process tracking.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const spawn = ProcessOwner.prototype.spawn;
    const observed = vi
      .spyOn(ProcessOwner.prototype, "spawn")
      .mockImplementation(function (this: ProcessOwner, options) {
        expect(options.command).toBe("code-tunnel.exe");
        return spawn.call(this, {
          ...options,
          command: process.execPath,
          args: [resolve("test", "owned-host.mjs"), ...options.args],
        });
      });
    const service = await Service.create(input);
    try {
      await Promise.all(
        [...service.hosts.values()].map(({ native }) => native.ensure()),
      );
      expect(observed).toHaveBeenCalledTimes(2);
      for (const host of input.hosts) {
        const path = join(input.dataDir, "hosts", host.id);
        const runs = await readdir(join(path, "r"));
        const run = join(path, "r", runs[0] ?? "", "user-data");
        const info: unknown = JSON.parse(
          await readFile(join(run, "process.json"), "utf8"),
        );
        expect(info).toMatchObject({ home: path, data: join(path, "cli") });
        expect(JSON.stringify(info)).not.toContain("SHOULD_NOT_REACH_CHILD");
        expect(await service.select(host.id).native.listSessions()).toEqual([]);
      }
      await service.select("a").native.stop();
      await eventually(() => service.select("a").native.status === "idle");
      expect(service.select("b").native.status).toBe("ready");
    } finally {
      await service.close();
    }
    expect(await readdir(input.dataDir)).not.toContain("owner.lock");
  }, 15_000);

  it("checks child liveness, kills only tracked trees and rejects closed or aborted ownership", async () => {
    const directory = await root();
    const owner = new ProcessOwner();
    owned.push(owner);
    const child = owner.spawn({
      command: process.execPath,
      args: ["-e", "setInterval(()=>{},1000)"],
      env: isolatedEnvironment(directory),
      signal: new AbortController().signal,
    });
    expect(child.child.pid).toBeTypeOf("number");
    owner.check();
    await child.stop();
    await child.stop();
    expect(() => {
      child.check();
    }).toThrow("owned process exited");
    await owner.close();
    expect(() =>
      owner.spawn({
        command: "none",
        args: [],
        env: {},
        signal: new AbortController().signal,
      }),
    ).toThrow("owner closed");
    const aborted = AbortSignal.abort();
    expect(
      () =>
        new OwnedProcess({
          command: "none",
          args: [],
          env: {},
          signal: aborted,
        }),
    ).toThrow();
    const missing = new OwnedProcess({
      command: join(directory, "missing.exe"),
      args: [],
      env: {},
      signal: new AbortController().signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(() => {
      missing.check();
    }).toThrow();
    await missing.stop();
  });

  it("keeps registry ownership strict and never adopts another editor endpoint", async () => {
    const directory = await root();
    expect(await registryEndpoint(join(directory, "missing"))).toBeUndefined();
    expect(await registryEndpoint(directory)).toBeUndefined();
    const file = join(directory, "entry");
    await writeFile(file, "{");
    await expect(registryEndpoint(directory)).rejects.toMatchObject({
      code: "invalid_owned_registry",
    });
    for (const endpoint of [
      { type: "tcp", host: "outside.example", port: 1 },
      { type: "tcp", host: "127.0.0.1", port: 0 },
      { type: "pipe", host: "127.0.0.1", port: 1 },
    ]) {
      await writeFile(
        file,
        JSON.stringify({
          schemaVersion: 2,
          type: "standalone",
          instanceId: "x",
          endpoint,
        }),
      );
      await expect(registryEndpoint(directory)).rejects.toMatchObject({
        code: "unsupported_owned_registry",
      });
    }
    await writeFile(
      file,
      JSON.stringify({
        schemaVersion: 2,
        type: "standalone",
        instanceId: "x",
        endpoint: { type: "tcp", host: "::1", port: 1234 },
      }),
    );
    expect((await registryEndpoint(directory))?.href).toBe("ws://[::1]:1234/");
    await writeFile(join(directory, "another"), "{}");
    await expect(registryEndpoint(directory)).rejects.toMatchObject({
      code: "ambiguous_owned_registry",
    });
  });

  it("cleans startup failures and honors aborts without a transport/process duplicate", async () => {
    const directory = await root();
    const input = config(["a"]);
    const host = input.hosts[0];
    if (host === undefined) throw new Error();
    host.startup.command = process.execPath;
    const owner = new ProcessOwner();
    owned.push(owner);
    const driver = vscodeFactory.create(
      {
        hostId: "a",
        dataDir: directory,
        processes: owner,
        secrets: new Secrets(new Redactor()),
        logger: { event: () => {} },
        connection() {
          throw new Error("not used");
        },
      },
      host,
      {},
    );
    await expect(
      driver.openTransport(new AbortController().signal),
    ).rejects.toThrow("host not started");
    await expect(driver.start(AbortSignal.timeout(2000))).rejects.toThrow();
    await driver.stop(new AbortController().signal);
    await driver.dispose();
    expect(
      await driver.verifyAuthentication(
        { hostId: "a", provider: "x", resource: "https://x" },
        new AbortController().signal,
      ),
    ).toMatchObject({ status: "unknown" });
  });
});
