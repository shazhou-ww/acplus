import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import {
  diagnostic,
  ConfigurationError,
  profileIdentity,
  Redactor,
  ServiceError,
  text,
  uuid,
  workspace,
} from "./acp-common.js";
import { validateConfig } from "./acp-config.js";
import { lockDirectory } from "./data-lock.js";
import { Store } from "./acp-store.js";
import { AcpRuntime } from "./acp-agent.js";
import type {
  AgentConfig,
  AuthFlow,
  AuthObservation,
  AuthStep,
  Config,
  Session,
  Turn,
} from "./acp-types.js";

interface Binding {
  sessionId: string;
  turnId: string | null;
}
interface LoginInput {
  stepId: string;
  resolve(values: Record<string, string>): void;
}
interface AgentState {
  config: AgentConfig;
  runtime: AcpRuntime;
  identity: string;
  busy: boolean;
  flow: AuthFlow | null;
  input: LoginInput | null;
  capabilities: unknown;
  capabilitiesObservedAt: string | null;
  pendingUpdates: {
    id: string;
    update: SessionUpdate;
    source: "live" | "replay";
  }[];
  pendingBytes: number;
  preparing: boolean;
}

export class Service {
  readonly redactor = new Redactor();
  readonly agents = new Map<string, AgentState>();
  readonly store: Store;
  private readonly bindings = new Map<string, Binding>();
  private readonly jobs = new Set<Promise<void>>();
  private closing = false;
  private failed = false;
  private closed: Promise<void> | null = null;
  private readonly lifetime = new AbortController();

  private constructor(
    readonly config: Config,
    private readonly release: () => Promise<void>,
  ) {
    this.store = new Store(
      join(config.dataDir, "sessions.sqlite"),
      this.redactor,
    );
  }

  static async create(input: Config): Promise<Service> {
    const config = validateConfig(input);
    const release = await lockDirectory(config.dataDir);
    let service: Service | undefined;
    try {
      service = new Service(config, release);
      await service.initialize();
      return service;
    } catch (error) {
      if (service !== undefined) await service.close();
      else await release();
      throw error;
    }
  }

  private async initialize(): Promise<void> {
    const profiles = new Set<string>();
    for (const config of this.config.agents) {
      try {
        await mkdir(config.profileDir, { recursive: true, mode: 0o700 });
        config.profileDir = await realpath(config.profileDir);
      } catch {
        throw new ServiceError("credential_profile_unavailable", 409);
      }
      const canonicalProfile =
        process.platform === "win32"
          ? config.profileDir.toLowerCase()
          : config.profileDir;
      if (profiles.has(canonicalProfile))
        throw new ConfigurationError(
          "Agents must not share credential profiles",
        );
      profiles.add(canonicalProfile);
      for (const [key, value] of Object.entries(config.env)) {
        if (typeof value === "string") {
          if (/token|secret|password|key/iu.test(key)) this.redactor.add(value);
        } else {
          let secret: string;
          try {
            secret =
              value.source === "env"
                ? (process.env[value.name] ?? "")
                : (await readFile(value.path, "utf8")).replace(/\r?\n$/u, "");
          } catch {
            throw new ServiceError("credential_unavailable", 409);
          }
          if (secret === "")
            throw new ServiceError("credential_unavailable", 409);
          this.redactor.add(secret);
        }
      }
      for (const server of config.mcpServers) {
        const values = "env" in server ? server.env : server.headers;
        for (const value of values)
          if (/token|secret|password|key|authorization/iu.test(value.name)) {
            this.redactor.add(value.value);
            if (value.value.startsWith("Bearer "))
              this.redactor.add(value.value.slice(7));
          }
      }
      const identity = profileIdentity(config);
      const runtime = new AcpRuntime(
        config,
        {
          update: async (id, update, source) => {
            await this.update(config.id, id, update, source);
          },
          disconnected: (error) => {
            this.log(config.id, error.code);
            this.store.invalidateAuth(config.id, "runtime_disconnected");
          },
          authenticated: (evidence) => {
            this.authenticated(config.id, evidence);
          },
          invalidated: (reason) => {
            this.store.invalidateAuth(config.id, reason);
          },
          permission: (id, allowed) => {
            const binding = this.bindings.get(`${config.id}:${id}`);
            if (binding !== undefined)
              this.store.appendEvent(
                binding.sessionId,
                binding.turnId,
                "permission",
                { allowed },
              );
            else this.log(config.id, "session_permission_unbound");
            return Promise.resolve();
          },
          event: (code) => {
            this.log(config.id, code);
          },
        },
        this.redactor,
      );
      this.agents.set(config.id, {
        config,
        runtime,
        identity,
        busy: false,
        flow: null,
        input: null,
        capabilities: null,
        capabilitiesObservedAt: null,
        pendingUpdates: [],
        pendingBytes: 0,
        preparing: false,
      });
    }
  }

