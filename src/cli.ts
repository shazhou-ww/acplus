#!/usr/bin/env node
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigurationError, diagnostic, ServiceError } from "./acp-common.js";
import { execute } from "./cli-core.js";

export const run = (args: string[]): Promise<void> => execute(args);

if (
  process.argv[1] !== undefined &&
  (await realpath(resolve(process.argv[1]))) === fileURLToPath(import.meta.url)
) {
  void run(process.argv.slice(2)).catch((error: unknown) => {
    if (process.connected) {
      process.send?.({
        error:
          error instanceof ServiceError
            ? error.code
            : "local_service_configuration_failed",
      });
      process.disconnect?.();
    }
    if (process.argv.includes("--json"))
      console.error(JSON.stringify({ error: diagnostic(error) }));
    else
      console.error(
        error instanceof Error ? error.message : "Operation failed",
      );
    process.exitCode = error instanceof ConfigurationError ? 2 : 1;
  });
}
