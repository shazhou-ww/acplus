import { spawn, execFile } from "node:child_process";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { record, ServiceError } from "./acp-common.js";
import type { Config } from "./acp-types.js";

const discoveryFile = "service.json";
export const defaultIdleGraceMs = 30000;
export const startupTimeoutMs = 15000;
const exec = promisify(execFile);
let userSid: Promise<string> | undefined;
let userAccount = "";

function windowsSid(): Promise<string> {
  userSid ??= exec("whoami.exe", ["/user", "/fo", "csv", "/nh"]).then(
    ({ stdout }) => {
      const sid = /S-1-\d+(?:-\d+)+/u.exec(stdout)?.[0];
      const account = /^"([^"]+)"/u.exec(stdout)?.[1];
      if (sid === undefined || account === undefined)
        throw new ServiceError("local_discovery_permissions", 503);
      userAccount = account.toLowerCase();
      return sid;
    },
  );
  return userSid;
}

export interface LocalOwner {
  dataDir: string;
  url: string;
  token: string;
}

export async function canonicalDataDir(directory: string): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = await realpath(directory);
  return process.platform === "win32" ? path.toLowerCase() : path;
}

async function privateFile(path: string): Promise<void> {
  if (process.platform === "win32") {
    const sid = await windowsSid();
    await exec("icacls.exe", [
      path,
      "/inheritance:r",
      "/grant:r",
      `*${sid}:(F)`,
    ]);
  }
}

async function checkPrivateFile(path: string): Promise<void> {
  if (process.platform !== "win32") return;
  await windowsSid();
  const { stdout } = await exec("icacls.exe", [path]);
  const lines = stdout.split(/\r?\n/u);
  const first = lines[0]?.toLowerCase() ?? "";
  if (
    first !== `${path.toLowerCase()} ${userAccount}:(f)` ||
    lines.slice(1).some((line) => /^\s+\S.*:\(/u.test(line))
  )
    throw new ServiceError("local_discovery_permissions", 503);
}

function owner(value: unknown, dataDir: string): value is LocalOwner {
  if (
    !record(value) ||
    value.dataDir !== dataDir ||
    typeof value.token !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.token) ||
    typeof value.url !== "string"
  )
    return false;
  try {
    const url = new URL(value.url);
    return (
      url.protocol === "http:" &&
      ["127.0.0.1", "[::1]"].includes(url.hostname) &&
      url.pathname === "/v2" &&
      url.port !== "" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

export async function readOwner(dataDir: string): Promise<LocalOwner | null> {
  const path = join(dataDir, discoveryFile);
  try {
    const identity = await lstat(path);
    if (
      !identity.isFile() ||
      identity.size > 4096 ||
      (process.platform !== "win32" &&
        ((identity.mode & 0o077) !== 0 || identity.uid !== process.getuid?.()))
    )
      throw new ServiceError("local_discovery_invalid", 503);
    await checkPrivateFile(path);
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!owner(value, dataDir))
      throw new ServiceError("local_discovery_invalid", 503);
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof ServiceError) throw error;
    throw new ServiceError("local_discovery_invalid", 503);
  }
}

// Called only by the holder of the data-directory writer lease.
export async function publishOwner(dataDir: string, url: string) {
  if (await readOwner(dataDir)) await unlink(join(dataDir, discoveryFile));
  const value: LocalOwner = {
    dataDir,
    url,
    token: randomBytes(32).toString("hex"),
  };
  const path = join(dataDir, `.service-${value.token}.json`);
  const file = await open(path, "wx", 0o600);
  try {
    await privateFile(path);
    await file.writeFile(JSON.stringify(value));
  } catch {
    await file.close();
    await unlink(path);
    throw new ServiceError("local_discovery_permissions", 503);
  }
  await file.close();
  await rename(path, join(dataDir, discoveryFile));
  return {
    value,
    async release() {
      const current = await readOwner(dataDir);
      if (current?.token !== value.token)
        throw new ServiceError("local_discovery_changed", 503);
      await unlink(join(dataDir, discoveryFile));
    },
  };
}

export function proof(token: string, challenge: string): string {
  return createHmac("sha256", token).update(challenge).digest("hex");
}

export function localHeaders(
  value: LocalOwner,
  method: string,
  path: string,
): Record<string, string> {
  const nonce = `${Date.now()}.${randomBytes(16).toString("hex")}`;
  return {
    "x-acplus-nonce": nonce,
    "x-acplus-signature": proof(value.token, `${method}:${path}:${nonce}`),
  };
}

export function verifies(
  signature: string | undefined,
  expected: string,
): boolean {
  if (signature === undefined || !/^[a-f0-9]{64}$/u.test(signature))
    return false;
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

async function ready(value: LocalOwner): Promise<boolean> {
  try {
    const challenge = randomBytes(32).toString("hex");
    const response = await fetch(`${value.url}/local-owner`, {
      headers: { "x-acplus-challenge": challenge },
      signal: AbortSignal.timeout(1000),
    });
    if (!response.ok) return false;
    const result: unknown = await response.json();
    return (
      record(result) &&
      result.dataDir === value.dataDir &&
      typeof result.proof === "string" &&
      verifies(result.proof, proof(value.token, challenge))
    );
  } catch {
    return false;
  }
}

export async function localService(
  config: Config,
  configFile: string,
  idleGraceMs: number,
  allowStart: boolean,
): Promise<LocalOwner> {
  const dataDir = await canonicalDataDir(config.dataDir);
  const deadline = Date.now() + startupTimeoutMs;
  let launched = false;
  let failure: string | undefined;
  const assertStartup = () => {
    if (failure !== undefined) throw new ServiceError(failure, 503);
  };
  while (Date.now() < deadline) {
    assertStartup();
    const current = await readOwner(dataDir);
    if (current && (await ready(current))) return current;
    if (!allowStart)
      throw new ServiceError("local_work_owner_unavailable", 409);
    let writerPresent = false;
    try {
      await lstat(join(dataDir, "owner.lock"));
      writerPresent = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new ServiceError("local_service_unavailable", 503);
    }
    assertStartup();
    if (!launched && !writerPresent) {
      launched = true;
      const child = spawn(
        process.execPath,
        [
          fileURLToPath(new URL("./cli.js", import.meta.url)),
          "_auto-serve",
          "--config",
          configFile,
          "--data-dir",
          dataDir,
          "--idle-grace-ms",
          String(idleGraceMs),
        ],
        {
          detached: true,
          windowsHide: true,
          stdio: ["ignore", "ignore", "ignore", "ipc"],
        },
      );
      let contention = false;
      child.on("error", () => {
        failure = "local_service_spawn_failed";
      });
      child.on("exit", () => {
        launched = false;
        if (!contention && failure === undefined)
          failure = "local_service_exited_before_ready";
      });
      child.on("message", (message: unknown) => {
        if (record(message) && typeof message.error === "string") {
          if (message.error === "data_directory_locked") contention = true;
          else failure = message.error;
        }
      });
      child.unref();
      child.channel?.unref();
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assertStartup();
  throw new ServiceError("local_service_start_timeout", 503);
}