  private log(agentId: string, code: string): void {
    console.error(this.redactor.json({ agentId, event: code }));
  }

  assertReady(): void {
    if (this.closing) throw new ServiceError("service_stopping", 503);
    if (this.failed) throw new ServiceError("storage_failed", 503);
  }

  health(): void {
    this.assertReady();
    this.store.listSessions({ limit: 1 });
  }

  select(agentId: string): AgentState {
    this.assertReady();
    const agent = this.agents.get(agentId);
    if (agent === undefined) throw new ServiceError("agent_not_found", 404);
    return agent;
  }

  listAgents() {
    this.assertReady();
    return [...this.agents.values()].map((agent) => ({
      agentId: agent.config.id,
      label: agent.config.label,
      runtime: agent.runtime.status,
      capabilities: agent.capabilities,
      capabilitiesObservedAt: agent.capabilitiesObservedAt,
      auth: this.auth(agent.config.id),
    }));
  }

  auth(agentId: string) {
    const agent = this.select(agentId);
    const observation = this.store.getAuth(agentId, agent.identity);
    const methods =
      observation.methods.length > 0
        ? observation.methods
        : agent.runtime.methods();
    return {
      agentId,
      lastKnownStatus: observation.lastKnownStatus,
      verifiedAt: observation.verifiedAt,
      expiresAt: observation.expiresAt,
      freshness: observation.freshness,
      invalidationReason: observation.invalidationReason,
      evidence: observation.evidence,
      methods,
      flow: agent.flow,
    };
  }

  private authenticated(agentId: string, evidence: string): void {
    const agent = this.agents.get(agentId);
    if (agent === undefined) throw new ServiceError("agent_not_found", 404);
    const observation: AuthObservation = {
      ...this.store.getAuth(agentId, agent.identity),
      generation: agent.runtime.generation,
      lastKnownStatus: "authenticated",
      verifiedAt: new Date().toISOString(),
      expiresAt: null,
      freshness: "current",
      invalidationReason: null,
      evidence,
      methods: agent.runtime.methods(),
    };
    this.store.setAuth(observation);
  }

  private async prepare(agent: AgentState): Promise<void> {
    const result = await agent.runtime.ensure();
    const capabilities: unknown = JSON.parse(
      this.redactor.json(result.agentCapabilities),
    );
    agent.capabilities = capabilities;
    agent.capabilitiesObservedAt = new Date().toISOString();
    this.store.setAuth({
      ...this.store.getAuth(agent.config.id, agent.identity),
      generation: agent.runtime.generation,
      methods: agent.runtime.methods(),
    });
  }

  async createSession(agentId: string, directory: string): Promise<Session> {
    const agent = this.select(agentId);
    const canonical = await workspace(agent.config, directory);
    this.assertReady();
    return this.store.createSession(agentId, canonical, agent.identity);
  }

  private track(work: Promise<void>): void {
    this.jobs.add(work);
    void work
      .finally(() => this.jobs.delete(work))
      .catch((error: unknown) => {
        this.log("service", diagnostic(error).code);
      });
  }

  async submit(
    sessionId: string,
    turnId: string,
    prompt: string,
  ): Promise<Turn> {
    this.assertReady();
    uuid(sessionId, "sessionId");
    uuid(turnId, "turnId");
    text(prompt, "text");
    const session = this.store.getSession(sessionId);
    if (this.store.findTurn(sessionId, turnId) !== null)
      return this.store.admitTurn(sessionId, turnId, prompt).turn;
    const agent = this.select(session.agentId);
    if (session.profileIdentity !== agent.identity)
      throw new ServiceError("session_binding_changed", 409);
    await workspace(agent.config, session.workingDirectory);
    this.assertReady();
    if (agent.busy) throw new ServiceError("agent_busy", 409);
    const admitted = this.store.admitTurn(sessionId, turnId, prompt);
    agent.busy = true;
    this.track(this.execute(agent, session, turnId, prompt));
    return admitted.turn;
  }

