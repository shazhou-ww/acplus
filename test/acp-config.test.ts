import { mkdtemp, rm, writeFile, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import {
  ConfigurationError,
  diagnostic,
  Redactor,
  ServiceError,
  uuid,
  workspace,
  text,
  profileIdentity,
} from "../src/acp-common.js";
import { loadConfig, validateConfig } from "../src/acp-config.js";
import { fixtureConfig } from "./acp-fixture.js";

const directories: string[] = [];
async function directory() {
  const root = await mkdtemp(join(tmpdir(), "acplus-config-"));
  directories.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});
describe("ACP configuration and safe helpers", () => {
  it("requires schema 2 and explicit native commands, unique IDs and profiles", async () => {
    const root = await directory();
    const config = fixtureConfig(root);
    expect(validateConfig(config)).toEqual(config);
    expect(() => validateConfig({ ...config, schemaVersion: 1 })).toThrow(
      ConfigurationError,
    );
    expect(() => validateConfig({ ...config, taskQueue: true })).toThrow(
      ConfigurationError,
    );
    for (const command of ["copilot", "C:\\copilot.cmd", "C:\\copilot.bat"]) {
      const bad = structuredClone(config);
      bad.agents[0]!.command = command;
      expect(() => validateConfig(bad)).toThrow(ConfigurationError);
    }
    const duplicate = structuredClone(config);
    duplicate.agents.push(structuredClone(duplicate.agents[0]!));
    expect(() => validateConfig(duplicate)).toThrow(ConfigurationError);
    duplicate.agents[1]!.id = "other";
    expect(() => validateConfig(duplicate)).toThrow(ConfigurationError);
  });
  it("applies defaults and resolves explicit file paths", async () => {
    const root = await directory();
    const config = validateConfig(
      {
        schemaVersion: 2,
        dataDir: "state",
        agents: [
          {
            id: "copilot",
            command: process.execPath,
            profileDir: "profile",
            workspaces: ["workspace"],
            env: {
              TOKEN: { source: "file", path: "token" },
              NAME: { source: "env", name: "TOKEN" },
            },
          },
        ],
      },
      root,
    );
    expect(config.listen.port).toBe(4280);
    expect(config.agents[0]?.permission).toBe("deny");
    expect(config.agents[0]?.env.TOKEN).toEqual({
      source: "file",
      path: join(root, "token"),
    });
    expect(config.agents[0]?.args).toEqual(["--acp"]);
    const file = join(root, "config.json");
    await writeFile(file, JSON.stringify(config));
    expect(await loadConfig(file)).toEqual(config);
    expect(await loadConfig("-", JSON.stringify(config))).toEqual(config);
    const yamlFile = join(root, "config.yaml");
    await writeFile(yamlFile, "# Operator config\n" + stringify(config));
    expect(await loadConfig(yamlFile)).toEqual(config);
    expect(await loadConfig("-", stringify(config))).toEqual(config);
    await expect(loadConfig("-", "{bad")).rejects.toThrow(ConfigurationError);
    await expect(loadConfig(join(root, "missing"))).rejects.toThrow(
      ConfigurationError,
    );
  });
  it("rejects duplicate keys, multiple documents and unknown YAML tags", async () => {
    for (const content of [
      "schemaVersion: 2\nschemaVersion: 1\n",
      "---\nschemaVersion: 2\n---\nschemaVersion: 2\n",
      "schemaVersion: !execute 2\n",
      "schemaVersion: *missing\n",
      "",
      "null",
    ])
      await expect(loadConfig("-", content)).rejects.toThrow(
        ConfigurationError,
      );
  });
  it("checks real workspace boundaries and proper IDs without spawning", async () => {
    const root = await directory();
    const child = join(root, "workspace");
    await mkdir(child);
    const config = fixtureConfig(root);
    const agent = config.agents[0]!;
    expect(await workspace(agent, child)).toBe(await realpath(child));
    await expect(workspace(agent, join(root, "missing"))).rejects.toMatchObject(
      { code: "workspace_unavailable" },
    );
    await expect(workspace(agent, "relative")).rejects.toMatchObject({
      code: "workspace_not_allowed",
    });
    const outside = await directory();
    await expect(workspace(agent, outside)).rejects.toMatchObject({
      code: "workspace_not_allowed",
    });
    const file = join(root, "not-directory");
    await writeFile(file, "");
    await expect(workspace(agent, file)).rejects.toMatchObject({
      code: "workspace_unavailable",
    });
    expect(uuid("12345678-1234-1234-1234-123456789abc", "id")).toContain(
      "12345678",
    );
    expect(() => uuid("wrong", "id")).toThrow(ServiceError);
    expect(() => text(" ", "text")).toThrow(ServiceError);
    expect(text("OK", "text")).toBe("OK");
    expect(profileIdentity(agent)).toBe(
      profileIdentity(structuredClone(agent)),
    );
    expect(profileIdentity({ ...agent, profileDir: outside })).not.toBe(
      profileIdentity(agent),
    );
  });
  it("redacts every nested string and exposes only known diagnostic errors", () => {
    const redactor = new Redactor();
    redactor.add("secret");
    redactor.add("");
    expect(
      redactor.json({ nested: [{ arbitrary: "a secret" }], count: 1 }),
    ).toContain("[redacted]");
    expect(diagnostic(new Error("private detail"))).toEqual({
      code: "operation_failed",
      message: "operation failed",
    });
    expect(diagnostic(new ServiceError("known", 409))).toEqual({
      code: "known",
      message: "known",
    });
  });
});
