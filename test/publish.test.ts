import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const helper = pathToFileURL(resolve("scripts", "check-npm-version.js")).href;
const candidate = "0.1.1-canary.20261106.1";
const metadata = {
  name: "ahplex",
  versions: { "0.1.0": { name: "ahplex", version: "0.1.0" } },
  "dist-tags": { latest: "0.1.0" },
};

function check(
  body = JSON.stringify(metadata),
  status = 200,
  version = candidate,
) {
  return spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import assert from "node:assert/strict";
       import { assertNpmVersionAvailable } from ${JSON.stringify(helper)};
       const result = await assertNpmVersionAvailable("ahplex", ${JSON.stringify(version)}, async (url, options) => {
         assert.equal(url, "https://registry.npmjs.org/ahplex");
         assert.equal(options.headers.accept, "application/json");
         assert.ok(options.signal instanceof AbortSignal);
         return new Response(${JSON.stringify(body)}, { status: ${status} });
       });
       console.log(JSON.stringify(result));`,
    ],
    { encoding: "utf8" },
  );
}

describe("Actions npm version availability", () => {
  it("accepts absence only in a successful, valid existing-package response", () => {
    const result = check();
    expect(result.status).toBe(0);
    const output: unknown = JSON.parse(result.stdout);
    expect(output).toEqual({
      name: "ahplex",
      version: candidate,
      available: true,
      latest: "0.1.0",
      canary: null,
    });
  });

  it("rejects an already published version", () => {
    const result = check(undefined, 200, "0.1.0");
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("already published");
  });

  it.each([401, 403, 404, 429, 500, 503])(
    "keeps availability unknown after HTTP %s, including 404",
    (status) => {
      const result = check("{}", status);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(
        `HTTP ${status}; version availability is unknown`,
      );
    },
  );

  it.each([
    null,
    [],
    {},
    { ...metadata, name: "another-package" },
    { ...metadata, versions: [] },
    { ...metadata, versions: {} },
    { ...metadata, "dist-tags": null },
    { ...metadata, "dist-tags": { latest: "missing" } },
    { ...metadata, "dist-tags": { latest: "0.1.0", canary: 123 } },
    { ...metadata, versions: { "0.1.0": { version: "0.2.0" } } },
  ])("rejects malformed or mismatched metadata %#", (value) => {
    const result = check(JSON.stringify(value));
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Invalid registry metadata");
  });

  it("does not mistake malformed JSON for an unpublished version", () => {
    const result = check("{");
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("SyntaxError");
  });

  it("blocks Canary publication when existing latest is not stable", () => {
    const previous = "0.1.1-canary.20261105.1";
    const result = check(
      JSON.stringify({
        ...metadata,
        versions: { [previous]: { version: previous } },
        "dist-tags": { latest: previous },
      }),
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Existing latest must be stable");
  });

  it("propagates network failure without a successful availability receipt", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import { assertNpmVersionAvailable } from ${JSON.stringify(helper)};
         console.log(await assertNpmVersionAvailable("ahplex", ${JSON.stringify(candidate)}, async () => {
           throw new Error("fixture network unavailable");
         }));`,
      ],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("fixture network unavailable");
  });

  it("validates the candidate before requesting registry metadata", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import { assertNpmVersionAvailable } from ${JSON.stringify(helper)};
         await assertNpmVersionAvailable("ahplex", "not-a-version", () => {
           throw new Error("must not fetch");
         });`,
      ],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Expected X.Y.Z");
    expect(result.stderr).not.toContain("Error: must not fetch");
  });

  it("refuses direct local registry verification", () => {
    const result = spawnSync(
      process.execPath,
      [resolve("scripts", "check-npm-version.js")],
      {
        encoding: "utf8",
        env: { ...process.env, GITHUB_ACTIONS: "false" },
      },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("GitHub Actions only");
  });
});
