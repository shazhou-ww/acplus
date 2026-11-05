import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { githubCliFactory } from "../src/github-cli.js";
import { loadConfig } from "../src/config.js";
import { ServiceError } from "../src/common.js";
import { OwnedProcess, ProcessOwner } from "../src/processes.js";
import type { AuthenticationContext } from "../src/extensions.js";
import { config, eventually, harness } from "./fixture.js";

type Harness = Awaited<ReturnType<typeof harness>>;
let app: Harness | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function options(profileDir: string, mode = "login") {
  return {
    command: process.execPath,
    args: [resolve("test", "github-cli-fixture.mjs")],
    profileDir,
    account: "fixture-user",
    mode,
    isolation: "dedicated-runtime",
  };
}

async function setup(authTimeoutMs = 5000, command = process.execPath) {
  const input = config(["a", "b", "unbound"]);
  const directory = join(input.dataDir, "profile");
  await mkdir(directory, { recursive: true });
  for (const host of input.hosts.slice(0, 2)) {
    host.authentication = ["login", "reuse"].map((mode) => ({
      id: mode,
      provider: "copilotcli",
      resource: "https://api.github.com",
      adapter: "github-cli",
      options: { ...options(directory, mode), command },
    }));
  }
  app = await harness(input, { authTimeoutMs });
  for (const id of ["a", "b", "unbound"]) {
    const provider = app.host(id).root.agents[0];
    if (provider === undefined) throw new Error();
    provider.provider = "copilotcli";
  }
  return {
    input,
    directory,
    async control(value: Record<string, unknown>) {
      await writeFile(join(directory, "control.json"), JSON.stringify(value));
    },
    async begin(methodId = "login", host = "a") {
      expect(
        (await app?.api(`/hosts/${host}/auth`, "POST", { methodId }))?.status,
      ).toBe(202);
      await eventually(() => {
        const status = app?.service.select(host).auth.get().status;
        return (
          status === "succeeded" || status === "failed" || status === "expired"
        );
      });
      return app?.service.select(host).auth.get();
    },
    async calls() {
      const lines = await readFile(join(directory, "calls.jsonl"), "utf8");
      return lines
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    },
  };
}