  private async execute(
    agent: AgentState,
    session: Session,
    turnId: string,
    prompt: string,
  ): Promise<void> {
    const execution = { dispatched: false };
    let binding: Binding | undefined;
    try {
      this.store.setTurnState(session.sessionId, turnId, "starting");
      await this.prepare(agent);
      if (this.store.getTurn(session.sessionId, turnId).state === "cancelled")
        return;
      agent.preparing = true;
      const backend = await agent.runtime.attach(session);
      if (this.store.getTurn(session.sessionId, turnId).state === "cancelled")
        return;
      this.store.bindSession(session.sessionId, backend);
      binding = { sessionId: session.sessionId, turnId: null };
      this.bindings.set(`${agent.config.id}:${backend}`, binding);
      agent.preparing = false;
      for (const pending of agent.pendingUpdates.splice(0)) {
        if (pending.id === backend)
          await this.update(
            agent.config.id,
            backend,
            pending.update,
            pending.source,
          );
        else this.log(agent.config.id, "session_update_unbound");
      }
      agent.pendingBytes = 0;
      this.store.setTurnState(session.sessionId, turnId, "dispatching");
      const activeBinding = binding;
      const resultPromise = agent.runtime.prompt(backend, prompt, () => {
        if (this.store.getTurn(session.sessionId, turnId).state === "cancelled")
          throw new ServiceError("turn_cancelled_before_dispatch", 409);
        execution.dispatched = true;
        activeBinding.turnId = turnId;
        this.store.setTurnState(session.sessionId, turnId, "running");
      });
      const result = await resultPromise;
      binding.turnId = null;
      const state =
        result.stopReason === "cancelled" ? "cancelled" : "complete";
      this.store.setTurnState(session.sessionId, turnId, state, {
        stopReason: result.stopReason,
      });
      if (
        state === "complete" &&
        result.stopReason === "end_turn" &&
        this.store.getTurn(session.sessionId, turnId).response.trim() !== ""
      )
        this.authenticated(agent.config.id, "completed_prompt");
    } catch (error) {
      const failure = diagnostic(error);
      this.log(agent.config.id, failure.code);
      if (failure.code === "agent_auth_required")
        this.store.setAuth({
          ...this.store.getAuth(agent.config.id, agent.identity),
          lastKnownStatus: "required",
          freshness: "current",
          invalidationReason: "auth_required",
          evidence: "auth_required",
          verifiedAt: new Date().toISOString(),
        });
      try {
        if (this.store.getTurn(session.sessionId, turnId).state === "cancelled")
          return;
        this.store.setTurnState(
          session.sessionId,
          turnId,
          execution.dispatched &&
            ![
              "agent_auth_required",
              "agent_request_failed",
              "agent_method_unsupported",
            ].includes(failure.code)
            ? "unknown"
            : "error",
          { error: failure },
        );
      } catch (storageError) {
        this.failed = true;
        this.log(agent.config.id, diagnostic(storageError).code);
        await agent.runtime.close();
      }
    } finally {
      if (binding !== undefined) binding.turnId = null;
      agent.preparing = false;
      agent.pendingUpdates.length = 0;
      agent.pendingBytes = 0;
      agent.busy = false;
    }
  }

  private update(
    agentId: string,
    backend: string,
    update: SessionUpdate,
    source: "live" | "replay",
  ): Promise<void> {
    const agent = this.agents.get(agentId);
    if (agent === undefined) throw new ServiceError("agent_not_found", 404);
    const binding = this.bindings.get(`${agentId}:${backend}`);
    if (binding === undefined) {
      if (agent.preparing) {
        const bytes = Buffer.byteLength(JSON.stringify(update));
        if (
          agent.pendingUpdates.length >= 1000 ||
          bytes > 1048576 ||
          agent.pendingBytes + bytes > 8388608
        )
          throw new ServiceError("history_buffer_overflow", 503);
        agent.pendingUpdates.push({ id: backend, update, source });
        agent.pendingBytes += bytes;
      } else this.log(agentId, "session_update_unbound");
      return Promise.resolve();
    }
    if (update.sessionUpdate === "agent_thought_chunk") {
      this.store.appendEvent(binding.sessionId, null, "content_excluded", {
        type: update.sessionUpdate,
      });
      return Promise.resolve();
    }
    if (update.sessionUpdate === "user_message_chunk" && source === "live")
      return Promise.resolve();
    this.store.appendEvent(
      binding.sessionId,
      source === "live" &&
        [
          "agent_message_chunk",
          "tool_call",
          "tool_call_update",
          "plan",
        ].includes(update.sessionUpdate)
        ? binding.turnId
        : null,
      update.sessionUpdate,
      update,
      source,
    );
    return Promise.resolve();
  }

