import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import process from "node:process";
import { URL } from "node:url";

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  if (index < 0 || args[index + 1] === undefined)
    throw new Error("Missing option");
  return args[index + 1];
};
const directory = option("--user-data-dir");
const token = await readFile(option("--connection-token-file"), "utf8");
const server = new WebSocketServer({
  port: 0,
  host: "127.0.0.1",
  verifyClient: ({ req }) =>
    new URL(req.url, "http://localhost").searchParams.get("tkn") === token,
});
await new Promise((resolve) => server.once("listening", resolve));
const address = server.address();
const entries = join(directory, "agent-host", "local-endpoint", "entries");
await mkdir(entries, { recursive: true });
await writeFile(
  join(entries, "fixture.json"),
  JSON.stringify({
    schemaVersion: 2,
    type: "standalone",
    instanceId: "owned-fixture",
    endpoint: { type: "tcp", host: "127.0.0.1", port: address.port },
  }),
);
await writeFile(
  join(directory, "process.json"),
  JSON.stringify({
    pid: process.pid,
    args,
    environmentKeys: Object.keys(process.env),
    home: process.env.HOME,
    data: option("--cli-data-dir"),
  }),
);
server.on("connection", (socket) => {
  socket.on("message", (data) => {
    const request = JSON.parse(String(data));
    if (request.id === undefined) return;
    const snapshot = {
      resource: "ahp-root://",
      fromSeq: 0,
      state: { agents: [] },
    };
    const result =
      request.method === "initialize"
        ? { protocolVersion: "1.0.0", serverSeq: 0, snapshots: [snapshot] }
        : request.method === "listSessions"
          ? { items: [] }
          : request.method === "subscribe"
            ? { snapshot }
            : null;
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
  });
});
