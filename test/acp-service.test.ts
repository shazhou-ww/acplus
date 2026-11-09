import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
  realpath,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  InitializeResponse,
  PromptResponse,
} from "@agentclientprotocol/sdk";
import type { AgentConfig, AuthStep, RuntimeHooks } from "../src/acp-types.js";
import { ServiceError } from "../src/acp-common.js";
import { Service } from "../src/acp-service.js";
import { fixtureConfig } from "./acp-fixture.js";

const state = vi.hoisted(() => ({
  hooks: new Map<string, RuntimeHooks>(),
  ensure: vi.fn<() => Promise<InitializeResponse>>(),
  attach: vi.fn<() => Promise<string>>(),
  prompt: vi.fn<(id: string, text: string) => Promise<PromptResponse>>(),
  preflight: vi.fn<(id: string) => Promise<void>>(),
  cancel: vi.fn<(id: string) => Promise<void>>(),
  authenticate:
    vi.fn<
      (
        method: string,
        step: (value: AuthStep) => void,
        input: (
          step: Extract<AuthStep, { kind: "input" }>,
          signal: AbortSignal,
        ) => Promise<Record<string, string>>,
        signal: AbortSignal,
      ) => Promise<void>
    >(),
  logout: vi.fn<() => Promise<void>>(),
  close: vi.fn<() => Promise<void>>(),
}));
vi.mock("../src/acp-agent.js", () => ({
  AcpRuntime: class {
    status = "stopped";
    generation = 1;
    constructor(config: AgentConfig, hooks: RuntimeHooks) {
      state.hooks.set(config.id, hooks);
    }
    methods() {
      return [{ id: "sign-in", name: "Sign in", type: "agent" }];
    }
    async ensure() {
      const result = await state.ensure();
      this.status = "ready";
      return result;
    }
    attach() {
      return state.attach();
    }
    async prompt(id: string, text: string, onDispatch?: () => void) {
      await state.preflight(id);
      onDispatch?.();
      return state.prompt(id, text);
    }
    cancel(id: string) {
      return state.cancel(id);
    }
    authenticate(...args: Parameters<typeof state.authenticate>) {
      return state.authenticate(...args);
    }
    logout() {
      return state.logout();
    }
    close() {
      this.status = "stopped";
      return state.close();
    }
  },
}));
const services: Service[] = [];
const roots: string[] = [];
beforeEach(() => {
  state.hooks.clear();
  state.ensure.mockResolvedValue({ protocolVersion: 1, agentCapabilities: {} });
  state.attach.mockResolvedValue("backend");
  state.preflight.mockResolvedValue();
  state.prompt.mockImplementation(async (id) => {
    await hooks().update(
      id,
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "OK" },
      },
      "live",
    );
    return { stopReason: "end_turn" };
  });
  state.cancel.mockResolvedValue();
  state.authenticate.mockResolvedValue();
  state.logout.mockResolvedValue();
  state.close.mockResolvedValue();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const mock of [
    state.ensure,
    state.attach,
    state.prompt,
    state.preflight,
    state.cancel,
    state.authenticate,
    state.logout,
    state.close,
  ])
    mock.mockReset();
});
function hooks() {
  const value = state.hooks.get("copilot");
  if (value === undefined) throw new Error("Missing hooks");
  return value;
}
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "acplus-service-"));
  roots.push(root);
  const config = fixtureConfig(root);
  const service = await Service.create(config);
  services.push(service);
  const session = await service.createSession("copilot", root);
  return { service, session, root, config };
}
async function settled(
  service: Service,
  id: string,
  turnId: string,
  expected: string,
) {
  await vi.waitFor(() => {
    expect(service.store.getTurn(id, turnId).state).toBe(expected);
  });
  await vi.waitFor(() => {
    expect(service.select("copilot").busy).toBe(false);
  });
  return service.store.getTurn(id, turnId);
}

