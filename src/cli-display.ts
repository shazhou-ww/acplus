import { ConfigurationError, record } from "./acp-common.js";

const commands: Record<string, { usage: string; description: string }> = {
  init: {
    usage:
      "init --agent ID --agent-command PATH [--config FILE --profile PATH --login-account LOGIN --data-dir PATH --port N]",
    description:
      "Create a private configuration for the explicit Agent ID (1..64 letters/digits/underscore/hyphen, starting with a letter or digit). ID and label use the supplied value, never the executable name. Default profile: ~/.acplus/ID-profile. Choose a working directory when creating each Session.",
  },
  serve: {
    usage:
      "serve [--config FILE --port N --listen-host ADDRESS --data-dir PATH]",
    description:
      "Run a persistent HTTP service. Local execution commands can start an idle-managed service automatically.",
  },
  health: {
    usage: "health [--url BASE/v2 --config FILE --data-dir PATH]",
    description:
      "Check an existing service. Never start a service just to report it healthy.",
  },
  "agents list": {
    usage: "agents list",
    description:
      "List configured Agents and their observed runtime state using a local or explicit remote service.",
  },
  "agents auth": {
    usage: "agents auth --agent ID [--confirm-storage yes|no]",
    description:
      "Show authentication status, public login steps and what to do next. Explicit --confirm-storage yes|no answers the current storage-consent step without hand-writing JSON. Reading status never logs in or sends a paid model probe.",
  },
  "agents login": {
    usage: "agents login --agent ID [--method METHOD --no-wait --timeout-ms N]",
    description:
      "Start login and wait for public device instructions or a result. The service selects its configured supported native adapter or sole advertised Agent method; multiple choices require --method. Complete the shown browser step, then inspect agents auth. --no-wait returns admission; --timeout-ms bounds waiting (default 300000). No model prompt is sent.",
  },
  "agents auth-input": {
    usage: "agents auth-input --agent ID --input-file FILE|-",
    description:
      "Submit the exact requested authentication input step. Never submit passwords or tokens.",
  },
  "agents logout": {
    usage: "agents logout --agent ID",
    description: "Explicitly log out using the Agent's supported adapter.",
  },
  "sessions list": {
    usage: "sessions list [--agent ID --limit N --cursor CURSOR]",
    description:
      "Read committed Sessions without starting a service. Session selectors accept full UUIDs or unique prefixes of at least 8 characters.",
  },
  "sessions create": {
    usage:
      "sessions create --agent ID --working-directory PATH [--name NAME --idle-grace-ms N]",
    description:
      "Create a Session in an existing directory. Relative paths resolve from the CLI caller's current directory, including with --url; the resulting path must exist on the service host. Optional names are display-only and may repeat; select Sessions by UUID or unique prefix, not by name. This does not start the Agent.",
  },
  "sessions get": {
    usage: "sessions get --session SESSION",
    description:
      "Read one Session by full UUID or unique prefix without starting a service.",
  },
  "sessions delete": {
    usage: "sessions delete SESSION [--yes]",
    description:
      "Permanently delete local Session/Turn/Event history only. Never delete project files, credentials or backend history. Active or ambiguous work is rejected. Interactive confirmation is required unless --yes is supplied.",
  },
  "sessions send": {
    usage:
      'sessions send SESSION "MESSAGE" [--turn UUID --no-wait --timeout-ms N --idle-grace-ms N]',
    description:
      'Send a message, generate a Turn ID, wait and print the reply. Alternatives: --session SESSION --text "MESSAGE", or --text-file FILE|-. Default wait timeout: 300000 ms; range 100..86400000. --no-wait returns admission only. IDs are printed to stderr before dispatch; reuse them after an ambiguous response. Ctrl+C stops waiting, not the Agent.',
  },
  "turns list": {
    usage: "turns list --session SESSION [--limit N --cursor CURSOR]",
    description:
      "Read committed Turns. Stored running state is last-observed evidence, not proof of process liveness.",
  },
  "turns start": {
    usage:
      'turns start --session SESSION --text "MESSAGE" [--turn UUID --idle-grace-ms N]',
    description:
      "Submit without waiting for completion. Turn IDs are generated unless supplied. Use --text-file FILE|- instead of --text for files or stdin. Prefer sessions send for ordinary conversation.",
  },
  "turns get": {
    usage: "turns get --session SESSION --turn UUID",
    description:
      "Read one Turn and its accumulated reply. Reading an error or unknown outcome is still a successful observation.",
  },
  "turns cancel": {
    usage: "turns cancel --session SESSION --turn UUID",
    description:
      "Request cancellation from the actual owner. Never start a replacement service to pretend cancellation succeeded.",
  },
  "events list": {
    usage: "events list --session SESSION [--turn UUID --after N --limit N]",
    description:
      "Read committed events without a server. Turn filtering happens before pagination; sequence cursors remain Session-wide.",
  },
};

