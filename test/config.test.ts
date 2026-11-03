import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, validateConfig } from "../src/config.js";

const paths: string[] = [];
afterEach(async () => {
  for (const path of paths.splice(0))
    await rm(path, { recursive: true, force: true });
});

function service(): Record<string, unknown> {
  return {
    id: "one",
    kind: "ahp-websocket",
    endpoint: { registry: true },
    startupTimeoutMs: 1000,
    lifecycle: "owned",
    launch: {
      executable: "native-executable",
      args: ["--literal", "space argument"],
      cwd: process.cwd(),
      environment: { mode: "inherited", inherit: [], values: {} },
    },
  };
}
const candidate = (row = service()): unknown => ({
  version: 1,
  services: [row],
});

describe("strict versioned service configuration", () => {
  it("accepts explicit launch context and attachments without requiring provider credentials", () => {
    expect(validateConfig(candidate()).services[0]).toMatchObject({
      id: "one",
      launch: { args: ["--literal", "space argument"] },
    });
    expect(
      validateConfig({
        version: 1,
        services: [
          {
            id: "external",
            kind: "ahp-websocket",
            lifecycle: "attached",
            startupTimeoutMs: 50,
            endpoint: {
              url: "ws://localhost:4321",
              tokenEnv: "SERVICE_CONNECTION_TOKEN",
            },
          },
        ],
      }).services[0]?.endpoint,
    ).toEqual({
      url: "ws://localhost:4321/",
      tokenEnv: "SERVICE_CONNECTION_TOKEN",
    });
    const raw = service();
    raw.launch = {
      ...(raw.launch as Record<string, unknown>),
      args: ['{"providerOption":true}'],
    };
    expect(validateConfig(candidate(raw)).services[0]?.launch?.args).toEqual([
      '{"providerOption":true}',
    ]);
  });

  it.each([
    [undefined, "invalid_object"],
    [{ version: 2, services: [service()] }, "invalid_service_configuration"],
    [{ version: 1, services: [] }, "invalid_service_configuration"],
    [{ version: 1, services: "one" }, "invalid_service_configuration"],
    [
      { version: 1, services: [service()], unexpected: true },
      "unknown_configuration_field",
    ],
    [{ version: 1, services: [service(), service()] }, "duplicate_service_id"],
    [candidate({ ...service(), id: "../escape" }), "invalid_instance"],
    [candidate({ ...service(), kind: "acp-stdio" }), "unsupported_bridge_kind"],
    [candidate({ ...service(), typo: true }), "unknown_configuration_field"],
    [
      candidate({ ...service(), startupTimeoutMs: 0 }),
      "invalid_startup_timeout",
    ],
    [
      candidate({ ...service(), startupTimeoutMs: 300001 }),
      "invalid_startup_timeout",
    ],
    [
      candidate({ ...service(), startupTimeoutMs: 1.5 }),
      "invalid_startup_timeout",
    ],
    [
      candidate({ ...service(), startupTimeoutMs: "100" }),
      "invalid_startup_timeout",
    ],
    [
      candidate({ ...service(), lifecycle: "detached" }),
      "invalid_service_lifecycle",
    ],
    [
      candidate({ ...service(), launch: undefined }),
      "launch_lifecycle_mismatch",
    ],
    [
      candidate({ ...service(), lifecycle: "attached" }),
      "launch_lifecycle_mismatch",
    ],
    [
      candidate({ ...service(), endpoint: { url: "ws://example.com:1" } }),
      "explicit_loopback_endpoint_required",
    ],
    [candidate({ ...service(), endpoint: {} }), "invalid_service_endpoint"],
    [
      candidate({
        ...service(),
        endpoint: { registry: true, tokenEnv: "TOKEN" },
      }),
      "invalid_service_endpoint",
    ],
    [
      candidate({ ...service(), endpoint: { registry: false } }),
      "invalid_service_endpoint",
    ],
    [
      candidate({
        ...service(),
        endpoint: { registry: true, url: "ws://localhost:1" },
      }),
      "invalid_service_endpoint",
    ],
    [
      candidate({
        ...service(),
        endpoint: { registry: true, discovery: "auto" },
      }),
      "unknown_configuration_field",
    ],
    [
      candidate({ ...service(), lifecycle: "attached", launch: undefined }),
      "launch_lifecycle_mismatch",
    ],
    [
      candidate({ ...service(), endpoint: { url: "not a URL" } }),
      "invalid_endpoint",
    ],
    [
      candidate({ ...service(), endpoint: { url: "ws://localhost:4321" } }),
      "owned_registry_endpoint_required",
    ],
    [
      {
        version: 1,
        services: ["one", "two"].map((id) => ({
          id,
          kind: "ahp-websocket",
          lifecycle: "attached",
          startupTimeoutMs: 100,
          endpoint: { url: "ws://localhost:4321" },
        })),
      },
      "duplicate_service_endpoint",
    ],
  ])("rejects invalid configuration %#", (value, error) => {
    expect(() => validateConfig(value)).toThrow(String(error));
  });

  it.each([
    [{ executable: "" }, "invalid_string"],
    [{ cwd: "relative" }, "absolute_launch_cwd_required"],
    [{ args: "shell string" }, "invalid_configuration_array"],
    [{ args: [1] }, "invalid_configuration_array"],
    [{ args: ["{unknown}"] }, "invalid_launch_value"],
    [{ executable: "a\0b" }, "invalid_launch_value"],
    [{ shell: true }, "unknown_configuration_field"],
    [
      { environment: { mode: "auto", inherit: [], values: {} } },
      "invalid_environment_mode",
    ],
    [
      { environment: { mode: "isolated", inherit: [], values: { VALUE: 1 } } },
      "invalid_environment_values",
    ],
    [
      { environment: { mode: "isolated", inherit: [1], values: {} } },
      "invalid_configuration_array",
    ],
    [
      {
        environment: {
          mode: "isolated",
          inherit: [],
          values: {},
          surprise: true,
        },
      },
      "unknown_configuration_field",
    ],
    [
      { environment: { mode: "inherited", inherit: [""], values: {} } },
      "invalid_environment_name",
    ],
    [
      {
        environment: {
          mode: "inherited",
          inherit: [],
          values: { "INVALID=NAME": "value" },
        },
      },
      "invalid_environment_name",
    ],
  ])("rejects invalid launch context %#", (patch, error) => {
    const row = service();
    row.launch = { ...(row.launch as Record<string, unknown>), ...patch };
    expect(() => validateConfig(candidate(row))).toThrow(error);
  });

  it("loads only explicit JSON configuration and reports missing/invalid files safely", async () => {
    const path = await mkdtemp(join(process.cwd(), ".test-config-"));
    paths.push(path);
    await expect(loadConfig(join(path, "missing"))).rejects.toThrow(
      "configuration_read_failed",
    );
    const file = join(path, "services.json");
    await writeFile(file, "{");
    await expect(loadConfig(file)).rejects.toThrow("configuration_read_failed");
    await writeFile(file, JSON.stringify(candidate()));
    expect((await loadConfig(file)).services).toHaveLength(1);
    await writeFile(file, '{"version":2}');
    await expect(loadConfig(file)).rejects.toThrow(
      "invalid_service_configuration",
    );
  });
});
