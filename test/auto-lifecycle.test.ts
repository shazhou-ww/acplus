import { execFile, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { stringify } from "yaml";
import { Store } from "../src/acp-store.js";
import { history } from "../src/acp-history.js";
import { startManaged, serve } from "../src/acp-server.js";
import { Service } from "../src/acp-service.js";
import { run } from "../src/cli.js";
import { lockDirectory } from "../src/data-lock.js";
import {
  canonicalDataDir,
  localHeaders,
  localService,
  proof,
  publishOwner,
  readOwner,
  verifies,
} from "../src/local-service.js";
import { fixtureConfig } from "./acp-fixture.js";

const exec = promisify(execFile);
const root = resolve(".auto-lifecycle-tests", randomUUID());
const cleanups: (() => Promise<unknown>)[] = [];
const cli = resolve("dist", "cli.js");
const env = { ...process.env, ACPLUS_URL: undefined };
const idleMeasurements: number[] = [];

async function fixture() {
  const directory = join(root, randomUUID());
  await mkdir(directory, { recursive: true });
  const config = fixtureConfig(directory);
  const file = join(directory, "config.yaml");
  await writeFile(file, stringify(config));
  return { directory, config, file };
}

async function command(args: string[]) {
  const result = await exec(process.execPath, [cli, ...args], {
    env,
    timeout: 20000,
  });
  return JSON.parse(result.stdout) as unknown;
}

async function until(
  operation: () => Promise<boolean> | boolean,
  timeout = 10000,
) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await operation()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Lifecycle condition timed out");
}

