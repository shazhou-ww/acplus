import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import { type Redactor, ServiceError } from "./acp-common.js";
import type { AgentConfig, AuthStep } from "./acp-types.js";

export function waitFor<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = (): void => {
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new ServiceError("operation_cancelled"),
      );
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", abort);
    });
  });
}

export async function agentEnvironment(
  agent: AgentConfig,
  redactor: Redactor,
): Promise<NodeJS.ProcessEnv> {
  const credential = (name: string, value: string): string => {
    if (/token|secret|password|key|authorization|cookie/iu.test(name)) {
      redactor.add(value);
      if (/^Bearer \S+$/iu.test(value)) redactor.add(value.slice(7));
    }
    return value;
  };
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
  for (const [name, reference] of Object.entries(agent.env)) {
    if (typeof reference === "string") env[name] = credential(name, reference);
    else {
      let value: string | undefined;
      try {
        value =
          reference.source === "env"
            ? process.env[reference.name]
            : (await readFile(reference.path, "utf8")).replace(/\r?\n$/u, "");
      } catch {
        throw new ServiceError("credential_unavailable", 409);
      }
      for (const server of agent.mcpServers)
        for (const { name, value } of "headers" in server
          ? server.headers
          : server.env)
          credential(name, value);
      if (value === undefined || value === "")
        throw new ServiceError("credential_unavailable", 409);
      env[name] = redactor.add(value);
    }
  }
  const directories = [
    "",
    "appdata",
    "localappdata",
    "tmp",
    "config",
    "data",
    "cache",
  ];
  await Promise.all(
    directories.map(async (name) => {
      await mkdir(join(agent.profileDir, name), {
        recursive: true,
        mode: 0o700,
      });
    }),
  );
  return {
    ...env,
    HOME: agent.profileDir,
    USERPROFILE: agent.profileDir,
    COPILOT_HOME: agent.profileDir,
    APPDATA: join(agent.profileDir, "appdata"),
    LOCALAPPDATA: join(agent.profileDir, "localappdata"),
    TMP: join(agent.profileDir, "tmp"),
    TEMP: join(agent.profileDir, "tmp"),
    TMPDIR: join(agent.profileDir, "tmp"),
    XDG_CONFIG_HOME: join(agent.profileDir, "config"),
    XDG_DATA_HOME: join(agent.profileDir, "data"),
    XDG_CACHE_HOME: join(agent.profileDir, "cache"),
    DBUS_SESSION_BUS_ADDRESS: "disabled:",
  };
}

/** Owns a private process group, never a command-name based process selection. */
export class AgentProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly ended: Promise<void>;
  private exited = false;
  private stopping: Promise<void> | undefined;

  constructor(command: string, args: string[], env: NodeJS.ProcessEnv) {
    this.child = spawn(command, args, {
      env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: "pipe",
    });
    this.ended = new Promise((resolve) => {
      const finish = (): void => {
        this.exited = true;
        resolve();
      };
      this.child.once("error", finish);
      this.child.once("exit", finish);
    });
    // Pipes can fail concurrently with transport shutdown.
    this.child.stdin.on("error", () => {});
    this.child.stdout.on("error", () => {});
    this.child.stderr.on("error", () => {});
  }

  stop(): Promise<void> {
    this.stopping ??= this.stopTree();
    return this.stopping;
  }

  private async stopTree(): Promise<void> {
    const pid = this.child.pid;
    if (pid !== undefined) {
      if (process.platform === "win32") {
        if (!this.exited)
          await new Promise<void>((resolve, reject) => {
            execFile(
              "taskkill.exe",
              ["/PID", String(pid), "/T", "/F"],
              { windowsHide: true, timeout: 3000 },
              (error) => {
                if (error !== null && !this.exited)
                  reject(new ServiceError("owned_cleanup_failed"));
                else resolve();
              },
            );
          });
      } else {
        const kill = (signal: NodeJS.Signals): void => {
          try {
            process.kill(-pid, signal);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH")
              throw new ServiceError("owned_cleanup_failed");
          }
        };
        kill("SIGTERM");
        await Promise.race([this.ended, delay(250)]);
        kill("SIGKILL");
      }
    }
    await Promise.race([
      this.ended,
      delay(3000).then(() => {
        throw new ServiceError("owned_cleanup_failed");
      }),
    ]);
    this.child.stdin.destroy();
    this.child.stdout.destroy();
    this.child.stderr.destroy();
  }
}

export class CopilotLoginParser {
  private pending = "";
  private published = false;
  private prompted = false;
  private code: string | undefined;
  private link: string | undefined;
  private account: string | undefined;
  private confirmed = false;