describe("official GitHub CLI handoff (synthetic subprocesses)", () => {
  it("reports an unavailable launcher without falling back to gh on PATH", async () => {
    const run = await setup(
      5000,
      resolve("test", "not-installed-launcher.exe"),
    );
    expect(await run.begin()).toMatchObject({
      status: "failed",
      error: { code: "auth_cli_unavailable" },
    });
  });

  it("reaps a CLI cancelled immediately after spawn and retains unsafe profile leases on cleanup failure", async () => {
    const run = await setup();
    const owner = new ProcessOwner();
    const context: AuthenticationContext = {
      target: {
        hostId: "a",
        provider: "copilotcli",
        resource: "https://api.github.com",
      },
      expiresAt: new Date(Date.now() + 5000).toISOString(),
      secrets: { resolve: () => Promise.reject(new Error("not used")) },
      processes: owner,
      logger: { event: () => {} },
      publishStep: () => {},
      requestInput: () => Promise.reject(new Error("not used")),
      submitCredential: () => Promise.resolve({ status: "authenticated" }),
      verifyAuthentication: () => Promise.resolve({ status: "authenticated" }),
    };
    const factory = githubCliFactory();
    const adapter = factory.create(
      factory.options.parse(options(run.directory)),
    );
    const abort = new AbortController();
    let pid: number | undefined;
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const spawn = owner.spawn;
    const spy = vi.spyOn(owner, "spawn").mockImplementation((value) => {
      const child = spawn.call(owner, value);
      pid = child.child.pid;
      abort.abort();
      return child;
    });
    try {
      await expect(adapter.run(context, abort.signal)).rejects.toThrow();
      expect(pid).toBeTypeOf("number");
      expect(() => process.kill(pid!, 0)).toThrow();
      spy.mockRestore();
      vi.spyOn(OwnedProcess.prototype, "stop").mockRejectedValueOnce(
        new ServiceError("owned_cleanup_failed", 503),
      );
      await expect(
        adapter.run(context, new AbortController().signal),
      ).rejects.toMatchObject({
        code: "owned_cleanup_failed",
      });
      await expect(
        adapter.run(context, new AbortController().signal),
      ).rejects.toMatchObject({
        code: "auth_profile_busy",
      });
    } finally {
      await owner.close();
    }
  });

  it("requires explicit isolation, account and absolute runtime profile; resolves only local executable paths", async () => {
    const factory = githubCliFactory();
    const valid = options("/opt/ahplex/profile");
    for (const change of [
      { isolation: undefined },
      { isolation: "shared-keychain" },
      { profileDir: "" },
      { profileDir: "./default" },
      { account: "" },
      { mode: "ambient" },
      { arbitraryCommand: "token" },
    ])
      expect(() => factory.options.parse({ ...valid, ...change })).toThrow();
    expect(() =>
      factory.create({ ...factory.options.parse(valid), command: "gh.cmd" }),
    ).toThrow();
    if (process.platform === "win32")
      expect(() =>
        factory.create({ ...factory.options.parse(valid), command: "gh.exe" }),
      ).toThrow();
    factory.create(factory.options.parse(valid));
    expect(() =>
      factory.create(
        factory.options.parse({ ...valid, account: "other-user" }),
      ),
    ).toThrow("account conflict");
    const input = config(["a"]);
    input.hosts[0]?.authentication.push({
      id: "login",
      provider: "copilotcli",
      resource: "https://api.github.com",
      adapter: "github-cli",
      options: { ...valid, command: ".\\wrapper.exe" },
    });
    const base = resolve("test");
    const loaded = await loadConfig(
      "-",
      {},
      () => Promise.resolve(JSON.stringify(input)),
      base,
    );
    expect(loaded.hosts[0]?.authentication[0]?.options.command).toBe(
      join(base, "wrapper.exe"),
    );
    expect(loaded.hosts[0]?.authentication[0]?.options.profileDir).toBe(
      "/opt/ahplex/profile",
    );
    const run = await setup();
    const path = join(run.directory, "config.json");
    await writeFile(path, JSON.stringify(input));
    const file = await loadConfig(path);
    expect(file.hosts[0]?.authentication[0]?.options.command).toBe(
      join(run.directory, "wrapper.exe"),
    );
    expect(file.hosts[0]?.authentication[0]?.options.profileDir).toBe(
      "/opt/ahplex/profile",
    );
  });

  it("parses only device link/code, exports through official pinned account API, and binds two selected connections", async () => {
    for (const name of [
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "COPILOT_GITHUB_TOKEN",
      "GH_DEBUG",
      "SHOULD_NOT_REACH_CHILD",
    ])
      vi.stubEnv(name, "ambient-must-not-reach-gh");
    const run = await setup();
    await run.control({ hold: true });
    await app?.api("/hosts/a/auth", "POST", { methodId: "login" });
    await eventually(
      () => app?.service.select("a").auth.get().status === "action_required",
    );
    expect((await app?.api("/hosts/a/auth"))?.body).toEqual({
      status: "action_required",
      methodId: "login",
      step: {
        kind: "link",
        url: "https://github.com/login/device",
        userCode: "ABCD-1234",
      },
    });
    // A second host never launches a competing login against the same profile.
    expect(await run.begin("login", "b")).toMatchObject({
      status: "failed",
      error: { code: "auth_profile_busy" },
    });
    await app?.service.select("a").auth.close();
    await app?.close();
    const completed = await setup();
    expect(await completed.begin()).toMatchObject({ status: "succeeded" });
    expect(await completed.begin("reuse", "b")).toMatchObject({
      status: "succeeded",
    });
    expect(
      (await app?.api("/hosts/unbound/auth", "POST", { methodId: "reuse" }))
        ?.status,
    ).toBe(404);
    for (const id of ["a", "b"]) {
      const requests = app
        ?.host(id)
        .requests.filter((request) => request.method === "authenticate");
      expect(requests).toHaveLength(1);
      expect(requests?.[0]?.params).toMatchObject({
        resource: "https://api.github.com",
        token: "gho_fixtureSecret",
        scopes: ["repo", "read:org", "gist", "read:user", "user:email"],
      });
      expect(app?.host(id).connections).toBe(1);
      expect(
        JSON.stringify((await app?.api(`/hosts/${id}/auth`))?.body),
      ).not.toContain("gho_");
    }
    expect(app?.host("unbound").requests).toHaveLength(0);
    const calls = await completed.calls();
    expect(calls.map((call) => (call.args as string[])[1])).toEqual([
      "login",
      "status",
      "token",
      "status",
      "token",
    ]);
    for (const call of calls) {
      expect(call).toMatchObject({
        ambient: [],
        browser: "ahplex-browser-disabled",
        dbus: "disabled:",
      });
      if ((call.args as string[])[1] === "login")
        expect(call.args).toEqual([
          "auth",
          "login",
          "--hostname",
          "github.com",
          "--web",
          "--git-protocol",
          "https",
          "--skip-ssh-key",
          "--insecure-storage",
          "--clipboard=false",
          "--scopes",
          "read:user,user:email",
        ]);
      if ((call.args as string[])[1] === "token")
        expect(call.args).toEqual([
          "auth",
          "token",
          "--hostname",
          "github.com",
          "--user",
          "fixture-user",
          "--no-refresh",
        ]);
    }
    expect(app?.service.redactor.clean("gho_fixtureSecret")).toBe("[redacted]");
  });

  it("requires explicit rebind after reconnect and invalidates auth when an RPC requires authentication", async () => {
    const run = await setup();
    expect(await run.begin()).toMatchObject({ status: "succeeded" });
    await app?.host().disconnect();
    await eventually(
      () => app?.service.select("a").auth.get().status === "idle",
    );
    await eventually(() => app?.service.select("a").native.status === "ready");
    expect(app?.service.select("a").auth.get()).toEqual({ status: "idle" });
    expect(
      app
        ?.host()
        .requests.filter((request) => request.method === "authenticate"),
    ).toHaveLength(1);
    expect(await run.begin("reuse")).toMatchObject({ status: "succeeded" });
    expect(app?.host().connections).toBe(2);
    app?.host().errors.set("listSessions", -32007);
    expect((await app?.api("/hosts/a/sessions"))?.body).toMatchObject({
      error: { code: "upstream_auth_required" },
    });
    expect(app?.service.select("a").auth.get()).toEqual({ status: "idle" });
    expect(
      app
        ?.host()
        .requests.some((request) => request.method === "dispatchAction"),
    ).toBe(false);
  });

  it("fails closed for missing profile credentials, invalid source/account/status/expiry and CLI failures without raw output", async () => {
    const run = await setup();
    expect(await run.begin("reuse")).toMatchObject({
      error: { code: "auth_cli_account_unavailable" },
    });
    expect(await run.begin()).toMatchObject({ status: "succeeded" });
    for (const [control, code] of [
      [{ fail: "login" }, "auth_cli_failed"],
      [{ fail: "status" }, "auth_cli_failed"],
      [{ fail: "token" }, "auth_cli_failed"],
      [{ noCode: true }, "auth_cli_interaction_missing"],
      [{ badUrl: true }, "auth_cli_interaction_missing"],
      [{ invalidJson: true }, "auth_cli_invalid_response"],
      [{ account: "wrong-account" }, "auth_cli_account_unavailable"],
      [{ state: "error" }, "auth_cli_account_unavailable"],
      [{ source: "keyring" }, "auth_cli_credential_source"],
      [{ source: "GH_TOKEN" }, "auth_cli_credential_source"],
      [{ source: "other-profile/hosts.yml" }, "auth_cli_credential_source"],
      [{ scopes: 42 }, "auth_cli_invalid_response"],
      [{ scopes: "'read:user', 'user:email'" }, "auth_cli_invalid_response"],
      [{ scopes: '"read:user", "user:email"' }, "auth_cli_invalid_response"],
      [{ scopes: "repo,read:org,gist" }, "auth_scope_missing"],
      [{ scopes: "read:user" }, "auth_scope_missing"],
      [{ scopes: "" }, "auth_scope_missing"],
      [{ expiry: "invalid" }, "auth_cli_invalid_response"],
      [{ expiry: "2000-01-01T00:00:00Z" }, "auth_expired"],
      [{ token: "gho_first\ngho_second\n" }, "auth_invalid_credential"],
      [{ token: "" }, "auth_invalid_credential"],
      [{ overflow: true }, "auth_cli_invalid_response"],
      [{ overflow: "lines" }, "auth_cli_output_limit"],
    ] as const) {
      await run.control(control);
      const status = await run.begin();
      expect(status).toMatchObject({ error: { code } });
      expect(JSON.stringify(status)).not.toContain("fixtureSecret");
    }
  }, 15_000);

  it("expands only GitHub's documented user implication and forwards clean deduplicated scopes", async () => {
    const run = await setup();
    for (const [reported, granted] of [
      [
        "repo, user, gist, user",
        ["repo", "user", "gist", "read:user", "user:email"],
      ],
      ["user,read:user,user:email", ["user", "read:user", "user:email"]],
    ] as const) {
      await run.control({ scopes: reported });
      expect(await run.begin()).toMatchObject({ status: "succeeded" });
      const requests = app
        ?.host()
        .requests.filter((request) => request.method === "authenticate");
      expect(requests?.at(-1)?.params.scopes).toEqual(granted);
    }
  });

  it("preserves negative native authenticate, passes known expiry, and rejects unsupported resource before spawning", async () => {
    const run = await setup();
    await run.control({ expiry: "future" });
    app!.host().authenticationResult = { authenticated: false };
    expect(await run.begin()).toMatchObject({
      status: "failed",
      error: { code: "upstream_auth_required" },
    });
    app!.host().authenticationResult = {};
    expect(await run.begin("reuse")).toMatchObject({ status: "succeeded" });
    expect(
      app?.host().requests.find((request) => request.method === "authenticate")
        ?.params.expiresIn,
    ).toBeGreaterThan(0);
    const factory = githubCliFactory();
    const adapter = factory.create(
      factory.options.parse(options(run.directory)),
    );
    await expect(
      adapter.run(
        {
          target: {
            hostId: "a",
            provider: "$host",
            resource: "https://api.github.com",
          },
        } as never,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "auth_target_unsupported" });
  });

  it("stops the actual pending CLI on timeout, reconnect, and shutdown", async () => {
    for (const action of ["timeout", "reconnect", "shutdown"]) {
      const run = await setup(action === "timeout" ? 350 : 5000);
      await run.control({ hold: true });
      await app?.api("/hosts/a/auth", "POST", { methodId: "login" });
      await eventually(
        () => app?.service.select("a").auth.get().status === "action_required",
      );
      const pid = Number(await readFile(join(run.directory, "pid"), "utf8"));
      if (action === "reconnect") await app?.host().disconnect();
      if (action === "shutdown") await app?.service.select("a").auth.close();
      await eventually(() => {
        const status = app?.service.select("a").auth.get().status;
        return status === "failed" || status === "expired";
      });
      await eventually(() => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      });
      expect(
        app
          ?.host()
          .requests.some((request) => request.method === "authenticate"),
      ).toBe(false);
      await app?.close();
      app = undefined;
    }
  });
});
