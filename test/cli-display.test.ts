import { afterEach, describe, expect, it, vi } from "vitest";
import { helpFor, humanOutput, printResult } from "../src/cli-display.js";

afterEach(() => vi.restoreAllMocks());

describe("human CLI output and focused help", () => {
  it("renders Sessions, Turns, events, Agents and empty pages without protocol envelopes", () => {
    expect(humanOutput("health", null)).toContain("healthy");
    expect(humanOutput("sessions delete", null)).toContain("deleted");
    expect(humanOutput("init", { config: "config.yaml" })).toContain(
      "config.yaml",
    );
    expect(
      humanOutput("sessions get", {
        sessionId: "session",
        agentId: "copilot",
        workingDirectory: "C:\\project",
      }),
    ).toBe("Session: session\nAgent: copilot\nDirectory: C:\\project");
    expect(
      humanOutput("turns get", {
        sessionId: "session",
        turnId: "turn",
        state: "error",
        response: "partial",
        error: { code: "failed" },
      }),
    ).toContain("partial\nError:");
    expect(
      humanOutput("turns get", { turnId: "turn", state: "accepted" }),
    ).toContain("Status: accepted");
    expect(humanOutput("sessions list", { items: [], nextCursor: null })).toBe(
      "No records.",
    );
    expect(
      humanOutput("sessions list", {
        items: [
          {
            sessionId: "session",
            agentId: "copilot",
            workingDirectory: "C:\\project",
          },
        ],
        nextCursor: "next",
      }),
    ).toContain("Next cursor: next");
    expect(
      humanOutput("turns list", {
        items: [{ turnId: "turn", state: "complete", response: "OK" }],
      }),
    ).toContain("turn  complete  OK");
    expect(
      humanOutput("events list", {
        items: [
          {
            sequence: 1,
            source: "live",
            type: "agent_message_chunk",
            payload: { content: { text: "hello" } },
          },
          {
            sequence: 2,
            source: "live",
            type: "tool_call",
            payload: { title: "Read" },
          },
          null,
        ],
        nextAfter: 2,
      }),
    ).toContain("hello\n2 [live] tool_call: title: Read\n-\nNext after: 2");
    expect(humanOutput("agents list", [])).toBe("No Agents.");
    expect(
      humanOutput("agents list", [{ agentId: "copilot", runtime: "stopped" }]),
    ).toContain("runtime: stopped");
    expect(
      humanOutput("agents auth", {
        flow: {
          step: {
            url: "https://github.com/login/device",
            userCode: "ABCD-EFGH",
          },
        },
      }),
    ).toContain("ABCD-EFGH");
    expect(humanOutput("", "hello")).toBe("hello");
    expect(humanOutput("", 1)).toBe("1");
    expect(humanOutput("", { items: ["raw"] })).toBe("raw");
  });

  it("keeps JSON stdout machine-readable and does not fabricate a body for empty HTTP responses", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    printResult("sessions list", { items: [], nextCursor: null }, true);
    expect(console.log).toHaveBeenLastCalledWith(
      '{"items":[],"nextCursor":null}',
    );
    printResult("health", null, true);
    expect(console.log).toHaveBeenCalledOnce();
    printResult("health", null, false);
    expect(console.log).toHaveBeenLastCalledWith("Service is healthy.");
  });

  it("documents individual commands, groups and safe send/delete semantics", () => {
    expect(helpFor([])).toContain("sessions send");
    expect(helpFor(["sessions"])).toContain("sessions delete");
    expect(helpFor(["sessions", "send"])).toContain("Ctrl+C stops waiting");
    expect(helpFor(["sessions", "delete"])).toContain("Active or ambiguous");
    expect(helpFor(["init"])).not.toContain("--url");
    expect(helpFor(["init"])).toContain("init --agent ID --agent-command PATH");
    expect(helpFor(["serve"])).toContain("persistent");
    expect(() => helpFor(["bad"])).toThrow("Unknown command");
    expect(() => helpFor(["sessions", "bad"])).toThrow("Unknown command");
  });
  it("shows Session names in human lists/details without replacing stable IDs", () => {
    const session = {
      sessionId: "uuid",
      name: "Project review",
      agentId: "agent",
      workingDirectory: "D:\\project",
    };
    expect(humanOutput("sessions get", session)).toContain(
      "Session: uuid\nName: Project review\n",
    );
    expect(humanOutput("sessions list", { items: [session] })).toBe(
      "uuid  Project review  agent  D:\\project",
    );
    expect(helpFor(["sessions", "create"])).toContain("--name NAME");
    expect(helpFor(["sessions", "create"])).toContain("may repeat");
  });
});