  constructor(
    private readonly onStep: (step: AuthStep) => void,
    private readonly input: () => void,
  ) {}

  accept(chunk: string): void {
    this.pending += stripVTControlCharacters(chunk);
    if (this.pending.length > 32_768)
      throw new ServiceError("auth_cli_invalid_response", 502);
    this.code ??= /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/u.exec(this.pending)?.[1];
    this.link ??= /https:\/\/github\.com\/login\/device(?=\s)/u.exec(
      this.pending,
    )?.[0];
    if (!this.published && this.code !== undefined && this.link !== undefined) {
      this.onStep({ kind: "link", url: this.link, userCode: this.code });
      this.published = true;
    }
    if (
      !this.prompted &&
      this.pending.includes(
        "System keychain unavailable. Store token in plaintext config file? (y/N)",
      )
    ) {
      this.prompted = true;
      this.input();
    }
    const receipt =
      /(?:^|\r?\n)(?:✓ )?Signed in successfully as ([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\.[ \t]*\r?\n/u.exec(
        this.pending,
      );
    if (receipt?.[1] !== undefined && (!this.prompted || this.confirmed))
      this.account = receipt[1];
  }

  confirm(): void {
    this.confirmed = true;
    // A receipt printed before consent must never authenticate this attempt.
    this.pending = "";
  }

  verify(expectedAccount: string): void {
    if (!this.published || this.account !== expectedAccount)
      throw new ServiceError("auth_identity_unverified", 409);
  }
}

export async function copilotLogin(
  agent: AgentConfig,
  env: NodeJS.ProcessEnv,
  onStep: (step: AuthStep) => void,
  requestInput: (
    step: Extract<AuthStep, { kind: "input" }>,
    signal: AbortSignal,
  ) => Promise<Record<string, string>>,
  signal: AbortSignal,
  platform = process.platform,
): Promise<void> {
  if (platform !== "linux")
    throw new ServiceError("auth_native_pty_unsupported", 409);
  signal.throwIfAborted();
  const loginLifetime = new AbortController();
  signal = AbortSignal.any([signal, loginLifetime.signal]);
  const quote = (value: string): string =>
    `'${value.replaceAll("'", "'\\''")}'`;
  const owned = new AgentProcess(
    "/usr/bin/script",
    [
      "--quiet",
      "--return",
      "--flush",
      "--command",
      `${quote(agent.command)} login --device-code`,
      "/dev/null",
    ],
    { ...env, TERM: "dumb" },
  );
  let input: Promise<void> | undefined;
  let rejectOperation: (error: unknown) => void = () => {};
  const parser = new CopilotLoginParser(onStep, () => {
    const step: Extract<AuthStep, { kind: "input" }> = {
      kind: "input",
      stepId: "plaintext-storage",
      fields: ["confirmPlaintextStorage"],
    };
    onStep(step);
    input = (async () => {
      const answer = await waitFor(requestInput(step, signal), signal);
      signal.throwIfAborted();
      if (answer.confirmPlaintextStorage !== "yes")
        throw new ServiceError("auth_storage_declined", 409);
      parser.confirm();
      await new Promise<void>((resolve, reject) => {
        owned.child.stdin.write("y\n", (error) => {
          if (error != null) reject(new ServiceError("auth_cli_failed", 409));
          else resolve();
        });
      });
    })();
    void input.catch((error: unknown) => {
      rejectOperation(error);
    });
  });
  const abort = (): void => {
    rejectOperation(new ServiceError("auth_cancelled", 409));
  };
  const consume = (chunk: string): void => {
    try {
      parser.accept(chunk);
    } catch (error) {
      rejectOperation(error);
    }
  };
  owned.child.stdout.setEncoding("utf8");
  owned.child.stderr.setEncoding("utf8");
  try {
    await new Promise<void>((resolve, reject) => {
      rejectOperation = reject;
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      owned.child.stdout.on("data", consume);
      owned.child.stderr.on("data", consume);
      owned.child.once("error", () => {
        reject(new ServiceError("auth_cli_unavailable"));
      });
      owned.child.once("close", (code) => {
        if (code === 0) resolve();
        else reject(new ServiceError("auth_cli_failed", 409));
      });
    });
    parser.verify(agent.authentication?.loginAccount ?? "");
    if (input !== undefined) await waitFor(input, signal);
  } finally {
    signal.removeEventListener("abort", abort);
    loginLifetime.abort(new ServiceError("auth_cancelled", 409));
    await owned.stop();
  }
}
