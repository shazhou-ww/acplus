import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConfigurationError,
  Redactor,
  ServiceError,
  bounded,
  diagnostic,
  fields,
  record,
  text,
  upstream,
  uri,
} from "../src/common.js";
import { RpcError } from "@microsoft/agent-host-protocol/client";
import {
  loadConfig,
  objectSchema,
  parseJson,
  validateConfig,
} from "../src/config.js";
import { AdapterRegistry, codec } from "../src/extensions.js";
import { lockDirectory, Secrets } from "../src/processes.js";
import { vscodeFactory } from "../src/vscode.js";
import { config } from "./fixture.js";

const directories: string[] = [];
async function root(): Promise<string> {
  const directory = resolve(".test-state", randomUUID());
  directories.push(directory);
  await mkdir(directory, { recursive: true });
  return directory;
}
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("static configuration", () => {
  it("validates the documented schema, identifiers and exact common shapes", async () => {
    const example: unknown = JSON.parse(
      await readFile(join("docs", "hosts.example.json"), "utf8"),
    );
    expect(validateConfig(example).hosts).toHaveLength(2);
    for (const bad of [
      null,
      [],
      {},
      { ...config(), unknown: true },
      { ...config(), instance: ".." },
      { ...config(), listen: { host: "localhost", port: -1 } },
    ])
      expect(() => validateConfig(bad)).toThrow(ConfigurationError);
    const input = config();
    input.hosts.push(...input.hosts);
    expect(() => validateConfig(input)).toThrow("duplicate");
    const duplicatePlugin = { id: "p", module: ".\\p.mjs", options: {} };
    expect(() =>
      validateConfig({
        ...config(),
        plugins: [duplicatePlugin, duplicatePlugin],
      }),
    ).toThrow("duplicate");
    const host = config().hosts[0];
    if (host === undefined) throw new Error();
    host.authentication = Array.from({ length: 2 }, () => ({
      id: "same",
      provider: "p",
      resource: "https://example.com",
      adapter: "auth",
      options: {},
    }));
    expect(() => validateConfig({ ...config(), hosts: [host] })).toThrow(
      "duplicate",
    );
  });

  it("resolves file, stdin and explicit override bases without touching secret contents", async () => {
    const directory = await root();
    const input = config(["a"]);
    input.dataDir = `.${sep}state`;
    input.plugins = [{ id: "plugin", module: `.${sep}p.mjs`, options: {} }];
    const host = input.hosts[0];
    if (host === undefined) throw new Error();
    host.startup.command = `.${sep}bin${sep}host.exe`;
    host.startup.cwd = `.${sep}workspace`;
    host.startup.env.TOKEN = {
      source: "file",
      path: `.${sep}not-present.secret`,
    };
    host.authentication = [
      {
        id: "login",
        provider: "p",
        resource: "https://example.com",
        adapter: "auth",
        options: {
          credentials: [{ source: "file", path: `.${sep}credential` }],
        },
      },
    ];
    const path = join(directory, "config.json");
    await writeFile(path, JSON.stringify(input));
    const loaded = await loadConfig(path, {
      port: 0,
      listenHost: "0.0.0.0",
      instance: "override",
      dataDir: `.${sep}override`,
    });
    expect(loaded.dataDir).toBe(resolve("override"));
    expect(loaded.listen).toEqual({ host: "0.0.0.0", port: 0 });
    expect(loaded.hosts[0]?.startup.command).toBe(
      join(directory, "bin", "host.exe"),
    );
    expect(loaded.hosts[0]?.startup.env.TOKEN).toEqual({
      source: "file",
      path: join(directory, "not-present.secret"),
    });
    const stdin = vi.fn(() => Promise.resolve(JSON.stringify(input)));
    const piped = await loadConfig("-", {}, stdin, directory);
    expect(stdin).toHaveBeenCalledOnce();
    expect(piped.dataDir).toBe(join(directory, "state"));
    expect(await readFile(path, "utf8")).toBe(JSON.stringify(input));
  });

  it("rejects malformed, empty, multiple documents, invalid overrides and unsafe plugin specifiers", async () => {
    expect(parseJson("\uFEFF{}")).toEqual({});
    for (const raw of ["", "{", "{}{}", "null"])
      await expect(
        loadConfig("-", {}, () => Promise.resolve(raw)),
      ).rejects.toThrow(ConfigurationError);
    await expect(loadConfig("not-present.json")).rejects.toThrow("read");
    await expect(
      loadConfig("-", { port: 2 }, () => Promise.reject(new Error("input"))),
    ).rejects.toThrow("read");
    await expect(
      loadConfig("-", { port: -1 }, () =>
        Promise.resolve(JSON.stringify(config())),
      ),
    ).rejects.toThrow();
    await expect(
      loadConfig("-", { dataDir: "" }, () =>
        Promise.resolve(JSON.stringify(config())),
      ),
    ).rejects.toThrow("non-empty");
    const invalidResource = config(["a"]);
    invalidResource.hosts[0]?.authentication.push({
      id: "x",
      provider: "p",
      resource: "not a URI",
      adapter: "a",
      options: {},
    });
    expect(() => validateConfig(invalidResource)).toThrow();
    for (const module of [
      "package-name",
      "https://example.com/p.mjs",
      "plugin.ts",
      "plugin.mjs",
    ]) {
      await expect(
        loadConfig("-", {}, () =>
          Promise.resolve(
            JSON.stringify({
              ...config(),
              plugins: [{ id: "p", module, options: {} }],
            }),
          ),
        ),
      ).rejects.toThrow("explicit local");
    }
  });

  it("loads only configured ESM modules, validates schema and rejects registry overrides", async () => {
    const directory = await root();
    const module = join(directory, "plugin.mjs");
    await writeFile(
      module,
      `export default {
      apiVersion: 1, id: "local", options: { schema: {type:"object",additionalProperties:false}, parse: x=>x },
      register(registry) {
        registry.addAuthenticationAdapter({id:"local-auth",options:{schema:{type:"object",additionalProperties:false},parse:x=>x},create:()=>({run:async()=>{}})});
      }, dispose:async()=>{}
    };`,
    );
    const registry = new AdapterRegistry();
    await registry.load({
      ...config([]),
      plugins: [{ id: "local", module, options: {} }],
    });
    expect(registry.authentication("local-auth", {})).toHaveProperty("run");
    await expect(
      registry.load({
        ...config([]),
        plugins: [{ id: "local", module, options: {} }],
      }),
    ).rejects.toThrow("Duplicate");
    const wrong = new AdapterRegistry();
    await expect(
      wrong.load({
        ...config([]),
        plugins: [{ id: "wrong", module, options: {} }],
      }),
    ).rejects.toThrow("Invalid plugin");
    expect(() => wrong.authentication("missing", {})).toThrow("Unresolved");
    expect(() => wrong.host("missing")).toThrow("Unresolved");
    wrong.addHostAdapter(vscodeFactory);
    expect(() => {
      wrong.addHostAdapter(vscodeFactory);
    }).toThrow("Duplicate");
    await wrong.dispose();
  });

  it("reports plugin parse/load/dispose failures and incompatible startup before resources", async () => {
    const directory = await root();
    const path = join(directory, "bad.mjs");
    await writeFile(path, "export default {apiVersion:2}");
    await expect(
      new AdapterRegistry().load({
        ...config([]),
        plugins: [{ id: "bad", module: path, options: {} }],
      }),
    ).rejects.toThrow();
    await expect(
      new AdapterRegistry().load({
        ...config([]),
        plugins: [
          { id: "bad", module: join(directory, "absent.mjs"), options: {} },
        ],
      }),
    ).rejects.toThrow("Plugin loading");
    const disposal = join(directory, "dispose.mjs");
    await writeFile(
      disposal,
      `export default {apiVersion:1,id:"bad",options:{schema:{type:"object"},parse:x=>x},register(){},dispose:async()=>{throw Error("private")}}`,
    );
    const registry = new AdapterRegistry();
    await registry.load({
      ...config([]),
      plugins: [{ id: "bad", module: disposal, options: {} }],
    });
    await expect(registry.dispose()).rejects.toThrow("Plugin cleanup");
    const opts = codec<{ value: string }>(
      objectSchema({ value: { type: "string" } }),
    );
    expect(() => opts.parse({ value: 1 })).toThrow("/value");
    const host = config().hosts[0];
    if (host === undefined) throw new Error();
    for (const args of [
      ["--port", "1"],
      ["--connection-token=literal"],
      ["--user-data-dir=x"],
    ]) {
      host.startup.args = args;
      expect(() => vscodeFactory.validate?.(host, {})).toThrow("conflicting");
    }
    host.startup.args = [];
    host.startup.command = "code.cmd";
    expect(() => vscodeFactory.validate?.(host, {})).toThrow("native");
    host.startup.command = "code-tunnel.exe";
    host.startup.env.HOME = "ambient";
    expect(() => vscodeFactory.validate?.(host, {})).toThrow("isolation");
  });
});

