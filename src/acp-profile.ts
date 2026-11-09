import { randomUUID } from "node:crypto";
import { mkdir, open, stat, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { ServiceError } from "./acp-common.js";

// Keep the coordination path stable across package renames.
const profileLeaseFile = ".ahplex-acp-owner.lock";

export class ProfileLease {
  private releasing: Promise<void> | undefined;

  constructor(
    private readonly path: string,
    private readonly handle: FileHandle,
    private readonly identity: { dev: number; ino: number },
  ) {}

  release(): Promise<void> {
    this.releasing ??= this.releaseOwned();
    return this.releasing;
  }

  private async releaseOwned(): Promise<void> {
    try {
      const current = await stat(this.path);
      if (
        current.dev !== this.identity.dev ||
        current.ino !== this.identity.ino
      )
        throw new ServiceError("agent_profile_lease_changed");
      await unlink(this.path);
    } catch {
      throw new ServiceError("agent_profile_lease_changed");
    } finally {
      await this.handle.close();
    }
  }
}

export async function acquireProfileLease(
  directory: string,
): Promise<ProfileLease> {
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  } catch {
    throw new ServiceError("agent_profile_unavailable");
  }
  let handle: FileHandle;
  try {
    handle = await open(join(directory, profileLeaseFile), "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new ServiceError("agent_profile_busy", 409);
    throw new ServiceError("agent_profile_unavailable");
  }
  const path = join(directory, profileLeaseFile);
  let lease: ProfileLease | undefined;
  try {
    lease = new ProfileLease(path, handle, await handle.stat());
    await handle.writeFile(
      JSON.stringify({ pid: process.pid, owner: randomUUID() }),
    );
    return lease;
  } catch {
    if (lease !== undefined) await lease.release();
    else await handle.close();
    throw new ServiceError("agent_profile_unavailable");
  }
}
