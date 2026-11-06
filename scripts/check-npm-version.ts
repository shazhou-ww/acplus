import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const versionPattern =
  /^\d+\.\d+\.\d+(?:-canary\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))?$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function assertNpmVersionAvailable(
  name: unknown,
  version: unknown,
  fetcher: typeof globalThis.fetch = globalThis.fetch,
) {
  if (typeof name !== "string" || name.length === 0)
    throw new Error("A package name is required.");
  if (typeof version !== "string" || !versionPattern.test(version))
    throw new Error("Expected X.Y.Z or X.Y.Z-canary.DATE.SEQUENCE.");

  const response = await fetcher(
    `https://registry.npmjs.org/${encodeURIComponent(name)}`,
    {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (response.status !== 200)
    throw new Error(
      `Registry returned HTTP ${response.status}; version availability is unknown.`,
    );
  const metadata: unknown = await response.json();
  if (
    !isRecord(metadata) ||
    metadata.name !== name ||
    !isRecord(metadata.versions) ||
    !isRecord(metadata["dist-tags"])
  )
    throw new Error(
      "Invalid registry metadata; version availability is unknown.",
    );

  const versions = metadata.versions;
  const tags = metadata["dist-tags"];
  const latest = tags.latest;
  if (
    typeof latest !== "string" ||
    !Object.hasOwn(versions, latest) ||
    !isRecord(versions[latest]) ||
    versions[latest].version !== latest ||
    (tags.canary !== undefined && typeof tags.canary !== "string")
  )
    throw new Error(
      "Invalid registry metadata; version availability is unknown.",
    );
  if (Object.hasOwn(versions, version))
    throw new Error(`${name}@${version} is already published.`);
  if (version.includes("-canary.") && !/^\d+\.\d+\.\d+$/u.test(latest))
    throw new Error("Existing latest must be stable before a Canary release.");

  return {
    name,
    version,
    available: true,
    latest,
    canary: tags.canary ?? null,
  };
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  if (process.env.GITHUB_ACTIONS !== "true")
    throw new Error("Run npm registry verification in GitHub Actions only.");
  const manifest: unknown = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  if (!isRecord(manifest)) throw new Error("Invalid package manifest.");
  console.log(
    JSON.stringify(
      await assertNpmVersionAvailable(
        manifest.name,
        process.env.PACKAGE_VERSION,
      ),
    ),
  );
}
