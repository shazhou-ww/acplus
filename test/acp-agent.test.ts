import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AcpRuntime } from "../src/acp-agent.js";
import * as login from "../src/acp-login.js";
import { profileIdentity, Redactor, ServiceError } from "../src/acp-common.js";
import type { AgentConfig, RuntimeHooks, Session } from "../src/acp-types.js";

const program = `
import {agent,methods,ndJsonStream,RequestError} from '@agentclientprotocol/sdk';
import {Readable,Writable} from 'node:stream';
const mode=process.env.MODE;
const app=agent({name:'fake'});
let pending;
app.onRequest(methods.agent.initialize,({params})=>{
 if(params.protocolVersion!==1 || params.clientCapabilities.terminal!==false ||
 params.clientCapabilities.fs.readTextFile!==false) throw new Error('handshake');
 if(mode==='startup-hang') return new Promise(()=>{});
 if(mode==='startup-fail') throw RequestError.internalError('SECRET_STDERR');
 return {protocolVersion:mode==='version'?2:1,
 agentCapabilities: mode==='no-resume'?{}: {
 loadSession:mode==='load',sessionCapabilities:mode==='load'?{}:{resume:{}},
 auth:mode==='no-logout'?{}:{logout:{}}},
 authMethods:mode==='bootstrap-required'?[{id:'copilot-login',name:'Copilot CLI login'}]:mode==='no-auth-methods'?[]:mode==='multiple-auth-methods'?[{id:'one',name:'One'},{id:'two',name:'Two'}]:[{id:'standard',name:'Sign in'},{id:'terminal',name:'Terminal',type:'terminal',args:['UNSAFE'],env:{NODE_OPTIONS:'UNSAFE'}}]};
});
app.onRequest(methods.agent.session.new,async({client})=>{
 if(mode==='auth-required')throw RequestError.authRequired();
 await client.notify(methods.client.session.update,{sessionId:'backend',update:{sessionUpdate:'available_commands_update',availableCommands:[]}});
 return {sessionId:'backend'};
});
app.onRequest(methods.agent.session.resume,()=>({}));
app.onRequest(methods.agent.session.load,async({params,client})=>{
 await client.notify(methods.client.session.update,{sessionId:params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'history'}}});
 await client.notify(methods.client.session.update,{sessionId:'other',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'background'}}});
 return {};
});
app.onRequest(methods.agent.authenticate,({params})=>{
 if(mode==='bootstrap-required')throw RequestError.authRequired();
 if(params.methodId!=='standard'||Object.keys(params).length!==1)throw RequestError.invalidParams();
 if(mode==='auth-fail')throw RequestError.authRequired();
 if(mode==='auth-hang')return new Promise(()=>{});
 return {};
});
app.onRequest(methods.agent.logout,()=>({}));
app.onNotification(methods.agent.session.cancel,()=>{
 if(pending){pending({stopReason:'cancelled'});pending=undefined;}
});
app.onRequest(methods.agent.session.prompt,async({params,client})=>{
 const text=params.prompt[0].text;
 if(text==='disconnect'){process.exit(1);}
 if(text==='hang')return new Promise(resolve=>{pending=resolve;});
 if(text==='permission'){
 const outcome=await client.request(methods.client.session.requestPermission,{
 sessionId:params.sessionId,toolCall:{toolCallId:'tool',title:'read',status:'pending'},
 options:[{optionId:'allow',name:'Allow once',kind:'allow_once'},{optionId:'forever',name:'Always',kind:'allow_always'}]});
 await client.notify(methods.client.session.update,{sessionId:params.sessionId,
 update:{sessionUpdate:'tool_call',toolCallId:'tool',title:outcome.outcome.outcome,status:'completed',content:[{type:'content',content:{type:'text',text:'result'}}]}});
 }
 if(text==='elicitation')await client.request(methods.client.elicitation.create,{message:'unsupported',requestedSchema:{type:'object',properties:{}}});
 if(text==='thought')await client.notify(methods.client.session.update,{sessionId:params.sessionId,update:{sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'hidden'}}});
 await client.notify(methods.client.session.update,{sessionId:params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text}}});
 if(text==='later')setTimeout(()=>void client.notify(methods.client.session.update,{sessionId:'other',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'later'}}}),20);
 if(text==='same-session-later')setTimeout(()=>void client.notify(methods.client.session.update,{sessionId:params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'previous background'}}}),20);
 if(text==='background-with-late'){
 await client.notify('_github.com/copilot/sessionEvent',{sessionId:params.sessionId,type:'subagent.started',data:{}});
 setTimeout(()=>void client.notify(methods.client.session.update,{sessionId:params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'previous background'}}}),20);
 setTimeout(()=>void client.notify('_github.com/copilot/sessionEvent',{sessionId:params.sessionId,type:'session.idle',data:{}}),300);
 }
 if(text==='detached'){
 await client.notify(methods.client.session.update,{sessionId:params.sessionId,update:{sessionUpdate:'tool_call',toolCallId:'detached',title:'background',rawInput:{detach:true}}});
 await client.notify('_github.com/copilot/sessionEvent',{sessionId:params.sessionId,type:'session.idle',data:{}});
 }
 if(text==='unknown')await client.notify('_unknown',{secret:'not-forwarded'});
 if(text==='overflow')for(let i=0;i<1100;i++)await client.notify(methods.client.session.update,{sessionId:params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'x'}}});
 if(text==='oversized')process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'x'.repeat(1100000)}}}})+'\\n');
 if(mode==='activity-background')await client.notify('_github.com/copilot/sessionEvent',{sessionId:params.sessionId,type:'assistant.turn_start'});
 if(text==='busy')setTimeout(()=>void client.notify('_github.com/copilot/sessionEvent',{sessionId:params.sessionId,type:'session.idle',data:{}}),300);
 if(text==='idle')await client.notify('_github.com/copilot/sessionEvent',{sessionId:params.sessionId,type:'session.idle',data:{}});
 if(text==='autopilot')await client.notify('_github.com/copilot/sessionEvent',{sessionId:params.sessionId,type:'session.idle',data:{mode:'autopilot'}});
 if(text==='background')await client.notify('_github.com/copilot/sessionEvent',{sessionId:'other',type:'session.background_tasks_changed',data:{}});
 return {stopReason:'end_turn'};
});
app.connect(ndJsonStream(Writable.toWeb(process.stdout),Readable.toWeb(process.stdin)));
`;

