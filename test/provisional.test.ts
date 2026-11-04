import { afterEach, expect, it } from "vitest";
import { SessionLifecycle } from "@microsoft/agent-host-protocol";
import { config, eventually, harness, resource } from "./fixture.js";

let app: Awaited<ReturnType<typeof harness>> | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

it("confirms provisional allocation without sending a turn or waiting for backend materialization", async () => {
  app = await harness(config(["a"]));
  const host = app.host();
  host.createdLifecycle = SessionLifecycle.Creating;
  host.hiddenCreated = true;
  const created = await app.api("/hosts/a/sessions", "POST", {
    provider: "test-provider",
    workingDirectories: ["file:///D:/work"],
  });
  expect(created.status).toBe(201);
  const session = resource(created.body);
  expect(host.session(session).lifecycle).toBe(SessionLifecycle.Creating);
  const catalogue = await app.api(
    `/hosts/a/chats?${new URLSearchParams({ session }).toString()}`,
  );
  expect(catalogue.status).toBe(200);
  expect(catalogue.body).toHaveProperty(
    "defaultChat",
    host.session(session).defaultChat,
  );
  expect((await app.api("/hosts/a/sessions")).body).toContainEqual({
    resource: session,
    title: "Context",
    provider: "test-provider",
  });
  expect((await app.api("/hosts/a/chats", "POST", { session })).status).toBe(
    201,
  );
  expect(host.requests.some(({ method }) => method === "dispatchAction")).toBe(
    false,
  );
  expect((await app.api("/hosts/a/stop", "POST")).status).toBe(202);
  await eventually(() => app?.service.select("a").native.status === "idle");
});
