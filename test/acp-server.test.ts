import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { record, text } from "../src/acp-common.js";
import { Service } from "../src/acp-service.js";
import { serve } from "../src/acp-server.js";
import { fixtureConfig } from "./acp-fixture.js";
import type { Config } from "../src/acp-types.js";

const roots: string[] = [];
const servers: { url: string; close(): Promise<void> }[] = [];
async function setup(configure?: (config: Config) => void) {
  const root = await mkdtemp(join(tmpdir(), "acplus-http-"));
  roots.push(root);
  const config = fixtureConfig(root);
  configure?.(config);
  const service = await Service.create(config);
  const server = await serve(service);
  servers.push(server);
  return { root, config, service, server };
}
async function api(url: string, path: string, method = "GET", value?: unknown) {
  const response = await fetch(url + path, {
    method,
    ...(value === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(value),
        }),
  });
  const raw = await response.text();
  const body: unknown = raw === "" ? null : JSON.parse(raw);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return { status: response.status, body };
}
function object(value: unknown): Record<string, unknown> {
  if (!record(value)) throw new Error("Expected object response");
  return value;
}
async function session(url: string, root: string) {
  const result = await api(url, "/sessions", "POST", {
    agentId: "copilot",
    workingDirectory: root,
  });
  expect(result.status).toBe(201);
  expect(result.body).not.toHaveProperty("backendSessionId");
  expect(result.body).not.toHaveProperty("profileIdentity");
  return text(object(result.body).sessionId, "sessionId");
}
async function turn(
  url: string,
  id: string,
  turnId: string,
  state = "complete",
) {
  const end = Date.now() + 10000;
  for (;;) {
    const result = await api(url, `/sessions/${id}/turns/${turnId}`);
    const data = object(result.body);
    if (data.state === state) return data;
    if (Date.now() > end || data.state === "error" || data.state === "unknown")
      throw new Error(JSON.stringify(data));
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("durable ACP HTTP /v2", () => {
  it("deletes committed Session history with explicit busy and missing errors", async () => {
    const { root, service, server } = await setup();
    const id = await session(server.url, root);
    const turnId = randomUUID();
    service.store.admitTurn(id, turnId, "pending");
    expect((await api(server.url, `/sessions/${id}`, "DELETE")).status).toBe(
      409,
    );
    service.store.setTurnState(id, turnId, "cancelled");
    expect(
      (await api(server.url, `/sessions/${id}?unexpected=x`, "DELETE")).status,
    ).toBe(400);
    expect((await api(server.url, `/sessions/${id}`, "DELETE")).status).toBe(
      204,
    );
    expect((await api(server.url, `/sessions/${id}`)).status).toBe(404);
    expect((await api(server.url, `/sessions/${id}/turns`)).status).toBe(404);
    expect((await api(server.url, `/sessions/${id}/events`)).status).toBe(404);
    expect((await api(server.url, `/sessions/${id}`, "DELETE")).status).toBe(
      404,
    );
  });
  it("creates local Sessions and serves all reads when the executable is unavailable", async () => {
    const { root, server } = await setup((config) => {
      config.agents[0]!.command = join(tmpdir(), "missing-copilot");
    });
    const url = server.url;
    expect((await api(url, "/health")).status).toBe(204);
    expect((await api(url, "/agents")).status).toBe(200);
    expect((await api(url, "/agents/copilot/auth")).status).toBe(200);
    const id = await session(url, root);
    expect((await api(url, "/sessions")).status).toBe(200);
    expect((await api(url, `/sessions/${id}`)).body).toMatchObject({
      backendBound: false,
    });
    expect((await api(url, `/sessions/${id}/turns`)).body).toMatchObject({
      items: [],
    });
    expect((await api(url, `/sessions/${id}/events`)).body).toMatchObject({
      items: [],
    });
    await expect(readFile(join(root, "counter"), "utf8")).rejects.toMatchObject(
      { code: "ENOENT" },
    );
  });
  it("runs a prompt, persists tool events and returns scoped filtered pages", async () => {
    const { root, server, service } = await setup();
    const id = await session(server.url, root);
    const first = randomUUID();
    const second = randomUUID();
    expect(
      (
        await api(server.url, `/sessions/${id}/turns`, "POST", {
          turnId: first,
          text: "fixture-secret-value",
        })
      ).status,
    ).toBe(202);
    expect(await turn(server.url, id, first)).toMatchObject({
      response: "OK",
      text: "[redacted]",
      state: "complete",
    });
    expect(
      (
        await api(server.url, `/sessions/${id}/turns`, "POST", {
          turnId: second,
          text: "OK",
        })
      ).status,
    ).toBe(202);
    await turn(server.url, id, second);
    service.store.appendEvent(id, null, "session_notice", {
      text: "not assigned",
    });
    const page = await api(
      server.url,
      `/sessions/${id}/events?turnId=${first}&limit=1`,
    );
    const firstPage = object(page.body);
    expect(firstPage.items).toHaveLength(1);
    const items = firstPage.items;
    if (!Array.isArray(items)) throw new Error("Expected events");
    expect(items[0]).toMatchObject({ turnId: first });
    const all = await api(
      server.url,
      `/sessions/${id}/events?turnId=${first}&limit=1000`,
    );
    expect(JSON.stringify(all.body)).toContain("tool_call_update");
    expect(JSON.stringify(all.body)).not.toContain("fixture-secret-value");
    expect(JSON.stringify(all.body)).not.toContain("not assigned");
    const duplicate = await api(server.url, `/sessions/${id}/turns`, "POST", {
      turnId: first,
      text: "fixture-secret-value",
    });
    expect(duplicate.status).toBe(202);
    expect(duplicate.body).toMatchObject({ state: "complete" });
    expect(
      (
        await api(server.url, `/sessions/${id}/turns`, "POST", {
          turnId: first,
          text: "changed",
        })
      ).status,
    ).toBe(409);
    expect(
      (await readFile(join(root, "counter"), "utf8")).trim().split("\n"),
    ).toHaveLength(1);
    expect(
      (await api(server.url, `/sessions/${id}/turns?limit=1`)).body,
    ).toHaveProperty("nextCursor");
    expect(
      (await api(server.url, `/sessions?agentId=copilot&limit=1`)).status,
    ).toBe(200);
  });
  it("rejects busy work and cancels the exact pending prompt", async () => {
    const { root, server } = await setup();
    const id = await session(server.url, root);
    const pending = randomUUID();
    await api(server.url, `/sessions/${id}/turns`, "POST", {
      turnId: pending,
      text: "HOLD",
    });
    await turn(server.url, id, pending, "running");
    expect(
      (
        await api(server.url, `/sessions/${id}/turns`, "POST", {
          turnId: randomUUID(),
          text: "other",
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await api(server.url, "/agents/copilot/auth", "POST", {
          methodId: "sign-in",
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await api(
          server.url,
          `/sessions/${id}/turns/${pending}/cancel`,
          "POST",
          {},
        )
      ).status,
    ).toBe(202);
    await turn(server.url, id, pending, "cancelled");
    expect(
      (
        await api(
          server.url,
          `/sessions/${id}/turns/${pending}/cancel`,
          "POST",
          {},
        )
      ).status,
    ).toBe(202);
  });
  it("survives restart, loads the same backend and isolates replay from a new Turn", async () => {
    const { root, config, server } = await setup();
    const id = await session(server.url, root);
    const first = randomUUID();
    await api(server.url, `/sessions/${id}/turns`, "POST", {
      turnId: first,
      text: "OK",
    });
    await turn(server.url, id, first);
    await server.close();
    const service = await Service.create(config);
    const next = await serve(service);
    servers.push(next);
    expect(
      (await api(next.url, `/sessions/${id}/turns/${first}`)).body,
    ).toMatchObject({ response: "OK" });
    expect((await api(next.url, "/agents/copilot/auth")).body).toMatchObject({
      freshness: "stale",
    });
    expect(
      (await readFile(join(root, "counter"), "utf8")).trim().split("\n"),
    ).toHaveLength(1);
    const second = randomUUID();
    await api(next.url, `/sessions/${id}/turns`, "POST", {
      turnId: second,
      text: "OK",
    });
    expect(await turn(next.url, id, second)).toMatchObject({ response: "OK" });
    const filtered = await api(
      next.url,
      `/sessions/${id}/events?turnId=${second}`,
    );
    expect(JSON.stringify(filtered.body)).not.toContain("PAST");
    expect(
      JSON.stringify((await api(next.url, `/sessions/${id}/events`)).body),
    ).toContain("replay");
  });
  it("preserves history and reports unsupported backend recovery", async () => {
    const { root, config, server } = await setup((cfg) => {
      cfg.agents[0]!.env.NO_LOAD = "1";
    });
    const id = await session(server.url, root);
    const first = randomUUID();
    await api(server.url, `/sessions/${id}/turns`, "POST", {
      turnId: first,
      text: "OK",
    });
    await turn(server.url, id, first);
    await server.close();
    const next = await serve(await Service.create(config));
    servers.push(next);
    const second = randomUUID();
    await api(next.url, `/sessions/${id}/turns`, "POST", {
      turnId: second,
      text: "OK",
    });
    const end = Date.now() + 10000;
    for (;;) {
      const result = await api(next.url, `/sessions/${id}/turns/${second}`);
      if (object(result.body).state === "error") {
        expect(result.body).toMatchObject({
          error: { code: "session_resume_unsupported" },
        });
        break;
      }
      if (Date.now() > end) throw new Error("Recovery error timeout");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(
      (await api(next.url, `/sessions/${id}/turns/${first}`)).body,
    ).toMatchObject({ response: "OK" });
  });
  it("bridges explicit auth and caches only public observations", async () => {
    const { server } = await setup();
    expect(
      (
        await api(server.url, "/agents/copilot/auth", "POST", {
          methodId: "sign-in",
        })
      ).status,
    ).toBe(202);
    const end = Date.now() + 10000;
    for (;;) {
      const auth = await api(server.url, "/agents/copilot/auth");
      if (object(object(auth.body).flow).status === "succeeded") {
        expect(auth.body).toMatchObject({
          lastKnownStatus: "authenticated",
          freshness: "current",
        });
        break;
      }
      if (Date.now() > end) throw new Error("Login timeout");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(
      (
        await api(server.url, "/agents/copilot/auth/input", "POST", {
          stepId: randomUUID(),
          values: { password: "secret" },
        })
      ).status,
    ).toBe(400);
    expect(
      (await api(server.url, "/agents/copilot/auth/logout", "POST", {})).status,
    ).toBe(202);
    expect((await api(server.url, "/agents/copilot/auth")).body).toMatchObject({
      lastKnownStatus: "required",
    });
  });
  it("rejects malformed routes, queries, input, and cross-session event filters", async () => {
    const { root, server } = await setup();
    const id = await session(server.url, root);
    for (const path of [
      "/health?bad=1",
      "/sessions?limit=0",
      "/sessions?limit=x",
      "/sessions?limit=1001",
      `/sessions/${id}/events?turnId=`,
      `/sessions/${id}/events?turnId=${randomUUID()}&turnId=${randomUUID()}`,
      `/sessions/${id}/events?after=-1`,
      "/sessions/not-uuid",
      "/agents/%zz/auth",
    ]) {
      expect((await api(server.url, path)).status).toBe(400);
    }
    expect((await api(server.url, "/v1/hosts")).status).toBe(404);
    expect((await api(server.url, "/agents/missing/auth")).status).toBe(404);
    expect(
      (await api(server.url, `/sessions/${id}/events?turnId=${randomUUID()}`))
        .status,
    ).toBe(404);
    expect(
      (
        await api(server.url, "/sessions", "POST", {
          agentId: "copilot",
          workingDirectory: root,
          command: "bad",
        })
      ).status,
    ).toBe(400);
    const badContent = await fetch(server.url + "/sessions", {
      method: "POST",
      body: "{}",
    });
    expect(badContent.status).toBe(400);
    expect((await api(server.url, "/sessions", "POST", ["bad"])).status).toBe(
      400,
    );
    expect(
      (
        await api(server.url, `/sessions/${id}/turns`, "POST", {
          turnId: randomUUID(),
          text: "x".repeat(1048576),
        })
      ).status,
    ).toBe(400);
    expect(
      (await api(server.url, `/sessions/${id}/events/nope`, "POST", {})).status,
    ).toBe(400);
  });
});