describe("ACP service admission and failure boundaries", () => {
  it("chooses unrelated directories per Session and rechecks them before execution", async () => {
    const { service, session, root } = await setup();
    const other = await mkdtemp(join(tmpdir(), "acplus-session-directory-"));
    roots.push(other);
    const second = await service.createSession("copilot", other);
    expect(session.workingDirectory).toBe(await realpath(root));
    expect(second.workingDirectory).toBe(await realpath(other));
    expect(state.attach).not.toHaveBeenCalled();
    await expect(
      service.createSession("copilot", "relative"),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      service.createSession("copilot", join(other, "missing")),
    ).rejects.toMatchObject({ code: "workspace_unavailable" });
    const file = join(other, "not-directory");
    await writeFile(file, "");
    await expect(service.createSession("copilot", file)).rejects.toMatchObject({
      code: "workspace_unavailable",
    });
    await rm(other, { recursive: true });
    await expect(
      service.submit(second.sessionId, randomUUID(), "OK"),
    ).rejects.toMatchObject({ code: "workspace_unavailable" });
    expect(state.attach).not.toHaveBeenCalled();
    expect(state.prompt).not.toHaveBeenCalled();
  });
  it("validates Session binding and exact request identity", async () => {
    const { service, session } = await setup();
    expect(() => service.select("unknown")).toThrow(ServiceError);
    await expect(
      service.submit("bad", randomUUID(), "OK"),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      service.submit(session.sessionId, randomUUID(), " "),
    ).rejects.toMatchObject({ code: "invalid_input" });
    service.select("copilot").identity = "changed";
    await expect(
      service.submit(session.sessionId, randomUUID(), "OK"),
    ).rejects.toMatchObject({ code: "session_binding_changed" });
    expect(state.prompt).not.toHaveBeenCalled();
  });
  it("cancels before dispatch without running an Agent prompt", async () => {
    const { service, session } = await setup();
    let release: ((value: InitializeResponse) => void) | undefined;
    state.ensure.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const id = randomUUID();
    await service.submit(session.sessionId, id, "OK");
    expect((await service.cancel(session.sessionId, id)).state).toBe(
      "cancelled",
    );
    release?.({ protocolVersion: 1, agentCapabilities: {} });
    await settled(service, session.sessionId, id, "cancelled");
    expect(state.prompt).not.toHaveBeenCalled();
  });
  it("keeps a cancellation made while attaching and never dispatches it", async () => {
    const { service, session } = await setup();
    let release: ((value: string) => void) | undefined;
    state.attach.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const id = randomUUID();
    await service.submit(session.sessionId, id, "OK");
    await vi.waitFor(() => {
      expect(state.attach).toHaveBeenCalled();
    });
    await service.cancel(session.sessionId, id);
    release?.("backend");
    await settled(service, session.sessionId, id, "cancelled");
    expect(state.prompt).not.toHaveBeenCalled();
  });
  it("distinguishes definite rejection from an ambiguous disconnect", async () => {
    const { service, session } = await setup();
    state.prompt.mockRejectedValueOnce(
      new ServiceError("agent_auth_required", 409),
    );
    const rejected = randomUUID();
    await service.submit(session.sessionId, rejected, "OK");
    expect(
      (await settled(service, session.sessionId, rejected, "error")).error
        ?.code,
    ).toBe("agent_auth_required");
    expect(service.auth("copilot")).toMatchObject({
      lastKnownStatus: "required",
    });
    state.prompt.mockRejectedValueOnce(
      new ServiceError("agent_disconnected", 503),
    );
    const unknown = randomUUID();
    await service.submit(session.sessionId, unknown, "OK");
    await settled(service, session.sessionId, unknown, "unknown");
    await expect(
      service.cancel(session.sessionId, unknown),
    ).rejects.toMatchObject({ code: "turn_outcome_unknown" });
    await expect(
      service.submit(session.sessionId, randomUUID(), "OK"),
    ).rejects.toMatchObject({ code: "turn_outcome_unknown" });
  });
  it("does not overwrite a confirmed cancellation with a startup error", async () => {
    const { service, session } = await setup();
    let reject: ((error: Error) => void) | undefined;
    state.ensure.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    const id = randomUUID();
    await service.submit(session.sessionId, id, "OK");
    await service.cancel(session.sessionId, id);
    reject?.(new ServiceError("agent_start_failed", 503));
    await settled(service, session.sessionId, id, "cancelled");
  });
  it("keeps late preflight output out of a rejected Turn", async () => {
    const { service, session } = await setup();
    state.preflight.mockImplementationOnce(async (id) => {
      await hooks().update(
        id,
        {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "late prior output" },
        },
        "live",
      );
      throw new ServiceError("session_background_ambiguous", 409);
    });
    const id = randomUUID();
    await service.submit(session.sessionId, id, "OK");
    const result = await settled(service, session.sessionId, id, "error");
    expect(result.error?.code).toBe("session_background_ambiguous");
    expect(result.response).toBe("");
    expect(
      service.store
        .listEvents(session.sessionId, { turnId: id, limit: 100 })
        .items.some((event) => event.type === "agent_message_chunk"),
    ).toBe(false);
    expect(
      service.store
        .listEvents(session.sessionId, { limit: 100 })
        .items.some(
          (event) =>
            event.turnId === null && event.type === "agent_message_chunk",
        ),
    ).toBe(true);
    expect(state.prompt).not.toHaveBeenCalled();
  });
  it("cancels during preflight without allowing the actual dispatch callback", async () => {
    const { service, session } = await setup();
    let release: (() => void) | undefined;
    state.preflight.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const id = randomUUID();
    await service.submit(session.sessionId, id, "OK");
    await vi.waitFor(() => {
      expect(service.store.getTurn(session.sessionId, id).state).toBe(
        "dispatching",
      );
    });
    await service.cancel(session.sessionId, id);
    release?.();
    await settled(service, session.sessionId, id, "cancelled");
    expect(state.prompt).not.toHaveBeenCalled();
  });
  it("stages replay, excludes reasoning, and keeps Session metadata out of Turns", async () => {
    const { service, session } = await setup();
    state.attach.mockImplementationOnce(async () => {
      await hooks().update(
        "backend",
        {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "PAST" },
        },
        "replay",
      );
      await hooks().update(
        "other",
        {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "OTHER" },
        },
        "live",
      );
      return "backend";
    });
    state.prompt.mockImplementationOnce(async (id) => {
      await hooks().update(
        id,
        {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "hidden" },
        },
        "live",
      );
      await hooks().update(
        id,
        {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "echo" },
        },
        "live",
      );
      await hooks().update(
        id,
        { sessionUpdate: "current_mode_update", currentModeId: "mode" },
        "live",
      );
      await hooks().permission(id, false);
      await hooks().update(
        id,
        {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "OK" },
        },
        "live",
      );
      return { stopReason: "end_turn" };
    });
    const id = randomUUID();
    await service.submit(session.sessionId, id, "OK");
    const result = await settled(service, session.sessionId, id, "complete");
    expect(result.response).toBe("OK");
    const page = service.store.listEvents(session.sessionId, {
      turnId: id,
      limit: 1000,
    });
    expect(JSON.stringify(page)).not.toContain("PAST");
    expect(JSON.stringify(page)).not.toContain("hidden");
    expect(JSON.stringify(page)).not.toContain("current_mode_update");
    expect(page.items.some((item) => item.type === "permission")).toBe(true);
    await hooks().update(
      "backend",
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "late" },
      },
      "live",
    );
    expect(
      service.store.listEvents(session.sessionId, { limit: 1000 }).items.at(-1)
        ?.turnId,
    ).toBeNull();
    await hooks().update(
      "unmanaged",
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "unbound" },
      },
      "live",
    );
    await hooks().permission("unmanaged", false);
    hooks().event("safe_event");
    hooks().disconnected({
      code: "agent_disconnected",
      message: "disconnected",
    });
    expect(service.auth("copilot")).toMatchObject({ freshness: "stale" });
  });
  it("bounds preparing updates and fails before dispatch on overflow", async () => {
    const { service, session } = await setup();
    state.attach.mockImplementationOnce(async () => {
      await hooks().update(
        "backend",
        {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "x".repeat(1048577) },
        },
        "replay",
      );
      return "backend";
    });
    const id = randomUUID();
    await service.submit(session.sessionId, id, "OK");
    expect(
      (await settled(service, session.sessionId, id, "error")).error?.code,
    ).toBe("history_buffer_overflow");
    expect(state.prompt).not.toHaveBeenCalled();
  });
  it("does not establish authentication from an empty completed prompt", async () => {
    const { service, session } = await setup();
    state.prompt.mockResolvedValueOnce({ stopReason: "end_turn" });
    const id = randomUUID();
    await service.submit(session.sessionId, id, "OK");
    await settled(service, session.sessionId, id, "complete");
    expect(service.auth("copilot").lastKnownStatus).toBe("unknown");
  });
  it("rejects cancellation without an exact dispatched binding", async () => {
    const { service, session } = await setup();
    const id = randomUUID();
    service.store.admitTurn(session.sessionId, id, "OK");
    service.store.setTurnState(session.sessionId, id, "starting");
    service.store.setTurnState(session.sessionId, id, "dispatching");
    service.store.setTurnState(session.sessionId, id, "running");
    await expect(service.cancel(session.sessionId, id)).rejects.toMatchObject({
      code: "turn_not_dispatched",
    });
    service.store.setTurnState(session.sessionId, id, "error");
  });
});

