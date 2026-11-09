import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const metadata = JSON.parse(readFileSync("package.json", "utf8"));
const directory = mkdtempSync(join(tmpdir(), "acplus-cli-entry-"));
try {
  const target = resolve(metadata.bin.acplus);
  const alias = join(directory, "acplus");
  if (process.platform !== "win32") symlinkSync(target, alias);
  const result = spawnSync(
    process.execPath,
    [process.platform === "win32" ? target : alias, "--version"],
    { encoding: "utf8", timeout: 10000 },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout.trim(),
    `acplus ${metadata.version} (HTTP /v2, ACP v1)`,
  );
  assert.equal(result.stderr, "");
  console.log("Public CLI entry verified");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
