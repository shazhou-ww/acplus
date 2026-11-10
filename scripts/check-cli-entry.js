import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";

const metadata = JSON.parse(readFileSync("package.json", "utf8"));
const directory = mkdtempSync(resolve(".cli-entry-"));
try {
  assert.deepEqual(Object.keys(metadata.bin).sort(), ["acplus", "acplus-ai"]);
  for (const [name, entry] of Object.entries(metadata.bin)) {
    const target = resolve(entry);
    assert.ok(readFileSync(target, "utf8").startsWith("#!/usr/bin/env node\n"));
    const alias = join(directory, name);
    if (process.platform !== "win32") symlinkSync(target, alias);
    const result = spawnSync(
      process.execPath,
      [process.platform === "win32" ? target : alias, "--version"],
      { encoding: "utf8", timeout: 10000 },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout.trim(),
      `${name} ${metadata.version} (HTTP /v2, ACP v1)`,
    );
    assert.equal(result.stderr, "");
    const help = spawnSync(process.execPath, [target, "--help"], {
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(help.status, 0, help.stderr);
    assert.equal(help.stderr, "");
    assert.ok(
      help.stdout.includes(
        `${name} session${name === "acplus-ai" ? "-" : "s "}send`,
      ),
    );
    assert.ok(!help.stdout.includes("_auto-serve"));
    if (name === "acplus-ai") {
      const bytes = Buffer.byteLength(help.stdout, "utf8");
      assert.ok(bytes <= 8192, `AI help is ${bytes} bytes`);
      console.log(`acplus-ai help: ${bytes} UTF-8 bytes`);
    }
  }
  console.log("Both public CLI entries verified");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
