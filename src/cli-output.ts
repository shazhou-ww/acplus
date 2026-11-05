import { stripVTControlCharacters } from "node:util";
import { record, ServiceError } from "./common.js";

function display(value: unknown): string {
  return typeof value === "string"
    ? stripVTControlCharacters(value).replace(/[\r\n\t]/gu, " ")
    : "";
}

function diagnostic(value: unknown): string {
  return record(value)
    ? `${display(value.code)}${value.message ? `: ${display(value.message)}` : ""}`
    : "";
}

function table(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return "No entries.\n";
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] ?? "").length)),
  );
  return (
    [headers, ...rows]
      .map((row) =>
        row
          .map((cell, index) => cell.padEnd(widths[index] ?? 0))
          .join("  ")
          .trimEnd(),
      )
      .join("\n") + "\n"
  );
}

export function humanOutput(command: string, value: unknown): string {
  if (command === "hosts list" || command === "sessions list") {
    if (!Array.isArray(value) || !value.every(record))
      throw new ServiceError("invalid_cli_response", 502);
    if (command === "sessions list")
      return table(
        ["SESSION", "PROVIDER", "TITLE"],
        value.map((item) => [
          display(item.resource),
          display(item.provider),
          display(item.title),
        ]),
      );
    return table(
      ["HOST", "STATUS", "PROVIDERS", "AUTH METHODS", "ERROR"],
      value.map((item) => [
        display(item.hostId),
        display(item.status),
        Array.isArray(item.providers)
          ? item.providers.map(display).join(", ")
          : "-",
        Array.isArray(item.authMethods)
          ? item.authMethods
              .filter(record)
              .map((method) => display(method.methodId))
              .join(", ")
          : "-",
        diagnostic(item.error),
      ]),
    );
  }
  if (!record(value)) throw new ServiceError("invalid_cli_response", 502);
  if (command.endsWith(" create")) {
    return `${command.startsWith("sessions") ? "Session" : "Chat"} created: ${display(value.resource)}\n`;
  }
  if (command === "chats list") {
    if (!Array.isArray(value.chats) || !value.chats.every(record))
      throw new ServiceError("invalid_cli_response", 502);
    return table(
      ["CHAT", "DEFAULT", "INTERACTION", "ORIGIN", "TITLE"],
      value.chats.map((chat) => [
        display(chat.resource),
        chat.resource === value.defaultChat ? "yes" : "",
        display(chat.interactivity) || "full",
        record(chat.origin) ? display(chat.origin.kind) : "unknown",
        display(chat.title),
      ]),
    );
  }
  if (command === "turns get") {
    const lines = [`Turn: ${display(value.state)}`];
    if (value.inputRequired === true)
      lines.push(
        "Waiting for user input or tool approval; this CLI cannot answer it. You may cancel the turn.",
      );
    if (value.error) lines.push(`Error: ${diagnostic(value.error)}`);
    if (typeof value.text === "string") {
      lines.push("", stripVTControlCharacters(value.text));
    }
    return lines.join("\n") + "\n";
  }
  if (command === "auth get") {
    const lines = [`Authentication: ${display(value.status)}`];
    if (value.methodId) lines.push(`Method: ${display(value.methodId)}`);
    if (value.error) lines.push(`Error: ${diagnostic(value.error)}`);
    if (record(value.step)) {
      if (value.step.kind === "link") {
        lines.push("", `Open: ${display(value.step.url)}`);
        if (value.step.userCode)
          lines.push(`Verification code: ${display(value.step.userCode)}`);
        lines.push(
          "Complete authorization in your browser, then run this command again.",
        );
      } else if (value.step.kind === "input") {
        lines.push(`Step: ${display(value.step.stepId)}`);
        if (Array.isArray(value.step.fields))
          lines.push(
            `Required fields: ${value.step.fields.map(display).join(", ")}`,
          );
        lines.push(
          "Submit a JSON string map with auth input --step <step> --input-file <file|->.",
        );
      }
    }
    return lines.join("\n") + "\n";
  }
  throw new ServiceError("invalid_cli_response", 502);
}
