import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as api from "../src/index.js";

describe("ACP public package shape", () => {
  it("does not retain obsolete AHP documents or examples", () => {
    for (const file of [
      "AHPD-RUNTIME.md",
      "EXTENSIONS.md",
      "HOST-CONFIG.md",
      "ahpd.example.json",
      "host-config.schema.json",
      "hosts.example.json",
    ])
      expect(existsSync(new URL(`../docs/${file}`, import.meta.url))).toBe(
        false,
      );
  });
  it("preserves the ESM exports and allowlist while replacing the normal bin", () => {
    const metadata: unknown = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    expect(metadata).toMatchObject({
      type: "module",
      main: "./dist/index.js",
      types: "./dist/index.d.ts",
      name: "acplus",
      bin: { acplus: "dist/acp-cli.js" },
      files: ["dist", "README.md", "LICENSE"],
      exports: {
        ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
        "./package.json": "./package.json",
      },
      dependencies: { "@agentclientprotocol/sdk": "2.4.0" },
    });
    expect(metadata).not.toHaveProperty(
      "dependencies.@microsoft/agent-host-protocol",
    );
    expect(metadata).not.toHaveProperty("bin.ahplex");
  });
  it("exports only supported runtime APIs without legacy adapters", () => {
    expect(Object.keys(api).sort()).toEqual([
      "ConfigurationError",
      "ServiceError",
      "loadConfig",
      "start",
      "validateConfig",
    ]);
    expect(api.validateConfig).toBeTypeOf("function");
    expect(api.start).toBeTypeOf("function");
  });
});
