import { describe, expect, it } from "vitest";
import {
  directoryUri,
  equalSecret,
  localUrl,
  object,
  publicError,
  redact,
  string,
} from "../src/common.js";
import { load, patchLive } from "../src/compat-loader.js";
import { readFile } from "node:fs/promises";

describe("Windows URI compatibility", () => {
  it("encodes drive paths, spaces, Unicode and URI delimiter characters", () => {
    expect(directoryUri("C:\\demo folder\\#test%")).toBe(
      "file:///C:/demo%20folder/%23test%25",
    );
    expect(directoryUri("\\\\server\\share\\demo folder")).toBe(
      "file://server/share/demo%20folder",
    );
    expect(directoryUri("C:\\\u4e2d\u6587")).toBe(
      "file:///C:/%E4%B8%AD%E6%96%87",
    );
    expect(() => directoryUri("relative")).toThrow(
      "absolute_directory_required",
    );
  });

  it("applies deterministic ID, guarded cancellation and both URI patches exactly once", () => {
    const fixture = [
      "workingDirectory: `file://${workingDirectory}`",
      "workingDirectory: `file://${workingDirectory}`",
      "workingDirectories: [`file://${workingDirectory}`]",
      "say: (uri, text, model) => {",
      "type: 'chat/turnStarted',\n                turnId: randomUUID(),",
      "stopTurn: (uri) => {",
      "if (!turnId)\n                    return;",
    ].join("\n");
    const patched = patchLive(fixture);
    expect(patched).toContain(
      "workingDirectory: hubFileURL(workingDirectory).href",
    );
    expect(patched).toContain(
      "workingDirectories: [hubFileURL(workingDirectory).href]",
    );
    expect(patched).toContain("turnId: hubTurnId ?? randomUUID()");
    expect(patched).toContain("turnId !== hubTurnId");
    expect(() => patchLive(patched)).toThrow("compatibility patch mismatch");
    expect(() => patchLive("different upstream source")).toThrow(
      "compatibility patch mismatch",
    );
  });

  it("patches the pristine installed ahpc module, not an experiment copy", async () => {
    const url = import.meta.resolve("@softov/ahpc/dist/src/ahp/live.js");
    const source = await readFile(new URL(url), "utf8");
    const patched = patchLive(source);
    expect(patched.match(/workingDirectory: hubFileURL/g)).toHaveLength(2);
    expect(patched).toContain("workingDirectories: [hubFileURL");
    const context = { format: "module", importAttributes: {}, conditions: [] };
    for (const input of [source, Buffer.from(source)]) {
      const result = await load(url, context, () =>
        Promise.resolve({ format: "module", source: input }),
      );
      expect(result.source).toBe(patched);
    }
    const other = { format: "module", source: "export {}" };
    expect(
      await load("file:///other.js", context, () => Promise.resolve(other)),
    ).toBe(other);
  });
});

describe("boundary validation and redaction", () => {
  it("rejects implicit or remote hosts and embedded credentials", () => {
    expect(localUrl("ws://127.0.0.1:1234", "ws:").port).toBe("1234");
    for (const url of [
      "ws://example.com",
      "ws://localhost/?tkn=secret",
      "http://localhost",
      "ws://user:pass@localhost",
    ]) {
      expect(() => localUrl(url, "ws:")).toThrow();
    }
  });

  it("validates shapes and returns safe errors", () => {
    expect(object({ x: 1 })).toEqual({ x: 1 });
    expect(() => object(null)).toThrow("invalid_object");
    expect(() => object([])).toThrow("invalid_object");
    expect(() => string(" ")).toThrow("invalid_string");
    expect(string("value")).toBe("value");
    expect(publicError(new Error("secret")).code).toBe("internal_error");
  });

  it("redacts configured secrets recursively and never exposes credential properties", () => {
    expect(equalSecret("a", "a")).toBe(true);
    expect(equalSecret("a", "longer")).toBe(false);
    expect(
      redact({ text: "secret", items: ["secret", 42], token: "hidden" }, [
        "",
        "secret",
      ]),
    ).toEqual({
      text: "[redacted]",
      items: ["[redacted]", 42],
      token: "[redacted]",
    });
  });
});
