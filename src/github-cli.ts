import { stripVTControlCharacters } from "node:util";
import { basename } from "node:path";
import { bounded, ConfigurationError, record, ServiceError } from "./common.js";
import { objectSchema } from "./config.js";
import {
  codec,
  type AuthenticationAdapterFactory,
  type AuthenticationContext,
  type UpstreamCredential,
} from "./extensions.js";
import { isolatedEnvironment } from "./processes.js";

interface GithubCliOptions {
  command: string;
  args: string[];
  profileDir: string;
  account: string;
  mode: "login" | "reuse";
  isolation: "dedicated-runtime";
}

const copilotScopes = ["read:user", "user:email"];

const optionsCodec = codec<GithubCliOptions>(
  objectSchema({
    command: { type: "string", minLength: 1 },
    args: { type: "array", items: { type: "string" } },
    profileDir: { type: "string", pattern: "^(?:/|[A-Za-z]:[\\\\/]).+" },
    account: {
      type: "string",
      pattern: "^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$",
    },
    mode: { enum: ["login", "reuse"] },
    isolation: { const: "dedicated-runtime" },
  }),
);

// The command is a deployment-trusted boundary: on Windows it must be a
// wrapper into an isolated runtime, not the current user's native gh.
export function githubCliFactory(): AuthenticationAdapterFactory<GithubCliOptions> {
  const profiles = new Map<string, { account: string; active: boolean }>();
  return {
    id: "github-cli",
    options: optionsCodec,
    create(options) {
      if (
        /\.(?:cmd|bat)$/iu.test(options.command) ||
        (process.platform === "win32" &&
          /^gh(?:\.exe)?$/iu.test(basename(options.command)))
      )
        throw new ConfigurationError(
          "github-cli requires a trusted isolated-runtime launcher",
        );
      const key = JSON.stringify([
        options.command,
        options.args,
        options.profileDir,
      ]);
      let profile = profiles.get(key);
      const account = options.account.toLowerCase();
      if (profile !== undefined && profile.account !== account)
        throw new ConfigurationError("github-cli profile account conflict");
      if (profile === undefined) {
        profile = { account, active: false };
        profiles.set(key, profile);
      }
      const binding = profile;
      return {
        async run(context, signal) {
          if (
            context.target.provider !== "copilotcli" ||
            context.target.resource !== "https://api.github.com"
          )
            throw new ServiceError("auth_target_unsupported", 409);
          if (binding.active) throw new ServiceError("auth_profile_busy", 409);
          binding.active = true;
          let cleanupFailed = false;
          try {
            if (options.mode === "login") {
              const interaction = new DeviceInteraction(context);
              await command(
                options,
                context,
                [
                  "auth",
                  "login",
                  "--hostname",
                  "github.com",
                  "--web",
                  "--git-protocol",
                  "https",
                  "--skip-ssh-key",
                  "--insecure-storage",
                  "--clipboard=false",
                  "--scopes",
                  copilotScopes.join(","),
                ],
                signal,
                (stream, chunk) => {
                  interaction.write(stream, chunk);
                },
              );
              interaction.finish();
            }
            const status = await command(
              options,
              context,
              [
                "auth",
                "status",
                "--hostname",
                "github.com",
                "--active",
                "--json",
                "hosts",
                "--no-refresh",
              ],
              signal,
            );
            const { account, ...metadata } = credentialMetadata(
              status,
              options,
            );
            const output = await command(
              options,
              context,
              [
                "auth",
                "token",
                "--hostname",
                "github.com",
                "--user",
                account,
                "--no-refresh",
              ],
              signal,
            );
            const token = output.replace(/\r?\n$/u, "");
            if (!/^gh[ou]_[A-Za-z0-9_]+$/u.test(token))
              throw new ServiceError("auth_invalid_credential", 409);
            await context.submitCredential({ ...metadata, token }, signal);
          } catch (error) {
            cleanupFailed =
              error instanceof ServiceError &&
              error.code === "owned_cleanup_failed";
            throw error;
          } finally {
            if (!cleanupFailed) binding.active = false;
          }
        },
      };
    },
  };
}

