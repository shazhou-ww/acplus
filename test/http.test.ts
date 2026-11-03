import { createServer, get } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { HttpAdapter, type Adapter } from "../src/adapter.js";
import { serveHub } from "../src/server.js";
import { TaskManager } from "../src/tasks.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
});

async function setup(token?: string): Promise<string> {
  const adapter: Adapter = {
    call: async (name) => {
      await Promise.resolve();
      if (name === "new_session") return { session: "provider:/1" };
      if (name === "list_agents") return [{ provider: "test" }];
      if (name === "list_sessions") return [];
      if (name === "hub_start_turn") return {};
      if (name === "session_history") return { turns: [] };
      throw new Error("unexpected fixture call");
    },
  };
  const manager = new TaskManager(adapter, 1);
  const server = await serveHub(manager, {
    port: 0,
    ...(token === undefined ? {} : { token }),
  });
  cleanup.push(() => server.close());
  return server.url;
}

const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("resource API over real HTTP sockets", () => {
  it("serves health, agents, creates sessions and returns a traceable task immediately", async () => {
    const url = await setup();
    expect((await fetch(`${url}/health`)).status).toBe(200);
    expect((await fetch(`${url}/agents`)).status).toBe(200);
    const created = await fetch(
      `${url}/sessions`,
      post({ provider: "test", workingDirectory: "C:\\demo" }),
    );
    expect(created.status).toBe(201);
    const submitted = await fetch(
      `${url}/sessions/provider%3A%2F1/tasks`,
      post({ text: "hello" }),
    );
    expect(submitted.status).toBe(202);
    const task = (await submitted.json()) as { taskId: string };
    expect((await fetch(`${url}/tasks/${task.taskId}`)).status).toBe(200);
    const wait = await fetch(`${url}/tasks/${task.taskId}/wait?timeoutMs=1`);
    expect(wait.status).toBe(408);
    expect(((await wait.json()) as { timedOut: boolean }).timedOut).toBe(true);
    expect(
      (await fetch(`${url}/tasks/${task.taskId}/cancel`, { method: "POST" }))
        .status,
    ).toBe(202);
    const sessions = await fetch(`${url}/sessions`);
    expect(sessions.status).toBe(200);
  });

  it("rejects browser requests, rebinding, unknown routes, invalid JSON and timeouts", async () => {
    const url = await setup();
    expect(
      (
        await fetch(`${url}/health`, {
          headers: { origin: "https://evil.example" },
        })
      ).status,
    ).toBe(403);
    const rebinding = await new Promise<number | undefined>(
      (resolve, reject) => {
        get(
          `${url}/health`,
          { headers: { host: "evil.example" } },
          (response) => {
            response.resume();
            resolve(response.statusCode);
          },
        ).once("error", reject);
      },
    );
    expect(rebinding).toBe(403);
    expect((await fetch(`${url}/missing`)).status).toBe(404);
    expect((await fetch(`${url}/tasks/missing/other`)).status).toBe(404);
    expect((await fetch(`${url}/tasks/missing/wait?timeoutMs=-1`)).status).toBe(
      400,
    );
    expect(
      (await fetch(`${url}/tasks/missing/wait?timeoutMs=NaN`)).status,
    ).toBe(400);
    expect(
      (await fetch(`${url}/sessions`, { method: "POST", body: "{}" })).status,
    ).toBe(415);
    expect(
      (
        await fetch(`${url}/sessions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{",
        })
      ).status,
    ).toBe(400);
    expect((await fetch(`${url}/sessions`, post([]))).status).toBe(400);
    expect(
      (
        await fetch(
          `${url}/sessions`,
          post({ provider: "x", workingDirectory: "relative" }),
        )
      ).status,
    ).toBe(400);
  });

  it("requires only explicitly configured API credentials", async () => {
    const url = await setup("test-secret");
    expect((await fetch(`${url}/health`)).status).toBe(401);
    expect(
      (
        await fetch(`${url}/health`, {
          headers: { authorization: "Bearer wrong" },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${url}/health`, {
          headers: { authorization: "Bearer test-secret" },
        })
      ).status,
    ).toBe(200);
  });

  it("returns explicit errors for oversized bodies, malformed resource IDs and unavailable health", async () => {
    const url = await setup();
    expect(
      (await fetch(`${url}/sessions`, post({ text: "x".repeat(1_000_001) })))
        .status,
    ).toBe(413);
    expect((await fetch(`${url}/tasks/%FF`)).status).toBe(400);
    expect((await fetch(`${url}/tasks/x/wait?timeoutMs=120001`)).status).toBe(
      400,
    );
    const server = await serveHub(
      new TaskManager({ call: () => Promise.resolve([]) }),
      {
        port: 0,
        secrets: ["fixture-secret"],
        health: () => ({ status: "unavailable", detail: "fixture-secret" }),
      },
    );
    cleanup.push(() => server.close());
    const response = await fetch(`${server.url}/health`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      status: "unavailable",
      detail: "[redacted]",
    });
  });
});