export function helpFor(args: string[]): string {
  const words = args.filter((arg) => arg !== "--help" && arg !== "-h");
  const key = words.slice(0, 2).join(" ");
  const common = ["init", "serve"].includes(key)
    ? "\n\nUse --json for machine-readable stdout. Existing configuration and data are never silently overwritten."
    : "\n\nOptions: --json (machine-readable stdout), --config FILE, --data-dir PATH, --url BASE/v2.\nAn explicit URL or ACPLUS_URL never starts a replacement service.\nLocal defaults: ~/.acplus/acplus.yaml, 30000 ms idle grace. Agent authentication is explicit.";
  if (words.length === 0)
    return `acplus - on-demand Agents and durable Session history\nHuman interface. For non-interactive JSON automation: acplus-ai --help.\n\n${[
      ["Setup", ["init", "serve"]],
      [
        "Authentication",
        [
          "agents list",
          "agents auth",
          "agents login",
          "agents auth-input",
          "agents logout",
        ],
      ],
      [
        "Sessions",
        [
          "sessions list",
          "sessions create",
          "sessions get",
          "sessions send",
          "sessions delete",
        ],
      ],
      ["Execution", ["turns list", "turns start", "turns get", "turns cancel"]],
      ["Diagnostics", ["health", "events list"]],
    ]
      .map(
        ([title, names]) =>
          `${title as string}:\n${(names as string[]).map((name) => `  acplus ${commands[name]?.usage ?? ""}`).join("\n")}`,
      )
      .join("\n\n")}${common}`;
  const selected = commands[key];
  if (selected !== undefined)
    return `Usage: acplus ${selected.usage}\n\n${selected.description}${common}`;
  const children = Object.entries(commands).filter(([name]) =>
    name.startsWith(`${words[0]} `),
  );
  if (words.length === 1 && children.length > 0)
    return `Usage:\n${children.map(([, command]) => `  acplus ${command.usage}`).join("\n")}${common}`;
  throw new ConfigurationError("Unknown command");
}

function display(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(display).join(", ");
  if (record(value))
    return Object.entries(value)
      .map(([key, item]) => `${key}: ${display(item)}`)
      .join("; ");
  return JSON.stringify(value);
}