function credentialMetadata(
  output: string,
  options: GithubCliOptions,
): Omit<UpstreamCredential, "token"> & { account: string } {
  let data: unknown;
  try {
    data = JSON.parse(output);
  } catch {
    throw new ServiceError("auth_cli_invalid_response", 502);
  }
  const entries =
    record(data) && record(data.hosts) ? data.hosts["github.com"] : undefined;
  const entry: unknown =
    Array.isArray(entries) && entries.length === 1 ? entries[0] : undefined;
  if (
    !record(entry) ||
    entry.state !== "success" ||
    entry.active !== true ||
    entry.host !== "github.com" ||
    typeof entry.login !== "string" ||
    entry.login.toLowerCase() !== options.account.toLowerCase()
  )
    throw new ServiceError("auth_cli_account_unavailable", 409);
  const normalize = (path: string) =>
    path.replaceAll("\\", "/").replace(/\/$/u, "");
  if (
    typeof entry.tokenSource !== "string" ||
    normalize(entry.tokenSource) !==
      `${normalize(options.profileDir)}/hosts.yml`
  )
    throw new ServiceError("auth_cli_credential_source", 409);
  if (typeof entry.scopes !== "string")
    throw new ServiceError("auth_cli_invalid_response", 502);
  const scopes = [...new Set(entry.scopes.split(/[,\s]+/u).filter(Boolean))];
  if (scopes.some((scope) => !/^[a-z][a-z0-9:_-]*$/u.test(scope)))
    throw new ServiceError("auth_cli_invalid_response", 502);
  // GitHub normalizes implied grants out of its scope header. The Host's
  // scope matcher uses literal containment, so include these known subscopes.
  if (scopes.includes("user"))
    for (const scope of copilotScopes)
      if (!scopes.includes(scope)) scopes.push(scope);
  if (copilotScopes.some((scope) => !scopes.includes(scope)))
    throw new ServiceError("auth_scope_missing", 409);
  if (entry.tokenExpiresAt !== undefined) {
    if (
      typeof entry.tokenExpiresAt !== "string" ||
      !Number.isFinite(Date.parse(entry.tokenExpiresAt))
    )
      throw new ServiceError("auth_cli_invalid_response", 502);
    if (Date.parse(entry.tokenExpiresAt) <= Date.now())
      throw new ServiceError("auth_expired", 409);
  }
  return {
    account: entry.login,
    scopes,
    ...(typeof entry.tokenExpiresAt === "string"
      ? { expiresAt: entry.tokenExpiresAt }
      : {}),
  };
}

class DeviceInteraction {
  private readonly pending = { stdout: "", stderr: "" };
  private code: string | undefined;
  private url: string | undefined;
  private published = false;
  constructor(private readonly context: AuthenticationContext) {}

  write(stream: "stdout" | "stderr", chunk: string): void {
    this.pending[stream] += chunk;
    const lines = this.pending[stream].split(/\r?\n/u);
    this.pending[stream] = lines.pop() ?? "";
    if (
      this.pending[stream].length > 8192 ||
      lines.some((line) => line.length > 8192)
    )
      throw new ServiceError("auth_cli_invalid_response", 502);
    for (const line of lines) this.line(line);
  }

  private line(raw: string): void {
    const line = stripVTControlCharacters(raw);
    const code =
      /^! First copy your one-time code: ([A-Z0-9]{4}-[A-Z0-9]{4})\s*$/u.exec(
        line,
      );
    const link =
      /^Open this URL to continue in your web browser: (https:\/\/github\.com\/login\/device)\s*$/u.exec(
        line,
      );
    if (code !== null) this.code = code[1];
    if (link !== null) this.url = link[1];
    if (!this.published && this.code !== undefined && this.url !== undefined) {
      this.context.publishStep({
        kind: "link",
        url: this.url,
        userCode: this.code,
      });
      this.published = true;
    }
  }

  finish(): void {
    for (const value of Object.values(this.pending)) this.line(value);
    if (!this.published)
      throw new ServiceError("auth_cli_interaction_missing", 502);
  }
}

async function command(
  options: GithubCliOptions,
  context: AuthenticationContext,
  args: string[],
  signal: AbortSignal,
  observe?: (stream: "stdout" | "stderr", chunk: string) => void,
): Promise<string> {
  const child = context.processes.spawn({
    command: options.command,
    args: [...options.args, ...args],
    env: {
      ...isolatedEnvironment(options.profileDir),
      GH_CONFIG_DIR: options.profileDir,
      GH_PROMPT_DISABLED: "1",
      GH_NO_UPDATE_NOTIFIER: "1",
      GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
      GH_BROWSER: "ahplex-browser-disabled",
      BROWSER: "ahplex-browser-disabled",
      NO_COLOR: "1",
      TERM: "dumb",
      // Linux wrappers must preserve this or establish a separate no-keychain
      // runtime. HOME/GH_CONFIG_DIR alone never isolate a system keychain.
      DBUS_SESSION_BUS_ADDRESS: "disabled:",
    },
    signal,
    output: "pipe",
  });
  let output = "";
  let bytes = 0;
  const done = new Promise<void>((resolve, reject) => {
    for (const stream of ["stdout", "stderr"] as const) {
      child.child[stream]?.setEncoding("utf8");
      child.child[stream]?.on("data", (chunk: string) => {
        try {
          bytes += Buffer.byteLength(chunk);
          if (bytes > 65536)
            throw new ServiceError("auth_cli_output_limit", 502);
          if (observe !== undefined) observe(stream, chunk);
          else if (stream === "stdout") output += chunk;
        } catch (error) {
          reject(
            error instanceof ServiceError
              ? error
              : new ServiceError("auth_cli_invalid_response", 502),
          );
        }
      });
    }
    child.child.once("error", () => {
      reject(new ServiceError("auth_cli_unavailable", 503));
    });
    child.child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new ServiceError("auth_cli_failed", 409));
    });
  });
  // Cancellation can already be set between spawn and bounded's first check.
  // Reaping that process still rejects completion; never leave it unobserved.
  void done.catch(() => {});
  try {
    await bounded(done, signal);
    return output;
  } finally {
    await child.stop();
  }
}
