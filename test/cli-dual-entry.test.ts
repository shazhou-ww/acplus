import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { start } from "../src/acp-server.js";
import { fixtureConfig } from "./acp-fixture.js";

const root = resolve(".cli-dual-entry-tests", randomUUID());
const env = { ...process.env, ACPLUS_URL: undefined };
const exec = promisify(execFile);
type Result = { code: number; stdout: string; stderr: string };

function command(audience: "human" | "ai", args: string[]): Promise<Result> {
  return new Promise((resolve) => {
    // Deliberately leave piped stdin open: an accidental read would time out.
    execFile(
      process.execPath,
      [join("dist", audience === "ai" ? "cli-ai.js" : "cli.js"), ...args],
      { env, encoding: "utf8", timeout: 20000 },
      (error, stdout, stderr) => {
        resolve({
          code:
            error === null
              ? 0
              : typeof error.code === "number"
                ? error.code
                : -1,
          stdout,
          stderr,
        });
      },
    );
  });
}

function json(result: Result, code = 0): Record<string, unknown> {
  expect(result.code, result.stderr).toBe(code);
  expect(result.stdout).not.toContain("\u001b");
  expect(result.stdout.trim().split("\n")).toHaveLength(1);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function diagnostics(result: Result): Record<string, unknown>[] {
  expect(result.stderr).not.toContain("\u001b");
  return result.stderr
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeAll(async () => {
  await mkdir(root, { recursive: true });
  const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
  await exec(process.execPath, [tsc, "-p", "tsconfig.build.json"], {
    timeout: 60000,
  });
}, 60000);
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("built dual CLI entries", () => {
  it("keeps help/version textual, exits usage with exact JSON and never waits on open stdin", async () => {
    const metadata = JSON.parse(await readFile("package.json", "utf8")) as {
      version: string;
    };
    for (const audience of ["human", "ai"] as const) {
      const version = await command(audience, ["--version"]);
      expect(version).toEqual({
        code: 0,
        stdout: `acplus${audience === "ai" ? "-ai" : ""} ${metadata.version} (HTTP /v2, ACP v1)\n`,
        stderr: "",
      });
      const help = await command(audience, ["--help"]);
      expect(help.code).toBe(0);
      expect(help.stderr).toBe("");
      if (audience === "ai")
        expect(Buffer.byteLength(help.stdout)).toBeLessThanOrEqual(8192);
    }
    for (const args of [
      ["session-delete", "--session", randomUUID()],
      [
        "session-send",
        "--session",
        randomUUID(),
        "--turn",
        randomUUID(),
        "--text-file",
        "-",
      ],
      ["agent-auth-input", "--agent", "copilot", "--input-file", "-"],
      [
        "init",
        "--agent",
        "copilot",
        "--agent-command",
        process.execPath,
        "--config",
        "-",
      ],
    ]) {
      const result = await command("ai", args);
      expect(result.code).toBe(2);
      expect(result.stdout).toBe("");
      const lines = diagnostics(result);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        error: {
          code: "invalid_input",
          message: expect.any(String) as unknown,
        },
      });
      if (args[0] === "session-delete")
        expect(result.stderr).toBe(
          `${JSON.stringify({ error: { code: "invalid_input", message: "acplus-ai session-delete requires --yes" } })}\n`,
        );
    }
  }, 30000);

  it("alternates real remote Human/AI operations, idempotency, auth, pagination, timeout and cancellation", async () => {
    const directory = join(root, "remote");
    await mkdir(directory);
    const service = await start(fixtureConfig(directory));
    const remote = ["--url", service.url];
    try {
      const created = json(
        await command("human", [
          "sessions",
          "create",
          "--agent",
          "copilot",
          "--working-directory",
          directory,
          "--name",
          "shared",
          ...remote,
          "--json",
        ]),
      );
      const session = String(created.sessionId);
      expect(
        json(
          await command("ai", ["session-get", "--session", session, ...remote]),
        ),
      ).toEqual(created);
      const page = json(
        await command("ai", ["session-list", "--limit", "1", ...remote]),
      );
      expect(page.items).toEqual([created]);
      expect(page.nextCursor).toBeNull();
      const turn = randomUUID();
      const target = ["--session", session, "--turn", turn];
      const args = [
        "session-send",
        ...target,
        "--text",
        "Hello",
        ...remote,
        "--wait-ms",
        "5000",
      ];
      const sent = await command("ai", args);
      expect(json(sent)).toMatchObject({
        sessionId: session,
        turnId: turn,
        state: "complete",
        response: "OK",
      });
      expect(diagnostics(sent)).toEqual([
        { event: "turn_submitting", sessionId: session, turnId: turn },
      ]);
      expect(json(await command("ai", args))).toMatchObject({
        turnId: turn,
        response: "OK",
      });
      const changed = await command("ai", [
        "turn-start",
        ...target,
        "--text",
        "Changed",
        ...remote,
      ]);
      expect(changed.code).toBe(1);
      expect(changed.stdout).toBe("");
      expect(diagnostics(changed).at(-1)).toMatchObject({
        error: { code: "turn_id_conflict" },
      });
      expect(
        json(
          await command("human", [
            "turns",
            "get",
            ...target,
            ...remote,
            "--json",
          ]),
        ),
      ).toMatchObject({ state: "complete" });
      const events = json(
        await command("ai", [
          "event-list",
          ...target,
          "--limit",
          "1",
          ...remote,
        ]),
      );
      expect(events.items).toHaveLength(1);
      expect(events.nextAfter).toBeTypeOf("number");
      const hold = randomUUID();
      const held = ["--session", session, "--turn", hold];
      const timeout = await command("ai", [
        "session-send",
        ...held,
        "--text",
        "HOLD",
        "--wait-ms",
        "100",
        ...remote,
      ]);
      expect(timeout.code).toBe(1);
      expect(timeout.stdout).toBe("");
      expect(diagnostics(timeout).at(-1)).toMatchObject({
        error: {
          code: "turn_wait_timeout",
          message: expect.stringContaining("acplus-ai turn-get") as unknown,
        },
      });
      json(await command("ai", ["turn-cancel", ...held, ...remote]));
      expect(
        json(await command("ai", ["turn-get", ...held, ...remote])),
      ).toMatchObject({ state: "cancelled" });
      json(
        await command("ai", ["agent-auth", "--agent", "copilot", ...remote]),
      );
      const login = json(
        await command("ai", [
          "agent-login",
          "--agent",
          "copilot",
          "--method",
          "sign-in",
          "--wait-ms",
          "5000",
          ...remote,
        ]),
      );
      expect(login).toMatchObject({
        status: "succeeded",
        operationId: expect.any(String) as unknown,
      });
      const deleted = json(
        await command("ai", [
          "session-delete",
          "--session",
          session,
          "--yes",
          ...remote,
        ]),
      );
      expect(deleted).toEqual({ sessionId: session, deleted: true });
      expect(
        json(await command("human", ["sessions", "list", ...remote, "--json"])),
      ).toMatchObject({ items: [] });
    } finally {
      await service.close();
    }
  }, 30000);

  it("AI auto-start still launches cli.js; both entries share local committed history without Agent startup", async () => {
    const directory = join(root, "local");
    await mkdir(directory);
    const config = fixtureConfig(directory);
    const file = join(directory, "config.yaml");
    await writeFile(file, stringify(config));
    const created = await command("ai", [
      "session-create",
      "--agent",
      "copilot",
      "--working-directory",
      directory,
      "--config",
      file,
      "--idle-grace-ms",
      "3000",
    ]);
    const session = String(json(created).sessionId);
    diagnostics(created);
    const ai = await command("ai", [
      "session-get",
      "--session",
      session,
      "--config",
      file,
    ]);
    expect(json(ai)).toMatchObject({ sessionId: session });
    // Local SQLite runtime warnings, if emitted by this Node version, remain JSONL.
    for (const warning of diagnostics(ai))
      expect(warning).toMatchObject({
        event: "runtime_warning",
        name: expect.any(String) as unknown,
        message: expect.any(String) as unknown,
      });
    expect(
      json(
        await command("human", [
          "sessions",
          "get",
          "--session",
          session,
          "--config",
          file,
          "--json",
        ]),
      ),
    ).toEqual(json(ai));
    await expect(stat(join(directory, "counter"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const deadline = Date.now() + 10000;
    for (;;) {
      try {
        await stat(join(config.dataDir, "owner.lock"));
      } catch {
        break;
      }
      if (Date.now() > deadline)
        throw new Error("Auto-service did not release its lock");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }, 30000);
});
