import { ConfigurationError, record } from "./acp-common.js";

const commands = {
  init: {
    path: ["init"],
    usage:
      "init --agent ID --agent-command PATH [--config FILE --profile PATH --login-account LOGIN --data-dir PATH --port N]",
    description:
      "Create a new private config; never overwrite. Agent executable must exist. Returns {config}.",
  },
  health: {
    path: ["health"],
    usage: "health",
    description:
      "Observe an existing service; never start one. Returns service health.",
  },
  "agent-list": {
    path: ["agents", "list"],
    usage: "agent-list",
    description: "List configured Agents and observed runtime state.",
  },
  "agent-auth": {
    path: ["agents", "auth"],
    usage: "agent-auth --agent ID [--confirm-storage yes|no]",
    description:
      "Observe cached auth and current flow; no login/model probe. Consent answers only the current plaintext-storage step.",
  },
  "agent-login": {
    path: ["agents", "login"],
    usage:
      "agent-login --agent ID [--method METHOD --wait-ms N --idle-grace-ms N]",
    description:
      "Start login once; default returns admission/flow immediately. Explicit wait stops at instructions or result, not user input.",
  },
  "agent-auth-input": {
    path: ["agents", "auth-input"],
    usage: "agent-auth-input --agent ID --input-file FILE",
    description:
      "Submit exact requested {stepId,values} JSON. Never submit passwords/tokens. Returns service acknowledgement.",
  },
  "agent-logout": {
    path: ["agents", "logout"],
    usage: "agent-logout --agent ID",
    description:
      "Request supported logout; unsupported is an error, not success. History remains unchanged.",
  },
  "session-list": {
    path: ["sessions", "list"],
    usage: "session-list [--agent ID --limit N --cursor CURSOR]",
    description: "Read committed Sessions; returns {items,nextCursor}.",
  },
  "session-create": {
    path: ["sessions", "create"],
    usage:
      "session-create --agent ID --working-directory PATH [--name NAME --idle-grace-ms N]",
    description:
      "Create Session, not Agent process. Returns Session UUID. Working directory must exist on service host; relative paths resolve at caller. Names are display-only.",
  },
  "session-get": {
    path: ["sessions", "get"],
    usage: "session-get --session UUID",
    description: "Read one committed Session.",
  },
  "session-send": {
    path: ["sessions", "send"],
    usage:
      "session-send --session UUID --turn UUID (--text TEXT | --text-file FILE) [--wait-ms N --idle-grace-ms N]",
    description:
      "Submit once; default returns admission, not execution success. Explicit wait returns terminal Turn. Receipt IDs go to stderr before dispatch.",
  },
  "session-delete": {
    path: ["sessions", "delete"],
    usage: "session-delete --session UUID --yes [--idle-grace-ms N]",
    description:
      "Delete local Session/Turn/Event history only. Active/ambiguous work is rejected. Returns {sessionId,deleted:true}.",
  },
  "turn-list": {
    path: ["turns", "list"],
    usage: "turn-list --session UUID [--limit N --cursor CURSOR]",
    description:
      "Read committed Turns; returns {items,nextCursor}. Running state is not proof of liveness.",
  },
  "turn-start": {
    path: ["turns", "start"],
    usage:
      "turn-start --session UUID --turn UUID (--text TEXT | --text-file FILE) [--idle-grace-ms N]",
    description: "Low-level admission only; no wait. Returns submitted Turn.",
  },
  "turn-get": {
    path: ["turns", "get"],
    usage: "turn-get --session UUID --turn UUID",
    description:
      "Read exact Turn/reply. Observing error/unknown exits 0; this is not execution success.",
  },
  "turn-cancel": {
    path: ["turns", "cancel"],
    usage: "turn-cancel --session UUID --turn UUID",
    description:
      "Request cancellation from actual owner; never start replacement. Returns acknowledgement, not proof execution stopped.",
  },
  "event-list": {
    path: ["events", "list"],
    usage: "event-list --session UUID [--turn UUID --after N --limit N]",
    description:
      "Read committed events; Turn filter precedes pagination. Returns {items,nextAfter}; sequence remains Session-wide.",
  },
} satisfies Record<
  string,
  { path: string[]; usage: string; description: string }
>;

