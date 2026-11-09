import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireProfileLease, type ProfileLease } from "../src/acp-profile.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, open: vi.fn(actual.open), stat: vi.fn(actual.stat) };
});

const directories: string[] = [];
const leases: ProfileLease[] = [];
async function directory() {
  const path = join(
    process.cwd(),
    "test",
    `acp-profile-${crypto.randomUUID()}`,
  );
  await mkdir(path, { recursive: true });
  directories.push(path);
  return path;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    leases.splice(0).map(async (lease) => {
      await lease.release().catch(() => {});
    }),
  );
  await Promise.all(
    directories.splice(0).map(async (path) => {
      await rm(path, { recursive: true, force: true });
    }),
  );
});

describe("cooperative explicit-profile lease", () => {
  it("acquires privately, rejects another owner, and coalesces owned release", async () => {
    const path = await directory();
    const lease = await acquireProfileLease(path);
    leases.push(lease);
    const metadata = JSON.parse(
      await readFile(join(path, ".ahplex-acp-owner.lock"), "utf8"),
    ) as { pid: number; owner: string };
    expect(metadata.pid).toBe(process.pid);
    expect(metadata.owner).toMatch(/^[0-9a-f-]{36}$/u);
    await expect(acquireProfileLease(path)).rejects.toMatchObject({
      code: "agent_profile_busy",
      status: 409,
    });
    const release = lease.release();
    expect(lease.release()).toBe(release);
    await release;
    const next = await acquireProfileLease(path);
    leases.push(next);
  });

  it("does not remove stale or pre-existing ownership metadata", async () => {
    const path = await directory();
    const lock = join(path, ".ahplex-acp-owner.lock");
    await writeFile(lock, "another owner");
    await expect(acquireProfileLease(path)).rejects.toMatchObject({
      code: "agent_profile_busy",
    });
    expect(await readFile(lock, "utf8")).toBe("another owner");
  });

  it("does not delete a replacement owner", async () => {
    const path = await directory();
    const lock = join(path, ".ahplex-acp-owner.lock");
    const lease = await acquireProfileLease(path);
    leases.push(lease);
    await rename(lock, join(path, "original-owner.lock"));
    await writeFile(lock, "replacement owner");
    await expect(lease.release()).rejects.toMatchObject({
      code: "agent_profile_lease_changed",
    });
    expect(await readFile(lock, "utf8")).toBe("replacement owner");
  });

  it("reports unavailable profiles and non-conflict acquisition errors safely", async () => {
    const path = await directory();
    const file = join(path, "not-a-directory");
    await writeFile(file, "not a directory");
    await expect(acquireProfileLease(file)).rejects.toMatchObject({
      code: "agent_profile_unavailable",
    });
    vi.mocked(fs.open).mockRejectedValueOnce(
      Object.assign(new Error("PRIVATE"), { code: "EACCES" }),
    );
    await expect(acquireProfileLease(path)).rejects.toMatchObject({
      code: "agent_profile_unavailable",
    });
  });

  it("releases its own lease after metadata-write failure", async () => {
    const path = await directory();
    const handle = await open(
      join(path, ".ahplex-acp-owner.lock"),
      "wx",
      0o600,
    );
    vi.spyOn(handle, "writeFile").mockRejectedValueOnce(new Error("PRIVATE"));
    vi.mocked(fs.open).mockResolvedValueOnce(handle);
    await expect(acquireProfileLease(path)).rejects.toMatchObject({
      code: "agent_profile_unavailable",
    });
    const next = await acquireProfileLease(path);
    leases.push(next);
  });

  it("closes the created handle if identity inspection fails", async () => {
    const path = await directory();
    const handle = await open(
      join(path, ".ahplex-acp-owner.lock"),
      "wx",
      0o600,
    );
    vi.spyOn(handle, "stat").mockRejectedValueOnce(new Error("PRIVATE"));
    vi.mocked(fs.open).mockResolvedValueOnce(handle);
    await expect(acquireProfileLease(path)).rejects.toMatchObject({
      code: "agent_profile_unavailable",
    });
    await expect(handle.stat()).rejects.toBeDefined();
  });
});