const runtimes: AcpRuntime[] = [];
const directories: string[] = [];
async function fixture(mode = "", extra: Partial<AgentConfig> = {}) {
  const directory = join(
    process.cwd(),
    "test",
    `acp-agent-${crypto.randomUUID()}`,
  );
  await mkdir(directory, { recursive: true });
  directories.push(directory);
  const config: AgentConfig = {
    id: "fake",
    label: "Fake",
    command: process.execPath,
    args: ["--input-type=module", "-e", program],
    env: { MODE: mode },
    profileDir: directory,
    mcpServers: [],
    startupTimeoutMs: 10_000,
    idleTimeoutMs: 40,
    permission: "deny",
    ...extra,
  };
  const hooks = {
    update: vi.fn(async () => {}),
    disconnected: vi.fn(),
    authenticated: vi.fn(),
    invalidated: vi.fn(),
    permission: vi.fn(async () => {}),
    event: vi.fn(),
  } satisfies RuntimeHooks;
  const runtime = new AcpRuntime(config, hooks, new Redactor());
  runtimes.push(runtime);
  const session: Session = {
    sessionId: crypto.randomUUID(),
    agentId: config.id,
    profileIdentity: profileIdentity(config),
    workingDirectory: process.cwd(),
    backendSessionId: null,
    createdAt: "",
    updatedAt: "",
    observedAt: "",
    lastSequence: 0,
    coverage: "unknown",
  };
  return { runtime, hooks, config, session };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    runtimes.splice(0).map(async (runtime) => {
      await runtime.close();
    }),
  );
  await Promise.all(
    directories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe("owned stable ACP v1 runtime", { timeout: 20_000 }, () => {
  it("permits generic no-session authentication and logout without activity support", async () => {
    const { runtime, hooks } = await fixture();
    await runtime.authenticate(
      "standard",
      vi.fn(),
      vi.fn(),
      new AbortController().signal,
    );
    expect(runtime.status).toBe("idle_unknown");
    expect(hooks.update).not.toHaveBeenCalled();
    expect(hooks.authenticated).toHaveBeenCalledWith("agent_authenticate");
    await runtime.logout();
    expect(hooks.invalidated).toHaveBeenCalledWith("logout");
    expect(hooks.disconnected).not.toHaveBeenCalled();
  });

  it.each([
    "background-with-late",
    "same-session-later",
    "detached",
    "background",
  ])(
    "rejects auth/logout before native close or RPC with observed %s work",
    async (work) => {
      const { runtime, hooks, session } = await fixture("", {
        authentication: { type: "copilot", loginAccount: "expected-user" },
      });
      const id = await runtime.attach(session);
      await runtime.prompt(id, work);
      if (work === "same-session-later")
        await vi.waitFor(() => {
          expect(hooks.update).toHaveBeenCalledWith(
            id,
            {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "previous background" },
            },
            "live",
          );
        });
      const stop = vi.spyOn(login.AgentProcess.prototype, "stop");
      const native = vi.spyOn(login, "copilotLogin").mockResolvedValue();
      const generation = runtime.generation;
      await expect(
        runtime.authenticate(
          "standard",
          vi.fn(),
          vi.fn(),
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({
        code: "session_background_ambiguous",
        status: 409,
      });
      await expect(
        runtime.authenticate(
          "native-login",
          vi.fn(),
          vi.fn(),
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({
        code: "session_background_ambiguous",
        status: 409,
      });
      await expect(runtime.logout()).rejects.toMatchObject({
        code: "session_background_ambiguous",
        status: 409,
      });
      expect(stop).not.toHaveBeenCalled();
      expect(native).not.toHaveBeenCalled();
      expect(hooks.authenticated).not.toHaveBeenCalled();
      expect(hooks.invalidated).not.toHaveBeenCalledWith("authentication");
      expect(hooks.invalidated).not.toHaveBeenCalledWith("logout");
      expect(runtime.generation).toBe(generation);
    },
  );

  it("leases a shared profile before spawning and permits distinct profiles", async () => {
    const first = await fixture();
    const contender = await fixture("", {
      profileDir: first.config.profileDir,
      command: join(first.config.profileDir, "must-not-spawn"),
    });
    const distinct = await fixture();
    await Promise.all([first.runtime.ensure(), distinct.runtime.ensure()]);
    await expect(contender.runtime.ensure()).rejects.toMatchObject({
      code: "agent_profile_busy",
      status: 409,
    });
    expect(
      await first.runtime.prompt(
        await first.runtime.attach(first.session),
        "still-owned",
      ),
    ).toEqual({ stopReason: "end_turn" });
  });

  it("releases the lease after startup failure and completed shutdown", async () => {
    const failed = await fixture("startup-fail");
    const replacement = await fixture("", {
      profileDir: failed.config.profileDir,
    });
    await expect(failed.runtime.ensure()).rejects.toBeDefined();
    await replacement.runtime.ensure();
    await replacement.runtime.close();
    const next = await fixture("", { profileDir: failed.config.profileDir });
    await next.runtime.ensure();
  });

  it("retains native-login exclusivity through terminal cleanup and ACP reinitialization", async () => {
    const first = await fixture("", {
      authentication: { type: "copilot", loginAccount: "expected-user" },
    });
    const contender = await fixture("", {
      profileDir: first.config.profileDir,
    });
    await first.runtime.ensure();
    vi.spyOn(login, "copilotLogin").mockImplementation(async () => {
      await expect(contender.runtime.ensure()).rejects.toMatchObject({
        code: "agent_profile_busy",
      });
      await delay(20);
    });
    await first.runtime.authenticate(
      "native-login",
      vi.fn(),
      vi.fn(),
      new AbortController().signal,
    );
    expect(first.runtime.status).toBe("stopped");
    await expect(contender.runtime.ensure()).rejects.toMatchObject({
      code: "agent_profile_busy",
    });
    await first.runtime.ensure();
    await expect(contender.runtime.ensure()).rejects.toMatchObject({
      code: "agent_profile_busy",
    });
    await first.runtime.close();
    await contender.runtime.ensure();
  });

  it("bootstraps native login using an explicit expected account without changing profile binding", async () => {
    const { runtime, config, hooks } = await fixture();
    const before = profileIdentity(config);
    const native = vi.spyOn(login, "copilotLogin").mockResolvedValue();
    await runtime.authenticate(
      undefined,
      vi.fn(),
      vi.fn(),
      new AbortController().signal,
      "expected-user",
    );
    expect(native).toHaveBeenCalledWith(
      expect.objectContaining({
        profileDir: config.profileDir,
        authentication: { type: "copilot", loginAccount: "expected-user" },
      }),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(config.authentication).toBeUndefined();
    expect(profileIdentity(config)).toBe(before);
    expect(hooks.authenticated).toHaveBeenCalledWith("native_device_login");
    await expect(
      runtime.authenticate(
        "standard",
        vi.fn(),
        vi.fn(),
        new AbortController().signal,
        "expected-user",
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(() =>
      runtime.authenticate(
        undefined,
        vi.fn(),
        vi.fn(),
        new AbortController().signal,
        "not an account",
      ),
    ).toThrow(expect.objectContaining({ code: "invalid_input" }));
    expect(native).toHaveBeenCalledOnce();
  });

  it("explains the default Copilot ACP bootstrap failure without repeating its login RPC", async () => {
    const { runtime, hooks } = await fixture("bootstrap-required");
    try {
      await runtime.authenticate(
        undefined,
        vi.fn(),
        vi.fn(),
        new AbortController().signal,
      );
      throw new Error("Expected bootstrap failure");
    } catch (error) {
      expect(error).toMatchObject({ code: "auth_bootstrap_required" });
      if (!(error instanceof Error)) throw error;
      expect(error.message).toContain("--login-account");
    }
    expect(hooks.authenticated).not.toHaveBeenCalled();
  });

  it("releases a failed native flow only after its helper finishes cleanup", async () => {
    const first = await fixture("", {
      authentication: { type: "copilot", loginAccount: "expected-user" },
    });
    const contender = await fixture("", {
      profileDir: first.config.profileDir,
    });
    vi.spyOn(login, "copilotLogin").mockImplementation(async () => {
      await expect(contender.runtime.ensure()).rejects.toMatchObject({
        code: "agent_profile_busy",
      });
      await delay(20);
      throw new ServiceError("auth_cli_failed", 409);
    });
    await expect(
      first.runtime.authenticate(
        "native-login",
        vi.fn(),
        vi.fn(),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "auth_cli_failed" });
    await contender.runtime.ensure();
  });

  it("retains the lease when owned-process cleanup fails", async () => {
    const first = await fixture();
    const contender = await fixture("", {
      profileDir: first.config.profileDir,
    });
    await first.runtime.ensure();
    const stop = vi
      .spyOn(login.AgentProcess.prototype, "stop")
      .mockRejectedValueOnce(new ServiceError("owned_cleanup_failed"));
    await expect(first.runtime.close()).rejects.toMatchObject({
      code: "owned_cleanup_failed",
    });
    await expect(contender.runtime.ensure()).rejects.toMatchObject({
      code: "agent_profile_busy",
    });
    await expect(first.runtime.ensure()).rejects.toMatchObject({
      code: "owned_cleanup_failed",
    });
    stop.mockRestore();
    await first.runtime.close();
    await contender.runtime.ensure();
  });

  it("constructs without spawning and coalesces startup", async () => {
    const { runtime, hooks } = await fixture();
    expect(runtime.status).toBe("stopped");
    expect(runtime.generation).toBe(0);
    expect(runtime.methods()).toEqual([]);
    const [first, second] = await Promise.all([
      runtime.ensure(),
      runtime.ensure(),
    ]);
    expect(first).toBe(second);
    expect(await runtime.ensure()).toBe(first);
    expect(runtime.generation).toBe(1);
    expect(runtime.methods()).toEqual([
      { id: "standard", name: "Sign in", type: "agent" },
    ]);
    expect(hooks.authenticated).not.toHaveBeenCalled();
    expect(runtime.status).toBe("idle_unknown");
    await runtime.close();
    await runtime.ensure();
    expect(runtime.generation).toBe(2);
    expect(hooks.invalidated).toHaveBeenCalledWith("restart");
  });

  it("streams supported updates and awaits hooks before final response", async () => {
    const { runtime, hooks, session } = await fixture();
    const id = await runtime.attach(session);
    vi.mocked(hooks.update).mockImplementation(async () => {
      await delay(15);
    });
    expect(await runtime.prompt(id, "actual")).toEqual({
      stopReason: "end_turn",
    });
    expect(hooks.update).toHaveBeenLastCalledWith(
      id,
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "actual" },
      },
      "live",
    );
    expect(await runtime.attach({ ...session, backendSessionId: id })).toBe(id);
  });

  it("calls optional dispatch synchronously only after preflight", async () => {
    const { runtime, hooks, session } = await fixture();
    const id = await runtime.attach(session);
    const order: string[] = [];
    vi.mocked(hooks.update).mockImplementation(() => {
      order.push("update");
      return Promise.resolve();
    });
    const onDispatch = vi.fn(() => {
      order.push("dispatch");
    });
    expect(await runtime.prompt(id, "with-callback", onDispatch)).toEqual({
      stopReason: "end_turn",
    });
    expect(onDispatch).toHaveBeenCalledOnce();
    expect(order).toEqual(["dispatch", "update"]);
    expect(await runtime.prompt(id, "without-callback")).toEqual({
      stopReason: "end_turn",
    });
  });

  it("does not dispatch when the synchronous callback throws", async () => {
    const { runtime, hooks, session } = await fixture();
    const id = await runtime.attach(session);
    const onDispatch = vi.fn(() => {
      throw new Error("cancel before dispatch");
    });
    await expect(
      runtime.prompt(id, "must-not-dispatch", onDispatch),
    ).rejects.toBeDefined();
    expect(onDispatch).toHaveBeenCalledOnce();
    await delay(30);
    expect(hooks.update).not.toHaveBeenCalledWith(
      id,
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "must-not-dispatch" },
      },
      "live",
    );
    expect(await runtime.prompt(id, "after-rejection")).toEqual({
      stopReason: "end_turn",
    });
  });

  it.each([
    "x".repeat(1024 * 1024),
    "🚀".repeat(270_000),
    "\u0000".repeat(180_000),
  ])(
    "bounds the UTF-8 JSON-RPC envelope before the dispatch callback",
    async (text) => {
      const { runtime, session } = await fixture();
      const id = await runtime.attach(session);
      const onDispatch = vi.fn();
      await expect(runtime.prompt(id, text, onDispatch)).rejects.toMatchObject({
        code: "agent_request_too_large",
        status: 413,
      });
      expect(onDispatch).not.toHaveBeenCalled();
    },
  );
  it.each(["deny", "allow"] as const)(
    "applies %s permissions using only advertised allow_once",
    async (permission) => {
      const { runtime, hooks, session } = await fixture("", { permission });
      await runtime.prompt(await runtime.attach(session), "permission");
      expect(hooks.permission).toHaveBeenCalledWith(
        "backend",
        permission === "allow",
      );
      expect(hooks.update).toHaveBeenCalledWith(
        "backend",
        expect.objectContaining({
          sessionUpdate: "tool_call",
          title: permission === "allow" ? "selected" : "cancelled",
        }),
        "live",
      );
    },
  );

  it("loads replay without attributing background events to the loaded session", async () => {
    const { runtime, hooks, session } = await fixture("load");
    expect(
      await runtime.attach({ ...session, backendSessionId: "existing" }),
    ).toBe("existing");
    expect(hooks.update).toHaveBeenCalledWith(
      "existing",
      expect.anything(),
      "replay",
    );
    expect(hooks.update).toHaveBeenCalledWith(
      "other",
      expect.anything(),
      "live",
    );
    await runtime.prompt("existing", "after-load");
  });

  it("resumes advertised sessions without substituting a new session", async () => {
    const { runtime, hooks, session } = await fixture();
    expect(
      await runtime.attach({ ...session, backendSessionId: "existing" }),
    ).toBe("existing");
    expect(hooks.update).not.toHaveBeenCalled();
  });

  it("rejects absent resume/load and profile mismatch", async () => {
    const { runtime, session, config } = await fixture("no-resume");
    await expect(
      runtime.attach({ ...session, backendSessionId: "existing" }),
    ).rejects.toMatchObject({
      code: "session_resume_unsupported",
      status: 409,
    });
    await expect(
      runtime.attach({ ...session, profileIdentity: "other" }),
    ).rejects.toMatchObject({ code: "session_profile_mismatch" });
    await expect(runtime.prompt("missing", "text")).rejects.toMatchObject({
      code: "session_not_attached",
    });
    config.env.changed = "different";
    await expect(runtime.ensure()).rejects.toMatchObject({
      code: "agent_profile_changed",
    });
  });

  it("authenticates only advertised agent methods and negotiates logout", async () => {
    const { runtime, hooks } = await fixture();
    const signal = new AbortController().signal;
    await runtime.authenticate("standard", vi.fn(), vi.fn(), signal);
    expect(hooks.authenticated).toHaveBeenCalledWith("agent_authenticate");
    await expect(
      runtime.authenticate("terminal", vi.fn(), vi.fn(), signal),
    ).rejects.toMatchObject({ code: "auth_method_unsupported" });
    await runtime.logout();
    expect(hooks.invalidated).toHaveBeenCalledWith("logout");
    const unsupported = await fixture("no-logout");
    await expect(unsupported.runtime.logout()).rejects.toMatchObject({
      code: "agent_logout_unsupported",
      status: 409,
    });
    expect(unsupported.hooks.invalidated).not.toHaveBeenCalledWith("logout");
  });

  it("chooses a sole supported Agent login method but refuses absent or ambiguous choices", async () => {
    const { runtime, hooks } = await fixture();
    await runtime.authenticate(
      undefined,
      vi.fn(),
      vi.fn(),
      new AbortController().signal,
    );
    expect(hooks.authenticated).toHaveBeenCalledWith("agent_authenticate");
    for (const mode of ["no-auth-methods", "multiple-auth-methods"]) {
      const { runtime: other, hooks: otherHooks } = await fixture(mode);
      await expect(
        other.authenticate(
          undefined,
          vi.fn(),
          vi.fn(),
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: "auth_method_required" });
      expect(otherHooks.authenticated).not.toHaveBeenCalled();
    }
  });

  it("does not synthesize authentication success after auth-required or cancellation", async () => {
    const { runtime, hooks } = await fixture("auth-fail");
    await expect(
      runtime.authenticate(
        "standard",
        vi.fn(),
        vi.fn(),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "agent_auth_required" });
    expect(hooks.authenticated).not.toHaveBeenCalled();
    expect(hooks.invalidated).toHaveBeenCalledWith("auth_required");
    const hung = await fixture("auth-hang");
    await hung.runtime.ensure();
    const controller = new AbortController();
    const auth = hung.runtime.authenticate(
      "standard",
      vi.fn(),
      vi.fn(),
      controller.signal,
    );
    await delay(20);
    controller.abort();
    await expect(auth).rejects.toBeDefined();
    expect(hung.hooks.authenticated).not.toHaveBeenCalled();
    const required = await fixture("auth-required");
    await expect(
      required.runtime.attach(required.session),
    ).rejects.toMatchObject({ code: "agent_auth_required" });
  });

  it.each(["startup-fail", "startup-hang", "version"])(
    "bounds %s startup and cleans up",
    async (mode) => {
      const { runtime, hooks } = await fixture(mode, {
        startupTimeoutMs: mode === "startup-hang" ? 300 : 2000,
      });
      await expect(runtime.ensure()).rejects.toBeDefined();
      expect(runtime.status).toBe("failed");
      expect(hooks.authenticated).not.toHaveBeenCalled();
      expect(
        JSON.stringify(vi.mocked(hooks.disconnected).mock.calls),
      ).not.toContain("SECRET_STDERR");
      await runtime.close();
    },
  );

  it("handles spawn failures with sanitized diagnostics", async () => {
    const { runtime, hooks } = await fixture("", {
      command: join(process.cwd(), "test", "acp-missing-command"),
    });
    await expect(runtime.ensure()).rejects.toBeDefined();
    expect(hooks.disconnected).toHaveBeenCalledWith({
      code: "agent_spawn_failed",
      message: "agent spawn failed",
    });
  });

  it("fences disconnects and restarts without cached session bindings", async () => {
    const { runtime, session, hooks } = await fixture();
    const id = await runtime.attach(session);
    await expect(runtime.prompt(id, "disconnect")).rejects.toMatchObject({
      code: "agent_disconnected",
    });
    expect(hooks.disconnected).toHaveBeenCalled();
    await runtime.ensure();
    await expect(runtime.prompt(id, "text")).rejects.toMatchObject({
      code: "session_not_attached",
    });
  });

  it("serializes prompts, and cancel ends a genuine pending prompt", async () => {
    const { runtime, session } = await fixture();
    await expect(runtime.cancel("backend")).rejects.toMatchObject({
      code: "agent_not_running",
    });
    const id = await runtime.attach(session);
    const first = runtime.prompt(id, "hang");
    const second = runtime.prompt(id, "second");
    await delay(30);
    await runtime.cancel(id);
    expect(await first).toEqual({ stopReason: "cancelled" });
    expect(await second).toEqual({ stopReason: "end_turn" });
  });

  it("retains unknown-idle runtimes and forwards late updates without turn guesses", async () => {
    const { runtime, hooks, session } = await fixture();
    const id = await runtime.attach(session);
    await runtime.prompt(id, "later");
    await delay(80);
    expect(hooks.update).toHaveBeenCalledWith(
      "other",
      expect.anything(),
      "live",
    );
    expect(runtime.status).toBe("idle_unknown");
    await runtime.prompt(id, "unknown");
    expect(hooks.event).toHaveBeenCalledWith("agent_notification_unsupported");
    await runtime.prompt(id, "thought");
    expect(hooks.event).toHaveBeenCalledWith("agent_thought_unsupported");
    expect(hooks.update).not.toHaveBeenCalledWith(
      id,
      expect.objectContaining({ sessionUpdate: "agent_thought_chunk" }),
      "live",
    );
  });

  it("only exits when negotiated activity proves quiescence", async () => {
    const { runtime, session } = await fixture("activity-background");
    const id = await runtime.attach(session);
    await runtime.prompt(id, "busy");
    await delay(80);
    expect(runtime.status).toBe("ready");
    await expect(runtime.prompt(id, "next")).rejects.toMatchObject({
      code: "session_background_ambiguous",
      status: 409,
    });
    await vi.waitFor(
      () => {
        expect(runtime.status).toBe("stopped");
      },
      { timeout: 4000 },
    );
  });

  it("retains unknown background and autopilot activity despite root idle", async () => {
    const { runtime, session } = await fixture("activity-background");
    const id = await runtime.attach(session);
    await runtime.prompt(id, "autopilot");
    expect(runtime.status).toBe("idle_unknown");
    await expect(runtime.prompt(id, "next")).rejects.toMatchObject({
      code: "session_background_ambiguous",
    });
    const another = await fixture();
    const anotherId = await another.runtime.attach(another.session);
    await another.runtime.prompt(anotherId, "background");
    await another.runtime.prompt(anotherId, "idle");
    await delay(100);
    expect(another.runtime.status).toBe("idle_unknown");
  });

  it("rejects a same-session new prompt while known prior background can still stream", async () => {
    const { runtime, hooks, session } = await fixture("", { idleTimeoutMs: 0 });
    const id = await runtime.attach(session);
    await runtime.prompt(id, "background-with-late");
    const onDispatch = vi.fn();
    const queued = runtime.prompt(id, "must-not-dispatch", onDispatch);
    await expect(queued).rejects.toMatchObject({
      code: "session_background_ambiguous",
      status: 409,
    });
    expect(onDispatch).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(hooks.update).toHaveBeenCalledWith(
        id,
        {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "previous background" },
        },
        "live",
      );
    });
    expect(hooks.update).not.toHaveBeenCalledWith(
      id,
      expect.objectContaining({
        content: { type: "text", text: "must-not-dispatch" },
      }),
      "live",
    );
    await vi.waitFor(() => {
      expect(hooks.event).toHaveBeenCalledWith("agent_activity_idle");
    });
    expect(await runtime.prompt(id, "after-quiescence")).toEqual({
      stopReason: "end_turn",
    });
  });

  it("rejects observed late same-session updates without inventing correlation", async () => {
    const { runtime, hooks, session } = await fixture();
    const id = await runtime.attach(session);
    await runtime.prompt(id, "same-session-later");
    await vi.waitFor(() => {
      expect(hooks.update).toHaveBeenCalledWith(
        id,
        {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "previous background" },
        },
        "live",
      );
    });
    await expect(runtime.prompt(id, "next")).rejects.toMatchObject({
      code: "session_background_ambiguous",
    });
  });

  it("does not treat root idle as proof that an observed detached tool ended", async () => {
    const { runtime, session } = await fixture();
    const id = await runtime.attach(session);
    await runtime.prompt(id, "detached");
    await expect(runtime.prompt(id, "next")).rejects.toMatchObject({
      code: "session_background_ambiguous",
    });
  });

  it("cancels queued prompts on close rather than spawning a replacement", async () => {
    const { runtime, session } = await fixture();
    const id = await runtime.attach(session);
    const first = runtime.prompt(id, "hang");
    const second = runtime.prompt(id, "queued");
    const failures = Promise.allSettled([first, second]);
    await delay(30);
    await runtime.close();
    expect((await failures).map((result) => result.status)).toEqual([
      "rejected",
      "rejected",
    ]);
    expect(runtime.generation).toBe(1);
  });

  it("fences native login startup and waits for its owned cleanup on close", async () => {
    const { runtime, hooks } = await fixture("", {
      authentication: { type: "copilot", loginAccount: "expected-user" },
    });
    vi.spyOn(login, "copilotLogin").mockImplementation(
      (_agent, _env, _onStep, _input, signal) =>
        login.waitFor(new Promise<void>(() => {}), signal).finally(async () => {
          await delay(20);
        }),
    );
    const authentication = runtime.authenticate(
      "native-login",
      vi.fn(),
      vi.fn(),
      new AbortController().signal,
    );
    const outcome = Promise.allSettled([authentication]);
    await delay(30);
    await expect(runtime.ensure()).rejects.toMatchObject({
      code: "agent_auth_in_progress",
    });
    await runtime.close();
    expect((await outcome)[0].status).toBe("rejected");
    expect(hooks.authenticated).not.toHaveBeenCalled();
  });

  it("records genuine native authentication without fabricating readiness", async () => {
    const { runtime, hooks } = await fixture("", {
      authentication: { type: "copilot", loginAccount: "expected-user" },
    });
    vi.spyOn(login, "copilotLogin").mockResolvedValue();
    await runtime.authenticate(
      "native-login",
      vi.fn(),
      vi.fn(),
      new AbortController().signal,
    );
    expect(hooks.authenticated).toHaveBeenCalledWith("native_device_login");
    expect(runtime.status).toBe("stopped");
    expect(runtime.generation).toBe(0);
  });

  it.skipIf(process.platform !== "linux")(
    "uses a real Linux PTY without recording its transcript",
    async () => {
      const { config } = await fixture("", {
        authentication: { type: "copilot", loginAccount: "expected-user" },
      });
      const command = join(config.profileDir, "login.sh");
      await writeFile(
        command,
        "#!/bin/sh\nprintf 'ABCD-1234 https://github.com/login/device\\nSystem keychain unavailable. Store token in plaintext config file? (y/N)'\nread answer\n[ \"$answer\" = y ] || exit 1\nprintf '\\nSigned in successfully as expected-user.\\n'\n",
        { mode: 0o700 },
      );
      config.command = command;
      const steps: unknown[] = [];
      await login.copilotLogin(
        config,
        await login.agentEnvironment(config, new Redactor()),
        (step) => {
          steps.push(step);
        },
        () => Promise.resolve({ confirmPlaintextStorage: "yes" }),
        AbortSignal.timeout(5000),
      );
      expect(steps).toHaveLength(2);
    },
  );

  it("rejects unsupported elicitation promptly", async () => {
    const { runtime, session } = await fixture();
    await expect(
      runtime.prompt(await runtime.attach(session), "elicitation"),
    ).rejects.toMatchObject({ code: "agent_method_unsupported" });
  });

  it("closes explicitly on failed update/permission hooks", async () => {
    const { runtime, hooks, session } = await fixture();
    const id = await runtime.attach(session);
    vi.mocked(hooks.update).mockRejectedValue(new Error("PRIVATE"));
    await expect(runtime.prompt(id, "text")).rejects.toBeDefined();
    expect(hooks.disconnected).toHaveBeenCalledWith({
      code: "agent_update_failed",
      message: "agent update failed",
    });
    const another = await fixture();
    const anotherId = await another.runtime.attach(another.session);
    vi.mocked(another.hooks.permission).mockRejectedValue(new Error("PRIVATE"));
    await expect(
      another.runtime.prompt(anotherId, "permission"),
    ).rejects.toBeDefined();
    expect(another.hooks.disconnected).toHaveBeenCalledWith({
      code: "agent_callback_failed",
      message: "agent callback failed",
    });
  });

  it("rejects oversized messages and bounded notification queue overflow", async () => {
    const { runtime, hooks, session } = await fixture();
    const id = await runtime.attach(session);
    vi.mocked(hooks.update).mockImplementation(async () => {
      await delay(50);
    });
    await expect(runtime.prompt(id, "overflow")).rejects.toBeDefined();
    expect(hooks.disconnected).toHaveBeenCalledWith(
      expect.objectContaining({ code: "agent_notification_overflow" }),
    );
    const another = await fixture();
    await expect(
      another.runtime.prompt(
        await another.runtime.attach(another.session),
        "oversized",
      ),
    ).rejects.toBeDefined();
  });

  it("unblocks waiting hooks on close and rejects aborted native login", async () => {
    const { runtime, hooks, session } = await fixture();
    const id = await runtime.attach(session);
    vi.mocked(hooks.update).mockImplementation(() => new Promise(() => {}));
    const prompt = runtime.prompt(id, "waiting");
    await delay(20);
    await runtime.close();
    await expect(prompt).rejects.toBeDefined();
    const native = await fixture("", {
      authentication: { type: "copilot", loginAccount: "test" },
    });
    expect(native.runtime.methods()[0]?.id).toBe("native-login");
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      native.runtime.authenticate(
        "native-login",
        vi.fn(),
        vi.fn(),
        aborted.signal,
      ),
    ).rejects.toBeDefined();
    if (process.platform !== "linux")
      await expect(
        native.runtime.authenticate(
          "native-login",
          vi.fn(),
          vi.fn(),
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: "auth_native_pty_unsupported" });
    expect(native.hooks.authenticated).not.toHaveBeenCalled();
  });
});
