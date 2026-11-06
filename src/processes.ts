import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ServiceError, type Redactor } from "./common.js";
import type { SecretReference } from "./config.js";
import type { SecretResolver } from "./extensions.js";

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
  ])
    if (process.env[name] !== undefined) env[name] = process.env[name];
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
    VSCODE_CLI_DATA_DIR: join(directory, "cli"),
    VSCODE_AGENT_FOLDER: join(directory, "server"),
  };
}

export class Secrets implements SecretResolver {
  constructor(private readonly redactor: Redactor) {}
  async resolve(reference: SecretReference): Promise<string> {
    let value: string | undefined;
    try {
      value =
        reference.source === "env"
          ? process.env[reference.name]
          : (await readFile(reference.path, "utf8")).replace(/\r?\n$/u, "");
    } catch {
      throw new ServiceError("credential_unavailable", 409);
    }
    if (value === undefined || value === "")
      throw new ServiceError("credential_unavailable", 409);
    return this.redactor.add(value);
  }
}

export interface SpawnOptions {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  cwd?: string;
  output?: "pipe";
  input?: "pipe";
}

export class OwnedProcess {
  readonly child: ChildProcess;
  private ended = false;
  private readonly done: Promise<void>;
  private stopping: Promise<void> | undefined;
  private failureCode = "owned_process_exited";

  constructor(options: SpawnOptions) {
    options.signal.throwIfAborted();
    this.child = spawn(options.command, options.args, {
      shell: false,
      env: options.env,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: [
        options.input === "pipe" ? "pipe" : "ignore",
        options.output === "pipe" ? "pipe" : "ignore",
        options.output === "pipe" ? "pipe" : "ignore",
      ],
    });
    this.done = new Promise((resolve) => {
      const finish = (): void => {
        this.ended = true;
        resolve();
      };
      this.child.once("error", finish);
      this.child.once("exit", finish);
    });
  }

  check(): void {
    if (this.ended) throw new ServiceError(this.failureCode, 503);
  }

  setFailureCode(code: string): void {
    this.failureCode = code;
  }

  stop(): Promise<void> {
    this.stopping ??= this.stopTree();
    return this.stopping;
  }

  private hasEnded(): boolean {
    return this.ended;
  }

  private async stopTree(): Promise<void> {
    if (!this.ended && this.child.pid !== undefined) {
      const pid = this.child.pid;
      if (process.platform === "win32") {
        await new Promise<void>((resolve, reject) => {
          execFile(
            "taskkill.exe",
            ["/PID", String(pid), "/T", "/F"],
            { windowsHide: true, timeout: 10_000 },
            (error) => {
              if (error !== null && !this.ended)
                reject(new ServiceError("owned_cleanup_failed", 503));
              else resolve();
            },
          );
        });
      } else {
        process.kill(-pid, "SIGTERM");
        await Promise.race([this.done, delay(3000)]);
        if (!this.hasEnded()) process.kill(-pid, "SIGKILL");
      }
    }
    await this.done;
  }
}

export class ProcessOwner {
  private readonly children = new Set<OwnedProcess>();
  private closed = false;

  spawn(options: SpawnOptions): OwnedProcess {
    if (this.closed) throw new ServiceError("owner_closed", 503);
    const child = new OwnedProcess(options);
    this.children.add(child);
    return child;
  }

  check(): void {
    for (const child of this.children) child.check();
  }

  async stop(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.children].map(async (child) => {
        await child.stop();
        this.children.delete(child);
      }),
    );
    if (results.some((result) => result.status === "rejected"))
      throw new ServiceError("owned_cleanup_failed", 503);
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.stop();
  }
}
