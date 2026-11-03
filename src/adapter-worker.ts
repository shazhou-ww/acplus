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
  let authStatus = "required";
  const refused = new Set<string>();
  const host = await liveHost({
    url: config.url,
    token: config.connectionToken,
    clientId: `ahplex-${config.instance}`,
    onRefusal: (uri) => {
      refused.add(uri);
    },
    onAuthRequired: () => {
      authStatus = "required";
    },
    onConnected: async (connected) => {
      if (config.authResource !== undefined && config.authToken !== undefined) {
        try {
          if (connected.authenticate === undefined)
            throw new Error("authentication_unsupported");
          await connected.authenticate(config.authResource, config.authToken);
          authStatus = "configured";
        } catch {
          authStatus = "required";
        }
      }
    },
  });
  const requireAuth = (): void => {
    if (authStatus !== "configured") throw new Error("auth_required");
    if (host.state() !== "connected") throw new Error("host_unavailable");
  };
  const create = TOOLS.find((tool) => tool.name === "new_session");
  if (create === undefined) throw new Error("Unsupported ahpc tool table");
  const createRun = create.run.bind(create);
  create.run = async (...args) => {
    requireAuth();
    return createRun(...args);
  };
  const historyTool = TOOLS.find((tool) => tool.name === "session_history");
  if (historyTool === undefined) throw new Error("Unsupported ahpc tool table");
  const historyRun = historyTool.run.bind(historyTool);
  historyTool.run = async (connection, input, report) => {
    requireAuth();
    if (refused.has(string(input.session))) throw new Error("session_refused");
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
        "Private ahplex readiness and explicit authentication state.",
      readOnly: true,
      input: { type: "object", properties: {} },
      run: async () => ({
        instance: config.instance,
        status: host.state() === "connected" ? "ready" : "unavailable",
        authentication: authStatus,
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
        requireAuth();
        const session = string(input.session);
        const snapshot = await until(
          host,
          session,
          (event) => event.type === "snapshot" || event.type === "error",
          { timeoutSeconds: 30 },
        );
        if (snapshot?.type !== "snapshot" || refused.has(session))
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
        controlled.stopTurn(string(input.session), string(input.turnId));
        return Promise.resolve({ requested: true });
      },
    },
  );
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
