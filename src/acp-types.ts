import type { McpServer, SessionUpdate } from "@agentclientprotocol/sdk";

export type SecretReference =
  { source: "env"; name: string } | { source: "file"; path: string };

export interface AgentConfig {
  id: string;
  label: string;
  command: string;
  args: string[];
  env: Record<string, string | SecretReference>;
  profileDir: string;
  mcpServers: McpServer[];
  startupTimeoutMs: number;
  idleTimeoutMs: number;
  permission: "deny" | "allow";
  authentication?: { type: "copilot"; loginAccount: string };
}

export interface Config {
  schemaVersion: 2;
  instance: string;
  dataDir: string;
  listen: { host: string; port: number };
  agents: AgentConfig[];
}

export type TurnState =
  | "accepted"
  | "starting"
  | "dispatching"
  | "running"
  | "cancelling"
  | "complete"
  | "cancelled"
  | "error"
  | "unknown";
export type Coverage = "complete" | "partial" | "unknown";
export interface ErrorInfo {
  code: string;
  message: string;
}
export interface Session {
  sessionId: string;
  name?: string;
  agentId: string;
  workingDirectory: string;
  profileIdentity: string;
  backendSessionId: string | null;
  createdAt: string;
  updatedAt: string;
  observedAt: string;
  lastSequence: number;
  coverage: Coverage;
}
export interface Turn {
  sessionId: string;
  turnId: string;
  text: string;
  state: TurnState;
  response: string;
  stopReason: string | null;
  error: ErrorInfo | null;
  createdAt: string;
  updatedAt: string;
  observedAt: string;
  lastSequence: number;
  coverage: Coverage;
}
export interface Event {
  sessionId: string;
  turnId: string | null;
  sequence: number;
  type: string;
  payload: unknown;
  source: "live" | "replay" | "session";
  observedAt: string;
}
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
export interface EventPage {
  items: Event[];
  nextAfter: number | null;
  lastSequence: number;
  coverage: Coverage;
  observedAt: string;
}
export interface AuthMethodView {
  id: string;
  name: string;
  type: "agent" | "terminal" | "native";
}
export interface AuthObservation {
  agentId: string;
  profileIdentity: string;
  generation: number | null;
  lastKnownStatus: "authenticated" | "required" | "unknown";
  verifiedAt: string | null;
  expiresAt: string | null;
  freshness: "current" | "stale" | "unknown";
  invalidationReason: string | null;
  evidence: string | null;
  methods: AuthMethodView[];
}
export type AuthStep =
  | { kind: "link"; url: string; userCode: string }
  | { kind: "input"; stepId: string; fields: string[] };
export interface AuthFlow {
  operationId: string;
  status: "pending" | "action_required" | "succeeded" | "failed" | "expired";
  expiresAt: string;
  step?: AuthStep;
  error?: ErrorInfo;
}
export interface RuntimeHooks {
  update(
    backendSessionId: string,
    update: SessionUpdate,
    source: "live" | "replay",
  ): Promise<void>;
  disconnected(error: ErrorInfo): void;
  authenticated(evidence: string): void;
  invalidated(reason: string): void;
  permission(backendSessionId: string, allowed: boolean): Promise<void>;
  event(code: string): void;
}