describe("ahpc HTTP normalization", () => {
  it("preserves safe backend capability/auth/connection errors and rejects invalid bridge JSON", async () => {
    const cases = [
      ["backend_capability_unsupported", 501],
      ["backend_authentication_required", 401],
      ["host_unavailable", 503],
      ["session_refused", 502],
      ["session_unavailable", 502],
      ["session_busy", 502],
      ["backend_request_failed", 502],
      ["invalid_json", 502],
    ] as const;
    let index = 0;
    const backend = createServer((_request, response) => {
      response.writeHead(500);
      const code = cases[index++]?.[0];
      response.end(
        code === "invalid_json" ? "{" : JSON.stringify({ error: code }),
      );
    });
    await new Promise<void>((resolve) =>
      backend.listen(0, "127.0.0.1", resolve),
    );
    cleanup.push(
      () =>
        new Promise<void>((resolve) => {
          backend.close(() => {
            resolve();
          });
        }),
    );
    const client = new HttpAdapter(
      `http://127.0.0.1:${(backend.address() as AddressInfo).port}`,
      "fixture",
    );
    for (const [code, status] of cases)
      await expect(client.call("test", {})).rejects.toMatchObject({
        code: code === "invalid_json" ? "adapter_invalid_response" : code,
        status,
      });
  });
  it("reports transport failure explicitly", async () => {
    await expect(
      new HttpAdapter("http://127.0.0.1:1", "fixture").call("test", {}),
    ).rejects.toMatchObject({ code: "adapter_unavailable" });
  });
  it.each([
    [{ session: "x" }, { session: "x" }],
    [{ result: [{ session: "x" }] }, [{ session: "x" }]],
    [[{ session: "x" }], [{ session: "x" }]],
  ])("normalizes the verified response shapes", async (value, expected) => {
    const backend = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(value));
    });
    await new Promise<void>((resolve) => {
      backend.listen(0, "127.0.0.1", resolve);
    });
    cleanup.push(
      () =>
        new Promise<void>((resolve) => {
          backend.close(() => {
            resolve();
          });
        }),
    );
    const client = new HttpAdapter(
      `http://127.0.0.1:${(backend.address() as AddressInfo).port}`,
      "test",
    );
    expect(await client.call("list_sessions", {})).toEqual(expected);
  });

  it.each([401, 400, 500])(
    "surfaces backend errors without leaking response credentials (%s)",
    async (status) => {
      const backend = createServer((_request, response) => {
        response.writeHead(status);
        response.end(
          JSON.stringify({
            error:
              status === 400
                ? "backend_authentication_required"
                : "private token",
          }),
        );
      });
      await new Promise<void>((resolve) => {
        backend.listen(0, "127.0.0.1", resolve);
      });
      cleanup.push(
        () =>
          new Promise<void>((resolve) => {
            backend.close(() => {
              resolve();
            });
          }),
      );
      const client = new HttpAdapter(
        `http://127.0.0.1:${(backend.address() as AddressInfo).port}`,
        "test",
      );
      await expect(client.call("test", {})).rejects.toMatchObject({
        code:
          status === 500
            ? "adapter_request_failed"
            : status === 400
              ? "backend_authentication_required"
              : "auth_required",
      });
    },
  );
});