  async cancel(sessionId: string, turnId: string): Promise<Turn> {
    this.assertReady();
    const turn = this.store.getTurn(sessionId, turnId);
    if (["complete", "cancelled", "error"].includes(turn.state)) return turn;
    if (turn.state === "unknown")
      throw new ServiceError("turn_outcome_unknown", 409);
    if (turn.state === "accepted" || turn.state === "starting")
      return this.store.setTurnState(sessionId, turnId, "cancelled", {
        stopReason: "cancelled",
      });
    const session = this.store.getSession(sessionId);
    const agent = this.select(session.agentId);
    const backend = session.backendSessionId;
    const binding =
      backend === null
        ? undefined
        : this.bindings.get(`${session.agentId}:${backend}`);
    if (turn.state === "dispatching" && binding?.turnId !== turnId)
      return this.store.setTurnState(sessionId, turnId, "cancelled", {
        stopReason: "cancelled",
      });
    if (binding?.turnId !== turnId || backend === null)
      throw new ServiceError("turn_not_dispatched", 409);
    this.store.setTurnState(sessionId, turnId, "cancelling");
    await agent.runtime.cancel(backend);
    return this.store.getTurn(sessionId, turnId);
  }

  beginAuth(agentId: string, methodId: string): AuthFlow {
    const agent = this.select(agentId);
    text(methodId, "methodId");
    if (agent.busy) throw new ServiceError("agent_busy", 409);
    this.store.invalidateAuth(agentId, "authentication_started");
    agent.busy = true;
    const signal = AbortSignal.any([
      this.lifetime.signal,
      AbortSignal.timeout(600000),
    ]);
    const flow: AuthFlow = {
      operationId: randomUUID(),
      status: "pending",
      expiresAt: new Date(Date.now() + 600000).toISOString(),
    };
    agent.flow = flow;
    this.track(
      (async () => {
        try {
          await this.prepare(agent);
          await agent.runtime.authenticate(
            methodId,
            (step) => {
              if (
                step.kind === "input" &&
                (step.fields.length !== 1 ||
                  step.fields[0] !== "confirmPlaintextStorage")
              )
                throw new ServiceError("auth_input_unsupported", 409);
              flow.status = "action_required";
              flow.step = step;
            },
            (step, inputSignal) =>
              this.requestInput(agent, flow, step, inputSignal),
            signal,
          );
          this.authenticated(agentId, "explicit_authentication");
          flow.status = "succeeded";
          delete flow.step;
        } catch (error) {
          flow.error = diagnostic(error);
          flow.status =
            signal.aborted || flow.error.code === "auth_expired"
              ? "expired"
              : "failed";
          delete flow.step;
          this.log(agentId, flow.error.code);
        } finally {
          agent.input = null;
          agent.busy = false;
        }
      })(),
    );
    return flow;
  }

  private requestInput(
    agent: AgentState,
    flow: AuthFlow,
    step: Extract<AuthStep, { kind: "input" }>,
    signal: AbortSignal,
  ): Promise<Record<string, string>> {
    return new Promise((resolve, reject) => {
      signal.throwIfAborted();
      const abort = (): void => {
        agent.input = null;
        reject(new ServiceError("auth_expired", 409));
      };
      signal.addEventListener("abort", abort, { once: true });
      agent.input = {
        stepId: step.stepId,
        resolve: (values) => {
          signal.removeEventListener("abort", abort);
          agent.input = null;
          flow.status = "pending";
          delete flow.step;
          resolve(values);
        },
      };
    });
  }

  authInput(
    agentId: string,
    stepId: string,
    values: Record<string, string>,
  ): void {
    const agent = this.select(agentId);
    if (
      agent.input?.stepId !== stepId ||
      Object.keys(values).length !== 1 ||
      !["yes", "no"].includes(values.confirmPlaintextStorage ?? "")
    )
      throw new ServiceError("auth_input_invalid", 400);
    agent.input.resolve(values);
  }

  async logout(agentId: string): Promise<void> {
    const agent = this.select(agentId);
    if (agent.busy) throw new ServiceError("agent_busy", 409);
    agent.busy = true;
    try {
      this.store.invalidateAuth(agentId, "logout_requested");
      await this.prepare(agent);
      await agent.runtime.logout();
      this.store.setAuth({
        ...this.store.getAuth(agentId, agent.identity),
        lastKnownStatus: "required",
        freshness: "current",
        invalidationReason: "logout",
        evidence: "logout",
        verifiedAt: new Date().toISOString(),
      });
    } finally {
      agent.busy = false;
    }
  }

  close(): Promise<void> {
    this.closed ??= this.shutdown();
    return this.closed;
  }

  private async shutdown(): Promise<void> {
    this.closing = true;
    this.lifetime.abort();
    const results = await Promise.allSettled(
      [...this.agents.values()].map((agent) => agent.runtime.close()),
    );
    await Promise.allSettled(this.jobs);
    if (results.some((result) => result.status === "rejected"))
      throw new ServiceError("cleanup_failed_lock_retained", 503);
    this.store.close();
    await this.release();
  }
}