async function released(dataDir: string) {
  await until(async () => {
    try {
      await stat(join(dataDir, "owner.lock"));
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
  });
}

beforeAll(async () => {
  await mkdir(root, { recursive: true });
  const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
  await exec(process.execPath, [tsc, "-p", "tsconfig.build.json"], {
    timeout: 60000,
  });
}, 60000);
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
afterAll(async () => {
  console.log(
    `Auto-service idle expiry measurements (ms): ${idleMeasurements.join(", ")}`,
  );
  await rm(root, { recursive: true, force: true });
});

describe("offline committed history", () => {
  it("shares HTTP shapes, filters, validation and snapshots without recovering running work", async () => {
    const { config, file, directory } = await fixture();
    const service = await Service.create(config);
    const http = await serve(service);
    cleanups.push(() => http.close());
    const session = await service.createSession("copilot", directory);
    const second = await service.createSession("copilot", directory);
    const turn = service.store.admitTurn(
      session.sessionId,
      randomUUID(),
      "HOLD",
    ).turn;
    service.store.setTurnState(session.sessionId, turn.turnId, "starting");
    service.store.setTurnState(session.sessionId, turn.turnId, "dispatching");
    service.store.setTurnState(session.sessionId, turn.turnId, "running");
    service.store.appendEvent(
      session.sessionId,
      turn.turnId,
      "agent_message_chunk",
      {
        content: { type: "text", text: "committed" },
      },
    );
    const database = join(config.dataDir, "sessions.sqlite");
    const before = await readFile(database);
    const beforeStat = await stat(database);
    const reader = new Store(database, undefined, true);
    cleanups.push(() => {
      reader.close();
      return Promise.resolve();
    });
    const paths = [
      "/sessions?agentId=copilot&limit=1",
      `/sessions/${session.sessionId}`,
      `/sessions/${second.sessionId}/turns`,
      `/sessions/${session.sessionId}/turns?limit=1`,
      `/sessions/${session.sessionId}/turns/${turn.turnId}`,
      `/sessions/${session.sessionId}/events?turnId=${turn.turnId}&after=0&limit=1`,
      `/sessions/${session.sessionId}/events`,
    ];
    for (const path of paths) {
      const response = await fetch(http.url + path);
      expect(response.status).toBe(200);
      expect(
        reader.snapshot(() =>
          history(reader, new URL(http.url + path), (id) => service.select(id)),
        ),
      ).toEqual(await response.json());
    }
    const page = reader.listSessions({ limit: 1 });
    expect(
      reader.listSessions({ limit: 1, cursor: page.nextCursor ?? "" }).items[0]
        ?.sessionId,
    ).toBe(second.sessionId);
    expect(reader.getTurn(session.sessionId, turn.turnId).state).toBe(
      "running",
    );
    expect(() => reader.createSession("a", directory, "p")).toThrow(
      expect.objectContaining({ code: "storage_read_only" }),
    );
    for (const path of [
      "/sessions?limit=0",
      "/sessions?limit=-1",
      "/sessions?limit=1001",
      "/sessions?limit=1&limit=2",
      "/sessions?cursor=bad",
      "/sessions?agentId=missing",
      "/sessions?extra=x",
      "/sessions/not-uuid",
      `/sessions/${session.sessionId}?cursor=bad`,
      `/sessions/${session.sessionId}/events?after=1.5`,
      `/sessions/${session.sessionId}/events?after=9007199254740992`,
      `/sessions/${session.sessionId}/events?turnId=bad`,
      `/sessions/${session.sessionId}/turns?cursor=${page.nextCursor ?? ""}`,
      `/sessions/${session.sessionId}/events/${turn.turnId}`,
    ]) {
      const response = await fetch(http.url + path);
      const raw = (await response.json()) as { error: { code: string } };
      expect(() =>
        history(reader, new URL(http.url + path), (id) => service.select(id)),
      ).toThrow(expect.objectContaining({ code: raw.error.code }));
    }
    expect(await readFile(database)).toEqual(before);
    expect((await stat(database)).mtimeMs).toBe(beforeStat.mtimeMs);
    expect((await stat(database)).mode).toBe(beforeStat.mode);
    await http.close();
    // A nonexistent Agent executable and secret do not participate in read-only history.
    config.agents[0]!.command = join(
      directory,
      "unavailable-native-executable",
    );
    config.agents[0]!.env = {
      SECRET: { source: "file", path: join(directory, "absent-secret") },
    };
    await writeFile(file, stringify(config));
    vi.stubEnv("ACPLUS_URL", undefined);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const network = vi.spyOn(globalThis, "fetch");
    await run([
      "turns",
      "get",
      "--config",
      file,
      "--session",
      session.sessionId,
      "--turn",
      turn.turnId,
    ]);
    expect(network).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenLastCalledWith(
      JSON.stringify(reader.getTurn(session.sessionId, turn.turnId)),
    );
    expect(await readFile(database)).toEqual(before);
  });

  it("does not create missing databases, migrate schemas or conceal corruption", async () => {
    const { directory } = await fixture();
    const file = join(directory, "absent", "sessions.sqlite");
    expect(() => new Store(file, undefined, true)).toThrow(
      expect.objectContaining({ code: "storage_missing" }),
    );
    await expect(stat(join(directory, "absent"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const corrupt = join(directory, "corrupt.sqlite");
    await writeFile(corrupt, "not sqlite");
    expect(() => new Store(corrupt, undefined, true)).toThrow(
      expect.objectContaining({ code: "storage_failed" }),
    );
    for (const version of [0, 1, 3]) {
      const path = join(directory, `v${version}.sqlite`);
      const db = new DatabaseSync(path);
      db.exec(`PRAGMA user_version=${version}`);
      db.close();
      const before = await readFile(path);
      expect(() => new Store(path, undefined, true)).toThrow(
        expect.objectContaining({ code: "storage_schema_unsupported" }),
      );
      expect(await readFile(path)).toEqual(before);
    }
    const store = new Store(join(directory, "bad-body.sqlite"));
    store.createSession("agent", directory, "profile");
    store.close();
    const db = new DatabaseSync(join(directory, "bad-body.sqlite"));
    db.exec("UPDATE sessions SET body='{}'");
    db.close();
    expect(
      () => new Store(join(directory, "bad-body.sqlite"), undefined, true),
    ).toThrow(expect.objectContaining({ code: "storage_corrupt" }));
  });
});

describe("native managed service processes", () => {
  it("reports initialization failures and does not invent a replacement cancellation owner", async () => {
    const { config, file, directory } = await fixture();
    config.agents[0]!.env = {
      SECRET: { source: "file", path: join(directory, "missing-secret") },
    };
    await writeFile(file, stringify(config));
    await expect(
      command([
        "sessions",
        "create",
        "--config",
        file,
        "--agent",
        "copilot",
        "--working-directory",
        directory,
      ]),
    ).rejects.toMatchObject({ stderr: "credential unavailable\n" });
    await released(config.dataDir);
    const store = new Store(join(config.dataDir, "sessions.sqlite"));
    const session = store.createSession("copilot", directory, "profile");
    const turn = store.admitTurn(session.sessionId, randomUUID(), "HOLD").turn;
    store.setTurnState(session.sessionId, turn.turnId, "starting");
    store.setTurnState(session.sessionId, turn.turnId, "dispatching");
    store.setTurnState(session.sessionId, turn.turnId, "running");
    store.close();
    const before = await readFile(join(config.dataDir, "sessions.sqlite"));
    await expect(
      command([
        "turns",
        "cancel",
        "--config",
        file,
        "--session",
        session.sessionId,
        "--turn",
        turn.turnId,
      ]),
    ).rejects.toMatchObject({ stderr: "local work owner unavailable\n" });
    expect(await readFile(join(config.dataDir, "sessions.sqlite"))).toEqual(
      before,
    );
    await expect(
      stat(join(config.dataDir, "owner.lock")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  }, 15000);
  it("concurrent caller processes reuse one writer, survive caller exit, expire and restart", async () => {
    const { file, config, directory } = await fixture();
    const args = [
      "sessions",
      "create",
      "--config",
      file,
      "--idle-grace-ms",
      "1500",
      "--agent",
      "copilot",
      "--working-directory",
      directory,
    ];
    cleanups.push(() => released(config.dataDir));
    const values = await Promise.all(
      Array.from({ length: 5 }, () => command(args)),
    );
    expect(
      new Set(values.map((value) => (value as { sessionId: string }).sessionId))
        .size,
    ).toBe(5);
    const firstOwner = await readOwner(await canonicalDataDir(config.dataDir));
    expect(firstOwner).not.toBeNull();
    await expect(stat(join(directory, "counter"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    // All callers have exited; the independently owned service still holds the lease.
    expect((await stat(join(config.dataDir, "owner.lock"))).isFile()).toBe(
      true,
    );
    const created = Date.now();
    await released(config.dataDir);
    const elapsed = Date.now() - created;
    idleMeasurements.push(elapsed);
    expect(elapsed).toBeGreaterThan(1000);
    expect(elapsed).toBeLessThan(6000);
    expect(await readOwner(await canonicalDataDir(config.dataDir))).toBeNull();
    const list = (await command(["sessions", "list", "--config", file])) as {
      items: unknown[];
    };
    expect(list.items).toHaveLength(5);
    await command(args);
    const restarted = await readOwner(await canonicalDataDir(config.dataDir));
    expect(restarted?.token).not.toBe(firstOwner?.token);
    await released(config.dataDir);
  }, 25000);

  it("a prompt longer than idle grace stays owned, cancellation is real, restart loads without replay", async () => {
    const { file, config, directory } = await fixture();
    const prompt = join(directory, "prompt.txt");
    await writeFile(prompt, "HOLD");
    const create = [
      "sessions",
      "create",
      "--config",
      file,
      "--idle-grace-ms",
      "1500",
      "--agent",
      "copilot",
      "--working-directory",
      directory,
    ];
    cleanups.push(() => released(config.dataDir));
    const session = (await command(create)) as { sessionId: string };
    const turnId = randomUUID();
    await command([
      "turns",
      "start",
      "--config",
      file,
      "--idle-grace-ms",
      "1500",
      "--session",
      session.sessionId,
      "--turn",
      turnId,
      "--text-file",
      prompt,
    ]);
    await until(async () => {
      const value = (await command([
        "turns",
        "get",
        "--config",
        file,
        "--session",
        session.sessionId,
        "--turn",
        turnId,
      ])) as { state: string };
      return value.state === "running";
    });
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect((await stat(join(config.dataDir, "owner.lock"))).isFile()).toBe(
      true,
    );
    await command([
      "turns",
      "cancel",
      "--config",
      file,
      "--session",
      session.sessionId,
      "--turn",
      turnId,
    ]);
    await until(async () => {
      const value = (await command([
        "turns",
        "get",
        "--config",
        file,
        "--session",
        session.sessionId,
        "--turn",
        turnId,
      ])) as { state: string };
      return value.state === "cancelled";
    });
    const completedAt = Date.now();
    await released(config.dataDir);
    idleMeasurements.push(Date.now() - completedAt);
    await expect(
      command([
        "turns",
        "cancel",
        "--config",
        file,
        "--session",
        session.sessionId,
        "--turn",
        turnId,
      ]),
    ).rejects.toMatchObject({
      stderr: "local work owner unavailable\n",
    });
    await writeFile(prompt, "OK");
    const nextTurn = randomUUID();
    await command([
      "turns",
      "start",
      "--config",
      file,
      "--idle-grace-ms",
      "1500",
      "--session",
      session.sessionId,
      "--turn",
      nextTurn,
      "--text-file",
      prompt,
    ]);
    await until(async () => {
      const value = (await command([
        "turns",
        "get",
        "--config",
        file,
        "--session",
        session.sessionId,
        "--turn",
        nextTurn,
      ])) as { state: string; response: string };
      if (value.state !== "complete") return false;
      expect(value.response).toBe("OK");
      return true;
    });
    await released(config.dataDir);
    const events = (await command([
      "events",
      "list",
      "--config",
      file,
      "--session",
      session.sessionId,
    ])) as { items: { source: string; turnId: string | null }[] };
    expect(
      events.items.some(
        (event) => event.source === "replay" && event.turnId === null,
      ),
    ).toBe(true);
    expect(
      (await readFile(join(directory, "counter"), "utf8")).trim().split("\n"),
    ).toHaveLength(2);
    await expect(
      stat(join(directory, "profile", ".ahplex-acp-owner.lock")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  }, 30000);

  it("explicit URLs never spawn; explicit serve is persistent and can be reused locally", async () => {
    const { file, config, directory } = await fixture();
    await expect(
      command([
        "sessions",
        "create",
        "--url",
        "http://127.0.0.1:1/v2",
        "--config",
        file,
        "--agent",
        "copilot",
        "--working-directory",
        directory,
      ]),
    ).rejects.toMatchObject({
      stderr: "fetch failed\n",
    });
    await expect(stat(config.dataDir)).rejects.toMatchObject({
      code: "ENOENT",
    });
    const child = spawn(process.execPath, [cli, "serve", "--config", file], {
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    const closed = new Promise<void>((resolve) => {
      child.once("exit", () => {
        resolve();
      });
    });
    cleanups.push(async () => {
      child.kill("SIGTERM");
      await closed;
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    await until(() => output.includes("listening at"));
    await new Promise((resolve) => setTimeout(resolve, 1800));
    expect(child.exitCode).toBeNull();
    const session = await command([
      "sessions",
      "create",
      "--config",
      file,
      "--idle-grace-ms",
      "100",
      "--agent",
      "copilot",
      "--working-directory",
      directory,
    ]);
    expect(session).toHaveProperty("sessionId");
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(child.exitCode).toBeNull();
    // Explicit URL remains ordinary unauthenticated HTTP for a persistent serve.
    const address = /listening at (\S+)/u.exec(output)?.[1] ?? "";
    expect((await fetch(address + "/sessions")).status).toBe(200);
  }, 15000);

  it("different data directories do not share discovery or metadata", async () => {
    const first = await fixture();
    const second = await fixture();
    for (const value of [first, second])
      cleanups.push(() => released(value.config.dataDir));
    await Promise.all(
      [first, second].map(({ file, directory }) =>
        command([
          "sessions",
          "create",
          "--config",
          file,
          "--idle-grace-ms",
          "1500",
          "--agent",
          "copilot",
          "--working-directory",
          directory,
        ]),
      ),
    );
    const a = await readOwner(await canonicalDataDir(first.config.dataDir));
    const b = await readOwner(await canonicalDataDir(second.config.dataDir));
    expect(a?.url).not.toBe(b?.url);
    expect(a?.token).not.toBe(b?.token);
  }, 15000);
});

describe("discovery and idle admission safety", () => {
  it("keeps a pending authentication flow alive beyond idle grace before clean release", async () => {
    const { config } = await fixture();
    const service = await Service.create(config);
    const runtime = service.agents.get("copilot")!.runtime;
    let finishLogin: (() => void) | undefined;
    const login = new Promise<void>((resolve) => {
      finishLogin = resolve;
    });
    vi.spyOn(runtime, "authenticate").mockImplementation(() => login);
    const http = await serve(service, 400);
    cleanups.push(() => http.close());
    const flow = service.beginAuth("copilot", "sign-in");
    await new Promise((resolve) => setTimeout(resolve, 1600));
    expect(flow.status).toBe("pending");
    expect((await stat(join(config.dataDir, "owner.lock"))).isFile()).toBe(
      true,
    );
    finishLogin?.();
    await released(config.dataDir);
    expect(flow.status).toBe("succeeded");
  }, 15000);

  it("persists unknown before idle cleanup and never replays it on service restart", async () => {
    const { config, directory } = await fixture();
    const service = await Service.create(config);
    const http = await serve(service, 400);
    cleanups.push(() => http.close());
    const session = await service.createSession("copilot", directory);
    const turnId = randomUUID();
    await service.submit(session.sessionId, turnId, "DISCONNECT");
    await until(
      () =>
        service.store.getTurn(session.sessionId, turnId).state === "unknown",
    );
    await released(config.dataDir);
    const restart = await Service.create(config);
    cleanups.push(() => restart.close());
    expect(restart.store.getTurn(session.sessionId, turnId).state).toBe(
      "unknown",
    );
    await expect(
      restart.submit(session.sessionId, randomUUID(), "OK"),
    ).rejects.toMatchObject({ code: "turn_outcome_unknown" });
    expect(
      (await readFile(join(directory, "counter"), "utf8")).trim().split("\n"),
    ).toHaveLength(1);
  }, 15000);
  it("proves private ownership, rejects unsigned/replayed requests and safely removes discovery", async () => {
    const { config, directory } = await fixture();
    const http = await startManaged(config, 1000);
    cleanups.push(() => http.close());
    const dataDir = await canonicalDataDir(config.dataDir);
    const owner = await readOwner(dataDir);
    expect(owner).not.toBeNull();
    expect(await localService(config, "unused", 1000, false)).toEqual(owner);
    const challenge = randomBytes(32).toString("hex");
    const identity = await fetch(http.url + "/local-owner", {
      headers: { "x-acplus-challenge": challenge },
    });
    expect(await identity.json()).toEqual({
      dataDir,
      proof: proof(owner!.token, challenge),
    });
    expect((await fetch(http.url + "/local-owner")).status).toBe(403);
    expect((await fetch(http.url + "/sessions")).status).toBe(403);
    const headers = localHeaders(owner!, "GET", "/v2/sessions");
    expect((await fetch(http.url + "/sessions", { headers })).status).toBe(200);
    expect((await fetch(http.url + "/sessions", { headers })).status).toBe(403);
    expect(
      (
        await fetch(http.url + "/sessions", {
          headers: {
            ...headers,
            "x-acplus-nonce": "bad",
          },
        })
      ).status,
    ).toBe(403);
    expect(verifies("bad", proof(owner!.token, challenge))).toBe(false);
    expect(verifies(undefined, proof(owner!.token, challenge))).toBe(false);
    expect(verifies("0".repeat(64), proof(owner!.token, challenge))).toBe(
      false,
    );
    await http.close();
    expect(await readOwner(dataDir)).toBeNull();
    await expect(
      localService(config, "unused", 1000, false),
    ).rejects.toMatchObject({ code: "local_work_owner_unavailable" });
    const path = join(dataDir, "service.json");
    await publishOwner(dataDir, "http://127.0.0.1:1234/v2");
    for (const value of [
      "bad",
      "{}",
      JSON.stringify({ dataDir, url: "http://evil/v2", token: "0".repeat(64) }),
    ]) {
      await writeFile(path, value, { mode: 0o600 });
      await expect(readOwner(dataDir)).rejects.toMatchObject({
        code: "local_discovery_invalid",
      });
    }
    await rm(path);
    const published = await publishOwner(dataDir, "http://127.0.0.1:1234/v2");
    await writeFile(
      path,
      JSON.stringify({ ...published.value, token: "1".repeat(64) }),
    );
    await expect(published.release()).rejects.toMatchObject({
      code: "local_discovery_changed",
    });
    await rm(path);
    await expect(stat(join(directory, "counter"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  }, 15000);

  it("does not expire during a delayed admitted request, even if its caller disconnects", async () => {
    const { config, directory } = await fixture();
    const service = await Service.create(config);
    const create = service.createSession.bind(service);
    let unblock: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const createMock = vi
      .spyOn(service, "createSession")
      .mockImplementation(async (...args) => {
        await blocked;
        return create(...args);
      });
    const http = await serve(service, 300);
    cleanups.push(() => http.close());
    const owner = await readOwner(await canonicalDataDir(config.dataDir));
    const controller = new AbortController();
    const request = fetch(http.url + "/sessions", {
      method: "POST",
      headers: {
        ...localHeaders(owner!, "POST", "/v2/sessions"),
        "content-type": "application/json",
      },
      body: JSON.stringify({ agentId: "copilot", workingDirectory: directory }),
      signal: controller.signal,
    }).catch(() => undefined);
    await until(() => createMock.mock.calls.length === 1);
    controller.abort();
    await request;
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect((await stat(join(config.dataDir, "owner.lock"))).isFile()).toBe(
      true,
    );
    unblock?.();
    await released(config.dataDir);
    const reader = new Store(
      join(config.dataDir, "sessions.sqlite"),
      undefined,
      true,
    );
    expect(reader.listSessions({ limit: 10 }).items).toHaveLength(1);
    reader.close();
  }, 15000);

  it("retains ownership if a foreign writer lease replaces its coordination file", async () => {
    const { directory } = await fixture();
    const release = await lockDirectory(directory);
    await writeFile(join(directory, "owner.lock"), "foreign");
    await expect(release()).rejects.toMatchObject({
      code: "data_directory_lease_changed",
    });
    expect(await readFile(join(directory, "owner.lock"), "utf8")).toBe(
      "foreign",
    );
  });
});