function authOutput(value: Record<string, unknown>): string {
  const agentId =
    typeof value.agentId === "string" ? value.agentId : "AGENT-ID";
  const flow = record(value.flow) ? value.flow : value;
  const next = `acplus agents auth --agent ${agentId}`;
  const context =
    "Use the same --config, --data-dir or --url options as this command.";
  if (typeof flow.operationId !== "string") {
    const methods = Array.isArray(value.methods)
      ? value.methods
          .filter(record)
          .map((method) => `${display(method.id)} (${display(method.name)})`)
          .join(", ")
      : "";
    return `Agent: ${agentId}\nLast observed authentication: ${display(value.lastKnownStatus)}\nEvidence freshness: ${display(value.freshness)}\nVerified at: ${display(value.verifiedAt)}${value.invalidationReason ? `\nInvalidated by: ${display(value.invalidationReason)}` : ""}${methods ? `\nLogin methods: ${methods}` : ""}\nThis is cached evidence, not a live model/entitlement check.\nTo log in: acplus agents login --agent ${agentId}\n${context}`;
  }
  const observed = Object.hasOwn(value, "lastKnownStatus")
    ? `\nLast observed authentication: ${display(value.lastKnownStatus)}\nEvidence freshness: ${display(value.freshness)}`
    : "";
  const heading = `Login: ${display(flow.status)}\nAgent: ${agentId}\nOperation: ${flow.operationId}\nExpires: ${display(flow.expiresAt)}${observed}`;
  if (flow.status === "succeeded")
    return `${heading}\n${observed ? "The previous login flow succeeded; interpret current status using the evidence freshness above." : "Authentication succeeded."} This is not a model entitlement or billing guarantee.`;
  if (flow.status === "failed" || flow.status === "expired")
    return `${heading}\nError: ${display(flow.error)}\nInspect the current evidence: ${next}\n${context}`;
  const step = record(flow.step) ? flow.step : undefined;
  if (step?.kind === "link")
    return `${heading}\n\nOpen in your browser: ${display(step.url)}\nDevice code: ${display(step.userCode)}\nComplete browser authorization, then run:\n  ${next}\n${context}\nFollow any subsequent storage-consent step. Never paste passwords or tokens into acplus.`;
  if (step?.kind === "input")
    return `${heading}\n\nStorage consent is required. Choose yes only if you accept plaintext credential storage; otherwise choose no.\nTo accept:\n  acplus agents auth --agent ${agentId} --confirm-storage yes\nTo decline:\n  acplus agents auth --agent ${agentId} --confirm-storage no\nThen inspect the result:\n  ${next}\n${context}\nThe CLI submits the exact currently requested step (${display(step.stepId)}). Never provide passwords or tokens.`;
  return `${heading}\nWaiting for Agent login instructions. Continue by running:\n  ${next}\n${context}\nDo not start a second login flow while this one is pending.`;
}

export function humanOutput(kind: string, value: unknown): string {
  if (kind === "health") return "Service is healthy.";
  if (kind === "sessions delete") return "Session and local history deleted.";
  if (kind === "agents auth-input")
    return "Authentication input submitted. Next, run acplus agents auth --agent AGENT-ID using the same Agent ID and --config/--data-dir/--url options to inspect the result.";
  if (kind === "agents logout")
    return "Agent confirmed logout. Project files and local Session history are unchanged. This does not revoke unrelated application logins.";
  if (record(value) && typeof value.config === "string")
    return `Configuration created: ${value.config}`;
  if (Array.isArray(value))
    return value.length === 0
      ? "No Agents."
      : value.map((item) => humanOutput("agents get", item)).join("\n\n");
  if (!record(value)) return display(value);
  if (kind === "agents login" || kind === "agents auth")
    return authOutput(value);
  if (Array.isArray(value.items)) {
    const items: unknown[] = value.items;
    const rows = items.map((item) => {
      if (!record(item)) return display(item);
      if (kind === "events list")
        return `${display(item.sequence)} [${display(item.source)}] ${display(item.type)}: ${record(item.payload) && record(item.payload.content) && typeof item.payload.content.text === "string" ? item.payload.content.text : display(item.payload)}`;
      if (kind === "sessions list")
        return `${display(item.sessionId)}  ${typeof item.name === "string" ? `${item.name}  ` : ""}${display(item.agentId)}  ${display(item.workingDirectory)}`;
      return `${display(item.turnId)}  ${display(item.state)}  ${display(item.response)}`;
    });
    const cursor =
      typeof value.nextCursor === "string"
        ? `\nNext cursor: ${value.nextCursor}`
        : "";
    const after =
      typeof value.nextAfter === "number"
        ? `\nNext after: ${value.nextAfter}`
        : "";
    return (
      (rows.length === 0 ? "No records." : rows.join("\n")) + cursor + after
    );
  }
  if (typeof value.turnId === "string")
    return `Turn: ${value.turnId}\nSession: ${display(value.sessionId)}\nStatus: ${display(value.state)}${typeof value.response === "string" && value.response ? `\n\n${value.response}` : ""}${value.error ? `\nError: ${display(value.error)}` : ""}`;
  if (typeof value.sessionId === "string")
    return `Session: ${value.sessionId}${typeof value.name === "string" ? `\nName: ${value.name}` : ""}\nAgent: ${display(value.agentId)}\nDirectory: ${display(value.workingDirectory)}`;
  return Object.entries(value)
    .map(([key, item]) => `${key}: ${display(item)}`)
    .join("\n");
}

export function printResult(kind: string, value: unknown, json: boolean): void {
  if (json) {
    if (value !== null) console.log(JSON.stringify(value));
  } else console.log(humanOutput(kind, value));
}
