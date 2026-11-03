import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import ts from "typescript";
import { expect, it } from "vitest";

const exec = promisify(execFile);

it("runs the real CLI entrypoint through a package-manager directory link", async () => {
  const root = await mkdtemp(join(tmpdir(), "agenthub-entry-"));
  try {
    const real = join(root, "real");
    const linked = join(root, "linked");
    await mkdir(real);
    await writeFile(join(real, "package.json"), '{"type":"module"}');
    for (const name of ["cli", "common"]) {
      const source = await readFile(
        new URL(`../src/${name}.ts`, import.meta.url),
        "utf8",
      );
      const output = ts.transpileModule(source, {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
        },
      }).outputText;
      await writeFile(join(real, `${name}.js`), output);
    }
    await writeFile(
      join(real, "runtime.js"),
      "export function start() { throw new Error('Host must not start for help'); }",
    );
    await symlink(
      real,
      linked,
      process.platform === "win32" ? "junction" : "dir",
    );
    const help = await exec(process.execPath, [
      join(linked, "cli.js"),
      "--help",
    ]);
    expect(help.stdout).toContain("agenthub --instance NAME");
    expect(help.stderr).toBe("");
    await expect(
      exec(process.execPath, [join(linked, "cli.js")]),
    ).rejects.toMatchObject({
      code: 1,
      stderr: "agenthub: instance_required\n",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