describe("ACP service provisioning and auth flows", () => {
  it("registers explicit secrets and rejects missing references without leaking a lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "acplus-secrets-"));
    roots.push(root);
    const config = fixtureConfig(root);
    const file = join(root, "secret");
    await writeFile(file, "file-secret\n");
    vi.stubEnv("ACP_TEST_SECRET", "env-secret");
    config.agents[0]!.env.FILE_SECRET = { source: "file", path: file };
    config.agents[0]!.env.ENV_SECRET = {
      source: "env",
      name: "ACP_TEST_SECRET",
    };
    config.agents[0]!.mcpServers = [
      {
        type: "http",
        name: "test",
        url: "https://example.invalid",
        headers: [{ name: "Authorization", value: "Bearer mcp-secret" }],
      },
    ];
    const service = await Service.create(config);
    services.push(service);
    expect(service.redactor.clean("file-secret env-secret mcp-secret")).toBe(
      "[redacted] [redacted] [redacted]",
    );
    await expect(Service.create(config)).rejects.toMatchObject({
      code: "data_directory_locked",
    });
    await service.close();
    config.agents[0]!.env.ENV_SECRET = {
      source: "env",
      name: "MISSING_ACP_TEST_SECRET",
    };
    await expect(Service.create(config)).rejects.toMatchObject({
      code: "credential_unavailable",
    });
    await expect(
      access(join(config.dataDir, "owner.lock")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    config.agents[0]!.env.ENV_SECRET = {
      source: "file",
      path: join(root, "missing"),
    };
    await expect(Service.create(config)).rejects.toMatchObject({
      code: "credential_unavailable",
    });
  });
  it("cleans up a lock when store construction fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "acplus-store-failure-"));
    roots.push(root);
    const config = fixtureConfig(root);
    await mkdir(join(config.dataDir, "sessions.sqlite"), { recursive: true });
    await expect(Service.create(config)).rejects.toMatchObject({
      code: "storage_failed",
    });
    await expect(
      access(join(config.dataDir, "owner.lock")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects an unusable credential profile before launching", async () => {
    const root = await mkdtemp(join(tmpdir(), "acplus-profile-"));
    roots.push(root);
    const config = fixtureConfig(root);
    await writeFile(config.agents[0]!.profileDir, "not a directory");
    await expect(Service.create(config)).rejects.toMatchObject({
      code: "credential_profile_unavailable",
    });
    expect(state.ensure).not.toHaveBeenCalled();
  });
  it("accepts only an exact non-secret input step and preserves successful public auth", async () => {
    const { service } = await setup();
    const step: Extract<AuthStep, { kind: "input" }> = {
      kind: "input",
      stepId: randomUUID(),
      fields: ["confirmPlaintextStorage"],
    };
    state.authenticate.mockImplementationOnce(
      async (_method, onStep, input, signal) => {
        onStep(step);
        const values = await input(step, signal);
        expect(values).toEqual({ confirmPlaintextStorage: "yes" });
      },
    );
    service.beginAuth("copilot", "sign-in");
    await vi.waitFor(() => {
      expect(service.auth("copilot").flow?.status).toBe("action_required");
    });
    expect(() => service.beginAuth("copilot", "sign-in")).toThrow(ServiceError);
    await expect(service.logout("copilot")).rejects.toMatchObject({
      code: "agent_busy",
    });
    expect(() => {
      service.authInput("copilot", "wrong", { confirmPlaintextStorage: "yes" });
    }).toThrow(ServiceError);
    expect(() => {
      service.authInput("copilot", step.stepId, { password: "secret" });
    }).toThrow(ServiceError);
    expect(() => {
      service.authInput("copilot", step.stepId, {
        confirmPlaintextStorage: "yes",
        extra: "no",
      });
    }).toThrow(ServiceError);
    service.authInput("copilot", step.stepId, {
      confirmPlaintextStorage: "yes",
    });
    await vi.waitFor(() => {
      expect(service.auth("copilot").flow?.status).toBe("succeeded");
    });
    expect(service.auth("copilot").flow?.step).toBeUndefined();
    await service.logout("copilot");
    expect(service.auth("copilot")).toMatchObject({
      lastKnownStatus: "required",
      freshness: "current",
    });
  });
  it("records failed and expired inputs instead of leaving a flow pending", async () => {
    const { service } = await setup();
    state.authenticate.mockRejectedValueOnce(
      new ServiceError("auth_method_unknown", 409),
    );
    service.beginAuth("copilot", "unknown");
    await vi.waitFor(() => {
      expect(service.auth("copilot").flow?.status).toBe("failed");
    });
    const step: Extract<AuthStep, { kind: "input" }> = {
      kind: "input",
      stepId: randomUUID(),
      fields: ["confirmPlaintextStorage"],
    };
    state.authenticate.mockImplementationOnce(
      async (_method, onStep, input) => {
        const controller = new AbortController();
        onStep(step);
        const pending = input(step, controller.signal);
        controller.abort();
        await pending;
      },
    );
    service.beginAuth("copilot", "sign-in");
    await vi.waitFor(() => {
      expect(service.auth("copilot").flow?.error?.code).toBe("auth_expired");
    });
    expect(service.select("copilot").input).toBeNull();
    expect(service.auth("copilot").flow?.status).toBe("expired");
  });
  it("rejects unsupported secret input requests rather than presenting them", async () => {
    const { service } = await setup();
    state.authenticate.mockImplementationOnce((_method, onStep) => {
      onStep({ kind: "input", stepId: randomUUID(), fields: ["password"] });
      return Promise.resolve();
    });
    service.beginAuth("copilot", "sign-in");
    await vi.waitFor(() => {
      expect(service.auth("copilot").flow?.status).toBe("failed");
    });
    expect(service.auth("copilot").flow?.error?.code).toBe(
      "auth_input_unsupported",
    );
    expect(service.auth("copilot").flow?.step).toBeUndefined();
  });
  it("invalidates cached success on unsupported logout rather than simulating success", async () => {
    const { service } = await setup();
    hooks().authenticated("explicit_authentication");
    state.logout.mockRejectedValueOnce(
      new ServiceError("agent_logout_unsupported", 409),
    );
    await expect(service.logout("copilot")).rejects.toMatchObject({
      code: "agent_logout_unsupported",
    });
    expect(service.auth("copilot").freshness).toBe("stale");
  });
  it("closes pending auth inputs and makes repeated close idempotent", async () => {
    const { service } = await setup();
    const step: Extract<AuthStep, { kind: "input" }> = {
      kind: "input",
      stepId: randomUUID(),
      fields: ["confirmPlaintextStorage"],
    };
    state.authenticate.mockImplementationOnce(
      async (_method, onStep, input, signal) => {
        onStep(step);
        await input(step, signal);
      },
    );
    service.beginAuth("copilot", "sign-in");
    await vi.waitFor(() => {
      expect(service.auth("copilot").flow?.status).toBe("action_required");
    });
    await service.close();
    await service.close();
    expect(() => {
      service.assertReady();
    }).toThrow(ServiceError);
    expect(state.close).toHaveBeenCalledTimes(1);
  });
});
