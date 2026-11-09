import { mkdir, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { ServiceError } from "./errors.js";

export async function lockDirectory(
  directory: string,
): Promise<() => Promise<void>> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "owner.lock");
  let lock;
  try {
    lock = await open(path, "wx", 0o600);
  } catch {
    throw new ServiceError("data_directory_locked", 409);
  }
  await lock.writeFile(String(process.pid));
  return async () => {
    await lock.close();
    await unlink(path);
  };
}
