import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { assertNpmVersionAvailable } from "../scripts/check-npm-version.js";

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
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(new Response(body, { status }));
  return { fetch, result: assertNpmVersionAvailable("ahplex", version, fetch) };
}

describe("Actions npm version availability", () => {
  it("accepts absence only in a successful, valid existing-package response", async () => {
    const { fetch, result } = check();
    await expect(result).resolves.toEqual({
      name: "ahplex",
      version: candidate,
      available: true,
      latest: "0.1.0",
      canary: null,
    });
    expect(fetch).toHaveBeenCalledOnce();
    const [url, options] = fetch.mock.calls[0]!;
    expect(url).toBe("https://registry.npmjs.org/ahplex");
    expect(options?.headers).toEqual({ accept: "application/json" });
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  });

  it("rejects an already published version", async () => {
    await expect(check(undefined, 200, "0.1.0").result).rejects.toThrow(
      "already published",
    );
  });

  it.each([401, 403, 404, 429, 500, 503])(
    "keeps availability unknown after HTTP %s, including 404",
    async (status) => {
      await expect(check("{}", status).result).rejects.toThrow(
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
  ])("rejects malformed or mismatched metadata %#", async (value) => {
    await expect(check(JSON.stringify(value)).result).rejects.toThrow(
      "Invalid registry metadata",
    );
  });

  it("does not mistake malformed JSON for an unpublished version", async () => {
    await expect(check("{").result).rejects.toBeInstanceOf(SyntaxError);
  });

  it("blocks Canary publication when existing latest is not stable", async () => {
    const previous = "0.1.1-canary.20261105.1";
    await expect(
      check(
        JSON.stringify({
          ...metadata,
          versions: { [previous]: { version: previous } },
          "dist-tags": { latest: previous },
        }),
      ).result,
    ).rejects.toThrow("Existing latest must be stable");
  });

  it("propagates network failure without a successful availability receipt", async () => {
    const failure = new Error("fixture network unavailable");
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(failure);
    await expect(
      assertNpmVersionAvailable("ahplex", candidate, fetch),
    ).rejects.toBe(failure);
  });

  it("validates the candidate before requesting registry metadata", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(
      assertNpmVersionAvailable("ahplex", "not-a-version", fetch),
    ).rejects.toThrow("Expected X.Y.Z");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses direct local registry verification", () => {
    const result = spawnSync(
      process.execPath,
      [resolve("scripts", "check-npm-version.ts")],
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
