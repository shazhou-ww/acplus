import type {
  AhpTransport,
  JsonRpcMessage,
  TransportFrame,
} from "@microsoft/agent-host-protocol/client";
import { record, ServiceError } from "./common.js";

// The SDK supervisor logs connection exceptions. Keep untrusted RPC diagnostics
// and credential-bearing WebSocket URLs out of those exceptions.
export function safeTransport(transport: AhpTransport): AhpTransport {
  return {
    async send(message: JsonRpcMessage | string) {
      try {
        await transport.send(message);
      } catch {
        throw new ServiceError("host_transport_send_failed", 503);
      }
    },
    async recv(): Promise<TransportFrame | null> {
      try {
        const frame = await transport.recv();
        if (frame === null) return null;
        const message: unknown =
          frame.kind === "parsed"
            ? frame.message
            : frame.kind === "text"
              ? JSON.parse(frame.text)
              : JSON.parse(Buffer.from(frame.data).toString("utf8"));
        if (record(message) && record(message.error))
          return {
            kind: "text",
            text: JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              error: {
                code: message.error.code,
                message: "Upstream request rejected",
              },
            }),
          };
        return frame;
      } catch {
        throw new ServiceError("host_transport_receive_failed", 503);
      }
    },
    async close() {
      try {
        await transport.close();
      } catch {
        throw new ServiceError("host_transport_close_failed", 503);
      }
    },
  };
}
