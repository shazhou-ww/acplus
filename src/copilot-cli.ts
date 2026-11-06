import { stripVTControlCharacters } from "node:util";
import { bounded, ServiceError } from "./common.js";
import { objectSchema } from "./config.js";
import {
  codec,
  type AuthenticationAdapterFactory,
  type AuthenticationContext,
} from "./extensions.js";
import type { ProcessOwner } from "./processes.js";

export const copilotCliFactory: AuthenticationAdapterFactory<{
  mode: "login" | "reuse";
}> = {
  id: "copilot-cli",
  options: codec(objectSchema({ mode: { enum: ["login", "reuse"] } })),
  create: ({ mode }) => ({
    async run(context, signal) {
      if (context.authenticateNative === undefined)
        throw new ServiceError("auth_target_unsupported", 409);
      await context.authenticateNative(mode, signal);
    },
  }),
};

// util-linux script supplies a real terminal without recording its transcript.
// Only exact device challenges and a single explicit storage choice leave it.
export async function nativeCopilotLogin(
  context: AuthenticationContext,
  command: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  platform = process.platform,
  processes: ProcessOwner = context.processes,
): Promise<{ authenticated: boolean; account?: string }> {
  if (platform !== "linux")
    throw new ServiceError("auth_native_pty_unsupported", 409);
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const owned = processes.spawn({
    command: "/usr/bin/script",
    args: [
      "--quiet",
      "--return",
      "--flush",
      "--command",
      `${quote(command)} login --device-code`,
      "/dev/null",
    ],
    env: { ...env, TERM: "dumb" },
    signal,
    output: "pipe",
    input: "pipe",
  });
  let pending = "";
  let published = false;
  let prompted = false;
  let code: string | undefined;
  let link: string | undefined;
  let input: Promise<void> | undefined;
  const identity: { account?: string; confirmedAt?: number; receipt: boolean } =
    { receipt: false };
  let failure: (error: unknown) => void = () => {};
  const inputError = (): void => {
    failure(new ServiceError("auth_cli_failed", 409));
  };
  owned.child.stdin?.on("error", inputError);
  const consume = (chunk: Buffer): void => {
    try {
      pending += stripVTControlCharacters(chunk.toString("utf8"));
      if (pending.length > 32_768)
        throw new ServiceError("auth_cli_invalid_response", 502);
      code ??= /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/u.exec(pending)?.[1];
      link ??= /https:\/\/github\.com\/login\/device\b/u.exec(pending)?.[0];
      if (!published && code !== undefined && link !== undefined) {
        context.publishStep({ kind: "link", url: link, userCode: code });
        published = true;
      }
      const success =
        /(?:^|\r?\n)(?:✓ )?Signed in successfully as ([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\.[ \t]*\r?\n/u.exec(
          pending,
        );
      if (
        identity.confirmedAt !== undefined &&
        success !== null &&
        success[1] !== undefined &&
        success.index >= identity.confirmedAt
      ) {
        identity.receipt = published;
        identity.account = success[1];
      }
      if (
        !prompted &&
        pending.includes(
          "System keychain unavailable. Store token in plaintext config file? (y/N)",
        )
      ) {
        prompted = true;
        input = (async () => {
          const answer = await context.requestInput(
            { kind: "input", fields: ["confirmPlaintextStorage"] },
            signal,
          );
          if (answer.values.confirmPlaintextStorage !== "yes")
            throw new ServiceError("auth_storage_declined", 409);
          signal.throwIfAborted();
          const stdin = owned.child.stdin;
          if (stdin === null) throw new ServiceError("auth_cli_failed", 409);
          identity.confirmedAt = pending.length;
          await new Promise<void>((resolve, reject) => {
            stdin.write("y\n", (error) => {
              if (error !== null && error !== undefined)
                reject(new ServiceError("auth_cli_failed", 409));
              else resolve();
            });
          });
        })();
        void input.catch(failure);
      }
    } catch (error) {
      failure(error);
    }
  };
  try {
    await bounded(
      new Promise<void>((resolve, reject) => {
        failure = reject;
        owned.child.stdout?.on("data", consume);
        owned.child.stderr?.on("data", consume);
        owned.child.once("error", () => {
          reject(new ServiceError("auth_cli_unavailable", 503));
        });
        owned.child.once("exit", (exitCode) => {
          if (exitCode !== 0) reject(new ServiceError("auth_cli_failed", 409));
          else resolve();
        });
      }),
      signal,
    );
    await input;
    return {
      authenticated: identity.receipt,
      ...(identity.account === undefined ? {} : { account: identity.account }),
    };
  } finally {
    owned.child.stdout?.off("data", consume);
    owned.child.stderr?.off("data", consume);
    await owned.stop();
    owned.child.stdin?.off("error", inputError);
  }
}
