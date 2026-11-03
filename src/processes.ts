import { execFile, spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, open, readdir, unlink } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { checkStartup, HubError } from "./common.js";

export async function nativeCode(): Promise<string> {
  const name = process.platform === "win32" ? "code-tunnel.exe" : "code";
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(directory, name);
    try {
      await access(candidate);
      return candidate;
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      )) {
        throw error;
      }
    }
  }
  throw new HubError("vscode_executable_not_found", 503);
}

export async function instanceDirectory(
  root: string,
  instance: string,
): Promise<{
  directory: string;
  release(): Promise<void>;
}> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(instance)) {
    throw new HubError("invalid_instance", 400);
  }
  const directory = resolve(root, instance);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let lock;
  try {
    lock = await open(join(directory, "owner.lock"), "wx", 0o600);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new HubError("instance_locked", 409);
    }
    throw error;
  }
  await lock.writeFile(String(process.pid));
  return {
    directory,
    release: async () => {
      await lock.close();
      await unlink(join(directory, "owner.lock"));
    },
  };
}

export function isolatedEnvironment(directory: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of [
    "PATH",
    "Path",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "ComSpec",
    "PATHEXT",
  ]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return {
    ...env,
    HOME: directory,
    USERPROFILE: directory,
    APPDATA: join(directory, "appdata"),
    LOCALAPPDATA: join(directory, "localappdata"),
    TMP: join(directory, "tmp"),
    TEMP: join(directory, "tmp"),
    TMPDIR: join(directory, "tmp"),
    XDG_CONFIG_HOME: join(directory, "config"),
    XDG_DATA_HOME: join(directory, "data"),
    XDG_CACHE_HOME: join(directory, "cache"),
    VSCODE_CLI_DATA_DIR: join(directory, "cli-data"),
    VSCODE_AGENT_FOLDER: join(directory, "server-data"),
  };
}

export class OwnedProcess {
  readonly child: ChildProcess;
  private exited = false;
  private failure: HubError | undefined;
  private readonly done: Promise<void>;
  private stopping = false;
  private stopPromise: Promise<void> | undefined;

  constructor(
    executable: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    onExit: () => void = () => {},
    ipc = false,
  ) {
    this.child = spawn(executable, args, {
      env,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ipc ? ["ignore", "ignore", "ignore", "ipc"] : "ignore",
    });
    this.done = new Promise((resolveDone) => {
      const finish = (): void => {
        if (this.exited) return;
        this.exited = true;
        if (!this.stopping) onExit();
        resolveDone();
      };
      this.child.once("error", () => {
        this.failure = new HubError("child_spawn_failed", 503);
        finish();
      });
      this.child.once("exit", () => {
        this.failure = new HubError("child_exited", 503);
        finish();
      });
    });
  }

  check(): void {
    if (this.failure !== undefined) throw this.failure;
  }

  stop(): Promise<void> {
    this.stopPromise ??= this.stopOwned();
    return this.stopPromise;
  }

  private hasExited(): boolean {
    return this.exited;
  }

  private async stopOwned(): Promise<void> {
    this.stopping = true;
    if (!this.exited && this.child.pid !== undefined) {
      if (process.platform === "win32") {
        const pid = this.child.pid;
        await new Promise<void>((resolveStop, reject) => {
          execFile(
            "taskkill.exe",
            ["/PID", String(pid), "/T", "/F"],
            (error) => {
              if (error && !this.exited)
                reject(new HubError("child_cleanup_failed", 503));
              else resolveStop();
            },
          );
        });
      } else {
        process.kill(-this.child.pid, "SIGTERM");
        await Promise.race([this.done, delay(3000)]);
        if (!this.hasExited()) process.kill(-this.child.pid, "SIGKILL");
      }
    }
    await this.done;
  }
}

export async function waitReady(
  process: OwnedProcess,
  probe: () => Promise<boolean>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  do {
    checkStartup(signal);
    process.check();
    if (await probe()) {
      checkStartup(signal);
      process.check();
      return;
    }
    await delay(50);
  } while (Date.now() < deadline);
  process.check();
  throw new HubError("startup_timeout", 503);
}

export async function endpointFromRegistry(
  directory: string,
): Promise<string | undefined> {
  const entries = join(
    directory,
    "user-data",
    "agent-host",
    "local-endpoint",
    "entries",
  );
  let names: string[];
  try {
    names = await readdir(entries);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  }
  // The runtime reads this private registry only; never the editor's registry.
  if (names.length > 1) throw new HubError("ambiguous_instance_registry", 503);
  return names[0] === undefined ? undefined : join(entries, names[0]);
}