describe("secrets, ownership and display-safe errors", () => {
  it("locks one root regardless of instance name and reads only explicit env/file secrets", async () => {
    const directory = await root();
    const release = await lockDirectory(directory);
    await expect(lockDirectory(directory)).rejects.toMatchObject({
      code: "data_directory_locked",
    });
    await release();
    await (
      await lockDirectory(directory)
    )();
    const redactor = new Redactor();
    const secrets = new Secrets(redactor);
    vi.stubEnv("EXPLICIT_FIXTURE", "secret-value");
    expect(
      await secrets.resolve({ source: "env", name: "EXPLICIT_FIXTURE" }),
    ).toBe("secret-value");
    vi.stubEnv("EXPLICIT_FIXTURE", "");
    await expect(
      secrets.resolve({ source: "env", name: "EXPLICIT_FIXTURE" }),
    ).rejects.toThrow();
    await expect(
      secrets.resolve({ source: "env", name: "NO_SUCH_AHPLEX_FIXTURE_VALUE" }),
    ).rejects.toThrow();
    const file = join(directory, "credential");
    await writeFile(file, "  token  \r\n");
    expect(await secrets.resolve({ source: "file", path: file })).toBe(
      "  token  ",
    );
    await expect(
      secrets.resolve({ source: "file", path: file + ".missing" }),
    ).rejects.toThrow();
    expect(redactor.clean("secret-value +   token  ")).toBe(
      "[redacted] + [redacted]",
    );
    expect(redactor.json({ safe: 1, content: "secret-value" })).toBe(
      '{"safe":1,"content":"[redacted]"}',
    );
    redactor.add("running");
    expect(
      redactor.json({
        state: "running",
        resource: "ahp-chat:/running",
        text: "running",
      }),
    ).toBe(
      '{"state":"running","resource":"ahp-chat:/running","text":"[redacted]"}',
    );
  });

  it("validates inputs without raw exceptions and bounds cancellation", async () => {
    expect(record(null)).toBe(false);
    expect(record([])).toBe(false);
    expect(() => fields({ a: 1, b: 2 }, ["a"])).toThrow();
    expect(() => text("", "test")).toThrow();
    expect(() => uri("http://x /", "uri")).toThrow();
    expect(() => uri("file:///C:/", "uri", "https:")).toThrow();
    expect(uri("ahp-chat:/%2F", "uri")).toBe("ahp-chat:/%2F");
    expect(upstream(new ServiceError("known"))).toMatchObject({
      code: "known",
    });
    for (const [code, expected] of [
      [-32007, "upstream_auth_required"],
      [-32004, "chat_busy"],
      [-32001, "resource_not_found"],
      [-32002, "provider_not_found"],
      [-32603, "upstream_rejected"],
    ]) {
      if (typeof code !== "number") throw new Error();
      expect(diagnostic(new RpcError(code, "private"))).toMatchObject({
        code: expected,
      });
    }
    expect(diagnostic(new Error("SECRET")).message).not.toContain("SECRET");
    expect(
      await bounded(Promise.resolve(1), new AbortController().signal),
    ).toBe(1);
    const controller = new AbortController();
    const waiting = bounded(new Promise<never>(() => {}), controller.signal);
    controller.abort();
    await expect(waiting).rejects.toThrow("operation cancelled");
    await expect(
      bounded(Promise.resolve(), controller.signal),
    ).rejects.toThrow();
  });
});
