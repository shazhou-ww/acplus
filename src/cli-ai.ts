#!/usr/bin/env node
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigurationError, diagnostic, ServiceError } from "./acp-common.js";
import { aiMessage } from "./cli-ai-contract.js";
import { execute } from "./cli-core.js";

export async function run(args: string[]): Promise<void> {
  try {
    await execute(args, "ai");
  } catch (error) {
    if (error instanceof ConfigurationError)
      throw new ConfigurationError(aiMessage(error.message));
    if (error instanceof ServiceError)
      throw new ServiceError(
        error.code,
        error.status,
        aiMessage(error.message),
      );
    throw error;
  }
}

if (
  process.argv[1] !== undefined &&
  (await realpath(resolve(process.argv[1]))) === fileURLToPath(import.meta.url)
) {
  process.removeAllListeners("warning");
  process.on("warning", (warning) => {
    console.error(
      JSON.stringify({
        event: "runtime_warning",
        name: warning.name,
        message: warning.message,
      }),
    );
  });
  void run(process.argv.slice(2)).catch((error: unknown) => {
    console.error(
      JSON.stringify({
        error:
          error instanceof ConfigurationError
            ? { code: "invalid_input", message: error.message }
            : diagnostic(error),
      }),
    );
    process.exitCode =
      error instanceof ConfigurationError ||
      (error instanceof ServiceError && error.code === "invalid_input")
        ? 2
        : 1;
  });
}