const common = `
Common options (all except init): --config FILE --data-dir PATH --url BASE/v2 --json.
init accepts only its listed options plus --json. JSON is always the default.
Service selection: --url overrides ACPLUS_URL; explicit URL never falls back to local service.
Local defaults: ~/.acplus/acplus.yaml, config dataDir; --data-dir overrides it.
History reads never start Agent/service. Writes reuse one idle-managed local service;
health, cancel, auth-input and consent never start a replacement.
--idle-grace-ms: 100..86400000, default 30000 (listed admission commands only).
init defaults: port 4280, data ~/.acplus/state, profile ~/.acplus/ID-profile;
Agent ID: 1..64 letters/digits/_/-, starting alphanumeric. Config schema is 2.
Session and Turn selectors require full lowercase UUIDs, never names/prefixes/latest.
Input is named args or files <=1 MiB. No stdin/readline/UI, even on TTY; FILE '-' is rejected.
Exactly one --text or --text-file. --yes is mandatory for deletion; never implied consent.
Pagination: --limit 1..1000 (default 100); pass returned nextCursor as --cursor;
events use --after nonnegative sequence (default 0), then nextAfter. null ends paging.
--wait-ms: explicit 100..86400000, only session-send/agent-login; no implicit wait.

Output: stdout is one JSON result, no progress/ANSI. stderr is JSON Lines:
{"event":"turn_submitting","sessionId":"...","turnId":"..."} before submission;
{"error":{"code":"...","message":"..."}} on thrown failure (no stdout result).
Observed failed resources may still be returned on stdout with exit 1 when waiting.
Runtime warnings also use JSON Lines: {event:"runtime_warning",name,message}.
--help/-h and --version/-V are text exceptions. Interrupted processes may have no final JSON.
Exit 0: successful observation/admission (not necessarily execution success);
1: operation failure, login failed/expired, wait timeout or non-complete terminal Turn;
2: invalid invocation/input. agent-auth can observe a failed flow with exit 0.
Wait terminal states: complete (0), cancelled/error/unknown (1); other states keep waiting.
Timeout/disconnect/Ctrl+C stops observation, NOT execution/cancellation.
Recover via acplus-ai turn-get --session UUID --turn UUID, or explicit turn-cancel.
Hold --turn UUID before admission. Lost write response: reconcile that ID and original text;
never silently retry or generate a new ID. unknown is NOT safe-to-retry or completed.
Auth pending/action_required: inspect acplus-ai agent-auth --agent ID with same service flags.
Complete browser action externally; answer exact input with acplus-ai agent-auth-input,
or explicit acplus-ai agent-auth --confirm-storage yes|no. Never start a second login flow.
Human grouped/interactive interface: acplus. No public AI serve command.`;

export function aiHelp(args: string[]): string {
  const name = args[0];
  if (name === undefined)
    return `acplus-ai - non-interactive Agent interface\n\n${Object.values(
      commands,
    )
      .map((command) => `acplus-ai ${command.usage}\n  ${command.description}`)
      .join("\n")}\n${common}`;
  if (!Object.hasOwn(commands, name))
    throw new ConfigurationError("Unknown command");
  const command = commands[name as keyof typeof commands];
  return `acplus-ai ${command.usage}\n${command.description}\n${common}`;
}

export function aiArguments(args: string[]): string[] {
  const name = args[0] ?? "";
  if (!Object.hasOwn(commands, name))
    throw new ConfigurationError("Unknown command");
  const result: string[] = [...commands[name as keyof typeof commands].path];
  let waiting = false;
  let json = false;
  for (let index = 1; index < args.length; index += 1) {
    const option = args[index] ?? "";
    if (
      !option.startsWith("--") ||
      ["--no-wait", "--timeout-ms"].includes(option)
    )
      throw new ConfigurationError(
        "acplus-ai requires named options; use --wait-ms for bounded waiting",
      );
    if (["--json", "--yes"].includes(option)) {
      result.push(option);
      if (option === "--json") json = true;
      continue;
    }
    const value = args[++index];
    if (value === undefined || (value.startsWith("--") && option !== "--text"))
      throw new ConfigurationError("Unknown, repeated, or incomplete option");
    if (
      ["--config", "--input-file", "--text-file"].includes(option) &&
      value === "-"
    )
      throw new ConfigurationError(
        `${option} does not accept stdin in acplus-ai`,
      );
    if (option === "--wait-ms") {
      if (!["session-send", "agent-login"].includes(name))
        throw new ConfigurationError(
          "--wait-ms is only available for session-send and agent-login",
        );
      result.push("--timeout-ms", value);
      waiting = true;
    } else result.push(option, value);
  }
  if (!json) result.push("--json");
  if (!waiting && ["session-send", "agent-login"].includes(name))
    result.push("--no-wait");
  return result;
}

export function aiMessage(message: string): string {
  return message
    .replace(
      /(?:acplus )?\b(agents|sessions|turns|events) (auth-input|auth|login|logout|list|create|get|send|delete|start|cancel)\b/gu,
      (_, resource: string, verb: string) =>
        `acplus-ai ${resource.slice(0, -1)}-${verb}`,
    )
    .replace(
      'Supply exactly one message: --text TEXT, --text-file FILE|-, or acplus-ai session-send SESSION "MESSAGE"',
      "Supply exactly one message: --text TEXT or --text-file FILE",
    );
}

export function aiResult(value: unknown): unknown {
  if (!record(value)) return value;
  return {
    ...value,
    ...(record(value.error) && typeof value.error.message === "string"
      ? { error: { ...value.error, message: aiMessage(value.error.message) } }
      : {}),
    ...(record(value.flow) ? { flow: aiResult(value.flow) } : {}),
    ...(Array.isArray(value.items) ? { items: value.items.map(aiResult) } : {}),
  };
}
