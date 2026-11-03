import { register } from "node:module";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { object, string } from "./common.js";

export interface WorkerConfig {
  url: string;
  connectionToken: string;
  apiToken: string;
  instance: string;
  authResource?: string;
  authToken?: string;
}

export async function runAdapter(config: WorkerConfig): Promise<void> {
  register(new URL("./compat-loader.js", import.meta.url), import.meta.url);
  const [{ liveHost }, { serve }, { TOOLS }, { until }] = await Promise.all([
    import("@softov/ahpc/dist/src/ahp/live.js"),
    import("@softov/ahpc/dist/src/mcp/http.js"),
    import("@softov/ahpc/dist/src/mcp/tools.js"),
    import("@softov/ahpc/dist/src/wait.js"),
  ]);
  const { authRequiredOf } = await import("@softov/ahpc/dist/src/ahp/auth.js");
  let authStatus = "backend";
  let credentialRefused = false;
  const refused = new Map<string, string>();
  const host = await liveHost({
    url: config.url,
    token: config.connectionToken,
    clientId: `ahplex-${config.instance}`,
    onRefusal: (uri, message) => {
      if (message.endsWith("(-32007)")) {
        authStatus = "required";
        credentialRefused = true;
      }
      refused.set(
        uri,
        message.endsWith("(-32007)")
          ? "backend_authentication_required"
          : "session_refused",
      );
    },
    onAuthRequired: (_resources, reason) => {
      authStatus = "required";
      if (reason === "expired") credentialRefused = true;
    },
    onConnected: async (connected) => {
      if (
        !credentialRefused &&
        config.authResource !== undefined &&
        config.authToken !== undefined
      ) {
        try {
          if (connected.authenticate === undefined)
            throw new Error("authentication_unsupported");
          await connected.authenticate(config.authResource, config.authToken);
          authStatus = "backend";
        } catch {
          authStatus = "required";
          credentialRefused = true;
        }
      }
    },
  });
  const requireConnected = (): void => {
    if (host.state() !== "connected") throw new Error("host_unavailable");
  };
  const create = TOOLS.find((tool) => tool.name === "new_session");
  if (create === undefined) throw new Error("Unsupported ahpc tool table");
  const historyTool = TOOLS.find((tool) => tool.name === "session_history");
  if (historyTool === undefined) throw new Error("Unsupported ahpc tool table");
  const historyRun = historyTool.run.bind(historyTool);
  historyTool.run = async (connection, input, report) => {
    requireConnected();
    const refusal = refused.get(string(input.session));
    if (refusal !== undefined) throw new Error(refusal);
    return historyRun(connection, input, report);
  };
  const controlled: typeof host & {
    say(uri: string, text: string, model: undefined, turnId: string): void;
    stopTurn(uri: string, turnId: string): void;
  } = host;
  TOOLS.push(
    {
      name: "hub_status",
      title: "Ahplex adapter status",
      description:
        "Private ahplex transport readiness and backend authorization observations.",
      readOnly: true,
      input: { type: "object", properties: {} },
      run: async () => ({
        instance: config.instance,
        status: host.state() === "connected" ? "ready" : "unavailable",
        authentication: authStatus,
        ...(authStatus === "required"
          ? {
              action:
                "Use the selected service/provider native authorization workflow; client-mediated AHP token acquisition is not implemented by this bridge.",
            }
          : {}),
        resources: (await host.protectedResources?.()) ?? [],
      }),
    },
    {
      name: "hub_start_turn",
      title: "Start a correlated turn",
      description:
        "Start exactly the caller-assigned turn, without waiting for completion.",
      readOnly: false,
      input: {
        type: "object",
        properties: {
          session: { type: "string" },
          text: { type: "string" },
          turnId: { type: "string" },
        },
        required: ["session", "text", "turnId"],
      },
      run: async (_host, input) => {
        requireConnected();
        const session = string(input.session);
        const snapshot = await until(
          host,
          session,
          (event) => event.type === "snapshot" || event.type === "error",
          { timeoutSeconds: 30 },
        );
        const refusal = refused.get(session);
        if (refusal !== undefined) throw new Error(refusal);
        if (snapshot?.type !== "snapshot")
          throw new Error("session_unavailable");
        if (snapshot.active !== undefined) throw new Error("session_busy");
        const turnId = string(input.turnId);
        controlled.say(session, string(input.text), undefined, turnId);
        return { id: turnId };
      },
    },
    {
      name: "hub_cancel_turn",
      title: "Cancel a correlated turn",
      description:
        "Cancel only if the active turn matches the caller-assigned ID.",
      readOnly: false,
      input: {
        type: "object",
        properties: { session: { type: "string" }, turnId: { type: "string" } },
        required: ["session", "turnId"],
      },
      run: (_host, input) => {
        requireConnected();
        controlled.stopTurn(string(input.session), string(input.turnId));
        return Promise.resolve({ requested: true });
      },
    },
  );
  // Upstream HTTP serializes error messages, so expose only stable safe codes.
  const safeErrors = new Set([
    "host_unavailable",
    "session_refused",
    "session_unavailable",
    "session_busy",
    "backend_authentication_required",
  ]);
  for (const entry of TOOLS) {
    const run = entry.run.bind(entry);
    entry.run = async (...args) => {
      try {
        if (entry.name !== "hub_status") requireConnected();
        return await run(...args);
      } catch (error) {
        if (authRequiredOf(error) !== null) {
          authStatus = "required";
          credentialRefused = true;
          throw new Error("backend_authentication_required", { cause: error });
        }
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === -32601
        )
          throw new Error("backend_capability_unsupported", { cause: error });
        const message = error instanceof Error ? error.message : "";
        throw new Error(
          safeErrors.has(message) ? message : "backend_request_failed",
          { cause: error },
        );
      }
    };
  }
  const server = await serve(host, {
    host: "127.0.0.1",
    port: 0,
    token: config.apiToken,
    name: "ahplex",
    version: "0.1.0",
  });
  process.send?.({ type: "ready", port: server.port });
  process.once("disconnect", () => {
    void host.close();
    process.exit(0);
  });
}

if (
  process.send !== undefined &&
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  process.once("message", (message: unknown) => {
    const input = object(message);
    const config: WorkerConfig = {
      url: string(input.url),
      connectionToken: string(input.connectionToken),
      apiToken: string(input.apiToken),
      instance: string(input.instance),
      ...(input.authResource === undefined
        ? {}
        : { authResource: string(input.authResource) }),
      ...(input.authToken === undefined
        ? {}
        : { authToken: string(input.authToken) }),
    };
    void runAdapter(config).catch(() => {
      process.send?.({ type: "failed" });
      process.exitCode = 1;
      process.disconnect?.();
    });
  });
}
