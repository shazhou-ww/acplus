#!/usr/bin/env node
import { parseArgs } from "node:util";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { HubError, publicError } from "./common.js";
import { start, type StartOptions } from "./runtime.js";
import { loadConfig } from "./config.js";

export async function main(args = process.argv.slice(2)): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: "boolean", short: "h" },
      instance: { type: "string" },
      config: { type: "string" },
      "data-dir": { type: "string" },
      port: { type: "string" },
      "code-path": { type: "string" },
      "host-url": { type: "string" },
    },
  });
  if (values.help === true) {
    process.stdout.write(
      "ahplex --instance NAME [--config FILE] [--port 4280] [--data-dir DIR] [--code-path EXECUTABLE] [--host-url ws://127.0.0.1:PORT]\nSelect a service using /services/ID/...; services start on demand.\nTransport: AHPLEX_API_TOKEN, AHPLEX_HOST_TOKEN (legacy attachment only).\nLegacy optional AHPLEX_AUTH_RESOURCE + AHPLEX_AUTH_TOKEN deliver an explicitly supplied credential; they are not a provider login prerequisite.\n",
    );
    return;
  }
  if (values.instance === undefined)
    throw new HubError("instance_required", 400);
  const port = Number(values.port ?? "4280");
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new HubError("invalid_port", 400);
  const options: StartOptions = {
    instance: values.instance,
    port,
    ...(values.config === undefined
      ? {}
      : { config: await loadConfig(values.config) }),
    ...(values["data-dir"] === undefined
      ? {}
      : { dataDir: values["data-dir"] }),
    ...(values["code-path"] === undefined
      ? {}
      : { codePath: values["code-path"] }),
    ...(values["host-url"] === undefined
      ? {}
      : { hostUrl: values["host-url"] }),
    ...(process.env.AHPLEX_HOST_TOKEN === undefined
      ? {}
      : { hostToken: process.env.AHPLEX_HOST_TOKEN }),
    ...(process.env.AHPLEX_API_TOKEN === undefined
      ? {}
      : { apiToken: process.env.AHPLEX_API_TOKEN }),
    ...(process.env.AHPLEX_AUTH_RESOURCE === undefined
      ? {}
      : { authResource: process.env.AHPLEX_AUTH_RESOURCE }),
    ...(process.env.AHPLEX_AUTH_TOKEN === undefined
      ? {}
      : { authToken: process.env.AHPLEX_AUTH_TOKEN }),
  };
  const controller = new AbortController();
  let running: Awaited<ReturnType<typeof start>> | undefined;
  const stop = (): void => {
    if (running === undefined) {
      controller.abort();
      return;
    }
    void running.close().then(
      () => {
        process.exitCode = 0;
      },
      () => {
        process.stderr.write("ahplex: cleanup_failed\n");
        process.exitCode = 1;
      },
    );
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    running = await start({ ...options, signal: controller.signal });
    process.stdout.write(
      `ahplex ${options.instance} listening at ${running.url}\n`,
    );
  } catch (error) {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    throw error;
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  void main().catch((error: unknown) => {
    process.stderr.write(`ahplex: ${publicError(error).code}\n`);
    process.exitCode = 1;
  });
}
