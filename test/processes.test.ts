import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  endpointFromRegistry,
  instanceDirectory,
  isolatedEnvironment,
  OwnedProcess,
  waitReady,
} from "../src/processes.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
});

async function directory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agenthub-test-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

describe("owned process lifecycle", () => {
  it("waits for readiness and cleans up only its own process", async () => {
    const dir = await directory();
    const child = new OwnedProcess(
      process.execPath,
      ["-e", "setInterval(()=>{},1000)"],
      isolatedEnvironment(dir),
    );
    cleanup.push(() => child.stop());
    await waitReady(child, () => Promise.resolve(true), 100);
    await child.stop();
    await child.stop();
    expect(
      child.child.exitCode !== null || child.child.signalCode !== null,
    ).toBe(true);
  });

  it("cancels readiness both before and during a probe without losing process ownership", async () => {
    const dir = await directory();
    const child = new OwnedProcess(
      process.execPath,
      ["-e", "setInterval(()=>{},1000)"],
      isolatedEnvironment(dir),
    );
    cleanup.push(() => child.stop());
    const before = new AbortController();
    before.abort();
    await expect(
      waitReady(child, () => Promise.resolve(false), 1000, before.signal),
    ).rejects.toThrow("startup_cancelled");
    const during = new AbortController();
    await expect(
      waitReady(
        child,
        () => {
          during.abort();
          return Promise.resolve(true);
        },
        1000,
        during.signal,
      ),
    ).rejects.toThrow("startup_cancelled");
  });

  it("surfaces spawn failures, startup exit and readiness timeout", async () => {
    const dir = await directory();
    const missing = new OwnedProcess(
      join(dir, "missing-executable"),
      [],
      isolatedEnvironment(dir),
    );
    cleanup.push(() => missing.stop());
    await expect(
      waitReady(missing, () => Promise.resolve(false), 500),
    ).rejects.toThrow("child_spawn_failed");
    const child = new OwnedProcess(
      process.execPath,
      ["-e", "process.exit(7)"],
      isolatedEnvironment(dir),
    );
    cleanup.push(() => child.stop());
    await expect(
      waitReady(child, () => Promise.resolve(false), 2000),
    ).rejects.toThrow("child_exited");
    const idle = new OwnedProcess(
      process.execPath,
      ["-e", "setInterval(()=>{},1000)"],
      isolatedEnvironment(dir),
    );
    cleanup.push(() => idle.stop());
    await expect(
      waitReady(idle, () => Promise.resolve(false), 1),
    ).rejects.toThrow("startup_timeout");
  });

  it("notifies on unexpected exit", async () => {
    let exited = false;
    const child = new OwnedProcess(
      process.execPath,
      ["-e", "process.exit(1)"],
      process.env,
      () => {
        exited = true;
      },
    );
    cleanup.push(() => child.stop());
    await vi.waitFor(() => {
      expect(exited).toBe(true);
    });
  });

  it("locks instances, rejects traversal and removes the lock on graceful close", async () => {
    const dir = await directory();
    const owned = await instanceDirectory(dir, "test");
    await expect(instanceDirectory(dir, "test")).rejects.toThrow(
      "instance_locked",
    );
    await expect(instanceDirectory(dir, "../escape")).rejects.toThrow(
      "invalid_instance",
    );
    await owned.release();
    const again = await instanceDirectory(dir, "test");
    await again.release();
  });

  it("reads only the private registry and refuses ambiguous entries", async () => {
    const dir = await directory();
    expect(await endpointFromRegistry(dir)).toBeUndefined();
    const entries = join(
      dir,
      "user-data",
      "agent-host",
      "local-endpoint",
      "entries",
    );
    await mkdir(entries, { recursive: true });
    expect(await endpointFromRegistry(dir)).toBeUndefined();
    await writeFile(join(entries, "one.json"), "{}");
    expect(await endpointFromRegistry(dir)).toBe(join(entries, "one.json"));
    await writeFile(join(entries, "two.json"), "{}");
    await expect(endpointFromRegistry(dir)).rejects.toThrow(
      "ambiguous_instance_registry",
    );
  });

  it("does not pass unrelated credentials or editor configuration to children", async () => {
    const dir = await directory();
    const env = isolatedEnvironment(dir);
    expect(env.HOME).toBe(dir);
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.AHPC_TOKEN).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.VSCODE_AGENT_FOLDER).toBe(join(dir, "server-data"));
  });
});
